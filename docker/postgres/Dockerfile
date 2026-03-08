FROM postgres:16-alpine

# Install PostgreSQL extensions
# Phase 1: ILIKE search (no additional extensions needed)
# Phase 2: OpenSearch for full-text search
# See docs/adr/009-opensearch-ilike-fallback.md for details

RUN apk add --no-cache \
    postgresql16-contrib

# Enable pg_trgm extension automatically when database is created
RUN mkdir -p /docker-entrypoint-initdb.d && \
    echo "CREATE EXTENSION IF NOT EXISTS pg_trgm;" > /docker-entrypoint-initdb.d/01-pg_trgm.sql
