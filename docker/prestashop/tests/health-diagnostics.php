<?php
// Exercise the actual endpoint in isolated subprocesses, never the installed shop.
$root = sys_get_temp_dir() . '/health-diagnostics-' . bin2hex(random_bytes(8));
mkdir($root . '/app/config', 0700, true);
mkdir($root . '/config', 0700, true);
copy(dirname(__DIR__) . '/health.php', $root . '/health.php');
copy(dirname(__DIR__) . '/health-context.php', $root . '/health-context.php');
$bootstrap = <<<'PHP'
<?php
function recordCall($value) { file_put_contents(__DIR__ . '/../calls', $value . "\n", FILE_APPEND); }
recordCall('bootstrap');
if (getenv('CASE_MODE') === 'bootstrap') { throw new RuntimeException('SECRET_CANARY bootstrap'); }
if ($_SERVER['HTTP_HOST'] !== 'DOMAIN_CANARY.example' ||
    $_SERVER['SERVER_NAME'] !== 'DOMAIN_CANARY.example' || isset($_SERVER['HTTP_X_FORWARDED_HOST'])) {
    throw new RuntimeException('HOST_CANARY unexpected context');
}
class Db {
    static function getInstance() { return new self(); }
    function getValue($sql) {
        recordCall('database');
        if ($sql !== 'SELECT 1') { throw new RuntimeException('SECRET_CANARY wrong SQL'); }
        if (getenv('CASE_MODE') === 'database-throw') { throw new RuntimeException('SECRET_CANARY database'); }
        return getenv('CASE_MODE') !== 'database-false';
    }
}
class Cache {
    static function getInstance() {
        recordCall('cache');
        return getenv('CASE_MODE') === 'cache-null' ? null : new self();
    }
    function set($key, $value, $ttl) {
        recordCall('set');
        if ($key !== 'readiness' || $value !== 'ok' || $ttl !== 30) {
            throw new RuntimeException('SECRET_CANARY wrong cache operation');
        }
        if (getenv('CASE_MODE') === 'cache-throw') { throw new RuntimeException('SECRET_CANARY cache'); }
        return getenv('CASE_MODE') !== 'cache-set';
    }
    function get($key) {
        recordCall('get');
        return getenv('CASE_MODE') === 'cache-get' ? 'SECRET_CANARY mismatch' : 'ok';
    }
}
PHP;
file_put_contents($root . '/config/config.inc.php', $bootstrap);
$runner = <<<'PHP'
<?php
http_response_code(200);
$_SERVER['HTTP_HOST'] = 'HOST_CANARY.example';
$_SERVER['HTTP_X_FORWARDED_HOST'] = 'FORWARDED_CANARY.example';
register_shutdown_function(function () {
    file_put_contents(__DIR__ . '/status', (string) http_response_code());
});
require __DIR__ . '/health.php';
PHP;
file_put_contents($root . '/runner.php', $runner);
$cases = [
    // Installation must reject before even invalid context or bootstrap can run.
    ['missing', false, false, 'invalid/DOMAIN_CANARY', 'installation', ''],
    ['locked-missing', false, true, 'invalid/DOMAIN_CANARY', 'installation', ''],
    ['locked', true, true, 'invalid/DOMAIN_CANARY', 'installation', ''],
    ['context', true, false, 'invalid/DOMAIN_CANARY', 'context', ''],
    ['empty-context', true, false, '', 'context', ''],
    ['bootstrap', true, false, 'DOMAIN_CANARY.example', 'database-or-bootstrap', "bootstrap\n"],
    ['database-false', true, false, 'DOMAIN_CANARY.example', 'database-or-bootstrap', "bootstrap\ndatabase\n"],
    ['database-throw', true, false, 'DOMAIN_CANARY.example', 'database-or-bootstrap', "bootstrap\ndatabase\n"],
    ['cache-null', true, false, 'DOMAIN_CANARY.example', 'cache', "bootstrap\ndatabase\ncache\n"],
    ['cache-set', true, false, 'DOMAIN_CANARY.example', 'cache', "bootstrap\ndatabase\ncache\nset\n"],
    ['cache-throw', true, false, 'DOMAIN_CANARY.example', 'cache', "bootstrap\ndatabase\ncache\nset\n"],
    ['cache-get', true, false, 'DOMAIN_CANARY.example', 'cache', "bootstrap\ndatabase\ncache\nset\nget\n"],
    ['success', true, false, 'DOMAIN_CANARY.example', null, "bootstrap\ndatabase\ncache\nset\nget\n"],
];
$assertions = 0;
$failures = 0;
$check = function ($condition, $message) use (&$assertions, &$failures) {
    ++$assertions;
    if (!$condition) { ++$failures; fwrite(STDERR, "FAIL: $message\n"); }
};
try {
    foreach ($cases as [$mode, $parameters, $lock, $domain, $phase, $calls]) {
        foreach (['app/config/parameters.php', 'install.lock', 'calls', 'status'] as $file) {
            if (is_file($root . '/' . $file)) { unlink($root . '/' . $file); }
        }
        if ($parameters) { file_put_contents($root . '/app/config/parameters.php', '<?php // SECRET_CANARY'); }
        if ($lock) { file_put_contents($root . '/install.lock', 'SECRET_CANARY'); }
        putenv('CASE_MODE=' . $mode);
        putenv('PS_DOMAIN=' . $domain);
        $beforeParameters = $parameters ? file_get_contents($root . '/app/config/parameters.php') : false;
        $beforeLock = $lock ? file_get_contents($root . '/install.lock') : false;
        $process = proc_open([PHP_BINARY, '-d', 'display_errors=0', '-d', 'log_errors=1',
            '-d', 'error_log=/dev/stderr', $root . '/runner.php'],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($process)) { throw new RuntimeException('Could not start endpoint fixture'); }
        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $exit = proc_close($process);
        $expected = $phase === null ? '' : 'readiness phase=' . $phase .
            ' parametersPresent=' . ($parameters ? 'true' : 'false') .
            ' lockPresent=' . ($lock ? 'true' : 'false') . "\n";
        // PHP may prefix private error_log messages with a timestamp.
        $diagnostics = preg_replace('/^\[[^\]\r\n]+\] /m', '', $stderr);
        $check($exit === 0, "$mode unchanged exit 0");
        $check($stdout === ($phase === null ? "ok\n" : "not ready\n"), "$mode exact body");
        $check(file_get_contents($root . '/status') === ($phase === null ? '200' : '503'), "$mode status");
        $check($diagnostics === $expected, "$mode safe diagnostics only");
        $check(!preg_match('/SECRET_CANARY|DOMAIN_CANARY|HOST_CANARY|FORWARDED_CANARY/', $stdout . $stderr), "$mode no canary leakage");
        $actualCalls = is_file($root . '/calls') ? file_get_contents($root . '/calls') : '';
        $check($actualCalls === $calls, "$mode ordered guards and short circuit");
        $afterParameters = is_file($root . '/app/config/parameters.php') ? file_get_contents($root . '/app/config/parameters.php') : false;
        $afterLock = is_file($root . '/install.lock') ? file_get_contents($root . '/install.lock') : false;
        $check($beforeParameters === $afterParameters && $beforeLock === $afterLock, "$mode installation files unchanged");
    }
} finally {
    // Only task-owned ephemeral fixtures are removed, including on failed assertions.
    foreach (['app/config/parameters.php', 'install.lock', 'calls', 'status', 'runner.php',
        'health.php', 'health-context.php', 'config/config.inc.php'] as $file) {
        if (is_file($root . '/' . $file)) { unlink($root . '/' . $file); }
    }
    foreach (['app/config', 'app', 'config', ''] as $directory) { rmdir($root . '/' . $directory); }
}
echo ($failures ? 'FAIL' : 'PASS') . ": $assertions assertions, $failures failures, " . count($cases) . " endpoint cases\n";
exit($failures ? 1 : 0);
