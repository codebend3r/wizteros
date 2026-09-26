import {
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  Inject,
  Injectable,
  Module,
  UnauthorizedException,
} from '@nestjs/common'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

// Admin auth is a Supabase session: the portal sends the signed-in admin's
// access token as `Authorization: Bearer <jwt>`. The signature is verified as
// ES256 against the project's published keys, then the email claim has to be
// on the allowlist. Both servers answer from the public internet through the
// Funnel, so every failure path, unset config included, is a 401.

export type AdminAuthConfig = {
  /** Base url of the Supabase project, no trailing slash; empty when unset. */
  supabaseUrl: string
  /** The admins allowed in, lowercased. Empty means nobody. */
  allowedEmails: ReadonlySet<string>
}

export type AdminAuthOptions = {
  /**
   * Called on every request, as the Python monitor did. A container's
   * environment is fixed when it starts, so in production this reads the same
   * values each time; what it buys is that nothing is captured at import, so
   * a test can change the config between requests.
   */
  readConfig: () => AdminAuthConfig
  /**
   * The signing-key lookup for one JWKS url. Production fetches it; a test
   * hands back a local key set so the signature is still verified for real.
   */
  keySetFor?: (jwksUrl: string) => JWTVerifyGetKey
}

export const ADMIN_AUTH_OPTIONS = Symbol('ADMIN_AUTH_OPTIONS')

// Nest builds a separate guard instance for every module whose controllers
// name it, so a cache held by the guard would be one cache per module, each
// fetching the keys on its own first request. Registering the cache once in
// the global module is what makes every instance share it.
const ADMIN_KEY_SETS = Symbol('ADMIN_KEY_SETS')

type KeySets = Map<string, JWTVerifyGetKey>

const fetchKeySet = (jwksUrl: string): JWTVerifyGetKey => createRemoteJWKSet(new URL(jwksUrl))

// FastAPI's HTTPException body, kept so the portal sees the same 401 it
// always has.
const unauthorized = (): UnauthorizedException =>
  new UnauthorizedException({ detail: 'unauthorized' })

const authorizationHeader = (request: unknown): string => {
  if (typeof request !== 'object' || request === null || !('headers' in request)) {
    return ''
  }
  const { headers } = request
  if (typeof headers !== 'object' || headers === null || !('authorization' in headers)) {
    return ''
  }
  const { authorization } = headers
  return typeof authorization === 'string' ? authorization : ''
}

// Split on the first space only, so `Bearer` with nothing after it, or any
// other scheme, yields no token at all.
const bearerToken = (header: string): string => {
  const space = header.indexOf(' ')
  if (space === -1) {
    return ''
  }
  return header.slice(0, space).toLowerCase() === 'bearer' ? header.slice(space + 1) : ''
}

@Injectable()
export class SupabaseAdminGuard implements CanActivate {
  constructor(
    @Inject(ADMIN_AUTH_OPTIONS) private readonly options: AdminAuthOptions,
    // One key set per JWKS url: jose caches the fetched keys inside it, which
    // is what keeps the network off the request path after the first call.
    @Inject(ADMIN_KEY_SETS) private readonly keySets: KeySets,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { supabaseUrl, allowedEmails } = this.options.readConfig()
    if (!supabaseUrl || allowedEmails.size === 0) {
      throw unauthorized()
    }

    const token = bearerToken(authorizationHeader(context.switchToHttp().getRequest()))
    if (!token) {
      throw unauthorized()
    }

    const email = await this.verifiedEmail({ token, supabaseUrl })
    if (!allowedEmails.has(email)) {
      throw unauthorized()
    }
    return true
  }

  private async verifiedEmail({
    token,
    supabaseUrl,
  }: {
    token: string
    supabaseUrl: string
  }): Promise<string> {
    try {
      const { payload } = await jwtVerify(
        token,
        this.keySet(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
        {
          algorithms: ['ES256'],
          audience: 'authenticated',
          issuer: `${supabaseUrl}/auth/v1`,
        },
      )
      return typeof payload.email === 'string' ? payload.email.toLowerCase() : ''
    } catch {
      throw unauthorized()
    }
  }

  private keySet(jwksUrl: string): JWTVerifyGetKey {
    const cached = this.keySets.get(jwksUrl)
    if (cached) {
      return cached
    }
    const created = (this.options.keySetFor ?? fetchKeySet)(jwksUrl)
    this.keySets.set(jwksUrl, created)
    return created
  }
}

/**
 * Registers the guard's options and key cache app-wide, so any controller in
 * any module can take `@UseGuards(SupabaseAdminGuard)` without importing this
 * module itself, and every one of those guards shares the one cache.
 */
@Module({})
export class AdminAuthModule {
  static forRoot(options: AdminAuthOptions): DynamicModule {
    return {
      module: AdminAuthModule,
      global: true,
      providers: [
        { provide: ADMIN_AUTH_OPTIONS, useValue: options },
        { provide: ADMIN_KEY_SETS, useValue: new Map<string, JWTVerifyGetKey>() },
      ],
      exports: [ADMIN_AUTH_OPTIONS, ADMIN_KEY_SETS],
    }
  }
}
