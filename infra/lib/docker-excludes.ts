/**
 * Shared Docker build context exclusions for CDK DockerImageAsset.
 * Mirrors .dockerignore so CDK asset hash ignores non-app files,
 * preventing unnecessary image rebuilds when only infra/docs change.
 */
export const DOCKER_ASSET_EXCLUDES = [
  'infra',
  'docs',
  'docker',
  '.git',
  '.github',
  '.vscode',
  '.claude',
  '.turbo',
  'coverage',
  '*.log',
  '*.md',
]
