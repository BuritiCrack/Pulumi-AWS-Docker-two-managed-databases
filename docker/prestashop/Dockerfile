FROM prestashop/prestashop:8.2.1-apache@sha256:798a98393b3a2160f60e46525e45c38e4686b1a994883e230542192c89145d7a
RUN pecl install redis-6.1.0 && docker-php-ext-enable redis
COPY CacheRedis.php configure-cache.php health.php health-context.php /opt/prestashop/
COPY init-cache.sh /tmp/init-scripts/10-cache.sh
RUN chmod 0755 /tmp/init-scripts/10-cache.sh
