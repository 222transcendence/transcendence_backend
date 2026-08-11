#!/bin/sh
set -e

echo "[entrypoint] running pending migrations..."
npx typeorm migration:run -d dist/data-source.js

echo "[entrypoint] starting app..."
exec node dist/main.js
