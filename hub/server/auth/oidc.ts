import crypto from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createId } from '@bionic/shared';
import type { HubConfig } from '../config.js';
import type { HubDatabase } from '../db/pool.js';
import type { SecretResolver } from '../secrets/resolver.js';
import type { AuthenticatedUser } from './sessions.js';

interface PendingPkceState {
  verifier: string;
  returnTo: string;
  expiresAtMs: number;
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export class OidcService {
  private readonly pendingStates = new Map<string, PendingPkceState>();
  private discoveryCache: OidcDiscovery | null = null;
  private jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(
    private readonly db: HubDatabase,
    private readonly cfg: HubConfig,
    private readonly secrets?: SecretResolver
  ) {}

  isOidcConfigured(): boolean {
    return Boolean(this.cfg.oidcIssuer && this.cfg.oidcClientId && (this.cfg.oidcClientSecret || this.cfg.oidcClientSecretRef));
  }

  private async resolveClientSecret(): Promise<string> {
    if (this.cfg.oidcClientSecret) return this.cfg.oidcClientSecret;
    if (this.cfg.oidcClientSecretRef && this.secrets) {
      return this.secrets.resolve(this.cfg.oidcClientSecretRef);
    }
    throw new Error('OIDC client secret not configured');
  }

  private async getDiscovery(): Promise<OidcDiscovery> {
    if (this.discoveryCache) return this.discoveryCache;
    const url = `${this.cfg.oidcIssuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) at ${url}`);
    this.discoveryCache = (await res.json()) as OidcDiscovery;
    this.jwksCache = createRemoteJWKSet(new URL(this.discoveryCache.jwks_uri));
    return this.discoveryCache;
  }

  async buildAuthorizationUrl(returnTo = '/'): Promise<string> {
    const disc = await this.getDiscovery();
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    // Prune expired pending states
    const now = Date.now();
    for (const [k, v] of this.pendingStates.entries()) {
      if (v.expiresAtMs < now) this.pendingStates.delete(k);
    }
    const safeReturnTo =
      returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith('/\\') ? returnTo : '/';
    this.pendingStates.set(state, {
      verifier,
      returnTo: safeReturnTo,
      expiresAtMs: now + 10 * 60 * 1000
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.oidcClientId,
      redirect_uri: `${this.cfg.hubOrigin}/api/v1/auth/oidc/callback`,
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    });
    return `${disc.authorization_endpoint}?${params.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<{ user: AuthenticatedUser; returnTo: string }> {
    const pending = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    if (!pending || pending.expiresAtMs < Date.now()) {
      throw new Error('Invalid or expired OIDC state');
    }

    const disc = await this.getDiscovery();
    const clientSecret = await this.resolveClientSecret();
    const tokenRes = await fetch(disc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${this.cfg.hubOrigin}/api/v1/auth/oidc/callback`,
        client_id: this.cfg.oidcClientId,
        client_secret: clientSecret,
        code_verifier: pending.verifier
      })
    });
    if (!tokenRes.ok) {
      throw new Error(`OIDC token exchange failed (${tokenRes.status})`);
    }
    const tokenBody = (await tokenRes.json()) as { id_token?: string };
    if (!tokenBody.id_token || !this.jwksCache) {
      throw new Error('OIDC response missing id_token');
    }

    const { payload } = await jwtVerify(tokenBody.id_token, this.jwksCache, {
      issuer: disc.issuer,
      audience: this.cfg.oidcClientId
    });

    const sub = String(payload.sub || '');
    const email = String(payload.email || '').toLowerCase().trim();
    const emailVerified = Boolean(payload.email_verified);
    const displayName = String(payload.name || email.split('@')[0] || 'Scientist');
    if (!sub || !email) {
      throw new Error('OIDC id_token missing required sub or email claim');
    }

    const user = await this.upsertOidcUser({
      issuer: disc.issuer,
      sub,
      email,
      emailVerified,
      displayName
    });
    return { user, returnTo: pending.returnTo };
  }

  async upsertOidcUser(input: {
    issuer: string;
    sub: string;
    email: string;
    emailVerified: boolean;
    displayName: string;
  }): Promise<AuthenticatedUser> {
    return this.db.withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT id, email, display_name, role, status FROM users WHERE oidc_issuer = $1 AND oidc_sub = $2`,
        [input.issuer, input.sub]
      );
      let userId: string;
      let role: 'admin' | 'researcher' | 'viewer' = 'researcher';

      if (existing.rows[0]) {
        if (existing.rows[0].status !== 'active') {
          throw new Error('User account is disabled');
        }
        userId = existing.rows[0].id;
        role = existing.rows[0].role;
        await client.query(
          `UPDATE users SET email = $2, email_verified = $3, display_name = $4, last_login_at = NOW() WHERE id = $1`,
          [userId, input.email, input.emailVerified, input.displayName]
        );
      } else {
        userId = createId('usr');
        // Break-glass initial admin bootstrap requires verified email match
        const isBootstrapAdmin =
          Boolean(this.cfg.bootstrapAdminEmail) &&
          input.emailVerified &&
          input.email.toLowerCase() === this.cfg.bootstrapAdminEmail;
        role = isBootstrapAdmin ? 'admin' : 'researcher';

        await client.query(
          `INSERT INTO users (id, email, email_verified, display_name, oidc_sub, oidc_issuer, role, last_login_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [userId, input.email, input.emailVerified, input.displayName, input.sub, input.issuer, role]
        );

        // Bind default groups
        await client.query(
          `INSERT INTO group_memberships (group_id, user_id)
           SELECT id, $1 FROM groups WHERE slug = ANY($2::text[])
           ON CONFLICT DO NOTHING`,
          [userId, role === 'admin' ? ['admins', 'researchers'] : ['researchers']]
        );
      }

      const grpRes = await client.query(
        `SELECT g.slug FROM group_memberships gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = $1`,
        [userId]
      );

      return {
        id: userId,
        email: input.email,
        displayName: input.displayName,
        role,
        groupSlugs: grpRes.rows.map((r) => r.slug)
      };
    });
  }
}
