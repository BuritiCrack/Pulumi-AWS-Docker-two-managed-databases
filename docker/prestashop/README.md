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

Redis requires `REDIS_HOST` and `REDIS_AUTH`; `REDIS_PREFIX` isolates cache keys.
TLS verifies certificates/hostnames. `REDIS_CA_FILE` may select a private test CA;
otherwise the system CA bundle is used. No plaintext fallback is implemented.
The health endpoint uses trusted `PS_DOMAIN` instead of incoming Host headers before
full application bootstrap, a MySQL query and a Redis cache write/read.

Tests in `tests/cache.php` use the real pinned CacheCore with a fake transport;
`tests/health-context.php` covers the trusted domain boundary. `tests/smoke.sh`
checks the installed shop against synthetic local MySQL/Redis TLS fixtures, without
host ports. Run that smoke only with an explicit bounded runtime:

```sh
timeout 600 sh docker/prestashop/tests/smoke.sh
```

The smoke removes only its own unique Compose project containers, volumes and network.
See the repository README for AWS costs, lab limitations and verification evidence.
