<?php
$root = '/var/www/html';
$file = $root . '/app/config/parameters.php';
if (!is_file($file)) { throw new RuntimeException('PrestaShop installation is incomplete'); }
$config = require $file;
$config['parameters']['ps_caching'] = 'CacheRedis';
$config['parameters']['ps_cache_enable'] = true;
// Refresh the adapter even when EFS already contains the application.
copy('/opt/prestashop/CacheRedis.php', $root . '/classes/cache/CacheRedis.php');
file_put_contents($file, '<?php return ' . var_export($config, true) . ';' . PHP_EOL, LOCK_EX);
foreach (['prod', 'dev'] as $environment) {
    foreach (['class_index.php', 'appParameters.php'] as $cache) {
        $path = $root . '/var/cache/' . $environment . '/' . $cache;
        if (is_file($path) && !unlink($path)) { throw new RuntimeException('Cannot refresh bootstrap cache'); }
    }
}
copy('/opt/prestashop/health-context.php', $root . '/health-context.php');
copy('/opt/prestashop/health.php', $root . '/health.php');
