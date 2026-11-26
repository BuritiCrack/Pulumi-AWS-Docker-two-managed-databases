"""Synthetic AWS CLI only. Never imports AWS libraries or reads host configuration."""
import json
import os
from pathlib import Path
import sys

p = Path(os.environ["IAM_FIXTURE"])
state = json.loads(p.read_text())
a = sys.argv[1:]
assert a[:6] == ["--profile", "synthetic", "--region", "us-east-1", "--output", "json"]
assert a[6] == "--no-cli-pager"
service, operation = a[7:9]
a = a[9:]

def value(key):
    return a[a.index(key) + 1]

def fail(code):
    sys.stderr.write(f"An error occurred ({code}) when calling the operation: synthetic\n")
    sys.exit(255)

if state.get("fail") == operation:
    fail(state.get("error", "AccessDenied"))
if service == "sts":
    result = {"Account": state.get("account", "123456789012"), "Arn": "arn:aws:iam::123456789012:user/synthetic"}
elif operation == "get-open-id-connect-provider":
    if state.get("provider") is None:
        fail("NoSuchEntity")
    result = state["provider"]
elif operation == "get-role":
    name = value("--role-name")
    if name not in state.get("roles", {}):
        fail("NoSuchEntity")
    result = {"Role": state["roles"][name]}
elif operation == "list-role-policies":
    result = {"PolicyNames": list(state.get("policies", {}).get(value("--role-name"), {}))}
elif operation == "get-role-policy":
    result = {"PolicyDocument": state["policies"][value("--role-name")][value("--policy-name")]}
elif operation == "list-attached-role-policies":
    result = {"AttachedPolicies": [{"PolicyArn": arn} for arn in state.get("attached", {}).get(value("--role-name"), [])]}
elif operation == "list-instance-profiles-for-role":
    result = {"InstanceProfiles": state.get("instances", [])}
elif operation == "get-policy":
    arn = value("--policy-arn")
    if arn not in state.get("managed", {}):
        fail("NoSuchEntity")
    result = {"Policy": {"Arn": arn, "DefaultVersionId": "v1", "PermissionsBoundaryUsageCount": 0}}
elif operation == "list-policy-tags":
    result = {"Tags": state["managed"][value("--policy-arn")]["Tags"]}
elif operation == "get-policy-version":
    result = {"PolicyVersion": {"Document": state["managed"][value("--policy-arn")]["Document"]}}
elif operation == "list-entities-for-policy":
    result = {"PolicyUsers": [], "PolicyGroups": [], "PolicyRoles": [{"RoleName": name}
        for name, arns in state.get("attached", {}).items() if value("--policy-arn") in arns]}
elif operation == "create-policy":
    arn = "arn:aws:iam::123456789012:policy/prestashop/github-oidc-cicd/" + value("--policy-name")
    state.setdefault("managed", {})[arn] = {"Tags": json.loads(value("--tags")), "Document": json.loads(value("--policy-document"))}
    result = {"Policy": {"Arn": arn}}
elif operation == "attach-role-policy":
    state.setdefault("attached", {}).setdefault(value("--role-name"), []).append(value("--policy-arn"))
    result = {}
elif operation == "create-open-id-connect-provider":
    state["provider"] = {"Url": value("--url"), "ClientIDList": [value("--client-id-list")], "Tags": json.loads(value("--tags"))}
    result = {"OpenIDConnectProviderArn": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"}
elif operation == "create-role":
    name = value("--role-name")
    state.setdefault("roles", {})[name] = {
        "Arn": "arn:aws:iam::123456789012:role/" + name,
        "Path": "/", "MaxSessionDuration": 3600,
        "Tags": json.loads(value("--tags")),
        "AssumeRolePolicyDocument": json.loads(value("--assume-role-policy-document")),
    }
    result = {"Role": state["roles"][name]}
else:
    raise AssertionError("Unexpected synthetic operation: " + operation)
if operation.startswith("create-") or operation == "attach-role-policy":
    state["mutations"] = state.get("mutations", 0) + 1
    p.write_text(json.dumps(state))
print(json.dumps(result))
