<?php
/** Keep readiness independent of an ALB IP/localhost Host header. */
function configureHealthContext(string $domain): void
{
    // Only deployment configuration may select the shop; never a request header.
    if (!preg_match('/\A[A-Za-z0-9.-]+(?::[0-9]{1,5})?\z/', $domain)) {
        throw new InvalidArgumentException('A configured shop domain is required for readiness');
    }
    $_SERVER['HTTP_HOST'] = $domain;
    $_SERVER['SERVER_NAME'] = explode(':', $domain, 2)[0];
    unset($_SERVER['HTTP_X_FORWARDED_HOST']);
}
