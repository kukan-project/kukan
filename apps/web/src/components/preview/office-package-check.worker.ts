/**
 * Unpacks an Office package off the main thread (office-package-check.ts): one
 * built to take long stalls only this worker, which the page ends after a while.
 */
import { checkPackage, type PackageCheckRequest, type PackageVerdict } from './office-package-check'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PackageCheckRequest>) => void) | null
  postMessage(verdict: PackageVerdict): void
}

scope.onmessage = async ({ data: { bytes, limit } }) => {
  scope.postMessage(await checkPackage(new Uint8Array(bytes), limit))
}
