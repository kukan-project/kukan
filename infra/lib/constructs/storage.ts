/**
 * KUKAN Storage Construct
 * S3 bucket for resource file storage.
 * CORS allows only PUT (presigned upload). Reads are server-proxied (no presigned GET).
 */

import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'
import type { KukanConfig } from '../config.js'

export interface StorageProps {
  config: KukanConfig
}

export class StorageConstruct extends Construct {
  readonly bucket: s3.Bucket

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id)

    const { config } = props

    this.bucket = new s3.Bucket(this, 'ResourceBucket', {
      bucketName: config.bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: config.domainName ? [`https://${config.domainName}`] : ['*'],
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
      lifecycleRules: [
        {
          id: 'AbortIncompleteMultipartUpload',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    })

    cdk.Tags.of(this).add('kukan:component', 'storage')
  }
}
