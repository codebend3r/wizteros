import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CryptoKey,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from 'jose'

// Test plumbing both servers share, imported as
// `@wizteros/server-common/testing`. Nothing in an app's `src` outside its
// tests imports this.

const KID = 'supabase-test-key'

export type MintOptions = {
  key?: CryptoKey
  email?: string
  issuer?: string
  audience?: string
  expiresAt?: string | number
}

export type SupabaseSigner = Readonly<{
  /** The key set an app's gate verifies against in place of Supabase's JWKS. */
  keySet: JWTVerifyGetKey
  /** A session token for `email`, signed by the signer's own key unless `key` is given. */
  mint: (options?: MintOptions) => Promise<string>
}>

/**
 * One throwaway ES256 keypair standing in for Supabase's. The test owns both
 * halves so it can mint a token that really verifies, rather than asserting
 * against a stubbed-out verifier that would still pass with the check removed.
 */
export const supabaseSigner = async ({
  supabaseUrl,
  email: defaultEmail,
}: {
  supabaseUrl: string
  email: string
}): Promise<SupabaseSigner> => {
  const signingKey = await generateKeyPair('ES256')
  const keySet = createLocalJWKSet({
    keys: [{ ...(await exportJWK(signingKey.publicKey)), kid: KID, alg: 'ES256', use: 'sig' }],
  })
  const mint = ({
    key = signingKey.privateKey,
    email = defaultEmail,
    issuer = `${supabaseUrl}/auth/v1`,
    audience = 'authenticated',
    expiresAt = '5m',
  }: MintOptions = {}): Promise<string> =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(key)
  return { keySet, mint }
}

/** The request headers that carry `token` as a bearer. */
export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
})

export type TempFiles = Readonly<{
  /** A path to a fresh, not yet created file in its own temp directory. */
  path: () => string
  /** Remove every directory `path` made. Call from an afterEach. */
  removeAll: () => void
}>

/** Throwaway files named `file`, each in a directory starting with `prefix`. */
export const tempFiles = ({ prefix, file }: { prefix: string; file: string }): TempFiles => {
  const dirs: string[] = []
  return {
    path: () => {
      const dir = mkdtempSync(join(tmpdir(), prefix))
      dirs.push(dir)
      return join(dir, file)
    },
    removeAll: () => {
      dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
    },
  }
}

export type Fixtures = Readonly<{
  /** A recorded fixture, as text. */
  text: (name: string) => string
  /** A recorded JSON fixture, parsed to `unknown` for the caller to narrow. */
  json: (name: string) => unknown
}>

/** The recorded fixtures in `dir`, a directory URL ending in a slash. */
export const fixturesIn = (dir: URL): Fixtures => {
  const text = (name: string): string => readFileSync(new URL(name, dir), 'utf8')
  return { text, json: (name) => JSON.parse(text(name)) }
}
