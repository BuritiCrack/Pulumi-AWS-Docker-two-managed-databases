"""Deterministic baseline, not a generated-minimum or runtime completeness claim."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPOSITORY = "BuritiCrack/Pulumi-AWS-Docker-two-managed-databases"
ISSUER = "token.actions.githubusercontent.com"
BUCKET = "prestashop-pulumi-state-e16207d96f49-us-east-1"
TAGS = [{"Key": "Repository", "Value": REPOSITORY},
        {"Key": "ManagedBy", "Value": "github-oidc-cicd"}]
VERSION = "2012-10-17"


def load(name):
    return json.loads((HERE / name).read_text(encoding="utf-8"))


def document(statements):
    return {"Version": VERSION, "Statement": statements}


def statement(actions, resources, conditions=None):
    result = {"Effect": "Allow", "Action": sorted(set(actions)), "Resource": sorted(set(resources))}
    if conditions:
        result["Condition"] = conditions
    return result


def render(account, region, boundary=None):
    operations, sar, scopes, resources = [load(name + ".json") for name in
                                        ["operations", "sar", "scopes", "resources"]]
    provider = f"arn:aws:iam::{account}:oidc-provider/{ISSUER}"
    result = {"provider": provider, "tags": TAGS}
    role_arns = [f"arn:aws:iam::{account}:{suffix}" for suffix in resources["iam"]["role"]]
    for mode, subject in [("preview", "pull_request"), ("deploy", "ref:refs/heads/main")]:
        statements = []
        for service, modes in operations.items():
            if service == "s3":
                continue  # Backend permissions are separated from application permissions below.
            actions = set()
            for kind in (["read"] if mode == "preview" else ["read", "write"]):
                for operation in modes[kind].split():
                    for item in sar[service]["operations"][operation]:
                        # SAR includes pull-through-cache import variants on normal image
                        # reads. This graph creates its own repository, never a cache rule.
                        if service == "ecr" and operation in {"BatchGetImage", "GetDownloadUrlForLayer"} and item["Name"] in {
                            "BatchImportUpstreamImage", "CreateRepository", "TagResource"}:
                            continue
                        if item["Service"] == service:
                            actions.add(item["Name"])
            # Single-tenant MySQL does not use the RDS multi-tenant Oracle variant.
            actions.discard("CreateTenantDatabase")
            if service == "iam":
                reads = {a for a in actions if a.startswith(("Get", "List"))}
                statements.append(statement(["iam:" + a for a in reads], role_arns))
                if mode == "deploy":
                    bounded = {a for a in actions - reads if "iam:PermissionsBoundary" in
                               scopes["iam"]["actions"][a]["conditions"]}
                    boundary_condition = {"iam:PermissionsBoundary": boundary} if boundary else {}
                    statements.append(statement(["iam:" + a for a in bounded - {"AttachRolePolicy", "DetachRolePolicy"}], role_arns,
                                                {"StringEquals": boundary_condition} if boundary else None))
                    statements.append(statement(["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
                        [role_arns[0]], {"StringEquals": {**boundary_condition,
                        "iam:PolicyARN": "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"}}))
                    statements.append(statement(["iam:TagRole", "iam:UntagRole"], role_arns))
                    statements.append(statement(["iam:PassRole"], role_arns,
                        {"StringEquals": {"iam:PassedToService": "ecs-tasks.amazonaws.com"}}))
                continue
            # All configured ARN types stay within the graph's resource families. Actions
            # which do not support resource scoping must be in a separate '*' statement.
            regional = {"StringEquals": {"aws:RequestedRegion": region}}
            scoped, unscoped = [], []
            for action in sorted(actions):
                metadata = scopes[service]["actions"][action]
                (scoped if metadata["resources"] else unscoped).append(service + ":" + action)
            if scoped:
                arns = []
                for suffixes in resources[service].values():
                    for suffix in suffixes if isinstance(suffixes, list) else [suffixes]:
                        arns.append(f"arn:aws:{service}:{region}:{account}:{suffix}")
                # Logs authorization may require the trailing :* log-group form.
                if service == "logs":
                    arns += [arn + ":*" for arn in arns]
                statements.append(statement(scoped, arns, regional))
            if unscoped:
                statements.append(statement(unscoped, ["*"], regional))
        bucket = "arn:aws:s3:::" + BUCKET
        backend_condition = {"StringEquals": {"s3:ResourceAccount": account}}
        statements.append(statement(["s3:GetBucketLocation", "s3:ListBucket"], [bucket], backend_condition))
        stack_files = [f".pulumi/stacks/prestashop/dev{suffix}" for suffix in [".json", ".json.gz", ".json.bak", ".json.gz.bak"]]
        state_paths = stack_files + [".pulumi/history/prestashop/dev/*", ".pulumi/backups/prestashop/dev/*",
                                     ".pulumi/locks/organization/prestashop/dev/*"]
        statements.append(statement(["s3:GetObject"], [bucket + "/" + p for p in
                                     [".pulumi/meta.yaml", *state_paths]], backend_condition))
        if mode == "deploy":
            statements.append(statement(["s3:PutObject", "s3:DeleteObject"],
                                        [bucket + "/" + p for p in state_paths], backend_condition))
        trust = document([{"Effect": "Allow", "Principal": {"Federated": provider},
            "Action": "sts:AssumeRoleWithWebIdentity", "Condition": {"StringEquals": {
                ISSUER + ":aud": "sts.amazonaws.com", ISSUER + ":sub": f"repo:{REPOSITORY}:{subject}"}}}])
        policy = document(statements)
        # Customer-managed policies have a 6,144-character document limit. Split at
        # statement boundaries; never weaken a statement to meet a quota.
        chunks = [[]]
        for item in statements:
            candidate = document([*chunks[-1], item])
            if len(json.dumps(candidate, separators=(",", ":"))) > 6144:
                chunks.append([])
            chunks[-1].append(item)
        managed = []
        for index, chunk in enumerate(chunks, 1):
            name = f"prestashop-github-{mode}-{index:02}"
            doc = document(chunk)
            if len(json.dumps(doc, separators=(",", ":"))) > 6144:
                raise ValueError("single statement exceeds managed policy quota")
            managed.append({"name": name, "arn": f"arn:aws:iam::{account}:policy/prestashop/github-oidc-cicd/{name}",
                            "document": doc})
        if len(managed) > 10:
            raise ValueError("rendered policy exceeds attachment quota")
        result[mode] = {"name": "prestashop-github-" + mode, "trust": trust,
                        "permissions": policy, "managed_policies": managed}
    return result
