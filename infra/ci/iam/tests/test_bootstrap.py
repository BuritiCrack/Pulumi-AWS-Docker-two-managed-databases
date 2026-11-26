"""Behavior tests through the public CLI; all child AWS commands are synthetic."""
import fnmatch
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import os

ROOT = Path(__file__).resolve().parents[1]
ACCOUNT = "123456789012"
REPO = "BuritiCrack/Pulumi-AWS-Docker-two-managed-databases"
IMMUTABLE_PREFIX = "repo:BuritiCrack@65743671/Pulumi-AWS-Docker-two-managed-databases@1457370075"

def permission_grants(document, exclude=None):
    """Canonical complete grants, independent of grouping and chunk placement."""
    return sorted({json.dumps({**s, "Action": action, "Resource": resource},
                              sort_keys=True, separators=(",", ":"))
                   for s in document["Statement"] for action in s["Action"]
                   if action != exclude for resource in s["Resource"]})


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="iam-synthetic-")
        self.addCleanup(self.scratch.cleanup)
        self.dir = Path(self.scratch.name)
        self.fixture = self.dir / "fixture.json"
        self.fixture.write_text(json.dumps({"mutations": 0}))
        self.output = self.dir / "journal"
        self.args = ["--account", ACCOUNT, "--account-fingerprint", hashlib.sha256(ACCOUNT.encode()).hexdigest(),
                     "--profile", "synthetic", "--region", "us-east-1",
                     "--app-boundary", f"arn:aws:iam::{ACCOUNT}:policy/prestashop-application-boundary"]

    def run_cli(self, *extra, args=None):
        return subprocess.run([sys.executable, "-B", str(ROOT / "bootstrap.py"),
                               *(self.args if args is None else args), *extra],
                              env={**os.environ, "IAM_FIXTURE": str(self.fixture)},
                              text=True, capture_output=True, timeout=30)

    def apply(self, *extra):
        return self.run_cli("--apply", "--private-output-confirmed", "--output-dir", str(self.output),
                            "--aws-cli", str(ROOT / "tests" / "fake_aws.py"), *extra)

    def store(self, state):
        self.fixture.write_text(json.dumps(state))

    def rejected(self, result, message, before):
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, "", "IAM bootstrap: " + message + "\n"))
        self.assertEqual(self.fixture.read_bytes(), before)
        self.assertFalse(self.output.exists())

    def rendered(self):
        result = self.run_cli()
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        return json.loads(result.stdout)

    def test_render_is_deterministic_offline_and_exact_trust(self):
        before = self.fixture.read_bytes()
        result = self.run_cli("--aws-cli", str(self.dir / "nonexistent"))
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        self.assertEqual(result.stdout, self.run_cli().stdout)
        bundle = json.loads(result.stdout)
        for mode, subject in [("preview", "pull_request"), ("deploy", "ref:refs/heads/main")]:
            trust = bundle[mode]["trust"]["Statement"]
            self.assertEqual(trust, [{"Effect": "Allow", "Principal": {"Federated":
                f"arn:aws:iam::{ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"},
                "Action": "sts:AssumeRoleWithWebIdentity", "Condition": {"StringEquals": {
                    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                    "token.actions.githubusercontent.com:sub": f"repo:{REPO}:{subject}"}}}])
        self.assertEqual(self.fixture.read_bytes(), before)
        self.assertFalse(self.output.exists())

    def test_oidc_subject_prefix_render_changes_only_exact_subjects(self):
        for args in [self.args, self.args[:-2]]:
            baseline = self.run_cli(args=args)
            self.assertEqual((baseline.returncode, baseline.stderr), (0, ""))
            for prefix in [IMMUTABLE_PREFIX, "repo:" + REPO]:
                with self.subTest(prefix=prefix, boundary="--app-boundary" in args):
                    before = self.fixture.read_bytes()
                    result = self.run_cli("--oidc-subject-prefix", prefix,
                                          "--aws-cli", str(self.dir / "nonexistent"), args=args)
                    self.assertEqual((result.returncode, result.stderr), (0, ""))
                    expected = json.loads(baseline.stdout)
                    for mode, context in [("preview", "pull_request"), ("deploy", "ref:refs/heads/main")]:
                        expected[mode]["trust"] = {"Version": "2012-10-17", "Statement": [{
                            "Effect": "Allow", "Principal": {"Federated":
                                f"arn:aws:iam::{ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"},
                            "Action": "sts:AssumeRoleWithWebIdentity", "Condition": {"StringEquals": {
                                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                                "token.actions.githubusercontent.com:sub": prefix + ":" + context}}}]}
                    self.assertEqual(result.stdout, json.dumps(expected, sort_keys=True, indent=2) + "\n")
                    self.assertEqual(self.fixture.read_bytes(), before)
                    self.assertFalse(self.output.exists())

    def test_oidc_subject_prefix_rejects_invalid_input_before_transport_or_output(self):
        invalid = ["", "repo:*", "repo:" + REPO + ":pull_request",
                   IMMUTABLE_PREFIX + ":ref:refs/heads/main",
                   "repo:Other/" + REPO.split("/")[1], "repo:BuritiCrack/Other",
                   IMMUTABLE_PREFIX.replace("BuritiCrack@", "Other@"),
                   IMMUTABLE_PREFIX.replace("databases@", "Other@"),
                   IMMUTABLE_PREFIX.replace("65743671", "*"),
                   IMMUTABLE_PREFIX.replace("1457370075", "?"),
                   IMMUTABLE_PREFIX.replace("65743671", "0"),
                   IMMUTABLE_PREFIX.replace("1457370075", "0123"),
                   IMMUTABLE_PREFIX.replace("65743671", "-1"),
                   IMMUTABLE_PREFIX.replace("1457370075", "1.5"),
                   IMMUTABLE_PREFIX.replace("@65743671", ""),
                   IMMUTABLE_PREFIX.replace("@1457370075", ""),
                   IMMUTABLE_PREFIX + "\n", " " + IMMUTABLE_PREFIX]
        self.store({"mutations": 0, "fail": "get-caller-identity"})
        for prefix in invalid:
            with self.subTest(prefix=prefix):
                before = self.fixture.read_bytes()
                self.rejected(self.run_cli("--oidc-subject-prefix=" + prefix),
                              "invalid OIDC subject prefix", before)
                self.rejected(self.apply("--oidc-subject-prefix=" + prefix),
                              "invalid OIDC subject prefix", before)

    def test_oidc_subject_prefix_apply_create_and_reuse(self):
        self.args += ["--oidc-subject-prefix", IMMUTABLE_PREFIX]
        self.test_create_journal_reuse_and_preservation()
        state = json.loads(self.fixture.read_text())
        expected = self.rendered()
        for mode in ["preview", "deploy"]:
            self.assertEqual(state["roles"][expected[mode]["name"]]["AssumeRolePolicyDocument"],
                             expected[mode]["trust"])

    def test_oidc_subject_prefix_does_not_migrate_existing_legacy_trust(self):
        bundle = self.rendered()
        self.store({"mutations": 0, "roles": {"prestashop-github-preview": {
            "Arn": f"arn:aws:iam::{ACCOUNT}:role/prestashop-github-preview", "Path": "/",
            "MaxSessionDuration": 3600, "Tags": bundle["tags"],
            "AssumeRolePolicyDocument": bundle["preview"]["trust"]}}})
        self.rejected(self.apply("--oidc-subject-prefix", IMMUTABLE_PREFIX),
                      "incompatible or externally managed role", self.fixture.read_bytes())

    def test_render_without_application_boundary(self):
        bounded = self.rendered()
        self.args = self.args[:-2]
        before = self.fixture.read_bytes()
        result = self.run_cli("--aws-cli", str(self.dir / "nonexistent"))
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        expected = json.loads(json.dumps(bounded))
        for section in [expected["deploy"]["permissions"],
                        *(p["document"] for p in expected["deploy"]["managed_policies"])]:
            for statement in section["Statement"]:
                condition = statement.get("Condition", {}).get("StringEquals", {})
                condition.pop("iam:PermissionsBoundary", None)
                if not condition:
                    statement.pop("Condition", None)
        actual = json.loads(result.stdout)
        self.assertEqual(actual["preview"], expected["preview"])
        self.assertEqual(actual["deploy"]["trust"], expected["deploy"]["trust"])
        self.assertEqual(actual["deploy"]["permissions"], expected["deploy"]["permissions"])
        self.assertEqual([s for p in actual["deploy"]["managed_policies"]
                          for s in p["document"]["Statement"]], expected["deploy"]["permissions"]["Statement"])
        self.assertEqual(result.stdout, self.run_cli().stdout)
        self.assertEqual(self.fixture.read_bytes(), before)
        self.assertFalse(self.output.exists())

    def test_apply_without_application_boundary(self):
        self.args = self.args[:-2]
        self.test_create_journal_reuse_and_preservation()

    def test_without_boundary_still_rejects_account_ownership_and_exposure(self):
        self.args = self.args[:-2]
        self.test_identity_guard_before_writes()
        self.test_provider_compatibility_and_external_ownership()
        self.test_external_role_and_owned_drift_rejected_before_any_writes()
        self.test_managed_policy_external_ownership_and_content_drift()
        self.test_apply_requires_private_fresh_output()
        self.store({"mutations": 0})
        self.test_existing_role_additional_permissions_rejected()

    def test_input_guards_without_changes(self):
        cases = [("--account", "123*", "invalid account"),
                 ("--account-fingerprint", "0" * 64, "account fingerprint mismatch"),
                 ("--profile", "--evil", "invalid profile"),
                 ("--region", "eu-west-1", "region must be us-east-1"),
                 ("--app-boundary", f"arn:aws:iam::{ACCOUNT}:policy/AdministratorAccess", "invalid application boundary")]
        for option, value, message in cases:
            with self.subTest(option=option):
                args = list(self.args)
                i = args.index(option)
                args[i:i+2] = [option + "=" + value]
                self.rejected(self.run_cli(args=args), message, self.fixture.read_bytes())

    def test_preview_has_only_app_reads_and_backend_reads(self):
        bundle = self.rendered()
        preview = bundle["preview"]["permissions"]["Statement"]
        allowed = {action for s in preview if s["Effect"] == "Allow" for action in s["Action"]}
        self.assertIn("ec2:DescribeAvailabilityZones", allowed)
        self.assertIn("secretsmanager:GetSecretValue", allowed)
        self.assertIn("s3:GetObject", allowed)
        self.assertTrue(all(a.split(":")[1].startswith(("Get", "List", "Describe", "BatchGet", "BatchCheck")) for a in allowed))
        self.assertNotIn("ecr:GetAuthorizationToken", allowed)
        self.assertFalse(any("*" in a for a in allowed))
        for s in preview:
            if any(a.startswith("s3:") for a in s["Action"]):
                self.assertEqual(s["Condition"]["StringEquals"]["s3:ResourceAccount"], ACCOUNT)

    def test_deploy_iam_and_backend_boundaries(self):
        bundle = self.rendered()
        statements = bundle["deploy"]["permissions"]["Statement"]
        for s in statements:
            self.assertTrue(all("*" not in a for a in s["Action"]))
            if s["Effect"] == "Allow" and any(a.startswith("iam:") for a in s["Action"]):
                self.assertTrue(all("role/shop-" in r for r in s["Resource"]))
                self.assertTrue(all("github" not in r and ACCOUNT in r for r in s["Resource"]))
                if "iam:PassRole" in s["Action"]:
                    self.assertEqual(s["Condition"]["StringEquals"]["iam:PassedToService"], "ecs-tasks.amazonaws.com")
                if "iam:CreateRole" in s["Action"] or "iam:PutRolePolicy" in s["Action"]:
                    self.assertEqual(s["Condition"]["StringEquals"]["iam:PermissionsBoundary"], self.args[-1])
            if "s3:PutObject" in s["Action"]:
                self.assertFalse(any("meta.yaml" in r for r in s["Resource"]))
                self.assertTrue(all("prestashop/dev" in r or "/dev" in r for r in s["Resource"]))
        for mode in ["preview", "deploy"]:
            policies = bundle[mode]["managed_policies"]
            self.assertLessEqual(len(policies), 10)
            flattened = []
            for policy in policies:
                self.assertLessEqual(len(json.dumps(policy["document"], separators=(",", ":"))), 6144)
                self.assertIn(":policy/prestashop/github-oidc-cicd/", policy["arn"])
                flattened.extend(policy["document"]["Statement"])
            self.assertEqual(flattened, bundle[mode]["permissions"]["Statement"])

    def test_rds_collection_read_preserves_non_target_bundle(self):
        # Computed once from the pre-change public CLI in all four configurations:
        # expand every statement into complete per-action/resource grants, exclude
        # only DescribeDBInstances, and retain all other bundle fields plus policy
        # names/ARNs. The boundary-enabled baseline had deploy-03: normalize that
        # metadata alone to the explicitly required deploy-01/02 interface after
        # verifying complete grant equality offline. All four cases now require
        # exactly two named policies below. No permission differences were found.
        # Managed grants must equal permissions before normalization. No committed
        # test reads git/history or assumes chunk-byte stability.
        original = {
            (False, False): "2113571811eab1c641bf64003bedcef5c92b85c219e913a15885e15be49765fe",
            (False, True): "0a43d2c8880a4ef3e5639808245d3e4d78e6a25f9b54da4b13c11ce55f91af3a",
            (True, False): "269d779bef26f97d73923ed058a968e3cb53f29ec2ee4ca61d9062d20e4d0997",
            (True, True): "63724f9f76accc3b799a27e12b6de3f0776e0dda01bba4b201a3f3ef273fad25",
        }
        action = "rds:DescribeDBInstances"
        collection = f"arn:aws:rds:us-east-1:{ACCOUNT}:db:*"
        for (boundary, immutable), fingerprint in original.items():
            with self.subTest(boundary=boundary, immutable=immutable):
                args = self.args if boundary else self.args[:-2]
                extra = ["--oidc-subject-prefix", IMMUTABLE_PREFIX] if immutable else []
                before = self.fixture.read_bytes()
                result = self.run_cli(*extra, "--aws-cli", str(self.dir / "nonexistent"), args=args)
                self.assertEqual((result.returncode, result.stderr), (0, ""))
                bundle = json.loads(result.stdout)
                self.assertEqual(result.stdout, json.dumps(bundle, sort_keys=True, indent=2) + "\n")
                self.assertEqual(self.fixture.read_bytes(), before)
                self.assertFalse(self.output.exists())
                for mode in ["preview", "deploy"]:
                    role = bundle[mode]
                    self.assertEqual([p["name"] for p in role["managed_policies"]],
                                     [f"prestashop-github-{mode}-{i:02}" for i in [1, 2]])
                    self.assertEqual([s for p in role["managed_policies"] for s in p["document"]["Statement"]],
                                     role["permissions"]["Statement"])
                    self.assertEqual(permission_grants(role["permissions"]), permission_grants({
                        "Statement": [s for p in role["managed_policies"] for s in p["document"]["Statement"]]}))
                    for p in role["managed_policies"]:
                        self.assertLessEqual(len(json.dumps(p["document"], separators=(",", ":"))), 6144)
                    if mode == "preview":
                        self.assertTrue(all(a.split(":")[1].startswith(
                            ("Get", "List", "Describe", "BatchGet", "BatchCheck"))
                            for s in role["permissions"]["Statement"] for a in s["Action"]))
                    for doc in [role["permissions"], *(p["document"] for p in role["managed_policies"])]:
                        target = [s for s in doc["Statement"] if action in s["Action"]]
                        if doc is role["permissions"] or target:
                            self.assertEqual(target, [{"Effect": "Allow", "Action": [action],
                                "Resource": [collection], "Condition": {
                                    "StringEquals": {"aws:RequestedRegion": "us-east-1"}}}])
                        # Evaluate the emitted grant for the observed collection and
                        # the previous named DB, not a locally invented grant pattern.
                        for resource in ([collection, collection[:-1] + "shop-mysql-dev"] if target else []):
                            self.assertTrue(any(fnmatch.fnmatchcase(resource, arn)
                                                for s in target for arn in s["Resource"]))
                    role["permissions"] = permission_grants(role["permissions"], exclude=action)
                    self.assertEqual(role["permissions"], permission_grants({"Statement": [
                        s for p in role["managed_policies"] for s in p["document"]["Statement"]]}, exclude=action))
                    role["managed_policies"] = [{k: v for k, v in p.items() if k != "document"}
                                                for p in role["managed_policies"]]
                canonical = json.dumps(bundle, sort_keys=True, separators=(",", ":"))
                self.assertEqual(hashlib.sha256(canonical.encode()).hexdigest(), fingerprint)

    def test_apply_requires_private_fresh_output(self):
        self.rejected(self.run_cli("--apply"), "apply requires private fresh output directory", self.fixture.read_bytes())

    def test_permission_error_is_not_missing(self):
        self.store({"mutations": 0, "fail": "get-open-id-connect-provider"})
        self.rejected(self.apply(), "AWS get-open-id-connect-provider failed", self.fixture.read_bytes())

    def test_identity_guard_before_writes(self):
        self.store({"mutations": 0, "account": "999999999999"})
        self.rejected(self.apply(), "caller account mismatch", self.fixture.read_bytes())

    def test_provider_compatibility_and_external_ownership(self):
        for provider in [
            {"Url": "token.actions.githubusercontent.com", "ClientIDList": ["other"]},
            {"Url": "wrong", "ClientIDList": ["sts.amazonaws.com"]},
            {"Url": "token.actions.githubusercontent.com", "ClientIDList": ["sts.amazonaws.com"],
             "Tags": [{"Key": "ManagedBy", "Value": "Terraform"}]},
        ]:
            with self.subTest(provider=provider):
                self.store({"mutations": 0, "provider": provider})
                self.rejected(self.apply(), "incompatible or externally managed provider", self.fixture.read_bytes())

    def test_external_role_and_owned_drift_rejected_before_any_writes(self):
        bundle = self.rendered()
        for tags, trust in [([], bundle["deploy"]["trust"]),
                            (bundle["tags"], {"Version": "2012-10-17", "Statement": []})]:
            self.store({"mutations": 0, "roles": {"prestashop-github-deploy": {
                "Arn": f"arn:aws:iam::{ACCOUNT}:role/prestashop-github-deploy", "Path": "/",
                "MaxSessionDuration": 3600, "Tags": tags, "AssumeRolePolicyDocument": trust}}})
            self.rejected(self.apply(), "incompatible or externally managed role", self.fixture.read_bytes())

    def test_create_journal_reuse_and_preservation(self):
        provider = {"Url": "token.actions.githubusercontent.com", "ClientIDList": ["sts.amazonaws.com"], "ThumbprintList": ["preserve"]}
        self.store({"mutations": 0, "provider": provider})
        result = self.apply()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "IAM bootstrap: applied\n", ""))
        state = json.loads(self.fixture.read_text())
        self.assertEqual(state["provider"], provider)
        expected = 2 + 2 * sum(len(self.rendered()[mode]["managed_policies"]) for mode in ["preview", "deploy"])
        self.assertEqual(state["mutations"], expected)
        journal = json.loads((self.output / "journal.json").read_text())
        self.assertEqual(journal["status"], "completed")
        self.assertEqual(len(journal["operations"]), expected)
        self.assertTrue((self.output / "before.json").exists())
        original = self.fixture.read_bytes()
        self.output = self.dir / "journal-reuse"
        result = self.apply()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "IAM bootstrap: applied\n", ""))
        self.assertEqual(self.fixture.read_bytes(), original)

    def test_managed_policy_external_ownership_and_content_drift(self):
        bundle = self.rendered()
        policy = bundle["preview"]["managed_policies"][0]
        for tags, doc in [([], policy["document"]), (bundle["tags"], {"Version": "2012-10-17", "Statement": []})]:
            with self.subTest(tags=tags):
                self.store({"mutations": 0, "managed": {policy["arn"]: {"Tags": tags, "Document": doc}}})
                self.rejected(self.apply(), "incompatible or externally managed policy", self.fixture.read_bytes())

    def test_existing_role_additional_permissions_rejected(self):
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        good = json.loads(self.fixture.read_text())
        for key, value in [("attached", {"prestashop-github-preview": ["arn:aws:iam::aws:policy/AdministratorAccess"]}),
                           ("policies", {"prestashop-github-preview": {"unrelated": {}}}),
                           ("instances", [{"InstanceProfileName": "external"}])]:
            with self.subTest(key=key):
                state = json.loads(json.dumps(good))
                state[key] = value
                self.store(state)
                self.output = self.dir / ("reject-" + key)
                self.rejected(self.apply(), "incompatible or externally managed role", self.fixture.read_bytes())

    def test_missing_provider_created_and_partial_failure_journaled(self):
        result = self.apply()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "IAM bootstrap: applied\n", ""))
        expected = 3 + 2 * sum(len(self.rendered()[mode]["managed_policies"]) for mode in ["preview", "deploy"])
        self.assertEqual(json.loads(self.fixture.read_text())["mutations"], expected)
        self.fixture.write_text(json.dumps({"mutations": 0, "fail": "attach-role-policy"}))
        self.output = self.dir / "partial"
        result = self.apply()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, "", "IAM bootstrap: AWS attach-role-policy failed\n"))
        self.assertEqual(json.loads((self.output / "journal.json").read_text())["status"], "failed")

if __name__ == "__main__":
    unittest.main()
