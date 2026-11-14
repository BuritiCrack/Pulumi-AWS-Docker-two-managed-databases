<?php
// Readiness checks the installed application's public DB/cache interfaces, not just Apache.
try {
    if (!is_file(__DIR__ . '/app/config/parameters.php') || is_file(__DIR__ . '/install.lock')) {
        throw new RuntimeException('Not installed');
    }
    require __DIR__ . '/health-context.php';
    configureHealthContext(getenv('PS_DOMAIN') ?: '');
    require __DIR__ . '/config/config.inc.php';
    if (!Db::getInstance()->getValue('SELECT 1')) { throw new RuntimeException('Database unavailable'); }
    $cache = Cache::getInstance();
    if (!$cache || !$cache->set('readiness', 'ok', 30) || $cache->get('readiness') !== 'ok') {
        throw new RuntimeException('Cache unavailable');
    }
    header('Content-Type: text/plain');
    echo "ok\n";
} catch (Throwable $error) {
    http_response_code(503);
    echo "not ready\n";
}
