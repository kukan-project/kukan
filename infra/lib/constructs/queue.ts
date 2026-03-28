/**
 * KUKAN Queue Construct
 * SQS queue for pipeline jobs with Dead Letter Queue.
 */

import * as cdk from 'aws-cdk-lib'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import { Construct } from 'constructs'

export class QueueConstruct extends Construct {
  readonly queue: sqs.Queue
  readonly dlq: sqs.Queue

  constructor(scope: Construct, id: string) {
    super(scope, id)

    this.dlq = new sqs.Queue(this, 'PipelineDlq', {
      queueName: 'kukan-pipeline-dlq',
      retentionPeriod: cdk.Duration.days(14),
    })

    this.queue = new sqs.Queue(this, 'PipelineQueue', {
      queueName: 'kukan-pipeline',
      visibilityTimeout: cdk.Duration.minutes(10),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 3,
      },
    })

    cdk.Tags.of(this).add('kukan:component', 'queue')
  }
}
