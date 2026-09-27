/**
 * KUKAN Access Log Construct
 * The site's CloudFront access log bucket, plus the Glue table that reads it —
 * so the logs can be queried the moment a burst is noticed, without first
 * pasting a DDL. The Athena workgroup is the environment's (createLogWorkGroup).
 */

import * as cdk from 'aws-cdk-lib'
import * as athena from 'aws-cdk-lib/aws-athena'
import * as glue from 'aws-cdk-lib/aws-glue'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { RegionInfo } from 'aws-cdk-lib/region-info'
import { Construct } from 'constructs'
import { athenaWorkGroupName, envPrefix } from '../naming.js'

export interface AccessLogProps {
  /** Days before a log file expires. */
  retentionDays: number
}

/** Fields of the legacy standard log file, in file order. Append-only upstream. */
const LOG_COLUMNS: [name: string, type: string][] = [
  ['date', 'date'],
  ['time', 'string'],
  ['x_edge_location', 'string'],
  ['sc_bytes', 'bigint'],
  ['c_ip', 'string'],
  ['cs_method', 'string'],
  ['cs_host', 'string'],
  ['cs_uri_stem', 'string'],
  ['sc_status', 'int'],
  ['cs_referrer', 'string'],
  ['cs_user_agent', 'string'],
  ['cs_uri_query', 'string'],
  ['cs_cookie', 'string'],
  ['x_edge_result_type', 'string'],
  ['x_edge_request_id', 'string'],
  ['x_host_header', 'string'],
  ['cs_protocol', 'string'],
  ['cs_bytes', 'bigint'],
  ['time_taken', 'float'],
  ['x_forwarded_for', 'string'],
  ['ssl_protocol', 'string'],
  ['ssl_cipher', 'string'],
  ['x_edge_response_result_type', 'string'],
  ['cs_protocol_version', 'string'],
  ['fle_status', 'string'],
  ['fle_encrypted_fields', 'int'],
  ['c_port', 'int'],
  ['time_to_first_byte', 'float'],
  ['x_edge_detailed_result_type', 'string'],
  ['sc_content_type', 'string'],
  ['sc_content_len', 'bigint'],
  ['sc_range_start', 'bigint'],
  ['sc_range_end', 'bigint'],
]

/**
 * Whether legacy standard logging can deliver to a bucket in `region`. It
 * cannot to opt-in regions; a region CDK does not know yet is treated as one,
 * since every region added since 2019 has been opt-in.
 */
export function supportsLegacyCdnLogging(region: string): boolean {
  if (cdk.Token.isUnresolved(region)) return true
  const known = RegionInfo.regions.some((r) => r.name === region)
  return known && !RegionInfo.get(region).isOptInRegion
}

export class AccessLogConstruct extends Construct {
  readonly bucket: s3.Bucket
  /** `<database>.<table>` as written in an Athena query. */
  readonly tableRef: string

  constructor(scope: Construct, id: string, props: AccessLogProps) {
    super(scope, id)

    // Legacy standard logging over v2: delivery is free (only S3 itself is
    // billed), and v2's delivery resources must live in us-east-1, which
    // pipeline mode cannot reach (ADR-030). Legacy delivery writes through
    // bucket ACLs, hence OBJECT_WRITER.
    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: 'ExpireAccessLogs', expiration: cdk.Duration.days(props.retentionDays) },
      ],
    })

    const { account } = cdk.Stack.of(this)
    // Glue names allow no hyphens: kukan-dev-citya → kukan_dev_citya_logs
    const databaseName = `${envPrefix(this).replaceAll('-', '_')}_logs`
    const tableName = 'cloudfront'
    this.tableRef = `${databaseName}.${tableName}`

    const database = new glue.CfnDatabase(this, 'Database', {
      catalogId: account,
      databaseInput: { name: databaseName },
    })

    const table = new glue.CfnTable(this, 'Table', {
      catalogId: account,
      databaseName,
      tableInput: {
        name: tableName,
        tableType: 'EXTERNAL_TABLE',
        // Each file opens with #Version and #Fields lines
        parameters: { 'skip.header.line.count': '2' },
        storageDescriptor: {
          columns: LOG_COLUMNS.map(([name, type]) => ({ name, type })),
          location: `s3://${this.bucket.bucketName}/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
            parameters: { 'field.delim': '\t', 'serialization.format': '\t' },
          },
        },
      },
    })
    table.addDependency(database)
  }
}

/**
 * The environment's Athena workgroup, one for all sites. Athena-managed result
 * storage: no results bucket to create or clean up. Not a site boundary — a
 * query reaches whichever database its FROM names.
 */
export function createLogWorkGroup(scope: Construct): athena.CfnWorkGroup {
  return new athena.CfnWorkGroup(scope, 'AthenaWorkGroup', {
    name: athenaWorkGroupName(scope),
    recursiveDeleteOption: true,
    workGroupConfiguration: {
      enforceWorkGroupConfiguration: true,
      managedQueryResultsConfiguration: { enabled: true },
    },
  })
}
