/**
 * What `cpuArchitecture` (config/types.ts) means to each place that has to agree on
 * it: the platform the images are built for, the one the tasks run on, and the
 * CodeBuild the pipeline builds the images on (the target's own architecture,
 * which keeps QEMU out of the pipeline).
 */

import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import * as assets from 'aws-cdk-lib/aws-ecr-assets'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import type { CpuArchitecture } from './config.js'

interface ArchitectureSettings {
  imagePlatform: assets.Platform
  taskRuntimePlatform: ecs.RuntimePlatform
  assetBuildImage: codebuild.IBuildImage
}

export const ARCHITECTURES = {
  arm64: {
    imagePlatform: assets.Platform.LINUX_ARM64,
    taskRuntimePlatform: {
      cpuArchitecture: ecs.CpuArchitecture.ARM64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    },
    assetBuildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
  },
  x86_64: {
    imagePlatform: assets.Platform.LINUX_AMD64,
    taskRuntimePlatform: {
      cpuArchitecture: ecs.CpuArchitecture.X86_64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    },
    assetBuildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
  },
} satisfies Record<CpuArchitecture, ArchitectureSettings>
