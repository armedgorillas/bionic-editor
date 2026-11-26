import crypto from 'crypto';
import { promisify } from 'util';
import { createId } from '@bionic/shared';
import type { HubConfig } from '../config.js';
import type { HubDatabase } from '../db/pool.js';
import { generateOpaqueToken, sha256Hex, type AuthenticatedUser } from './sessions.js';

const scryptAsync = promisify(crypto.scrypt);
const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw Object.assign(new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`), { statusCode: 400 });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHex, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/**
 * Demo-only local email/password user management:
 * - Admin manually adds/invites users and receives a 72-hour single-use setup link.
 * - Invited users set their own password tied to their email (`scrypt` + random salt).
 * - Includes in-memory brute-force rate limiting (max 10 failed attempts per 15 min per key).
 */
export class LocalAuthService {
  private readonly failedAttempts = new Map<string, { count: number; resetAtMs: number }>();

  constructor(private readonly db: HubDatabase, private readonly cfg: HubConfig) {}

  checkRateLimit(key: string): void {
    const now = Date.now();
    const rec = this.failedAttempts.get(key);
    if (!rec || rec.resetAtMs < now) {
      this.failedAttempts.delete(key);
      return;
    }
    if (rec.count >= 10) {
      throw Object.assign(new Error('Too many failed sign-in attempts. Try again in 15 minutes.'), { statusCode: 429 });
    }
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const rec = this.failedAttempts.get(key);
    if (!rec || rec.resetAtMs < now) {
      this.failedAttempts.set(key, { count: 1, resetAtMs: now + 15 * 60 * 1000 });
    } else {
      rec.count += 1;
    }
  }

  clearFailures(key: string): void {
    this.failedAttempts.delete(key);
  }

  async ensureBootstrapDemoAdmin(): Promise<void> {
    if (!this.cfg.localAuthEnabled || !this.cfg.bootstrapAdminEmail || !this.cfg.bootstrapAdminPassword) {
      return;
    }
    const email = this.cfg.bootstrapAdminEmail.toLowerCase().trim();
    const existing = await this.db.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [email]);
    if (existing.rowCount && existing.rowCount > 0) return;

    const userId = createId('usr');
    const pwHash = await hashPassword(this.cfg.bootstrapAdminPassword);
    await this.db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, email, email_verified, display_name, oidc_sub, oidc_issuer, role, status, password_hash)
         VALUES ($1, $2, TRUE, $3, $4, 'local://demo', 'admin', 'active', $5)`,
        [userId, email, email.split('@')[0], `local:${email}`, pwHash]
      );
      await client.query(
        `INSERT INTO group_memberships (group_id, user_id)
         SELECT id, $1 FROM groups WHERE slug IN ('admins', 'researchers')
         ON CONFLICT DO NOTHING`,
        [userId]
      );
    });
  }

  async inviteUser(input: {
    email: string;
    displayName?: string;
    role: 'admin' | 'researcher' | 'viewer';
    invitedByUserId?: string;
    ttlHours?: number;
  }): Promise<{ userId: string; email: string; role: string; setupUrl: string; expiresAt: string }> {
    const email = input.email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw Object.assign(new Error('Valid email address is required'), { statusCode: 400 });
    }
    const displayName = (input.displayName || email.split('@')[0]).trim().slice(0, 120);
    const rawToken = generateOpaqueToken(32);
    const tokenHash = sha256Hex(rawToken);
    const ttlHours = Math.max(1, Math.min(input.ttlHours ?? 72, 168));

    const { userId, expiresAt } = await this.db.withTransaction(async (client) => {
      const existing = await client.query<{ id: string }>(`SELECT id FROM users WHERE LOWER(email) = $1`, [email]);
      let uid: string;
      if (existing.rows[0]) {
        uid = existing.rows[0].id;
        await client.query(
          `UPDATE users SET display_name = $2, role = $3, status = 'active' WHERE id = $1`,
          [uid, displayName, input.role]
        );
      } else {
        uid = createId('usr');
        await client.query(
          `INSERT INTO users (id, email, email_verified, display_name, oidc_sub, oidc_issuer, role, status)
           VALUES ($1, $2, TRUE, $3, $4, 'local://demo', $5, 'active')`,
          [uid, email, displayName, `local:${email}`, input.role]
        );
      }

      const groupSlugs = input.role === 'admin' ? ['admins', 'researchers'] : ['researchers'];
      await client.query(
        `INSERT INTO group_memberships (group_id, user_id)
         SELECT id, $1 FROM groups WHERE slug = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [uid, groupSlugs]
      );

      // Invalidate any prior unconsumed setup tokens for this user
      await client.query(
        `UPDATE password_setup_tokens SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL`,
        [uid]
      );

      const tokRes = await client.query<{ expires_at: string }>(
        `INSERT INTO password_setup_tokens (token_hash, user_id, expires_at, created_by)
         VALUES ($1, $2, NOW() + make_interval(hours => $3), $4)
         RETURNING expires_at`,
        [tokenHash, uid, ttlHours, input.invitedByUserId || null]
      );

      return { userId: uid, expiresAt: new Date(tokRes.rows[0].expires_at).toISOString() };
    });

    const setupUrl = `${this.cfg.hubOrigin}/?setupToken=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(email)}`;
    return { userId, email, role: input.role, setupUrl, expiresAt };
  }

  async completePasswordSetup(input: { email: string; token: string; password: string }): Promise<AuthenticatedUser> {
    const email = input.email.toLowerCase().trim();
    const pwHash = await hashPassword(input.password);
    const tokenHash = sha256Hex(input.token);

    return this.db.withTransaction(async (client) => {
      const res = await client.query(
        `UPDATE password_setup_tokens pst
         SET consumed_at = NOW()
         FROM users u
         WHERE pst.token_hash = $1
           AND pst.user_id = u.id
           AND LOWER(u.email) = $2
           AND pst.consumed_at IS NULL
           AND pst.expires_at > NOW()
           AND u.status = 'active'
         RETURNING u.id, u.email, u.display_name, u.role`,
        [tokenHash, email]
      );
      const userRow = res.rows[0];
      if (!userRow) {
        throw Object.assign(new Error('Invalid, expired, or already-used password setup link'), { statusCode: 400 });
      }

      await client.query(`UPDATE users SET password_hash = $2, email_verified = TRUE, last_login_at = NOW() WHERE id = $1`, [
        userRow.id,
        pwHash
      ]);

      const grpRes = await client.query<{ slug: string }>(
        `SELECT g.slug FROM group_memberships gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = $1`,
        [userRow.id]
      );
      return {
        id: userRow.id,
        email: userRow.email,
        displayName: userRow.display_name,
        role: userRow.role,
        groupSlugs: grpRes.rows.map((r) => r.slug)
      };
    });
  }

  async authenticatePassword(emailRaw: string, password: string, clientIp?: string): Promise<AuthenticatedUser> {
    const email = emailRaw.toLowerCase().trim();
    const emailKey = `email:${email}`;
    const ipKey = clientIp ? `ip:${clientIp}` : '';
    this.checkRateLimit(emailKey);
    if (ipKey) this.checkRateLimit(ipKey);

    const res = await this.db.query(
      `SELECT u.id, u.email, u.display_name, u.role, u.status, u.password_hash,
              COALESCE(ARRAY_AGG(g.slug) FILTER (WHERE g.slug IS NOT NULL), '{}') AS group_slugs
       FROM users u
       LEFT JOIN group_memberships gm ON gm.user_id = u.id
       LEFT JOIN groups g ON g.id = gm.group_id
       WHERE LOWER(u.email) = $1
       GROUP BY u.id`,
      [email]
    );
    const row = res.rows[0];
    if (!row || row.status !== 'active' || !row.password_hash) {
      this.recordFailure(emailKey);
      if (ipKey) this.recordFailure(ipKey);
      throw Object.assign(new Error('Invalid email or password'), { statusCode: 401 });
    }

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      this.recordFailure(emailKey);
      if (ipKey) this.recordFailure(ipKey);
      throw Object.assign(new Error('Invalid email or password'), { statusCode: 401 });
    }

    this.clearFailures(emailKey);
    if (ipKey) this.clearFailures(ipKey);
    await this.db.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [row.id]);

    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      groupSlugs: row.group_slugs || []
    };
  }

  async listUsers(): Promise<Array<{
    id: string;
    email: string;
    display_name: string;
    role: string;
    status: string;
    has_password: boolean;
    last_login_at: string | null;
    created_at: string;
  }>> {
    const res = await this.db.query(
      `SELECT id, email, display_name, role, status, (password_hash IS NOT NULL) AS has_password, last_login_at, created_at
       FROM users ORDER BY created_at DESC`
    );
    return res.rows;
  }

  async setUserStatus(userId: string, status: 'active' | 'disabled'): Promise<void> {
    const res = await this.db.query(`UPDATE users SET status = $2 WHERE id = $1`, [userId, status]);
    if (res.rowCount === 0) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    if (status === 'disabled') {
      await this.db.query(`UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await this.db.query(`UPDATE scoped_origin_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    }
  }
}
