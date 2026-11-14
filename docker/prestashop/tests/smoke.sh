#!/bin/sh
set -eu
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME="prestashop-smoke-$$"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then docker compose -f compose.yaml logs --tail 35 shop redis mysql; fi
  docker compose -f compose.yaml down --volumes --remove-orphans >/dev/null
  exit "$status"
}
trap cleanup EXIT INT TERM
docker compose -f compose.yaml up -d shop
# The caller bounds the entire smoke run to five minutes, including cleanup.
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
