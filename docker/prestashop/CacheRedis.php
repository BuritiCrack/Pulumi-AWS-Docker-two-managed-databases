<?php
/** Redis adapter for the pinned PrestaShop 8.2 Cache interface. */
class CacheRedisCore extends Cache
{
    private Redis $redis;
    private string $prefix;

    public function __construct()
    {
        $host = getenv('REDIS_HOST');
        $token = getenv('REDIS_AUTH');
        if (!$host || !$token) {
            throw new RuntimeException('Redis host and authentication are required');
        }
        $this->prefix = getenv('REDIS_PREFIX') ?: 'prestashop:';
        $this->redis = new Redis();
        $connected = $this->redis->connect('tls://' . $host, 6379, 2.0, null, 0, 2.0, [
            'stream' => [
                'verify_peer' => true, 'verify_peer_name' => true,
                'cafile' => getenv('REDIS_CA_FILE') ?: '/etc/ssl/certs/ca-certificates.crt',
            ],
        ]);
        if (!$connected || !$this->redis->auth($token)) {
            throw new RuntimeException('Redis authentication failed');
        }
        $this->redis->setOption(Redis::OPT_SERIALIZER, Redis::SERIALIZER_PHP);
    }

    protected function _set($key, $value, $ttl = 0)
    {
        // Bound retention even when the legacy cache API requests no expiry.
        return $this->redis->setex($this->prefix . $key, $ttl > 0 ? $ttl : 300, $value);
    }
    protected function _get($key) { return $this->redis->get($this->prefix . $key); }
    protected function _exists($key) { return (bool) $this->redis->exists($this->prefix . $key); }
    protected function _delete($key) { $this->redis->del($this->prefix . $key); return true; }
    protected function _writeKeys() { /* Redis owns the key index, not a per-request PHP array. */ }
    public function set($key, $value, $ttl = 0) { return $this->_set($key, $value, $ttl); }
    public function get($key) { return $this->_get($key); }
    public function exists($key) { return $this->_exists($key); }

    public function delete($key)
    {
        if (strpos($key, '*') === false) { return $this->_delete($key); }
        $pattern = '~^' . str_replace('\\*', '.*', preg_quote($key, '~')) . '$~';
        $cursor = null;
        do {
            $keys = $this->redis->scan($cursor, $this->prefix . '*', 100);
            foreach ($keys ?: [] as $storedKey) {
                if (preg_match($pattern, substr($storedKey, strlen($this->prefix)))) {
                    $this->redis->del($storedKey);
                }
            }
        } while ($cursor !== 0);
        return true;
    }
    public function flush() { return $this->delete('*'); }
}
