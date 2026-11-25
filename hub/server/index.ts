import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { ATTESTABLE_STATES, isValidPrefixedId, type ConfigKind } from '@bionic/shared';
import { loadHubConfig, type HubConfig } from './config.js';
import { createHubDatabase, type HubDatabase } from './db/pool.js';
import { HubCertificateAuthority, type WorkloadJwtClaims } from './auth/ca.js';
import {
  SessionService,
  cookieNameForScope,
  serializeHostOnlyCookie,
  parseCookieHeader,
  type AuthenticatedUser,
  type OriginScope
} from './auth/sessions.js';
import { OidcService } from './auth/oidc.js';
import { LocalAuthService } from './auth/localAuth.js';
import { SecretResolver } from './secrets/resolver.js';
import { AdminConfigService } from './admin/configService.js';
import { LlmGatewayService } from './gateways/llm/gateway.js';
import { McpGatewayService } from './gateways/mcp/gateway.js';
import {
  LocalBareGitProvider,
  ForgejoGitProvider,
  GitSmartHttpProxy,
  type GitProvider
} from './gateways/git/proxy.js';
import { GcpComputeProvider, LocalComputeProvider, type ComputeProvider } from './compute/provider.js';
import { DataStorageService } from './storage/service.js';
import { PublishService } from './publish/service.js';
import { ProjectOrchestrator } from './projects/orchestrator.js';
import { EditorReverseProxy, parseSubdomainHost } from './proxy/editorProxy.js';
import { HubWorkerEngine } from './workers/reconciler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface HubRuntime {
  app: FastifyInstance;
  cfg: HubConfig;
  db: HubDatabase;
  ca: HubCertificateAuthority;
  sessions: SessionService;
  adminConfig: AdminConfigService;
  orchestrator: ProjectOrchestrator;
  publishService: PublishService;
  storageService: DataStorageService;
  workers: HubWorkerEngine;
  close: () => Promise<void>;
}

