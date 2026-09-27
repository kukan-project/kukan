/**
 * The waiting-jobs metric the worker writes and its service scales on
 * (ADR-058 §4). Here because both ends read it: the worker's EMF line and
 * the infra's scaling policy, which would otherwise watch a metric nothing
 * writes the moment one side renamed it.
 */
export const WAITING_METRIC_NAMESPACE = 'KUKAN/Worker'
export const WAITING_METRIC_NAME = 'JobsWaiting'
