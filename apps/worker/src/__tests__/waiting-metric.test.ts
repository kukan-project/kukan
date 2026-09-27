import { describe, it, expect } from 'vitest'
import { waitingMetricLine } from '../queue/waiting-metric'

describe('waitingMetricLine', () => {
  it('writes the figure as an EMF metric dimensioned by site', () => {
    expect(JSON.parse(waitingMetricLine('kukan-dev', 7, 1000))).toEqual({
      _aws: {
        Timestamp: 1000,
        CloudWatchMetrics: [
          {
            Namespace: 'KUKAN/Worker',
            Dimensions: [['Site']],
            Metrics: [{ Name: 'JobsWaiting', Unit: 'Count' }],
          },
        ],
      },
      Site: 'kukan-dev',
      JobsWaiting: 7,
    })
  })
})
