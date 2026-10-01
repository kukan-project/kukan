/**
 * The DuckLake catalog connections a task may hold beside its pg pool
 * (ADR-043 layer 2). The postgres extension opens one per concurrent
 * transaction and keeps it pooled for a minute after, so these caps — not one
 * per ATTACH — are what a task adds to the database, and infra's connection
 * budget counts them per task.
 */

/** The web: its lake scans take the single DuckDB slot in turn. */
export const WEB_LAKE_CATALOG_CONNECTIONS = 1

/** The worker: one holder of the catalog-wide lock beside the hourly sweeps, which take none. */
export const WORKER_LAKE_CATALOG_CONNECTIONS = 2
