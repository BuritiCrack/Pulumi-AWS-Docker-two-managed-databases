# CI IAM baseline and parent-only bootstrap

This unit supports ODD `github-oidc-cicd.md` T1 / S1–S7 and T9 / S10. It does not provision
GitHub secrets, run Pulumi, deploy application resources, or change LabRole.
Rendering is offline and deterministic; **only `--apply` invokes AWS CLI**.
Python 3.10+ stdlib only; no SDK, installer, login, profile changes, or shell.

## Original application graph and trusted-main risk

By default, application IAM creation/policy mutation does **not** require a new
permissions boundary. The original graph creates execution/task roles even in
labMode, without setting a boundary. S7 defers application changes and additional
boundary hardening; AWS does not mandate that extra boundary for role creation.

**This is not hard least privilege.** Scoped role creation, arbitrary inline/trust
policy updates and ECS PassRole can permit effective privilege escalation through
application tasks. Prefix scoping does not cap an application's effective access.
Only trusted, reviewed main changes may deploy; repository protection/publication
remain separate future work, not configured here. No global AdministratorAccess
or PowerUser policy is attached as a shortcut.

For compatibility, explicit `--app-boundary` retains the previous constrained
rendering and validates the same exact ARN. It is opt-in, NOT a prerequisite for
the original graph. Using it requires separately authorized app integration and
an existing parent-vetted policy; this bootstrap neither creates nor verifies
that boundary's contents. Do not enable it against the unchanged application.

## Public commands (repository root)

Replace angle-bracket placeholders with parent-verified nonsecret values.
`FINGERPRINT` is the lowercase SHA256 of the expected account's 12 ASCII digits,
not a credential or the hash of an access key. Account/fingerprint agreement is
checked even for offline rendering. Region is fixed to the workflow's us-east-1.

Offline render to stdout, no AWS process, file output, or credential discovery:

```text
python -B infra/ci/iam/bootstrap.py --account <ACCOUNT> --account-fingerprint <FINGERPRINT> --profile <EXISTING_PROFILE> --region us-east-1
```

### Explicit OIDC subject prefix (S10)

For the API-observed immutable prefix, the minimal offline invocation is:

```text
python -B infra/ci/iam/bootstrap.py --account <ACCOUNT> --account-fingerprint <FINGERPRINT> --profile <EXISTING_PROFILE> --region us-east-1 --oidc-subject-prefix repo:BuritiCrack@65743671/Pulumi-AWS-Docker-two-managed-databases@1457370075
```

Pass the actual GitHub API-issued `sub_claim_prefix` as configuration. This CLI
never fetches GitHub metadata or reads a JWT. `use_default=true` does **not** imply
legacy subjects when `use_immutable_subject=true`. Omitting the option preserves
legacy `repo:BuritiCrack/Pulumi-AWS-Docker-two-managed-databases`; that same prefix
is also accepted explicitly. Immutable form requires the exact configured owner
and repository names, each followed by `@` and a positive decimal ID without
leading zeros. IDs are supplied by the parent, not verified against GitHub offline.
Empty/foreign/malformed prefixes, wildcards and appended contexts fail with
`IAM bootstrap: invalid OIDC subject prefix` (exit 1, no output or AWS process).

Only `StringEquals.sub` changes: preview appends `:pull_request` and deployment
appends `:ref:refs/heads/main`. Principal, audience and permission policies stay
unchanged. Existing-role trust drift still refuses apply; **there is no automatic
trust migration**. The parent separately owns authorized live subject-only updates.
The observed legacy/immutable mismatch is consistent with the failed federation,
not proof of the historical failed JWT's subject (that JWT was not recovered).
Offline tests do not prove live OIDC integration or a successful Pulumi preview.

Parent-only apply uses the identical arguments (including the prefix when needed) plus:

```text
--apply --output-dir <ABSOLUTE_FRESH_PRIVATE_DIRECTORY> --private-output-confirmed
```

