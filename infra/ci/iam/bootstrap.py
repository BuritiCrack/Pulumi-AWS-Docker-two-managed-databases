"""Offline renderer by default. Only an explicit parent --apply invokes AWS CLI."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote

from policies import ISSUER, TAGS, render


class GuardError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise GuardError(message)


def compact(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def policy_document(value):
    return json.loads(unquote(value)) if isinstance(value, str) else value


def external(tags):
    return any(tag["Key"].lower().startswith("aws:cloudformation:") or
               (tag["Key"].lower() in {"managedby", "managed-by", "terraform", "pulumi"} and
                (tag["Key"], tag["Value"]) not in {(t["Key"], t["Value"]) for t in TAGS})
               for tag in tags)


class AWS:
    def __init__(self, args):
        executable = args.aws_cli
        require(not executable.lower().endswith((".cmd", ".bat")), "native AWS executable required")
        # .py is the explicit synthetic test transport, never an implicit fallback.
        self.prefix = ([sys.executable, "-B", executable] if executable.endswith(".py") else [executable])
        self.prefix += ["--profile", args.profile, "--region", args.region, "--output", "json", "--no-cli-pager"]

    def call(self, service, operation, *argv, missing=False):
        env = {**os.environ, "AWS_EC2_METADATA_DISABLED": "true", "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS": "true"}
        try:
            result = subprocess.run([*self.prefix, service, operation, *argv],
                                    env=env, capture_output=True, text=True, timeout=60, shell=False)
        except (OSError, subprocess.TimeoutExpired):
            raise GuardError("AWS " + operation + " failed") from None
        if result.returncode:
            if missing and re.search(r"\(NoSuchEntity\)", result.stderr):
                return None
            raise GuardError("AWS " + operation + " failed")
        try:
            return json.loads(result.stdout or "{}")
        except ValueError:
            raise GuardError("AWS " + operation + " returned invalid JSON") from None


def inventory(aws, bundle, account):
    identity = aws.call("sts", "get-caller-identity")
    require(identity.get("Account") == account and identity.get("Arn", "").split(":")[4:5] == [account],
            "caller account mismatch")
    provider = aws.call("iam", "get-open-id-connect-provider", "--open-id-connect-provider-arn", bundle["provider"], missing=True)
    if provider is not None:
        require(provider.get("Url") in {ISSUER, "https://" + ISSUER} and
                provider.get("ClientIDList") == ["sts.amazonaws.com"] and not external(provider.get("Tags", [])),
                "incompatible or externally managed provider")
    before = {"identity": identity, "provider": provider, "roles": {}, "policies": {}}
    for mode in ["preview", "deploy"]:
        desired = bundle[mode]
        for policy in desired["managed_policies"]:
            arn = policy["arn"]
            existing = aws.call("iam", "get-policy", "--policy-arn", arn, missing=True)
            if existing is None:
                before["policies"][arn] = None
                continue
            metadata = existing["Policy"]
            tags = aws.call("iam", "list-policy-tags", "--policy-arn", arn)
            version = aws.call("iam", "get-policy-version", "--policy-arn", arn,
                               "--version-id", metadata["DefaultVersionId"])
            entities = aws.call("iam", "list-entities-for-policy", "--policy-arn", arn)
            require(metadata.get("Arn") == arn and all(t in tags.get("Tags", []) for t in TAGS) and
                    not external(tags.get("Tags", [])) and
                    policy_document(version["PolicyVersion"]["Document"]) == policy["document"] and
                    not entities.get("PolicyUsers") and not entities.get("PolicyGroups") and
                    all(r.get("RoleName") == desired["name"] for r in entities.get("PolicyRoles", [])) and
                    metadata.get("PermissionsBoundaryUsageCount", 0) == 0,
                    "incompatible or externally managed policy")
            before["policies"][arn] = {"metadata": metadata, "tags": tags, "version": version, "entities": entities}
        name = desired["name"]
        response = aws.call("iam", "get-role", "--role-name", name, missing=True)
        if response is None:
            before["roles"][name] = None
            continue
        role = response["Role"]
        require(role.get("Arn") == f"arn:aws:iam::{account}:role/{name}" and role.get("Path") == "/" and
                role.get("MaxSessionDuration") == 3600 and not role.get("PermissionsBoundary") and
                not external(role.get("Tags", [])) and all(t in role.get("Tags", []) for t in TAGS) and
                policy_document(role.get("AssumeRolePolicyDocument")) == desired["trust"],
                "incompatible or externally managed role")
        attached = aws.call("iam", "list-attached-role-policies", "--role-name", name)
        instances = aws.call("iam", "list-instance-profiles-for-role", "--role-name", name)
        policies = aws.call("iam", "list-role-policies", "--role-name", name)
        require({p["PolicyArn"] for p in attached.get("AttachedPolicies", [])} ==
                {p["arn"] for p in desired["managed_policies"]} and not instances.get("InstanceProfiles") and
                policies.get("PolicyNames") == [], "incompatible or externally managed role")
        before["roles"][name] = {"role": role, "attached": attached, "instances": instances, "inline": policies}
    return before


def output_path(args):
    require(args.output_dir and args.private_output_confirmed, "apply requires private fresh output directory")
    path = Path(args.output_dir)
    require(path.is_absolute() and not path.exists() and path.parent.is_dir() and not path.is_symlink(),
            "apply requires private fresh output directory")
    # Inside the worktree, only the explicitly ignored evidence subtree is accepted.
    root = Path(__file__).resolve().parents[3]
    resolved = path.resolve()
    if resolved.is_relative_to(root):
        require(resolved.is_relative_to(Path(__file__).resolve().parent / ".evidence"),
                "output directory must be ignored or outside repository")
    require(not any(parent.is_symlink() for parent in path.parents), "output directory must not traverse symlinks")
    return path


def private_write(path, value, fresh=False):
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if fresh else os.O_TRUNC)
    with os.fdopen(os.open(path, flags, 0o600), "w", encoding="utf-8") as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def apply(args, bundle):
    path = output_path(args)
    aws = AWS(args)
    before = inventory(aws, bundle, args.account)
    # No persistent output or cloud mutations until EVERY existing object passes.
    path.mkdir(mode=0o700)
    private_write(path / "before.json", before, fresh=True)
    private_write(path / "rendered.json", bundle, fresh=True)
    journal = {"status": "running", "operations": []}
    journal_path = path / "journal.json"
    private_write(journal_path, journal, fresh=True)

    def mutate(operation, *argv):
        entry = {"operation": operation, "argv": list(argv), "status": "intent"}
        journal["operations"].append(entry)
        private_write(journal_path, journal)
        response = aws.call("iam", operation, *argv)
        entry["status"] = "completed"
        entry["response"] = response
        private_write(journal_path, journal)

    try:
        if before["provider"] is None:
            mutate("create-open-id-connect-provider", "--url", "https://" + ISSUER,
                   "--client-id-list", "sts.amazonaws.com", "--tags", compact(TAGS))
        for mode in ["preview", "deploy"]:
            desired = bundle[mode]
            for policy in desired["managed_policies"]:
                if before["policies"][policy["arn"]] is None:
                    mutate("create-policy", "--policy-name", policy["name"], "--path", "/prestashop/github-oidc-cicd/",
                           "--tags", compact(TAGS), "--policy-document", compact(policy["document"]))
            if before["roles"][desired["name"]] is None:
                mutate("create-role", "--role-name", desired["name"], "--path", "/",
                       "--max-session-duration", "3600", "--tags", compact(TAGS),
                       "--assume-role-policy-document", compact(desired["trust"]))
                for policy in desired["managed_policies"]:
                    mutate("attach-role-policy", "--role-name", desired["name"], "--policy-arn", policy["arn"])
        journal["status"] = "completed"
    except Exception:
        journal["status"] = "failed"
        private_write(journal_path, journal)
        raise
    private_write(journal_path, journal)


def parser():
    p = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    p.add_argument("--account", required=True, help="explicit expected twelve-digit account")
    p.add_argument("--account-fingerprint", required=True, help="SHA256 of the expected account's ASCII digits")
    p.add_argument("--profile", required=True, help="explicit existing AWS profile; never changed or logged in")
    p.add_argument("--region", required=True, help="must be us-east-1")
    p.add_argument("--oidc-subject-prefix", help="exact repository OIDC prefix (legacy repo:OWNER/REPO or immutable repo:OWNER@ID/REPO@ID); default is legacy; no context or wildcard")
    p.add_argument("--app-boundary", help="optional parent-vetted existing prestashop-application-boundary ARN; requires separate app integration")
    p.add_argument("--apply", action="store_true", help="PARENT ONLY: inventory then create missing CI provider/roles; otherwise offline render")
    p.add_argument("--output-dir", help="fresh absolute directory in ignored .evidence/ or outside checkout")
    p.add_argument("--private-output-confirmed", action="store_true", help="parent confirms private ACLs/encrypted storage on output parent")
    p.add_argument("--aws-cli", default="aws", help="native AWS CLI executable; explicit .py synthetic transport for tests")
    return p


def main():
    args = parser().parse_args()
    try:
        require(re.fullmatch(r"[0-9]{12}", args.account), "invalid account")
        require(args.account_fingerprint == hashlib.sha256(args.account.encode("ascii")).hexdigest(),
                "account fingerprint mismatch")
        require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", args.profile), "invalid profile")
        require(args.region == "us-east-1", "region must be us-east-1")
        require(args.app_boundary is None or
                args.app_boundary == f"arn:aws:iam::{args.account}:policy/prestashop-application-boundary",
                "invalid application boundary")
        bundle = render(args.account, args.region, args.app_boundary, args.oidc_subject_prefix)
        if args.apply:
            apply(args, bundle)
            sys.stdout.write("IAM bootstrap: applied\n")
        else:
            sys.stdout.write(json.dumps(bundle, sort_keys=True, indent=2) + "\n")
    except (GuardError, ValueError) as error:
        sys.stderr.write("IAM bootstrap: " + str(error) + "\n")
        return 1
    except Exception:
        sys.stderr.write("IAM bootstrap: local operation failed\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
