import crypto from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createId } from '@bionic/shared';
import type { HubDatabase } from '../db/pool.js';
import type { HubConfig } from '../config.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'researcher' | 'viewer';
  groupSlugs: string[];
  sessionId?: string;
}

export type OriginScope = 'editor' | 'live_report' | 'publication' | 'public_reports_site';

export interface ScopedOriginSession {
  id: string;
  parentSessionId: string;
  userId: string;
  scope: OriginScope;
  resourceId: string;
  targetOrigin: string;
  expiresAt: Date;
}

export function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function cookieNameForScope(scope: 'hub' | OriginScope, devMode: boolean): string {
  const prefix = devMode ? '' : '__Host-';
  switch (scope) {
    case 'hub':
      return `${prefix}bionic_session`;
    case 'editor':
      return `${prefix}bionic_editor_session`;
    case 'live_report':
    case 'publication':
    case 'public_reports_site':
      return `${prefix}bionic_report_session`;
  }
}

export function serializeHostOnlyCookie(name: string, value: string, maxAgeSec: number, devMode: boolean): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (!devMode) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookieHeader(header?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) result[k] = v;
  }
  return result;
}

export class SessionService {
  private readonly scopedCache = new Map<string, { session: ScopedOriginSession; expiresAtMs: number }>();
  private readonly jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(private readonly db: HubDatabase, private readonly cfg: HubConfig) {
    this.db.events.on('session_revocations', (msg: any) => {
      if (!msg?.parentSessionId && !msg?.tokenHash) return;
      for (const [k, v] of this.scopedCache.entries()) {
        if (
          (msg.parentSessionId && v.session.parentSessionId === msg.parentSessionId) ||
          (msg.tokenHash && k === msg.tokenHash)
        ) {
          this.scopedCache.delete(k);
        }
      }
    });
  }

  async createHubSession(userId: string, meta: { ip?: string; userAgent?: string }): Promise<{
    sessionId: string;
    rawToken: string;
    cookieHeader: string;
  }> {
    const sessionId = createId('ses');
    const rawToken = generateOpaqueToken(32);
    const tokenHash = sha256Hex(rawToken);
    const ttlSec = this.cfg.sessionTtlHours * 3600;

    await this.db.query(
      `INSERT INTO user_sessions (id, token_hash, user_id, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), $5::inet, $6)`,
      [sessionId, tokenHash, userId, ttlSec, meta.ip || null, meta.userAgent || null]
    );

    const cookieName = cookieNameForScope('hub', this.cfg.devMode);
    return {
      sessionId,
      rawToken,
      cookieHeader: serializeHostOnlyCookie(cookieName, rawToken, ttlSec, this.cfg.devMode)
    };
  }

  async validateHubSessionToken(rawToken: string): Promise<AuthenticatedUser | null> {
    if (!rawToken) return null;
    const tokenHash = sha256Hex(rawToken);
    const res = await this.db.query(
      `
      SELECT s.id AS session_id, u.id, u.email, u.display_name, u.role,
             COALESCE(ARRAY_AGG(g.slug) FILTER (WHERE g.slug IS NOT NULL), '{}') AS group_slugs
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN group_memberships gm ON gm.user_id = u.id
      LEFT JOIN groups g ON g.id = gm.group_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND u.status = 'active'
      GROUP BY s.id, u.id
      `,
      [tokenHash]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      groupSlugs: row.group_slugs || [],
      sessionId: row.session_id
    };
  }

