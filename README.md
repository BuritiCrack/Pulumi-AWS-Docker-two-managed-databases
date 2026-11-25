# Modular PrestaShop on AWS

Pulumi TypeScript components provision a temporary Docker-based PrestaShop shop,
RDS MySQL and ElastiCache Redis OSS. **The migrated `dev` stack is intentionally empty;
no application is currently deployed and live readiness is not verified.**

## Components

```text
infra/index.ts                # Composition only
infra/config.ts               # Validated stack inputs and secrets
infra/components/network.ts   # VPC, public compute / isolated data subnets
infra/components/database.ts  # RDS MySQL and password secret
infra/components/cache.ts     # Redis OSS with TLS/AUTH and token secret
infra/components/image.ts     # ECR and pinned custom Docker image
infra/components/storefront.ts# Fargate, ALB, EFS, IAM and logs
infra/tests/                  # Pulumi mocks: no AWS calls
docker/prestashop/             # Redis integration and image bootstrap
```

Every block extends `ComponentResource`, parents its resources, accepts resource
options and registers typed outputs. See [component contracts](infra/components/README.md).
The design follows [Pulumi components](https://www.pulumi.com/docs/iac/guides/building-extending/components/build-a-component/),
consulted through Context7 `/websites/pulumi`.

## Local checks — no cloud resources

Requirements: Pulumi CLI 3.212.0, Node.js 22+, npm, Docker running Linux containers.

```powershell
cd infra
npm ci
npm run typecheck
npm test
cd ..
docker build -t prestashop-lab:test docker/prestashop
```

From Git Bash/WSL, an optional isolated installed-shop smoke test is:

```bash
timeout 600 sh docker/prestashop/tests/smoke.sh
```

It creates synthetic MySQL/Redis/PrestaShop containers without host ports and removes
its own containers/volumes on exit. It requires the built image plus Docker Compose;
fixture images are `mysql:8.0` and `redis:7.2-alpine`. Never point it at existing data.

The local SDK is pinned to 3.276.0; this does not upgrade your global CLI 3.212.0.
AWS and Docker provider versions are pinned separately. The original SDK pin was
updated after npm audit found vulnerabilities; the updated production dependency
audit reports zero. Mock tests validate the resource graph, not AWS availability.

## Configuration and S3 deployment state

`infra/Pulumi.yaml` selects the canonical backend
`s3://prestashop-pulumi-state-e16207d96f49-us-east-1` for the existing `dev` stack,
not Pulumi Cloud. The migration preserved encrypted state and the original secret
provider; it did not deploy the shop. The private, versioned, AES256-encrypted,
TLS-only bucket was bootstrapped separately, outside the application's `dev` resource
graph, and persists through shop destruction. S3 server-side encryption does **not**
replace Pulumi's existing passphrase encryption.

From a Windows PowerShell console, enter `infra` and use process-scoped settings:

```powershell
cd infra
$env:AWS_PROFILE = 'pulumi-prestashop'
$env:AWS_REGION = 'us-east-1'
Remove-Item Env:PULUMI_BACKEND_URL -ErrorAction SilentlyContinue
pulumi stack ls
if ($LASTEXITCODE -ne 0) { throw 'Pulumi stack listing failed' }
pulumi stack --stack dev
if ($LASTEXITCODE -ne 0) { throw 'Pulumi stack inspection failed' }
```

Removing the stale environment override lets the project backend take effect; do not
use a global login or put credentials/profile parameters in the committed URL.
Stack listing is read-only and does not require secret decryption. Commands that
need encrypted configuration may prompt for the **original** Pulumi passphrase;
that prompt is not a request to create new credentials. Never print passphrases or
application passwords. Do not initialize, import, reconfigure or regenerate secrets
for this existing `dev` stack.

The original passphrase remains protected with Windows user-scoped DPAPI in
`infra/.pulumi-artifacts/state-passphrase.dpapi`; it and the real
`infra/Pulumi.dev.yaml` remain local/ignored. Preserve them. DPAPI requires the same
Windows user context; arrange secure passphrase recovery before removing that account.
The old `infra/.pulumi-artifacts/state`, its history, local encrypted export and
backups are retained **only as recovery snapshots**, not a parallel writable backend.
Recovery is a separately reviewed operation; do not point routine commands at them
or automatically remove them.

**Do not use the ignored `deploy-local.ps1` or `teardown-local.ps1` as normal
operators after migration.** They hardcode the old local `PULUMI_BACKEND_URL` and
target the stale snapshot, not the canonical S3 stack. They are preserved as
historical/local recovery material, not portable clone setup.

A fresh checkout uses the same project backend with authorized AWS access, but does
not contain the original local stack configuration or DPAPI recovery material.
Recover those securely before operations requiring them; do not create a replacement
`dev` stack or new secrets. `infra/Pulumi.dev.example.yaml` is an example only.
Backend selection alone does not configure GitHub secrets/configuration or OIDC;
CI integration remains future scope and is not verified.

For a separately authorized new stack, configuration constraints remain:
Database passwords: 16–41 letters/digits or `!#$%^&*_-`.
Redis tokens: 16–128 letters/digits or `!&#$^<>-`.
Administrator password: at least 12 characters.
Only IPv4 client CIDRs are accepted; unrestricted `0.0.0.0/0` is rejected.
An example configuration is in `infra/Pulumi.dev.example.yaml`.

`preview` reads AWS metadata and may download plugins; it does not validate a running shop.
A later, separately authorized `pulumi up` will build/push the image and create billable resources.
Shop and Back Office URLs are stack outputs. Installation may take several minutes.

## Redis integration and persistence

The custom adapter implements the real PrestaShop 8.2 Cache interface, rather than
merely setting unused Redis environment variables. The image pins PrestaShop 8.2.1
by digest and installs phpredis 6.1.0. The upstream init hook copies the adapter into
`classes/cache/CacheRedis.php` and sets `ps_caching=CacheRedis` and
`ps_cache_enable=true` in the installed application's parameters.

Connections require TLS, certificate/hostname verification and Redis AUTH.
Keys are namespaced; wildcard deletion and flush do not delete other shops' keys.
Entries expire after 300 seconds unless an explicit positive TTL is supplied.
Connection errors fail explicitly; there is no silent plaintext fallback.
The public `/health.php` checks the installed database and a cache write/read.
Before bootstrapping PrestaShop, readiness sets its internal shop context from trusted
`PS_DOMAIN`, not the incoming Host/forwarded Host. This avoids canonical-domain
redirects for localhost and ALB private-IP probes; the check still requires HTTP200
and the exact `ok` body. A redirect is never accepted as readiness.

Verification status: the earlier smoke timed out on HTTP302 before the health-context
correction. The corrected image's newly authorized 600-second smoke passed in 7m55s:
installed-shop health, MySQL access, Redis TLS/AUTH, and the real PrestaShop Cache API
round trip/wildcard invalidation. All synthetic containers, volumes and network were
removed. The targeted context test, PHP syntax checks and image build also pass.
Independent code verification passed in the separately authorized serial attempt:
5/5 existing TypeScript tests, typecheck, shell/Compose validation and both PHP tests.
Static inspection found no concrete code/security blocker. The prior path/setup and
Node memory failures remain recorded; serial execution required no system-memory changes.
An external `.vscode/settings.json` selects the local TypeScript SDK; its origin is
unknown and it is preserved outside the implementation/proof/review scope. Native
review and local work-unit finalization are separate. The later RDS naming correction
also passed independent verification: 6/6 serial tests and typecheck. AWS deployment
was partial at that historical checkpoint; the shop has since been torn down and
`dev` migrated empty. Live AWS runtime verification remains pending.

EFS persists `/var/www/html`, with only `/var/www/html/var/cache` overlaid by a
writable task-local volume. Symfony filesystem cache is disposable on task replacement;
Redis application caching and all other shop persistence remain unchanged. The image
prepares cache ownership for `www-data` before the inherited installer runs.

This cache isolation change is source-only so far: Docker is unavailable, so the new
image build and fresh-volume installation smoke are **pending**, not covered by the
historical smoke results above. The smoke now checks separate root/cache mounts and
cache writeability as `www-data` before running the normal installer and exact existing
health/cache tests. Fresh-root hydration (including upstream first-install detection)
must pass before deployment; this does not yet establish an EFS-related failure cause.
See [image and smoke details](docker/prestashop/README.md).

One task runs at a time, including deployments
(maximum 100%, minimum healthy 0%); updates intentionally have downtime to avoid
concurrent installers. This does not prove application-level SQL-cache correctness
under production traffic. Keep the pinned image until upgrades are tested; persisting
all application files means changing the image does not automatically upgrade PrestaShop.
The init hook refreshes only the custom adapter and health endpoint.

## Strict-plan deployment recovery

This is historical deployment context, not a pending partial deployment to resume.
For any future authorized deployment, use the canonical S3 setup above and a fresh
plan; do not resume from the retained local snapshot or old plan artifacts.

The deployment keeps `--plan` enforcement. After initial partial updates, resource
state is retained and a fresh preview is inspected before continuing. The stack
passes a stable RDS identifier through the optional `DatabaseArgs.identifier` input;
provider naming remains unchanged for other callers that omit it. This avoids
relying on generated identifiers for this new database. No database existed when
this correction was made; never rename an existing database without reviewing its
replacement/data consequences. Provider v7.24.0 predates the RDS autonaming change
in [pulumi-aws PR 6437](https://github.com/pulumi/pulumi-aws/pull/6437); the exact
cause of the observed plan discrepancy is not established by that PR alone.

## Runtime ECR authentication

The image no longer places short-lived ECR credentials in Pulumi inputs. The last
strict-plan failure differed at `registry.password`; no build/push success was proven.
Docker provider v4.10.0 reads runtime credentials for the qualified image hostname
when `registry` is omitted. This source fix is locally tested, not proof of a
successful saved-plan apply or live shop readiness. Create and inspect a fresh plan;
never apply the old token-bearing plan or drop `--plan` enforcement.

The tracked `infra/scripts/ecr-auth.ps1` runtime helper remains valid with the
canonical S3 backend. The ignored `deploy-local.ps1` wrapper is **not** the operator
path: it hardcodes the stale local backend. Preserve it, but do not run it for S3.
The invocation below checks for `docker-credential-ecr-login.exe` on PATH and uses
the existing AWS MSI CLI to resolve the registry through STS and the configured
profile/region. The tracked helper receives that registry and scopes Docker's runtime
credential-helper configuration; it does not perform those prerequisite checks itself.
There is no login-token fallback or install. A clone gets this helper, not the local
operator/state setup.

For a separately authorized future preview/up, first use the console setup above
(including removing `PULUMI_BACKEND_URL`) and unlock with the original passphrase
when required. From `infra`, preserve strict `--save-plan`/`--plan` enforcement:

```powershell
. ./scripts/ecr-auth.ps1
if (-not (Get-Command docker-credential-ecr-login.exe -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Required docker-credential-ecr-login.exe is unavailable on PATH'
}
$aws = Join-Path $env:ProgramFiles 'Amazon/AWSCLIV2/aws.exe'
$account = & $aws sts get-caller-identity --query Account --output text
if ($LASTEXITCODE -ne 0) { throw 'AWS identity lookup failed' }
if ($account -isnot [string] -or $account -notmatch '^\d{12}$' -or $env:AWS_REGION -notmatch '^[a-z]{2}-[a-z]+-\d+$') {
    throw 'AWS identity or region metadata is invalid'
}
$registry = "$account.dkr.ecr.$($env:AWS_REGION).amazonaws.com"
Invoke-EcrAuthScope -Registry $registry -Command {
    pulumi preview --stack dev --save-plan .pulumi-artifacts/plan.json
    if ($LASTEXITCODE -ne 0) { throw 'Pulumi preview failed' }
}
# After inspecting that fresh plan, use the same scope for:
# pulumi up --stack dev --plan .pulumi-artifacts/plan.json
# Check $LASTEXITCODE inside the scriptblock and throw on failure, as above.
```

The temporary Docker config contains only a per-registry `credHelpers` entry, not
`auths` or a copied home config. `AWS_ECR_DISABLE_CACHE=true` prevents token disk
caching; `AWS_ECR_CACHE_DIR` isolates helper cache/logs too. These variables and
`DOCKER_CONFIG` are restored even on failure, and only the fresh owned directory is
removed. Existing Docker context/host and AWS profile/region are untouched. The
helper does not unlock Pulumi or configure AWS for a regular CLI caller.

Deterministic helper checks (no AWS, Docker login or credential-helper calls):
`powershell.exe -NoProfile -File infra/tests/ecr-auth.test.ps1`.

## Costs and safety

**This is an HTTP-only lab, not a production shop.** Do not use real customer data,
payments, or reused passwords. Access is limited to your configured client CIDRs,
but HTTP does not encrypt browser traffic. MySQL traffic is private, not explicitly
TLS-enforced by this application configuration; Redis and EFS use TLS.

- Fargate tasks use public IPs to avoid NAT charges; only the ALB may reach task port 80.
- RDS/Redis/EFS are reachable only from the application security group on their specific ports.
- RDS master credentials are used by the lab application; production needs a separate least-privilege SQL user.
- EFS IAM permissions are scoped to the filesystem/access point. Initialization requires root access there.
- Lab mode disables deletion protection, DB backups and final snapshots; ECR images and secrets are disposable.
- `labMode=false` enables some retention/HA guards, **not production readiness**. Inspect costs and final snapshot naming before reusing it.
- RDS, ElastiCache, Fargate, EFS, ALB, public IPv4, logs, storage and transfer can incur charges. No free-tier guarantee.
- The persistent S3 backend incurs storage, request and retained-version charges even
  with an empty shop stack. Optional access logging, CloudTrail data events and metrics
  require separate future scope/cost review; they are not enabled by this change.

## Cleanup after an authorized deployment

The current S3 `dev` stack is empty; no shop cleanup is needed now. After a future
separately authorized deployment, use native CLI against the canonical backend,
**not** `teardown-local.ps1` or the retained local snapshot:

```powershell
cd infra
$env:AWS_PROFILE = 'pulumi-prestashop'
$env:AWS_REGION = 'us-east-1'
Remove-Item Env:PULUMI_BACKEND_URL -ErrorAction SilentlyContinue
pulumi stack ls
if ($LASTEXITCODE -ne 0) { throw 'Pulumi stack listing failed' }
pulumi stack --stack dev
if ($LASTEXITCODE -ne 0) { throw 'Pulumi stack inspection failed' }
# Confirm the intended stack/backend before proceeding; use the original passphrase if prompted.
pulumi destroy --stack dev
if ($LASTEXITCODE -ne 0) { throw 'Pulumi destroy failed' }
```

Destroy permanently deletes lab data and may require explicit confirmation.
Keep the stack record, S3 backend bucket, retained versions, local source history,
encrypted exports/backups, configuration and DPAPI recovery material; they are not
automatically removed. Do not delete the IAM user or stack state before destroying
resources. Verify resource removal and billing in AWS afterward; stopping a task
alone does not stop all charges. No destroy, stack removal, bucket deletion, push,
PR creation or deployment is performed automatically.
