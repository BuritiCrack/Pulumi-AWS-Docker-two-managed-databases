FROM prestashop/prestashop:8.2.1-apache@sha256:798a98393b3a2160f60e46525e45c38e4686b1a994883e230542192c89145d7a
RUN pecl install redis-6.1.0 && docker-php-ext-enable redis
COPY CacheRedis.php configure-cache.php health.php health-context.php /opt/prestashop/
COPY init-cache.sh /tmp/init-scripts/10-cache.sh
RUN chmod 0755 /tmp/init-scripts/10-cache.sh
# ECS copies this prepared skeleton into the matching task-local cache volume.
RUN mkdir -p /var/www/html/var/cache/dev /var/www/html/var/cache/prod \
    && chown -R www-data:www-data /var/www/html/var/cache \
    && chmod 0775 /var/www/html/var/cache /var/www/html/var/cache/dev /var/www/html/var/cache/prod
VOLUME ["/var/www/html/var/cache"]
