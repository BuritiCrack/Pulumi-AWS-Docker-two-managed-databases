# PrestaShop image and Redis integration

This lab image pins PrestaShop 8.2.1 by digest and installs phpredis 6.1.0.
Build from the repository root:

```sh
docker build -t prestashop-lab:test docker/prestashop
```

The official image initializes the shop using its `DB_*`, `ADMIN_*`, `PS_DOMAIN`
and `PS_INSTALL_AUTO` environment variables. Never enable `PS_ERASE_DB` on stored data.
The init hook installs `CacheRedis` and the health endpoint on every start, including
when `/var/www/html` is persisted. It does not upgrade persisted PrestaShop core files.

EFS still persists the whole `/var/www/html` root. Only `/var/www/html/var/cache`
is overlaid with a writable task-local volume in ECS; it is regenerable and lost
when the task is replaced. This is Symfony filesystem cache, not the Redis adapter.
The Dockerfile prepares `dev`/`prod` directories as `www-data:www-data` (0775) and
marks the matching path as `VOLUME` for image-data hydration before the inherited
entrypoint runs. No entrypoint, runtime user or installer flags are overridden.

Redis requires `REDIS_HOST` and `REDIS_AUTH`; `REDIS_PREFIX` isolates cache keys.
TLS verifies certificates/hostnames. `REDIS_CA_FILE` may select a private test CA;
otherwise the system CA bundle is used. No plaintext fallback is implemented.
The health endpoint uses trusted `PS_DOMAIN` instead of incoming Host headers before
full application bootstrap, a MySQL query and a Redis cache write/read.

Tests in `tests/cache.php` use the real pinned CacheCore with a fake transport;
`tests/health-context.php` covers the trusted domain boundary. `tests/smoke.sh`
checks the installed shop against synthetic local MySQL/Redis TLS fixtures, without
host ports. First it overrides the entrypoint only for a `www-data` precheck on fresh
root/cache volumes: distinct mounts, local cache, baked ownership/modes and file
write/read/removal before installation. Then the normal inherited entrypoint must
complete installation on those same volumes and pass the existing health/cache tests.
Run that smoke only with an explicit bounded runtime:

```sh
timeout 600 sh docker/prestashop/tests/smoke.sh
```

The smoke removes only its own unique Compose project containers, volumes and network,
including the disposable cache volume. It disables MSYS path conversion for Git Bash;
no host directories are bind-mounted.

**Pending verification:** Docker is currently unavailable. The new image and fresh
root/cache hydration smoke have not run. In particular, the baked cache skeleton
must not prevent upstream first-install detection. Passing Pulumi mocks does not
prove Docker/ECS hydration, NFS behavior, installation success or the failure cause.
Rebuild and pass the full smoke before any separately authorized deployment.
See the repository README for AWS costs, lab limitations and verification evidence.
