/**
 * The waiting-jobs metric the worker service scales on (ADR-058 §4).
 *
 * Written as CloudWatch Embedded Metric Format: a log line CloudWatch Logs
 * turns into a metric, so the worker needs no metrics client and no
 * permission beyond the log group it already writes to.
 */

import { WAITING_METRIC_NAME, WAITING_METRIC_NAMESPACE } from '@kukan/shared'

/**
 * How often the last known figure is written, whether or not it changed. The
 * queue recounts on the same minute (`WAITING_COUNT_MS`).
 */
export const WAITING_METRIC_INTERVAL_MS = 60_000

/** One EMF line for this site's waiting-jobs figure. */
export function waitingMetricLine(site: string, waiting: number, now = Date.now()): string {
  return JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: WAITING_METRIC_NAMESPACE,
          Dimensions: [['Site']],
          Metrics: [{ Name: WAITING_METRIC_NAME, Unit: 'Count' }],
        },
      ],
    },
    Site: site,
    [WAITING_METRIC_NAME]: waiting,
  })
}