Output parent must already exist and have private ACLs/encrypted storage. Inside
this checkout, choose a fresh child of ignored `infra/ci/iam/.evidence/`;
outside the checkout, output is inherently outside version control. Symlink
ancestors and pre-existing destinations are rejected. Windows ACL privacy is
parent-attested, not proved by Python chmod. POSIX files/directories are created
0600/0700. Never select a shared directory or put output into a GitHub artifact.
Native AWS CLI must already be installed/configured by the parent. Optional
`--aws-cli <EXECUTABLE>` chooses it explicitly; `.cmd`/`.bat` are rejected.
An explicit `.py` transport exists only for synthetic tests, not as a fallback.

## What apply does

1. Validate inputs and offline render; require a private fresh output destination.
2. Call regional STS GetCallerIdentity using the explicit profile and region.
   Require the expected account in both Account and caller ARN. No credential,
   AWS config, DPAPI, encrypted stack config, or application secret file is read
   by this Python program. The parent-invoked AWS CLI uses its normal credential
   resolution; metadata fallback and configured custom endpoints are disabled.
3. Inventory **all** CI objects before the first mutation or journal creation.
   Only explicit IAM `NoSuchEntity` means missing; denied/invalid responses abort.
4. Reuse the exact GitHub issuer/audience provider without changing its audience,
   thumbprints, or tags. Explicit external-management markers reject reuse.
   Untagged compatible shared providers are reused unchanged, never adopted.
5. Existing roles must carry this repository/task's ownership tags, exact trust,
   root path, 3600-second maximum session, and exactly the rendered attachments;
   boundaries, instance profiles, inline policies, foreign attachments and drift
   reject reuse. Existing managed policies require matching ownership/content,
   no foreign user/group/role use, and no boundary use. No overwrite/adoption.
6. Save `before.json` and `rendered.json`; journal every mutation intent/result in
   `journal.json`. Create missing CI provider, CI managed policies, and CI roles;
   attach only those policies. Managed policies split at statement boundaries
   below 6144 characters; at most ten attachments per role. No inline quota bypass.

Partial failures retain backups and a failed journal. There is no automatic
rollback, deletion, overwrite, or retry. A partially created role fails strict
reuse on the next run; the parent must inspect and authorize recovery. A timeout
or interrupted journal intent means outcome unknown: independently inspect it.
Concurrent control-plane modification between inventory and mutation is not
transactionally prevented. The parent must serialize bootstrap ownership.
The CLI never updates a shared provider, uploads GitHub secrets, or manages an
application role/policy itself. CI roles cannot manage these CI IAM objects.

## Policy provenance and scope

- `operations.json`: declared graph lifecycle/read operation inventory, including
  provider availability-zone lookup, ECS/ECR/Docker, and current labMode=true.
- `sar.json`: extracted official API-to-AuthorizedActions records for 182 operations,
  with full-document SHA256 per service. Source pattern:
  `https://servicereference.us-east-1.amazonaws.com/v1/<service>/<service>.json`.
  This is the official machine Service Authorization Reference, not account APIs.
- `scopes.json`: relevant official action/resource/condition metadata.
- `resources.json`: declarative application ARN families; `policies.py` renders
  one baseline, not a fabricated generated-minimum policy. Pulumi IaC is excluded
  from SDK-source Autopilot inputs; no runtime SDK source/Terraform plan exists.

Application reads and backend reads/writes are separate statements. Preview has
no application writes, IAM mutations, ECR authorization/push, or backend writes.
It models Secrets Manager GetSecretValue because provider resource refresh may
need version contents; tests never invoke that API (the fake rejects it).
These are potential reads of the three named secrets, not permission to upload
secrets to GitHub. Pulumi's encrypted checkpoint read is separately scoped.

Deployment includes application lifecycle actions, ECR image upload/delete, and
backend stack checkpoint/history/backup/lock writes. It excludes metadata writes,
old-version deletion, bucket management, KMS administration, CI-role mutation,
managed Administrator/PowerUser/ReadOnlyAccess, and all wildcard action names.
PassRole is limited to shop-execution/task role ARNs and ecs-tasks.amazonaws.com.
The execution managed-policy attachment is limited to the AWS ECS execution policy.
IAM inline/trust modifications and creation target only those application roles.
No boundary condition is imposed by default; the trusted-main risk above remains.
There is no permission to remove/change a boundary or mint managed policies.

