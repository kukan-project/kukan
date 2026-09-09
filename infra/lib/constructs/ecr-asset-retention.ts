/**
 * KUKAN ECR Asset Retention Construct
 * Lifecycle policy for the CDK bootstrap container-assets repository.
 *
 * The policy `cdk bootstrap` installs expires only UNTAGGED images, but
 * `DockerImageAsset` tags every image with its build hash, so nothing ever
 * expires and the repository grows without bound (348 images / 33.8 GB after
 * 5.5 months of deploys in one measured environment). The repository belongs
 * to the CDKToolkit stack, so app code cannot declare lifecycle rules on it —
 * this construct puts the policy there with an SDK call instead.
 *
 * Safe because the pipeline redeploys every service on each run, so the images
 * in use are always the most recently pushed (docs/specs phase4-deploy).
 */

import * as cdk from 'aws-cdk-lib'
import * as cr from 'aws-cdk-lib/custom-resources'
import { Construct } from 'constructs'

/**
 * The rules `cdk bootstrap` installs. PutLifecyclePolicy replaces the whole
 * document, so KUKAN owns the full text and restates them; a test pins this
 * against the installed CLI's bootstrap template so an upstream change fails
 * loudly instead of being silently reverted on the next deploy.
 */
export const STOCK_LIFECYCLE_RULES = [
  {
    rulePriority: 1,
    description: 'Untagged images should not exist, but expire any older than one year',
    selection: {
      tagStatus: 'untagged',
      countType: 'sinceImagePushed',
      countUnit: 'days',
      countNumber: 365,
    },
    action: { type: 'expire' },
  },
]

export interface EcrAssetRetentionProps {
  /** Images kept in the repository, newest first. */
  keep: number
}

export class EcrAssetRetentionConstruct extends Construct {
  constructor(scope: Construct, id: string, props: EcrAssetRetentionProps) {
    super(scope, id)

    const { keep } = props
    const stack = cdk.Stack.of(this)

    // Same name the bootstrap template derives — one repository per account/region.
    const qualifier =
      stack.synthesizer.bootstrapQualifier ?? cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER
    const repositoryName = cdk.Fn.sub(
      cdk.DefaultStackSynthesizer.DEFAULT_IMAGE_ASSETS_REPOSITORY_NAME,
      { Qualifier: qualifier }
    )

    // ECR requires the `any` rule to have the highest rulePriority number (it is
    // evaluated last).
    const policy = {
      rules: [
        ...STOCK_LIFECYCLE_RULES,
        {
          rulePriority: STOCK_LIFECYCLE_RULES.length + 1,
          description: `Keep the most recent ${keep} asset images`,
          selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: keep },
          action: { type: 'expire' },
        },
      ],
    }

    // A re-bootstrap resets the repository to the stock policy only when the
    // bootstrap template's repository definition changed, and every template
    // change bumps the bootstrap version. The synthesizer's BootstrapVersion
    // parameter reads that version from SSM at deploy time, so keying the
    // physical id on it re-applies the policy on the first deploy after such a
    // bootstrap — without re-running on every deploy.
    const bootstrapVersion = cdk.Fn.ref('BootstrapVersion')

    new cr.AwsCustomResource(this, 'Policy', {
      resourceType: 'Custom::KukanEcrAssetRetention',
      onUpdate: {
        service: 'ECR',
        action: 'putLifecyclePolicy',
        parameters: { repositoryName, lifecyclePolicyText: JSON.stringify(policy) },
        physicalResourceId: cr.PhysicalResourceId.of(
          `ecr-asset-retention:${keep}:bootstrap-${bootstrapVersion}`
        ),
      },
      // No onDelete: environments in one account share the repository, so
      // tearing one down must not strip the others' retention.
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [
          stack.formatArn({ service: 'ecr', resource: 'repository', resourceName: repositoryName }),
        ],
      }),
    })
  }
}
