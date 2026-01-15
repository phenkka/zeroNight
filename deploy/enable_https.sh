#!/usr/bin/env sh
set -eu

if [ $# -lt 2 ]; then
  echo "Usage: $0 <domain> <email>" >&2
  exit 2
fi

DOMAIN="$1"
EMAIL="$2"

mkdir -p deploy/certbot/www deploy/certbot/conf deploy/nginx

# Ensure stack is up on port 80 so webroot challenge works

docker compose -f docker-compose.prod.yml up -d --build

docker compose -f docker-compose.prod.yml run --rm certbot \
  certonly --webroot -w /var/www/certbot \
  -d "$DOMAIN" --email "$EMAIL" --agree-tos --no-eff-email

sed "s/__DOMAIN__/$DOMAIN/g" deploy/nginx/zeronight.docker.https.conf > deploy/nginx/zeronight.docker.https.generated.conf

# Switch nginx to HTTPS config

docker compose -f docker-compose.prod.yml -f docker-compose.https.yml up -d

echo "HTTPS enabled for $DOMAIN"
