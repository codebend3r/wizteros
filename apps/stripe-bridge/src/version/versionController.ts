import { createRequire } from 'node:module'
import { Controller, Get } from '@nestjs/common'

// The release this bridge was built from. The app's package.json is the
// marker scripts/release.sh moves in lockstep with every other package.json,
// and it is the only one that reaches the container, so GET /version is the
// authoritative answer to "what release is the NAS on". The file sits one
// level above both src/ and dist/, so the same relative path finds it under
// test and in the image.

const isVersioned = (value: unknown): value is { version: string } =>
  typeof value === 'object' &&
  value !== null &&
  'version' in value &&
  typeof value.version === 'string'

/** The `version` field of this app's package.json. */
export const packageVersion = (): string => {
  const manifest: unknown = createRequire(import.meta.url)('../../package.json')
  if (!isVersioned(manifest)) {
    throw new Error('stripe-bridge package.json has no version')
  }
  return manifest.version
}

// Unauthenticated on purpose: the release string is not a secret, and the
// deploy check has to work before anyone holds an admin token. Dual-pathed
// because the Funnel strips the /stripe prefix and direct calls keep it.
@Controller()
export class VersionController {
  /** Release version of the running bridge, so a deploy can be verified from outside. */
  @Get(['version', 'stripe/version'])
  version(): { version: string } {
    return { version: packageVersion() }
  }
}
