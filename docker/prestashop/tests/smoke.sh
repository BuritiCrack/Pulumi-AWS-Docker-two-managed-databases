#!/bin/sh
set -eu
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME="prestashop-smoke-$$"
# Keep Git Bash from rewriting container paths passed to Docker on Windows.
export MSYS_NO_PATHCONV=1
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then docker compose -f compose.yaml logs --tail 35 shop redis mysql; fi
  docker compose -f compose.yaml down --volumes --remove-orphans >/dev/null
  exit "$status"
}
trap cleanup EXIT INT TERM
# Hydrate fresh project volumes without invoking the installer or its root chown.
# The normal service below reuses these exact volumes and the inherited entrypoint.
docker compose -f compose.yaml run --rm --no-deps --user www-data --entrypoint php shop -r '
function check($condition, $message) {
    if (!$condition) { fwrite(STDERR, "FAIL: $message\n"); exit(1); }
}
$root = "/var/www/html";
$cache = "$root/var/cache";
$mounts = [];
foreach (file("/proc/self/mountinfo", FILE_IGNORE_NEW_LINES) as $line) {
    [$mount, $filesystem] = explode(" - ", $line, 2);
    $fields = explode(" ", $mount);
    $mounts[$fields[4]] = [$fields[0], explode(" ", $filesystem)[0]];
}
check(isset($mounts[$root], $mounts[$cache]), "root and cache must be explicit mounts");
check($mounts[$root][0] !== $mounts[$cache][0], "cache must have its own mount");
check(!in_array($mounts[$cache][1], ["nfs", "nfs4"], true), "cache must be local, not NFS");
check(!file_exists("$root/app/config/parameters.php"), "fixture must be uninstalled");
foreach ([$cache, "$cache/dev", "$cache/prod"] as $directory) {
    check(is_dir($directory), "missing baked cache directory: $directory");
    check(fileowner($directory) === 33 && filegroup($directory) === 33,
        "cache ownership must be www-data: $directory");
    check((fileperms($directory) & 0777) === 0775, "cache mode must be 0775: $directory");
    $probe = "$directory/.smoke-write";
    check(file_put_contents($probe, "cache-probe") === 11, "www-data must write: $directory");
    check(file_get_contents($probe) === "cache-probe", "www-data must read: $directory");
    check(unlink($probe), "www-data must remove its probe: $directory");
}
echo "PASS: fresh local cache mount writable as www-data before installer\n";
'
docker compose -f compose.yaml up -d shop
# The caller bounds the entire smoke run to 600 seconds, including cleanup.
until docker compose -f compose.yaml exec -T shop php -r '
$body = @file_get_contents("http://localhost/health.php");
if ($body !== "ok\n") { exit(1); }
echo "PASS: installed PrestaShop health checks MySQL and Redis TLS/AUTH\n";
' 2>/dev/null; do sleep 3; done
docker compose -f compose.yaml exec -T shop php -r '
require "/var/www/html/config/config.inc.php";
if (_PS_CACHING_SYSTEM_ !== "CacheRedis" || !_PS_CACHE_ENABLED_) { exit(1); }
$c = Cache::getInstance();
$c->set("smoke:product", ["name" => "example"], 30);
if ($c->get("smoke:product") !== ["name" => "example"]) { exit(1); }
$c->delete("smoke:*");
if ($c->exists("smoke:product")) { exit(1); }
echo "PASS: real PrestaShop Cache API round trip and wildcard invalidation\n";
'
