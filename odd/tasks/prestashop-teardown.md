# PrestaShop dev teardown
Objective: destroy only the authorized dev infrastructure and data; preserve code/local state/key.
Checks: inspect native destroy preview, execute parent-only destroy, verify remaining state and scoped AWS absence.

## Specs
S1. "baja la infra"
S2. "Eliminar todo, incluidos los datos" — selected without creating new backups; preserve code and local state.
S3. "Si, eliminala"

## Tasks
T1 | S1-S3 | parent + read-only explorer: inventory/identity/native destroy preview | done | evidence:job1 preview0,54 planned deletes,55 checkpoint records/0 pending
T2 | S1-S3 | parent only: native destroy | done | evidence:job6 destroy0,36 remaining deleted after original18
T3 | S1-S3 | parent: verify state/scoped AWS absence and report | done | evidence:job7 PASS0,0 checkpoint records/managed resources/pending;13 scoped AWS checks

## Log
L1. Original request: "baja la infra".
L2. Human explicitly selected "Eliminar todo, incluidos los datos", no new backups, then "Si, eliminala". This supersedes pause only for teardown. Do not remove stack/config/key/code or unrelated resources. Current unrelated infra/tsconfig.json and .vscode edits preserved.
L3. Local checkpoint55 resources/0 pending. Source explorer confirms lab protections conditional; verify deployed metadata. CLI3.212 destroy supports --preview-only/--yes but NO --plan; use native preview then destroy retaining its own preview (no --skip-preview/--remove/--run-program). Existing create/update saved plans are NOT destroy authorization and will not be replayed. No global upgrades or new native RDD. Route: parent-only destructive operation explicitly authorized; configured explorer read-only due context backstop. No production source changes or new feature commits.
L4. Job1 preview PASS0 in1m10s:55 checkpoint records/0 pending, identity matches resource account/region, no protect flags, RDS skipFinalSnapshot true/deletionProtection false, ALB protection false,ECR forceDelete true. Full native preview inspected:54 planned deletions, all dev; provider/component counts differ from cloud-resource count. No --remove/--run-program/skip-preview. Execute authorized native destroy, rechecking frozen inventory before it; no additional human consent needed.
L5. First destroy job2 FAILED1 after9m24s:18 deleted, Docker provider Configure cannot connect daemon; no other blocker. RDS/Redis/service/ALB/mount targets removed per native output. Checkpoint37 records/0 pending. Do not delete state or bypass provider. Job3 opens existing Docker Desktop normally/waits180s; no install/settings/restart/permission bypass. Resume guard preserves original inventory, accepts ONLY remaining subset with exact original URN/type/id, no new/protected resources, validates same account/region and freezes new remaining-scope hash before fresh native preview. No original scope/authorization expansion or new backups. Resume destroy only after daemon ready and current preview inspected.
L6. Job3 returned0 but NOT readiness: docker info reported missing docker_engine pipe and empty ServerVersion despite zero exit. No resume based on false positive. Job4 now validates docker version server JSON/nonempty Version for <=120s, command-scoped wait only, no settings changes. Docker Desktop was already open; no forced restart/update. If engine remains unavailable, human must start its engine; do not delete Docker resource from state or bypass dependency. Current cloud deletes remain18, checkpoint37/0 pending.
L7. Docker readiness job4 PASS0 actual server23.0.5. Resume preview job5 PASS0 in43s:37 remaining checkpoint records/0 pending,36 planned deletes; subset URN/type/id matches original frozen inventory, account/region validated. Full preview inspected; no new scope/protection bypass. Parent resumes native destroy with unchanged current-scope hash, own native preview retained. Prior daemon failure preserved, no state removal.
L8. Resume destroy job6 PASSED0 in1m4s (native21s):36 remaining deleted; native confirms resources removed, history/config kept. No stack rm/remove, state bypass or new backups. Now read-only checkpoint/pending and scoped AWS verification against original inventory; no account-wide delete/search. Unrelated tsconfig/editor edits preserved.
L9. Job7 verification PASSED0 in24s: checkpoint0 records,0 managed resources,0 pending; config/DPAPI key retained. Scoped original-ID checks: VPC,RDS,Redis,EFS,ECR,ALB,CloudWatch group,3Secrets and2IAM roles absent; ECS cluster INACTIVE (retained service metadata, not running cluster). No new backups made. Scope limited to managed dev resources, not whole account or unrelated resources; historical billing may remain visible. Teardown complete, original live-health follow-up retired by explicit deletion, not marked PASS.
