<?php
// Exercise the public cache interface against the real pinned PrestaShop CacheCore.
require '/tmp/data-ps/prestashop/classes/cache/Cache.php';
abstract class Cache extends CacheCore {}
class Redis {
    const OPT_SERIALIZER = 1;
    const SERIALIZER_PHP = 1;
    public static array $data = [];
    public static array $connection = [];
    public static bool $rejectAuth = false;
    public function connect(...$args) { self::$connection = $args; return true; }
    public function auth($token) { return !self::$rejectAuth && $token === 'test-token'; }
    public function setOption($key, $value) { return true; }
    public function setex($key, $ttl, $value) { self::$data[$key] = $value; return true; }
    public function get($key) { return self::$data[$key] ?? false; }
    public function exists($key) { return array_key_exists($key, self::$data) ? 1 : 0; }
    public function del($key) { unset(self::$data[$key]); return 1; }
    public function scan(&$cursor, $pattern, $count) {
        $cursor = 0;
        return array_values(array_filter(array_keys(self::$data), fn($key) => str_starts_with($key, 'test:')));
    }
}
function check($condition, $message) {
    if (!$condition) { throw new RuntimeException($message); }
}
putenv('REDIS_HOST=redis.example.test');
putenv('REDIS_AUTH=test-token');
putenv('REDIS_PREFIX=test:');
require dirname(__DIR__) . '/CacheRedis.php';
$cache = new CacheRedisCore();
check(Redis::$connection[0] === 'tls://redis.example.test', 'TLS transport required');
check(Redis::$connection[6]['stream']['verify_peer'] === true, 'Verify certificate');
check(Redis::$connection[6]['stream']['verify_peer_name'] === true, 'Verify hostname');
check($cache->get('missing') === false, 'Miss returns false');
check($cache->set('product:1', ['name' => 'A'], 30), 'Set succeeds');
check($cache->get('product:1') === ['name' => 'A'], 'Values round trip');
check($cache->exists('product:1'), 'Exists');
$cache->set('product:2', false);
$cache->set('cart:1', 'keep');
$cache->delete('product:*');
check(!$cache->exists('product:1') && !$cache->exists('product:2'), 'Wildcard invalidation');
check($cache->get('cart:1') === 'keep', 'Unrelated key preserved');
Redis::$data['another-shop:key'] = 'preserve';
$cache->flush();
check(!$cache->exists('cart:1'), 'Namespace flush');
check(Redis::$data['another-shop:key'] === 'preserve', 'Other namespace preserved');
Redis::$rejectAuth = true;
try { new CacheRedisCore(); throw new LogicException('Authentication rejection ignored'); }
catch (RuntimeException $error) { check(str_contains($error->getMessage(), 'authentication'), 'Authentication failure is explicit'); }
check(Redis::$data === ['another-shop:key' => 'preserve'], 'Failed auth leaves data unchanged');
echo "PASS: cache round trip, invalidation, namespace isolation, TLS options, authentication rejection\n";