  async revokeHubSession(sessionId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await client.query(`UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1`, [sessionId]);
      await client.query(
        `UPDATE scoped_origin_sessions SET revoked_at = NOW() WHERE parent_session_id = $1 AND revoked_at IS NULL`,
        [sessionId]
      );
    });
    await this.db.notify('session_revocations', { parentSessionId: sessionId });
  }

  /**
   * Issues a 30-second single-use code for cross-subdomain host-only cookie handoff (Security C1).
   */
  async createSubdomainHandoffCode(input: {
    userId: string;
    parentSessionId: string;
    targetOrigin: string;
    scope: OriginScope;
    resourceId: string;
  }): Promise<string> {
    const rawCode = generateOpaqueToken(32);
    const codeHash = sha256Hex(rawCode);
    await this.db.query(
      `INSERT INTO editor_auth_codes (code_hash, user_id, parent_session_id, target_origin, scope, resource_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '30 seconds')`,
      [codeHash, input.userId, input.parentSessionId, input.targetOrigin, input.scope, input.resourceId]
    );
    return rawCode;
  }

  /**
   * Atomically consumes a 30-second single-use handoff code and mints a host-only subdomain session.
   */
  async consumeSubdomainHandoffCode(rawCode: string, expectedOrigin: string): Promise<{
    session: ScopedOriginSession;
    cookieHeader: string;
  } | null> {
    const codeHash = sha256Hex(rawCode);
    return this.db.withTransaction(async (client) => {
      const codeRes = await client.query(
        `
        UPDATE editor_auth_codes
        SET consumed_at = NOW()
        WHERE code_hash = $1
          AND target_origin = $2
          AND consumed_at IS NULL
          AND expires_at > NOW()
        RETURNING user_id, parent_session_id, target_origin, scope, resource_id
        `,
        [codeHash, expectedOrigin]
      );
      const row = codeRes.rows[0];
      if (!row) return null;

      // Verify parent Hub session is still active
      const parentRes = await client.query(
        `SELECT id FROM user_sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
        [row.parent_session_id]
      );
      if (parentRes.rowCount === 0) return null;

      const scopedId = createId('ses');
      const rawToken = generateOpaqueToken(32);
      const tokenHash = sha256Hex(rawToken);
      const ttlSec = Math.min(this.cfg.sessionTtlHours * 3600, 12 * 3600);

      const ins = await client.query(
        `
        INSERT INTO scoped_origin_sessions
          (id, token_hash, parent_session_id, user_id, scope, resource_id, target_origin, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(secs => $8))
        RETURNING expires_at
        `,
        [scopedId, tokenHash, row.parent_session_id, row.user_id, row.scope, row.resource_id, row.target_origin, ttlSec]
      );

      const session: ScopedOriginSession = {
        id: scopedId,
        parentSessionId: row.parent_session_id,
        userId: row.user_id,
        scope: row.scope,
        resourceId: row.resource_id,
        targetOrigin: row.target_origin,
        expiresAt: new Date(ins.rows[0].expires_at)
      };

      const cookieName = cookieNameForScope(row.scope, this.cfg.devMode);
      return {
        session,
        cookieHeader: serializeHostOnlyCookie(cookieName, rawToken, ttlSec, this.cfg.devMode)
      };
    });
  }

  /**
   * Validates a host-only subdomain session cookie with a 20-second in-memory TTL cache
   * invalidated immediately via Postgres LISTEN/NOTIFY on logout/revocation.
   */
  async validateScopedOriginCookie(
    rawToken: string,
    expectedOrigin: string,
    expectedScope: OriginScope,
    expectedResourceId: string
  ): Promise<ScopedOriginSession | null> {
    if (!rawToken) return null;
    const tokenHash = sha256Hex(rawToken);
    const cached = this.scopedCache.get(tokenHash);
    if (cached && cached.expiresAtMs > Date.now()) {
      const s = cached.session;
      if (s.targetOrigin === expectedOrigin && s.scope === expectedScope && s.resourceId === expectedResourceId) {
        return s;
      }
      return null;
    }

    const res = await this.db.query(
      `
      SELECT s.id, s.parent_session_id, s.user_id, s.scope, s.resource_id, s.target_origin, s.expires_at
      FROM scoped_origin_sessions s
      JOIN user_sessions p ON p.id = s.parent_session_id
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.target_origin = $2
        AND s.scope = $3
        AND s.resource_id = $4
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND p.revoked_at IS NULL
        AND p.expires_at > NOW()
        AND u.status = 'active'
      `,
      [tokenHash, expectedOrigin, expectedScope, expectedResourceId]
    );
    const row = res.rows[0];
    if (!row) return null;

    const session: ScopedOriginSession = {
      id: row.id,
      parentSessionId: row.parent_session_id,
      userId: row.user_id,
      scope: row.scope,
      resourceId: row.resource_id,
      targetOrigin: row.target_origin,
      expiresAt: new Date(row.expires_at)
    };
    this.scopedCache.set(tokenHash, {
      session,
      expiresAtMs: Math.min(Date.now() + 20_000, session.expiresAt.getTime())
    });
    return session;
  }

  async createApiToken(input: {
    name: string;
    createdBy: string;
    scopes: string[];
    expiresInDays?: number;
  }): Promise<{ id: string; token: string; prefix: string }> {
    const id = createId('tok');
    const secret = generateOpaqueToken(28);
    const token = `bht_${id.slice(4, 12)}_${secret}`;
    const prefix = token.slice(0, 12);
    const tokenHash = sha256Hex(token);
    await this.db.query(
      `INSERT INTO api_tokens (id, name, prefix, token_hash, created_by, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $7) END)`,
      [id, input.name, prefix, tokenHash, input.createdBy, input.scopes, input.expiresInDays ?? null]
    );
    return { id, token, prefix };
  }

  async validateBearerAdminCredential(authHeader?: string): Promise<{
    kind: 'pat' | 'ci_oidc';
    actorId: string;
    scopes: string[];
  } | null> {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) return null;

    if (token.startsWith('bht_')) {
      const hash = sha256Hex(token);
      const res = await this.db.query(
        `UPDATE api_tokens SET last_used_at = NOW()
         WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
         RETURNING id, scopes`,
        [hash]
      );
      if (res.rowCount === 0) return null;
      return { kind: 'pat', actorId: res.rows[0].id, scopes: res.rows[0].scopes || [] };
    }

    // Attempt CI OIDC Workload Identity JWT verification against configured policies
    const policies = await this.db.query(
      `SELECT issuer, audience, subject_pattern, allowed_scopes FROM ci_oidc_trust_policies WHERE enabled = TRUE`
    );
    for (const pol of policies.rows) {
      try {
        const jwksUrl = new URL('/.well-known/jwks', pol.issuer);
        let jwks = this.jwksCache.get(pol.issuer);
        if (!jwks) {
          // Discover actual jwks_uri via OIDC discovery
          const disc = await fetch(`${pol.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
          const discJson = disc.ok ? (await disc.json()) as any : null;
          jwks = createRemoteJWKSet(new URL(discJson?.jwks_uri || jwksUrl.toString()));
          this.jwksCache.set(pol.issuer, jwks);
        }
        const { payload } = await jwtVerify(token, jwks, {
          issuer: pol.issuer,
          audience: pol.audience
        });
        const sub = String(payload.sub || '');
        const regex = new RegExp(`^${pol.subject_pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        if (regex.test(sub)) {
          return { kind: 'ci_oidc', actorId: sub, scopes: pol.allowed_scopes || [] };
        }
      } catch {
        // Try next trust policy
      }
    }
    return null;
  }

  async recordAudit(input: {
    actorUserId?: string;
    actorTokenId?: string;
    actorCiSub?: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, any>;
    ipAddress?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_logs (actor_user_id, actor_token_id, actor_ci_sub, action, resource_type, resource_id, metadata_json, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::inet)`,
      [
        input.actorUserId || null,
        input.actorTokenId || null,
        input.actorCiSub || null,
        input.action,
        input.resourceType,
        input.resourceId,
        JSON.stringify(input.metadata || {}),
        input.ipAddress || null
      ]
    );
  }
}
