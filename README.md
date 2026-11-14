# Modular PrestaShop on AWS

Pulumi TypeScript components provision a temporary Docker-based PrestaShop shop,
RDS MySQL and ElastiCache Redis OSS. **No AWS deployment has been executed.**

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
timeout 300 sh docker/prestashop/tests/smoke.sh
```

It creates synthetic MySQL/Redis/PrestaShop containers without host ports and removes
its own containers/volumes on exit. It requires the built image plus Docker Compose;
fixture images are `mysql:8.0` and `redis:7.2-alpine`. Never point it at existing data.

The local SDK is pinned to 3.276.0; this does not upgrade your global CLI 3.212.0.
AWS and Docker provider versions are pinned separately. The original SDK pin was
updated after npm audit found vulnerabilities; the updated production dependency
audit reports zero. Mock tests validate the resource graph, not AWS availability.

## Configure before a future deployment

These are instructions, not commands executed by this implementation.

```powershell
$env:AWS_PROFILE = "pulumi-prestashop"
cd infra
pulumi login
pulumi stack init dev
pulumi config set aws:profile pulumi-prestashop
pulumi config set aws:region us-east-1
pulumi config set labMode true
pulumi config set adminEmail your-email@example.com
pulumi config set --path 'allowedCidrs[0]' 'YOUR_PUBLIC_IPV4/32'
pulumi config set --secret dbPassword
pulumi config set --secret redisToken
pulumi config set --secret adminPassword
pulumi preview
```

Secret commands prompt for their values, keeping them out of shell history.
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
review and local work-unit finalization are separate. No AWS deployment or runtime
AWS verification has been performed.

EFS persists `/var/www/html`. One task runs at a time, including deployments
(maximum 100%, minimum healthy 0%); updates intentionally have downtime to avoid
concurrent installers. This does not prove application-level SQL-cache correctness
under production traffic. Keep the pinned image until upgrades are tested; persisting
all application files means changing the image does not automatically upgrade PrestaShop.
The init hook refreshes only the custom adapter and health endpoint.

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

## Cleanup after an authorized deployment

```powershell
cd infra
pulumi destroy
# Only after successful destruction:
pulumi stack rm dev
```

Destroy permanently deletes lab data and may require explicit confirmation.
Do not delete the IAM user or stack state before destroying resources.
Verify resource removal and billing in AWS afterward; stopping a task alone does not stop all charges.
No destroy, push, PR creation, or deployment is performed automatically.
