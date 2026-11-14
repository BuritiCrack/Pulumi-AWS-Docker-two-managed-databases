<?php
require dirname(__DIR__) . '/health-context.php';
function check($condition, $message) {
    if (!$condition) { throw new RuntimeException($message); }
}
foreach (['shop', '127.0.0.1', '10.42.0.10:80'] as $requestHost) {
    $_SERVER = ['HTTP_HOST' => $requestHost, 'HTTP_X_FORWARDED_HOST' => 'untrusted.example'];
    configureHealthContext('shop.example.test');
    check($_SERVER['HTTP_HOST'] === 'shop.example.test', 'Use configured shop host, not probe host');
    check($_SERVER['SERVER_NAME'] === 'shop.example.test', 'Match server name');
    check(!isset($_SERVER['HTTP_X_FORWARDED_HOST']), 'Ignore forwarded host for readiness');
}
foreach (['', 'http://shop.example.test', "shop.example.test\r\nLocation: other"] as $invalid) {
    $_SERVER = ['HTTP_HOST' => '127.0.0.1'];
    $before = $_SERVER;
    try { configureHealthContext($invalid); throw new LogicException('Invalid domain accepted'); }
    catch (InvalidArgumentException $error) { check($_SERVER === $before, 'Reject before changing request context'); }
}
echo "PASS: health context accepts canonical/internal hosts, ignores forwarded host and rejects invalid configuration without mutation\n";