export async function createHubServer(overrides?: Partial<HubConfig>): Promise<HubRuntime> {
  const cfg: HubConfig = { ...loadHubConfig(), ...overrides };
  const db = createHubDatabase(cfg);
  const ca = await HubCertificateAuthority.create({
    issuer: cfg.hubOrigin,
    caCertPem: cfg.internalCaPem,
    caKeyPem: cfg.internalCaKeyPem,
    jwtPrivateKeyPem: cfg.jwtPrivateKeyPem,
    jwtPublicKeyPem: cfg.jwtPublicKeyPem
  });

  const secrets = new SecretResolver();
  const sessions = new SessionService(db, cfg);
  const oidc = new OidcService(db, cfg, secrets);
  const localAuth = new LocalAuthService(db, cfg);
  const adminConfig = new AdminConfigService(db, cfg);
  const compute: ComputeProvider = cfg.computeProvider === 'gcp' ? new GcpComputeProvider(cfg) : new LocalComputeProvider();
  const gitProvider: GitProvider =
    cfg.gitProvider === 'forgejo' ? new ForgejoGitProvider(cfg) : new LocalBareGitProvider(cfg.gitLocalReposDir);
  const gitProxy = new GitSmartHttpProxy(cfg, gitProvider);
  const storageService = new DataStorageService(db, cfg);
  const publishService = new PublishService(db, cfg, storageService, gitProvider);
  const llmGateway = new LlmGatewayService(db, cfg, secrets);
  const mcpGateway = new McpGatewayService(db, cfg, secrets, sessions);
  const orchestrator = new ProjectOrchestrator(db, cfg, compute, gitProvider);
  const editorProxy = new EditorReverseProxy(db, cfg, sessions, ca, orchestrator, publishService, compute);
  const workers = new HubWorkerEngine(db, cfg, compute, ca);

  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 });

  // Always surface the real error message in both `error` and `message` fields
  app.setErrorHandler((err: any, _req, reply) => {
    const statusCode = typeof err?.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    const message = err?.message || 'Internal Server Error';
    if (statusCode >= 500) {
      console.error('[Bionic Hub] Unhandled error:', err);
    }
    reply.code(statusCode).send({ statusCode, error: message, message });
  });

  app.addContentTypeParser(
    ['application/gzip', 'application/octet-stream', 'application/x-git-upload-pack-request', 'application/x-git-receive-pack-request'],
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    }
  );

  // Helper: authenticate interactive Hub user + CSRF Origin guard on mutating cookie routes (#12)
  async function requireHubUser(req: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | null> {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !cfg.devMode) {
      const origin = String(req.headers.origin || '').toLowerCase();
      if (origin && origin !== cfg.hubOrigin.toLowerCase()) {
        reply.code(403).send({ error: 'CSRF origin check failed' });
        return null;
      }
    }
    const cookies = parseCookieHeader(req.headers.cookie);
    const cookieName = cookieNameForScope('hub', cfg.devMode);
    const user = await sessions.validateHubSessionToken(cookies[cookieName] || '');
    if (!user) {
      reply.code(401).send({ error: 'Authentication required' });
      return null;
    }
    return user;
  }

  // Security #1: Project-level RBAC / IDOR guard
  async function requireProjectRole(
    user: AuthenticatedUser,
    projectId: string,
    allowedRoles: Array<'owner' | 'editor' | 'viewer'>,
    reply: FastifyReply
  ): Promise<boolean> {
    if (!isValidPrefixedId(projectId, 'prj')) {
      reply.code(400).send({ error: 'Invalid project ID' });
      return false;
    }
    if (user.role === 'admin') return true;
    const res = await db.query<{ role: 'owner' | 'editor' | 'viewer' }>(
      `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [projectId, user.id]
    );
    const memberRole = res.rows[0]?.role;
    if (!memberRole || !allowedRoles.includes(memberRole)) {
      reply.code(403).send({ error: 'Not authorized for this project operation' });
      return false;
    }
    return true;
  }

  async function requireAdmin(
    req: FastifyRequest,
    reply: FastifyReply,
    requiredScope: string
  ): Promise<{ actor: string; userId?: string; tokenId?: string; ciSub?: string } | null> {
    const bearer = await sessions.validateBearerAdminCredential(req.headers.authorization);
    if (bearer) {
      if (!bearer.scopes.includes('*') && !bearer.scopes.includes(requiredScope)) {
        reply.code(403).send({ error: `Missing required scope: ${requiredScope}` });
        return null;
      }
      return bearer.kind === 'pat'
        ? { actor: `pat:${bearer.actorId}`, tokenId: bearer.actorId }
        : { actor: `ci:${bearer.actorId}`, ciSub: bearer.actorId };
    }
    const user = await requireHubUser(req, reply);
    if (!user) return null;
    if (user.role !== 'admin') {
      reply.code(403).send({ error: 'Administrator role required' });
      return null;
    }
    return { actor: user.email, userId: user.id };
  }

  async function requireWorkloadJwt(req: FastifyRequest, reply: FastifyReply): Promise<WorkloadJwtClaims | null> {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Workload JWT required' });
      return null;
    }
    try {
      return await ca.verifyWorkloadJwt(auth.slice('Bearer '.length).trim());
    } catch {
      reply.code(401).send({ error: 'Invalid or expired Workload JWT' });
      return null;
    }
  }

  // Subdomain reverse-proxy hook for `<prj>.editors.*`, `<prj>.reports.*`, `<pub>.reports.*`
  app.addHook('onRequest', async (req, reply) => {
    const subRoute = parseSubdomainHost(req.headers.host, cfg);
    if (subRoute) {
      await editorProxy.handleHttpRequest(subRoute, req, reply);
      return reply;
    }
  });

  app.server.on('upgrade', (req, socket, head) => {
    editorProxy.handleWebSocketUpgrade(req, socket, head).catch(() => socket.destroy());
  });

  // --- Health & Public Latest Redirects (exact + subpath, Reviewer 2 #3) ---
  app.get('/healthz', async () => ({ ok: true, hubId: cfg.hubId, role: cfg.role }));

  const handleLatestRedirect = async (slug: string, rest: string, reply: FastifyReply) => {
    const ver = await publishService.resolveLatestPublicVersion(slug);
    if (!ver) return reply.code(404).send({ error: 'No public publication found' });
    const cleanRest = rest.replace(/^\/+/, '') || 'index.html';
    reply.header('Cache-Control', 'no-store').redirect(`/reports/${slug}/v${ver}/${cleanRest}`);
  };
  app.get<{ Params: { slug: string } }>('/_public/reports/:slug/latest', async (req, reply) =>
    handleLatestRedirect(req.params.slug, 'index.html', reply)
  );
  app.get<{ Params: { slug: string; '*': string } }>('/_public/reports/:slug/latest/*', async (req, reply) =>
    handleLatestRedirect(req.params.slug, req.params['*'] || 'index.html', reply)
  );

  // --- Interactive Auth (OIDC + PKCE, Demo Local Email/Password Auth, Subdomain Handoff) ---
  app.get('/api/v1/auth/providers', async () => ({
    oidcEnabled: oidc.isOidcConfigured(),
    localAuthEnabled: cfg.localAuthEnabled,
    devMode: cfg.devMode,
    publicReportsRequireAuth: cfg.publicReportsRequireAuth
  }));

  // Demo-only local email/password sign-in (HUB_LOCAL_AUTH_ENABLED=true)
  app.post('/api/v1/auth/local/login', async (req, reply) => {
    if (!cfg.localAuthEnabled) {
      return reply.code(404).send({ error: 'Local email/password login is disabled on this deployment' });
    }
    const body = (req.body || {}) as { email?: string; password?: string };
    const user = await localAuth.authenticatePassword(String(body.email || ''), String(body.password || ''), req.ip);
    const sess = await sessions.createHubSession(user.id, {
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || '')
    });
    await sessions.recordAudit({
      actorUserId: user.id,
      action: 'auth.local.login',
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: req.ip
    });
    return reply.header('Set-Cookie', sess.cookieHeader).send({ user });
  });

  // Demo-only invited user password setup (consumes single-use setup token tied to email)
  app.post('/api/v1/auth/local/setup-password', async (req, reply) => {
    if (!cfg.localAuthEnabled) {
      return reply.code(404).send({ error: 'Local email/password setup is disabled on this deployment' });
    }
    const body = (req.body || {}) as { email?: string; token?: string; password?: string };
    const user = await localAuth.completePasswordSetup({
      email: String(body.email || ''),
      token: String(body.token || ''),
      password: String(body.password || '')
    });
    const sess = await sessions.createHubSession(user.id, {
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || '')
    });
    await sessions.recordAudit({
      actorUserId: user.id,
      action: 'auth.local.password_set',
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: req.ip
    });
    return reply.header('Set-Cookie', sess.cookieHeader).send({ user });
  });

  app.get('/api/v1/auth/oidc/login', async (req, reply) => {
    if (!oidc.isOidcConfigured()) {
      return reply.code(400).send({ error: 'OIDC is not configured on this Hub instance' });
    }
    const returnTo = String((req.query as any)?.returnTo || '/');
    const url = await oidc.buildAuthorizationUrl(returnTo);
    return reply.redirect(url);
  });

  app.get('/api/v1/auth/oidc/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string };
    if (!q.code || !q.state) return reply.code(400).send({ error: 'Missing code or state' });
    const { user, returnTo } = await oidc.handleCallback(q.code, q.state);
    const sess = await sessions.createHubSession(user.id, {
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || '')
    });
    return reply.header('Set-Cookie', sess.cookieHeader).redirect(returnTo);
  });

  app.post('/api/v1/auth/dev-login', async (req, reply) => {
    if (!cfg.devMode) return reply.code(404).send({ error: 'Not found' });
    const body = (req.body || {}) as { email?: string; displayName?: string };
    const email = (body.email || cfg.bootstrapAdminEmail || 'admin@bionic.localhost').toLowerCase().trim();
    const user = await oidc.upsertOidcUser({
      issuer: 'dev://local',
      sub: `dev:${email}`,
      email,
      emailVerified: true,
      displayName: body.displayName || email.split('@')[0]
    });
    const sess = await sessions.createHubSession(user.id, { ip: req.ip });
    return reply.header('Set-Cookie', sess.cookieHeader).send({ user });
  });

  app.get('/api/v1/auth/me', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    return { user };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    if (user.sessionId) await sessions.revokeHubSession(user.sessionId);
    const cookieName = cookieNameForScope('hub', cfg.devMode);
    // Security #12: Use serializeHostOnlyCookie so __Host- cookie includes Secure flag on clear!
    return reply.header('Set-Cookie', serializeHostOnlyCookie(cookieName, '', 0, cfg.devMode)).send({ success: true });
  });

  app.get('/api/v1/auth/handoff', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user || !user.sessionId) return;
    const q = req.query as { scope?: string; resource?: string; next?: string };
    const scope = q.scope as OriginScope;
    const resourceId = String(q.resource || '');
    const next = String(q.next || '/');
    const validResource =
      scope === 'public_reports_site' ? resourceId === 'site' : /^(prj|pub)-[a-z0-9]+$/.test(resourceId);
    if (!['editor', 'live_report', 'publication', 'public_reports_site'].includes(scope) || !validResource) {
      return reply.code(400).send({ error: 'Invalid handoff scope or resource' });
    }

    if (scope === 'editor' || scope === 'live_report') {
      const mRes = await db.query<{ role: string }>(
        `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
        [resourceId, user.id]
      );
      const role = mRes.rows[0]?.role;
      if (scope === 'editor' && role !== 'owner' && role !== 'editor' && user.role !== 'admin') {
        return reply.code(403).send({ error: 'Viewers cannot open interactive Editor VMs; inspect published reports instead.' });
      }
      if (scope === 'live_report' && !role && user.role !== 'admin') {
        return reply.code(403).send({ error: 'Not authorized to view this project report' });
      }
    } else if (scope === 'publication') {
      const pRes = await db.query(
        `SELECT pub.visibility, pm.role FROM publications pub
         LEFT JOIN project_members pm ON pm.project_id = pub.project_id AND pm.user_id = $2
         WHERE pub.id = $1 AND pub.status = 'ready'`,
        [resourceId, user.id]
      );
      const row = pRes.rows[0];
      if (!row || (row.visibility === 'private' && !row.role && user.role !== 'admin')) {
        return reply.code(403).send({ error: 'Not authorized to view this publication' });
      }
    }

    const scheme = cfg.devMode ? 'http' : 'https';
    const portSuffix = cfg.devMode && cfg.port !== 80 && cfg.port !== 443 ? `:${cfg.port}` : '';
    const targetOrigin =
      scope === 'public_reports_site'
        ? cfg.publicReportsOrigin
        : `${scheme}://${resourceId}.${scope === 'editor' ? 'editors' : 'reports'}.${cfg.domain}${portSuffix}`;

    const code = await sessions.createSubdomainHandoffCode({
      userId: user.id,
      parentSessionId: user.sessionId,
      targetOrigin,
      scope,
      resourceId
    });
    return reply.redirect(`${targetOrigin}/__bionic_auth/callback?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`);
  });

  // --- Templates & Projects & Reproducible Runs API (ALL guarded by requireProjectRole, #1!) ---
  app.get('/api/v1/templates', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    const res = await db.query(
      `SELECT t.slug, t.display_name, t.description, t.default_idle_timeout_min, t.max_idle_timeout_min
       FROM templates t
       WHERE $1 = 'admin' OR 'admins' = ANY($2::text[]) OR t.allowed_group_ids && $2::text[]
       ORDER BY t.slug ASC`,
      [user.role, user.groupSlugs]
    );
    return { templates: res.rows };
  });

  app.get('/api/v1/projects', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    const res = await db.query(
      `SELECT p.id, p.slug, p.name, p.description, p.template_slug, p.status, p.idle_timeout_minutes,
              p.last_activity_at, p.frozen_at, p.created_at, pm.role AS my_role
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
       WHERE p.status <> 'deleted'
       ORDER BY p.updated_at DESC`,
      [user.id]
    );
    return { projects: res.rows };
  });

  app.post('/api/v1/projects', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    if (user.role === 'viewer') return reply.code(403).send({ error: 'Viewers cannot create projects' });
    const body = (req.body || {}) as any;
    const created = await orchestrator.createProject({
      user,
      name: String(body.name || 'Untitled Analysis'),
      description: String(body.description || ''),
      templateSlug: body.templateSlug,
      idleTimeoutMinutes: body.idleTimeoutMinutes ? Number(body.idleTimeoutMinutes) : undefined,
      fromPublicationId: body.fromPublicationId
    });
    await sessions.recordAudit({
      actorUserId: user.id,
      action: body.fromPublicationId ? 'project.fork' : 'project.create',
      resourceType: 'project',
      resourceId: created.id,
      metadata: { templateSlug: body.templateSlug, fromPublicationId: body.fromPublicationId },
      ipAddress: req.ip
    });
    return reply.code(201).send(created);
  });

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/wake', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    if (!(await requireProjectRole(user, req.params.id, ['owner', 'editor'], reply))) return;
    return orchestrator.requestWakeProject(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/freeze', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    if (!(await requireProjectRole(user, req.params.id, ['owner', 'editor'], reply))) return;
    return orchestrator.requestTransition(req.params.id, 'freeze');
  });

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/stop', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    if (!(await requireProjectRole(user, req.params.id, ['owner', 'editor'], reply))) return;
    return orchestrator.requestTransition(req.params.id, 'stop');
  });

  app.delete<{ Params: { id: string } }>('/api/v1/projects/:id', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    if (!(await requireProjectRole(user, req.params.id, ['owner'], reply))) return;
    return orchestrator.requestTransition(req.params.id, 'delete');
  });

  // --- Publications Catalog & Headless Reproducible Module Runs ---
  app.get('/api/v1/publications', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    const res = await db.query(
      `SELECT pub.id, pub.project_id, pub.version, pub.title, pub.summary, pub.git_commit_sha,
              pub.template_slug, pub.static_site_url, pub.visibility, pub.test_results_json,
              pub.published_at, p.slug AS project_slug
       FROM publications pub
       JOIN projects p ON p.id = pub.project_id
       LEFT JOIN project_members pm ON pm.project_id = pub.project_id AND pm.user_id = $1
       WHERE pub.status = 'ready'
         AND (pub.visibility IN ('public', 'org') OR pm.user_id IS NOT NULL OR $2 = 'admin')
       ORDER BY pub.published_at DESC`,
      [user.id, user.role]
    );
    return { publications: res.rows };
  });

  app.post<{ Params: { pubId: string } }>('/api/v1/publications/:pubId/downgrade', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    const pubRes = await db.query<{ project_id: string }>(`SELECT project_id FROM publications WHERE id = $1`, [req.params.pubId]);
    if (!pubRes.rows[0]) return reply.code(404).send({ error: 'Publication not found' });
    if (!(await requireProjectRole(user, pubRes.rows[0].project_id, ['owner'], reply))) return;
    const vis = (req.body as any)?.visibility === 'org' ? 'org' : 'private';
    await publishService.downgradeVisibility(req.params.pubId, vis);
    return { success: true, visibility: vis };
  });

  app.post<{ Params: { pubId: string } }>('/api/v1/publications/:pubId/runs', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    const body = (req.body || {}) as { maxDurationSec?: number };
    const run = await orchestrator.triggerReproRun({
      user,
      publicationId: req.params.pubId,
      maxDurationSec: body.maxDurationSec
    });
    return reply.code(201).send(run);
  });

  app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    const res = await db.query(`SELECT * FROM runs WHERE id = $1`, [req.params.runId]);
    const run = res.rows[0];
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    if (run.triggered_by !== user.id && user.role !== 'admin') {
      return reply.code(403).send({ error: 'Not authorized to view this run' });
    }
    return { run };
  });

  app.post<{ Params: { runId: string } }>('/api/v1/runs/:runId/cancel', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    const res = await db.query(`SELECT id, triggered_by, status FROM runs WHERE id = $1`, [req.params.runId]);
    const run = res.rows[0];
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    if (run.triggered_by !== user.id && user.role !== 'admin') {
      return reply.code(403).send({ error: 'Not authorized to cancel this run' });
    }
    await db.query(
      `UPDATE runs SET status = 'cancelled', completed_at = NOW() WHERE id = $1 AND status IN ('queued', 'building_env', 'hydrating', 'running')`,
      [run.id]
    );
    return { success: true };
  });

  // --- Large Data Upload & Local Fallback Upload (ALL guarded by requireProjectRole, #1 + #5) ---
  const sanitizeRawTargetRel = (raw: string, filename: string): string => {
    const cleaned = (raw || `data/raw/${path.basename(filename)}`).replace(/^\/+/, '');
    if (cleaned.includes('..') || !cleaned.startsWith('data/raw/')) {
      throw Object.assign(new Error('targetRelPath must be inside data/raw/'), { statusCode: 400 });
    }
    return cleaned;
  };

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/data/upload-session', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    if (!(await requireProjectRole(user, req.params.id, ['owner', 'editor'], reply))) return;
    const body = (req.body || {}) as any;
    const filename = String(body.filename || '');
    const session = await storageService.initiateUploadSession({
      projectId: req.params.id,
      userId: user.id,
      filename,
      sizeBytes: Number(body.sizeBytes || 0),
      contentType: body.contentType,
      targetRelPath: sanitizeRawTargetRel(String(body.targetRelPath || ''), filename),
      description: body.description
    });
    return reply.code(201).send(session);
  });

  app.put<{ Params: { id: string; dataObjectId: string } }>('/api/v1/projects/:id/data/local-upload/:dataObjectId', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    if (!(await requireProjectRole(user, req.params.id, ['owner', 'editor'], reply))) return;
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
    await storageService.writeLocalUploadedBytes(req.params.id, req.params.dataObjectId, buf);
    return { success: true, bytes: buf.length };
  });

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/data/upload-complete', async (req, reply) => {
    const user = await requireHubUser(req, reply);
    if (!user) return;
    if (!(await requireProjectRole(user, req.params.id, ['owner', 'editor'], reply))) return;
    const body = (req.body || {}) as any;
    const pRes = await db.query<{ status: string }>(`SELECT status FROM projects WHERE id = $1`, [req.params.id]);
    const completed = await storageService.completeUpload({
      projectId: req.params.id,
      dataObjectId: String(body.dataObjectId || ''),
      clientSha256: String(body.clientSha256 || ''),
      targetRelPath: sanitizeRawTargetRel(String(body.targetRelPath || ''), 'data.bin'),
      projectIsRunning: pRes.rows[0]?.status === 'running'
    });
    return completed;
  });

  // --- Internal VM Endpoints (Strict GCE Attestation #4, Data Push/Pull/Stream #5, Publish Intake #15) ---
  app.post('/api/internal/vm/attest', async (req, reply) => {
    const body = (req.body || {}) as { identityJwt?: string; csrPem?: string; devProjectId?: string; devInstanceId?: string };
    if (!body.csrPem) return reply.code(400).send({ error: 'csrPem is required' });

    let projectId: string;
    let instanceId: string;
    let gceProjectId: string | undefined;
    let gceZone: string | undefined;

    if (cfg.devMode && body.devProjectId && body.devInstanceId && !body.identityJwt) {
      projectId = body.devProjectId;
      instanceId = body.devInstanceId;
    } else {
      if (!cfg.gcpProjectId) return reply.code(500).send({ error: 'GCP_PROJECT_ID not configured' });
      if (!body.identityJwt) return reply.code(400).send({ error: 'identityJwt is required' });
      const gce = await ca.verifyGceIdentityJwt(body.identityJwt, `${cfg.hubOrigin}/attest`);
      // Security #4: Verify Google-signed GCP project_id strictly matches our Hub's GCP project!
      if (gce.projectId !== cfg.gcpProjectId) {
        return reply.code(403).send({ error: 'GCE identity token project_id mismatch' });
      }
      projectId = gce.instanceName;
      instanceId = gce.instanceId;
      gceProjectId = gce.projectId;
      gceZone = gce.zone;
    }

    const projRes = await db.query(
      `SELECT id, status, compute_instance_id, compute_instance_name, compute_zone FROM projects WHERE id = $1`,
      [projectId]
    );
    const proj = projRes.rows[0];
    if (!proj || !ATTESTABLE_STATES.has(proj.status)) {
      return reply.code(403).send({ error: `Project ${projectId} is not in an attestable state` });
    }
    if (!cfg.devMode) {
      if (!proj.compute_instance_id || proj.compute_instance_id !== instanceId) {
        return reply.code(403).send({ error: 'GCE instance_id mismatch or not yet provisioned' });
      }
      if (gceZone && proj.compute_zone && gceZone !== proj.compute_zone) {
        return reply.code(403).send({ error: 'GCE zone mismatch' });
      }
      if (proj.compute_instance_name && proj.compute_instance_name !== projectId) {
        return reply.code(403).send({ error: 'GCE instance_name mismatch' });
      }
    } else if (proj.compute_instance_id && proj.compute_instance_id !== instanceId) {
      return reply.code(403).send({ error: 'instance_id mismatch' });
    }

    const issued = await ca.signVmCsr({ csrPem: body.csrPem, projectId, instanceId, ttlHours: 72 });
    const workloadJwt = await ca.mintWorkloadJwt({ projectId, vmInstanceId: instanceId, kind: 'editor' }, 900);

    // Resolve and persist authoritative internal VPC IP from GCE (or fallback to private req.ip)
    let resolvedInternalIp: string | null = null;
    try {
      const zone = gceZone || proj.compute_zone || cfg.gcpDefaultZone;
      const instName = proj.compute_instance_name || projectId;
      const instInfo = await compute.getInstance(zone, instName);
      if (instInfo?.internalIp) resolvedInternalIp = instInfo.internalIp;
    } catch {
      // Fallback below
    }
    if (!resolvedInternalIp && req.ip && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)/.test(req.ip)) {
      resolvedInternalIp = req.ip;
    }

    await db.query(
      `UPDATE projects
       SET compute_instance_id = COALESCE(compute_instance_id, $2),
           compute_internal_ip = COALESCE($5, compute_internal_ip),
           vm_cert_serial = $3,
           vm_cert_expires_at = $4,
           vm_attested_at = NOW(),
           status = CASE WHEN status IN ('starting', 'resuming') THEN 'running' ELSE status END,
           updated_at = NOW()
       WHERE id = $1`,
      [projectId, instanceId, issued.serialHex, issued.expiresAt, resolvedInternalIp]
    );
    await db.notify('project_state_changes', {
      projectId,
      status: 'running',
      attested: true,
      internalIp: resolvedInternalIp,
      gceProjectId
    });

    return {
      certPem: issued.certPem,
      caCertPem: issued.caCertPem,
      expiresAt: issued.expiresAt.toISOString(),
      workloadJwt
    };
  });

  // Zero-trust server-side Publish Intake (verifies claimed triggering user belongs to project, #15!)
  app.post<{ Params: { id: string } }>('/api/internal/projects/:id/publish-intake', async (req, reply) => {
    const workload = await requireWorkloadJwt(req, reply);
    if (!workload || workload.projectId !== req.params.id) {
      if (workload) reply.code(403).send({ error: 'Workload JWT project mismatch' });
      return;
    }
    const rawBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
    const claimedUser = String(req.headers['x-bionic-triggering-user'] || '');
    const pRes = await db.query(
      `SELECT p.owner_id, pm.role AS member_role
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
       WHERE p.id = $1`,
      [workload.projectId, claimedUser]
    );
    const row = pRes.rows[0];
    if (!row) return reply.code(404).send({ error: 'Project not found' });
    const verifiedPublisherId =
      claimedUser && (row.member_role === 'owner' || row.member_role === 'editor' || row.owner_id === claimedUser)
        ? claimedUser
        : row.owner_id;

    const visibility = (['private', 'org', 'public'].includes(String(req.headers['x-bionic-visibility']))
      ? String(req.headers['x-bionic-visibility'])
      : 'private') as 'private' | 'org' | 'public';

    const result = await publishService.publishFromIntake({
      projectId: workload.projectId,
      publishedByUserId: verifiedPublisherId,
      visibility,
      title: String(req.headers['x-bionic-title'] || 'Published Report').replace(/[\r\n\0]/g, ' ').slice(0, 140),
      summary: String(req.headers['x-bionic-summary'] || '').replace(/[\r\n\0]/g, ' ').slice(0, 1000),
      gitCommitSha: String(req.headers['x-bionic-git-commit'] || 'uncommitted'),
      reportTarballBuffer: rawBuf
    });
    return reply.code(201).send(result);
  });

  // VM Data Push/Pull/Stream Endpoints (#5 & Reviewer 2 #12)
  app.post('/api/internal/data/upload-session', async (req, reply) => {
    const workload = await requireWorkloadJwt(req, reply);
    if (!workload) return;
    const body = (req.body || {}) as any;
    const pRes = await db.query<{ owner_id: string }>(`SELECT owner_id FROM projects WHERE id = $1`, [workload.projectId]);
    const filename = String(body.filename || '');
    return storageService.initiateUploadSession({
      projectId: workload.projectId,
      userId: pRes.rows[0]?.owner_id || '',
      filename,
      sizeBytes: Number(body.sizeBytes || 0),
      targetRelPath: sanitizeRawTargetRel(String(body.targetRelPath || ''), filename)
    });
  });

  app.post('/api/internal/data/upload-complete', async (req, reply) => {
    const workload = await requireWorkloadJwt(req, reply);
    if (!workload) return;
    const body = (req.body || {}) as any;
    return storageService.completeUpload({
      projectId: workload.projectId,
      dataObjectId: String(body.dataObjectId || ''),
      clientSha256: String(body.clientSha256 || ''),
      targetRelPath: String(body.targetRelPath || ''),
      projectIsRunning: true
    });
  });

  app.post('/api/internal/data/read-url', async (req, reply) => {
    const workload = await requireWorkloadJwt(req, reply);
    if (!workload) return;
    const body = (req.body || {}) as { dataObjectId?: string };
    return storageService.mintAuthorizedReadUrl(workload.projectId, String(body.dataObjectId || ''));
  });

  app.get<{ Params: { projectId: string; dataObjectId: string } }>('/api/internal/data/stream/:projectId/:dataObjectId', async (req, reply) => {
    const tok = String((req.query as any)?.token || '');
    const validSigned = storageService.verifyStreamToken(req.params.projectId, req.params.dataObjectId, tok);
    if (!validSigned) {
      const workload = await requireWorkloadJwt(req, reply);
      if (!workload || workload.projectId !== req.params.projectId) {
        if (workload) reply.code(403).send({ error: 'Forbidden' });
        return;
      }
    }
    const streamInfo = await storageService.openAuthorizedReadStream(req.params.projectId, req.params.dataObjectId);
    if (streamInfo.gcsUrl && streamInfo.gcsBearer) {
      const gcsRes = await fetch(streamInfo.gcsUrl, { headers: { Authorization: `Bearer ${streamInfo.gcsBearer}` } });
      reply.hijack();
      reply.raw.writeHead(gcsRes.status, { 'Content-Type': streamInfo.contentType });
      if (gcsRes.body) {
        for await (const chunk of gcsRes.body as any) reply.raw.write(chunk);
      }
      reply.raw.end();
      return;
    }
    if (streamInfo.localFilePath && fs.existsSync(streamInfo.localFilePath)) {
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': streamInfo.contentType });
      fs.createReadStream(streamInfo.localFilePath).pipe(reply.raw);
      return;
    }
    reply.code(404).send({ error: 'Data object file missing' });
  });

  // Central Git Smart HTTP Proxy (H3 + #3)
  app.all<{ Params: { projectId: string; '*': string } }>('/api/internal/git/:projectId.git/*', async (req, reply) => {
    const workload = await requireWorkloadJwt(req, reply);
    if (!workload) return;
    await gitProxy.handleProxyRequest(req.params.projectId, req.params['*'] || '', workload, req, reply);
    return reply;
  });

  app.get('/api/internal/models', async (req, reply) => {
    const workload = await requireWorkloadJwt(req, reply);
    if (!workload) return;
    const grpRes = await db.query<{ slug: string }>(
      `SELECT g.slug FROM projects p
       JOIN group_memberships gm ON gm.user_id = p.owner_id
       JOIN groups g ON g.id = gm.group_id
       WHERE p.id = $1`,
      [workload.projectId]
    );
    const models = await llmGateway.listModelsForUser(grpRes.rows.map((r) => r.slug));
    return { hubManaged: true, models };
  });

  // --- Native Multi-Protocol LLM Gateway (wrapped in try/finally to NEVER leak reservations, #8!) ---
  app.post('/llm/anthropic/v1/messages', async (req, reply) => {
    const workload = await requireWorkloadJwt(req, reply);
    if (!workload) return;
    const body = (req.body || {}) as Record<string, any>;
    const startedAt = Date.now();
    const authz = await llmGateway.authorizeAndReserve({
      workload,
      claimedUserId: req.headers['x-bionic-triggering-user'] as string | undefined,
      modelSlug: String(body.model || '')
    });
    let usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, statusCode: 500 };
    try {
      usage = await llmGateway.proxyAnthropicMessages(authz.model, body, reply);
    } finally {
      await llmGateway.settleUsage({
        projectId: workload.projectId,
        userId: authz.userId,
        model: authz.model,
        reservationId: authz.reservationId,
        userScopeKey: authz.userScopeKey,
        projectScopeKey: authz.projectScopeKey,
        estimatedCostUsd: authz.estimatedCostUsd,
        ...usage,
        latencyMs: Date.now() - startedAt
      });
    }
    return reply;
  });

  app.post('/llm/openai/v1/chat/completions', async (req, reply) => {
    const workload = await requireWorkloadJwt(req, reply);
    if (!workload) return;
    const body = (req.body || {}) as Record<string, any>;
    const startedAt = Date.now();
    const authz = await llmGateway.authorizeAndReserve({
      workload,
      claimedUserId: req.headers['x-bionic-triggering-user'] as string | undefined,
      modelSlug: String(body.model || '')
    });
    let usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, statusCode: 500 };
    try {
      usage = await llmGateway.proxyOpenAiChat(authz.model, body, reply);
    } finally {
      await llmGateway.settleUsage({
        projectId: workload.projectId,
        userId: authz.userId,
        model: authz.model,
        reservationId: authz.reservationId,
        userScopeKey: authz.userScopeKey,
        projectScopeKey: authz.projectScopeKey,
        estimatedCostUsd: authz.estimatedCostUsd,
        ...usage,
        latencyMs: Date.now() - startedAt
      });
    }
    return reply;
  });

  app.post<{ Params: { modelAction: string } }>('/llm/google/v1beta/models/:modelAction', async (req, reply) => {
    const workload = await requireWorkloadJwt(req, reply);
    if (!workload) return;
    const [modelSlug, action = 'streamGenerateContent'] = req.params.modelAction.split(':');
    const startedAt = Date.now();
    const authz = await llmGateway.authorizeAndReserve({
      workload,
      claimedUserId: req.headers['x-bionic-triggering-user'] as string | undefined,
      modelSlug
    });
    let usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, statusCode: 500 };
    try {
      usage = await llmGateway.proxyGoogleGemini(authz.model, action, (req.body || {}) as any, reply);
    } finally {
      await llmGateway.settleUsage({
        projectId: workload.projectId,
        userId: authz.userId,
        model: authz.model,
        reservationId: authz.reservationId,
        userScopeKey: authz.userScopeKey,
        projectScopeKey: authz.projectScopeKey,
        estimatedCostUsd: authz.estimatedCostUsd,
        ...usage,
        latencyMs: Date.now() - startedAt
      });
    }
    return reply;
  });

  // --- SSRF-Hardened Remote MCP Gateway ---
  app.all<{ Params: { slug: string } }>('/mcp/:slug', async (req, reply) => {
    const workload = await requireWorkloadJwt(req, reply);
    if (!workload) return;
    await mcpGateway.proxyMcpRequest(
      req.params.slug,
      workload,
      req.headers['x-bionic-triggering-user'] as string | undefined,
      req,
      reply
    );
    return reply;
  });

  // --- Demo Manual User Management API (Admin only, when HUB_LOCAL_AUTH_ENABLED=true) ---
  app.get('/api/v1/admin/users', async (req, reply) => {
    const admin = await requireAdmin(req, reply, 'admin:users');
    if (!admin) return;
    return { users: await localAuth.listUsers() };
  });

  app.post('/api/v1/admin/users/invite', async (req, reply) => {
    if (!cfg.localAuthEnabled) {
      return reply.code(400).send({ error: 'Manual user invites require HUB_LOCAL_AUTH_ENABLED=true' });
    }
    const admin = await requireAdmin(req, reply, 'admin:users');
    if (!admin) return;
    const body = (req.body || {}) as { email?: string; displayName?: string; role?: string; ttlHours?: number };
    const role = (['admin', 'researcher', 'viewer'].includes(String(body.role)) ? String(body.role) : 'researcher') as
      | 'admin'
      | 'researcher'
      | 'viewer';
    const invite = await localAuth.inviteUser({
      email: String(body.email || ''),
      displayName: body.displayName,
      role,
      invitedByUserId: admin.userId,
      ttlHours: body.ttlHours
    });
    await sessions.recordAudit({
      actorUserId: admin.userId,
      actorTokenId: admin.tokenId,
      action: 'admin.user.invite',
      resourceType: 'user',
      resourceId: invite.userId,
      metadata: { email: invite.email, role: invite.role },
      ipAddress: req.ip
    });
    return reply.code(201).send(invite);
  });

  app.post<{ Params: { userId: string } }>('/api/v1/admin/users/:userId/status', async (req, reply) => {
    const admin = await requireAdmin(req, reply, 'admin:users');
    if (!admin) return;
    const status = (req.body as any)?.status === 'disabled' ? 'disabled' : 'active';
    await localAuth.setUserStatus(req.params.userId, status);
    await sessions.recordAudit({
      actorUserId: admin.userId,
      action: 'admin.user.status',
      resourceType: 'user',
      resourceId: req.params.userId,
      metadata: { status },
      ipAddress: req.ip
    });
    return { success: true, status };
  });

  // --- Declarative GitOps Admin Config & Token API ---
  app.post('/api/v1/admin/tokens', async (req, reply) => {
    const admin = await requireAdmin(req, reply, 'admin:tokens');
    if (!admin || !admin.userId) {
      if (admin) reply.code(403).send({ error: 'Interactive admin session required to mint API tokens' });
      return;
    }
    const body = (req.body || {}) as { name?: string; scopes?: string[]; expiresInDays?: number };
    const created = await sessions.createApiToken({
      name: String(body.name || 'ci-token'),
      createdBy: admin.userId,
      scopes: Array.isArray(body.scopes) && body.scopes.length ? body.scopes : ['config:read', 'config:write'],
      expiresInDays: body.expiresInDays
    });
    await sessions.recordAudit({
      actorUserId: admin.userId,
      action: 'admin.token.create',
      resourceType: 'api_token',
      resourceId: created.id,
      ipAddress: req.ip
    });
    return reply.code(201).send(created);
  });

  app.post('/api/v1/admin/config/apply', async (req, reply) => {
    const admin = await requireAdmin(req, reply, 'config:write');
    if (!admin) return;
    const body = (req.body || {}) as { items?: Array<{ kind: ConfigKind; contentYaml: string }>; gitCommitSha?: string; gitRepo?: string };
    const dryRun = String((req.query as any)?.dryRun || '') === 'true';
    const result = await adminConfig.applyConfigs({
      items: body.items || [],
      actor: admin.actor,
      gitCommitSha: body.gitCommitSha,
      gitRepo: body.gitRepo,
      dryRun
    });
    if (!dryRun) {
      await sessions.recordAudit({
        actorUserId: admin.userId,
        actorTokenId: admin.tokenId,
        actorCiSub: admin.ciSub,
        action: 'admin.config.apply',
        resourceType: 'config',
        resourceId: body.gitCommitSha || 'bulk',
        metadata: { changes: result.changes },
        ipAddress: req.ip
      });
    }
    return result;
  });

  app.put<{ Params: { kind: ConfigKind; slug: string } }>('/api/v1/admin/config/:kind/:slug', async (req, reply) => {
    const admin = await requireAdmin(req, reply, 'config:write');
    if (!admin) return;
    const contentYaml = String((req.body as any)?.contentYaml || '');
    const result = await adminConfig.applyConfigs({
      items: [{ kind: req.params.kind, contentYaml }],
      actor: admin.actor
    });
    await sessions.recordAudit({
      actorUserId: admin.userId,
      actorTokenId: admin.tokenId,
      actorCiSub: admin.ciSub,
      action: 'admin.config.upsert',
      resourceType: req.params.kind,
      resourceId: req.params.slug,
      metadata: { changes: result.changes },
      ipAddress: req.ip
    });
    return result;
  });

  app.get<{ Params: { kind: ConfigKind } }>('/api/v1/admin/config/:kind', async (req, reply) => {
    const admin = await requireAdmin(req, reply, 'config:read');
    if (!admin) return;
    if (!['template', 'model', 'skill', 'mcp'].includes(req.params.kind)) {
      return reply.code(400).send({ error: 'Invalid config kind' });
    }
    return { items: await adminConfig.listActiveConfigs(req.params.kind) };
  });

  app.post<{ Params: { kind: ConfigKind; slug: string } }>('/api/v1/admin/config/:kind/:slug/rollback', async (req, reply) => {
    const admin = await requireAdmin(req, reply, 'config:write');
    if (!admin) return;
    const version = Number((req.body as any)?.version || 0);
    if (version < 1) return reply.code(400).send({ error: 'version >= 1 required' });
    const out = await adminConfig.rollbackConfig(req.params.kind, req.params.slug, version);
    await sessions.recordAudit({
      actorUserId: admin.userId,
      actorTokenId: admin.tokenId,
      actorCiSub: admin.ciSub,
      action: 'admin.config.rollback',
      resourceType: req.params.kind,
      resourceId: req.params.slug,
      metadata: out,
      ipAddress: req.ip
    });
    return out;
  });

  app.get('/api/v1/admin/images/in-use', async (req, reply) => {
    const admin = await requireAdmin(req, reply, 'config:read');
    if (!admin) return;
    return { images: await adminConfig.getImagesInUse() };
  });

  app.get('/api/v1/admin/audit-logs', async (req, reply) => {
    const admin = await requireAdmin(req, reply, 'config:read');
    if (!admin) return;
    const res = await db.query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200`);
    return { logs: res.rows };
  });

  // Serve built Hub UI (`hub/client/dist` — fixed path `../../client/dist` + `/assets/*`!)
  const candidateClientDists = [
    path.resolve(__dirname, '../../client/dist'),
    path.resolve(__dirname, '../../../hub/client/dist')
  ];
  const clientDist = candidateClientDists.find((p) => fs.existsSync(path.join(p, 'index.html')));
  if (clientDist) {
    app.get('/', async (_req, reply) => {
      return reply.type('text/html; charset=utf-8').send(fs.readFileSync(path.join(clientDist, 'index.html'), 'utf-8'));
    });
    app.get<{ Params: { '*': string } }>('/assets/*', async (req, reply) => {
      const rel = (req.params['*'] || '').replace(/^\/+/, '');
      if (!rel || rel.includes('..')) return reply.code(403).send({ error: 'Forbidden' });
      const full = path.resolve(clientDist, 'assets', rel);
      if (!full.startsWith(path.resolve(clientDist, 'assets') + path.sep) || !fs.existsSync(full)) {
        return reply.code(404).send({ error: 'Asset not found' });
      }
      const ext = path.extname(full).toLowerCase();
      const mime = ext === '.js' ? 'application/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
      return reply.type(mime).header('Cache-Control', 'public, max-age=31536000, immutable').send(fs.readFileSync(full));
    });
  }

  return {
    app,
    cfg,
    db,
    ca,
    sessions,
    adminConfig,
    orchestrator,
    publishService,
    storageService,
    workers,
    close: async () => {
      workers.stop();
      await app.close();
      await db.close();
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  createHubServer()
    .then(async (hub) => {
      await hub.db.startListener();
      if (hub.cfg.localAuthEnabled) {
        const localBootstrap = new LocalAuthService(hub.db, hub.cfg);
        await localBootstrap.ensureBootstrapDemoAdmin();
      }
      if (hub.cfg.role === 'all' || hub.cfg.role === 'worker') {
        hub.workers.start();
      }
      await hub.app.listen({ port: hub.cfg.port, host: hub.cfg.host });
      console.log(`🚀 Bionic Hub listening on ${hub.cfg.host}:${hub.cfg.port} (origin=${hub.cfg.hubOrigin})`);
    })
    .catch((err) => {
      console.error('Failed to start Bionic Hub:', err);
      process.exit(1);
    });
}
