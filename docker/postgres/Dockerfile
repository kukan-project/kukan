FROM postgres:16-alpine

# Install PostgreSQL extensions
# Note: pg_bigm is not available in Alpine repositories
# For Phase 1, we use standard pg_trgm for full-text search
# Phase 2 will use Debian-based image with pg_bigm compiled from source
# PostGIS is not included in Phase 1 (spatial features are Phase 3+)
# See docs/adr/009-pg-bigm-japanese-search.md for details

RUN apk add --no-cache \
    postgresql16-contrib

# Enable pg_trgm extension automatically when database is created
RUN mkdir -p /docker-entrypoint-initdb.d && \
    echo "CREATE EXTENSION IF NOT EXISTS pg_trgm;" > /docker-entrypoint-initdb.d/01-pg_trgm.sql
