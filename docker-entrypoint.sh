#!/bin/sh
set -e

# Run database migrations
echo "Running database migrations..."
node node_modules/prisma/build/index.js migrate deploy

# Start the Next.js server
echo "Starting server on port ${PORT:-8080}..."
exec node server.js