SAR variant exclusions are deliberate: ECR pull-through-cache import/create/tag
variants on image reads are not used; RDS multi-tenant Oracle CreateTenantDatabase
is not MySQL; optional S3 Object Lambda, ACL, retention, tagging and historical
version actions are not used. RDS optional PassRole variants have no corresponding
role in this graph; only actual ECS passing is allowed. These exclusions are not
silent missing action guesses. The original SAR mappings remain inspectable.

Named resources use account/region and shop prefixes (explicit MySQL dev ID,
ECS task family shop). EC2/EFS generated IDs are unknown before creation: ARN
identifier wildcards remain within the selected graph resource types/account/
region. These are a coarser baseline, not tag-isolated protection of unrelated
same-account networks/filesystems. Resource-less Describe/List/provider calls,
ECR authorization, and ECS DeregisterTaskDefinition require Resource `*`; those
statements retain aws:RequestedRegion. No `service:*` actions are emitted.
Default service parameter groups are read-only graph dependencies.

## Preview backend evidence (pinned Pulumi 3.212.0)

Public upstream base: `https://github.com/pulumi/pulumi/blob/v3.212.0/pkg/backend/diy/`.
`backend.go` was downloaded directly. Parent verified the following remaining
source through a separate TLS-verifying researcher after this host's public
GitHub directory API failed issuer verification (no retries/trust bypass):

- `backend.go`: Preview -> apply(DryRun=true), no Lock; preview has no snapshot
  manager and skips addToHistory/backupStack. Update, unlike Preview, locks.
- `meta.go:43–105`: ensurePulumiMeta returns existing metadata without writes.
  Missing metadata initializes the layout and may WriteTo; `107–130` writes
  `.pulumi/meta.yaml` for v1. Missing metadata must fail closed for CI preview.
- `state.go:35–89`: newUpdate -> getTarget loads the snapshot/tags. Checkpoint
  persistence (`143–215`) and history persistence (`450–484`) are not this path.
- `lock.go:103–125`: Lock writes a lock object, but ordinary Preview does not call it.

Parent must confirm existing initialized metadata and project-scoped dev layout
before enabling CI. Policies scope the canonical bucket declared in Pulumi.yaml:
metadata plus prestashop/dev checkpoint/history/backup/lock paths. Bucket listing
is allowed for Pulumi discovery (names only); object reads exclude other stacks.
Neither role can initialize missing metadata, migrate state, or manage the bucket.
Parent-relayed Docker 4.10.0 evidence: image.ts:184 defaults buildOnPreview=false;
provider.go:367–379,444–457,766–768 and image.go:308–321 skip preview build/push.
This does not prove every plugin/version variant read-only or runtime completeness.
No real preview/up, provider call, policy simulation, or OIDC execution was run.
Service-linked roles and AWS-managed service dependencies must already exist;
this baseline cannot create them. labMode=false changes require another review.

## Local runcheck

```text
python -B -m unittest discover -s infra/ci/iam/tests -p "test_*.py"
python -B infra/ci/iam/bootstrap.py --help
```

Tests use public CLI subprocesses with `tests/fake_aws.py`, native argv, and fresh
system temporary directories removed by teardown. Rejected preflights assert
exact exit/stdout/stderr, unchanged fixture bytes/mutation counters, and no journal.
No real AWS/GitHub executable or credential/config/secret files are used.

The S7 simplification changes only CLI optionality, IAM conditions, regression
checks and these instructions; existing SAR evidence/mappings are retained rather
than regenerated or minified. Exact pre-simplification bytes and SHA256 manifest
are preserved in ignored `.evidence/pre-simplification/` (no credentials/config).

Original-unit review slicing proposal (>400 authored lines, no commits made): policy data,
renderer and policy/input tests with these usage/provenance sections; then guarded
bootstrap, fake transport, ownership/journal tests and apply/recovery sections.
Keep tests/docs with each behavior; machine-extracted SAR data is separately reviewable.
