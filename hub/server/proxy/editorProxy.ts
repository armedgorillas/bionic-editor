import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import type { Duplex } from 'stream';
import { GoogleAuth } from 'google-auth-library';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { HubConfig } from '../config.js';
import type { HubDatabase } from '../db/pool.js';
import type { SessionService } from '../auth/sessions.js';
import { cookieNameForScope, parseCookieHeader } from '../auth/sessions.js';
import type { HubCertificateAuthority } from '../auth/ca.js';
import { extractSpiffeSanFromPeerCert } from '../auth/ca.js';
import type { ProjectOrchestrator } from '../projects/orchestrator.js';

import type { OriginScope } from '../auth/sessions.js';
import type { PublishService } from '../publish/service.js';
import type { ComputeProvider } from '../compute/provider.js';

export interface ParsedOriginRoute {
  scope: OriginScope;
  resourceId: string;
  origin: string;
}

export function parseSubdomainHost(hostHeader: string | undefined, cfg: HubConfig): ParsedOriginRoute | null {
  if (!hostHeader) return null;
  const hostNoPort = hostHeader.split(':')[0].toLowerCase();
  const scheme = cfg.devMode ? 'http' : 'https';
  const origin = `${scheme}://${hostHeader.toLowerCase()}`;

  // Demo mode authenticated publication site (`public-reports.<domain>`)
  if (cfg.publicReportsRequireAuth) {
    const pubReportsHost = new URL(cfg.publicReportsOrigin).hostname.toLowerCase();
    if (hostNoPort === pubReportsHost) {
      return { scope: 'public_reports_site', resourceId: 'site', origin };
    }
  }

  const editorSuffix = `.editors.${cfg.domain.toLowerCase()}`;
  if (hostNoPort.endsWith(editorSuffix)) {
    const id = hostNoPort.slice(0, -editorSuffix.length);
    if (/^prj-[a-z0-9]+$/.test(id)) {
      return { scope: 'editor', resourceId: id, origin };
    }
  }

  const reportSuffix = `.reports.${cfg.domain.toLowerCase()}`;
  if (hostNoPort.endsWith(reportSuffix)) {
    const id = hostNoPort.slice(0, -reportSuffix.length);
    if (/^prj-[a-z0-9]+$/.test(id)) {
      return { scope: 'live_report', resourceId: id, origin };
    }
    if (/^pub-[a-z0-9]+$/.test(id)) {
      return { scope: 'publication', resourceId: id, origin };
    }
  }

  return null;
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.csv': 'text/csv; charset=utf-8'
  };
  return map[ext] || 'application/octet-stream';
}

function sanitizeHeaderLine(s: string): string {
  return s.replace(/[\r\n\0]/g, '');
}

/**
 * Authenticated mTLS Editor & Isolated Report / Private Publication Reverse Proxy:
 * - Intercepts `/__bionic_auth/callback` to consume 30s single-use handoff codes & set host-only cookies.
 * - Verifies VM cert `SAN === spiffe://bionic/project/<prj-id>` on every upstream connection.
 * - Serves authenticated private/org publications from `static-reports-private` (`scope === 'publication'`).
 * - Uses `reply.hijack()` on all raw/SSE responses and checks immediate status on `/__bionic_wake/events`.
 */
export class EditorReverseProxy {
  private readonly googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/devstorage.read_only']
  });

  constructor(
    private readonly db: HubDatabase,
    private readonly cfg: HubConfig,
    private readonly sessions: SessionService,
    private readonly ca: HubCertificateAuthority,
    private readonly orchestrator: ProjectOrchestrator,
    private readonly publishService?: PublishService,
    private readonly compute?: ComputeProvider
  ) {}

  async handleHttpRequest(route: ParsedOriginRoute, req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const urlPath = req.url || '/';

    // 1. Handle cross-subdomain single-use handoff callback (never proxied to VM)
    if (urlPath.startsWith('/__bionic_auth/callback')) {
      const q = new URL(urlPath, route.origin).searchParams;
      const code = q.get('code') || '';
      const next = q.get('next') || '/';
      const safeNext = next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';

      const consumed = await this.sessions.consumeSubdomainHandoffCode(code, route.origin);
      if (!consumed) {
        reply.code(401).send({ error: 'Invalid or expired authentication handoff code' });
        return;
      }
      reply.header('Set-Cookie', consumed.cookieHeader).redirect(safeNext);
      return;
    }

    // 2. Validate host-only scoped origin cookie
    const cookies = parseCookieHeader(req.headers.cookie);
    const cookieName = cookieNameForScope(route.scope, this.cfg.devMode);
    const scoped = await this.sessions.validateScopedOriginCookie(
      cookies[cookieName] || '',
      route.origin,
      route.scope,
      route.resourceId
    );
    if (!scoped) {
      const handoffUrl = `${this.cfg.hubOrigin}/api/v1/auth/handoff?scope=${route.scope}&resource=${encodeURIComponent(route.resourceId)}&next=${encodeURIComponent(urlPath)}`;
      reply.redirect(handoffUrl);
      return;
    }

    // 3. Authenticated private/org published reports (`<pub-id>.reports.<domain>`) — Security C3 + #5
    if (route.scope === 'publication') {
      await this.servePrivatePublicationAsset(route.resourceId, urlPath, reply);
      return;
    }

    // 3b. Demo-mode authenticated publication bucket (`public-reports.<domain>` when HUB_PUBLIC_REPORTS_REQUIRE_AUTH=true)
    if (route.scope === 'public_reports_site') {
      await this.serveAuthenticatedPublicSiteAsset(urlPath, reply);
      return;
    }

    // 4. Auto-Wake SSE progress stream (uses shared LISTEN EventEmitter + live mTLS readiness check, #16!)
    if (urlPath === '/__bionic_wake/events') {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      reply.raw.write('retry: 5000\n\n');

      let closed = false;
      let checking = false;
      let pollTimer: NodeJS.Timeout | null = null;
      let keepalive: NodeJS.Timeout | null = null;

      const sendEvent = (payload: Record<string, any>) => {
        if (closed || reply.raw.writableEnded) return;
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (keepalive) clearInterval(keepalive);
        this.db.events.off('project_state_changes', onState);
      };

      const checkReady = async () => {
        if (closed || checking) return;
        checking = true;
        try {
          const cur = await this.db.query<{
            status: string;
            status_message: string | null;
            compute_internal_ip: string | null;
            compute_zone: string | null;
            compute_instance_name: string | null;
          }>(
            `SELECT status, status_message, compute_internal_ip, compute_zone, compute_instance_name FROM projects WHERE id = $1`,
            [route.resourceId]
          );
          if (closed) return;
          const curRow = cur.rows[0];
          if (!curRow || curRow.status === 'error') {
            sendEvent({
              projectId: route.resourceId,
              status: 'error',
              ready: false,
              error: curRow?.status_message || 'Project unavailable'
            });
            cleanup();
            reply.raw.end();
            return;
          }

          let curIp = curRow.compute_internal_ip || null;
          if (curRow.status === 'running' && !curIp && this.compute && curRow.compute_instance_name) {
            try {
              const info = await this.compute.getInstance(
                curRow.compute_zone || this.cfg.gcpDefaultZone,
                curRow.compute_instance_name
              );
              if (info?.internalIp) {
                curIp = info.internalIp;
                await this.db.query(`UPDATE projects SET compute_internal_ip = $2, updated_at = NOW() WHERE id = $1`, [
                  route.resourceId,
                  curIp
                ]);
              }
            } catch {}
          }

          if (curRow.status === 'running' && curIp) {
            const vmReady = await this.isVmReady(route.resourceId, curIp, route.scope);
            if (closed) return;
            if (vmReady) {
              sendEvent({ projectId: route.resourceId, status: 'running', ready: true });
              cleanup();
              reply.raw.end();
              return;
            }
            sendEvent({
              projectId: route.resourceId,
              status: 'starting',
              detail: 'Waiting for editor service to accept connections…',
              ready: false
            });
            return;
          }

          sendEvent({ projectId: route.resourceId, status: curRow.status, ready: false });
        } finally {
          checking = false;
        }
      };

      const onState = (ev: any) => {
        if (closed || ev?.projectId !== route.resourceId) return;
        if (ev.status === 'running') {
          checkReady().catch(() => {});
          return;
        }
        sendEvent({ projectId: route.resourceId, status: ev.status, ready: false, error: ev.error });
        if (ev.status === 'error') {
          cleanup();
          reply.raw.end();
        }
      };

      await checkReady();
      if (closed) return;

      this.db.events.on('project_state_changes', onState);
      pollTimer = setInterval(() => {
        checkReady().catch(() => {});
      }, 4_000);
      keepalive = setInterval(() => {
        if (!closed && !reply.raw.writableEnded) reply.raw.write(': keepalive\n\n');
      }, 15_000);
      reply.raw.on('close', cleanup);
      return;
    }

    // 5. Live Editor or live Report preview
    const projRes = await this.db.query(
      `SELECT id, status, compute_internal_ip, compute_zone, compute_instance_name FROM projects WHERE id = $1 AND status <> 'deleted'`,
      [route.resourceId]
    );
    const proj = projRes.rows[0];
    if (!proj) {
      reply.code(404).send({ error: 'Project not found' });
      return;
    }

    // Self-heal missing compute_internal_ip for already-running VMs by querying GCE directly
    let internalIp: string | null = proj.compute_internal_ip || null;
    if (proj.status === 'running' && !internalIp && this.compute && proj.compute_instance_name) {
      try {
        const info = await this.compute.getInstance(proj.compute_zone || this.cfg.gcpDefaultZone, proj.compute_instance_name);
        if (info?.internalIp) {
          internalIp = info.internalIp;
          await this.db.query(`UPDATE projects SET compute_internal_ip = $2, updated_at = NOW() WHERE id = $1`, [
            proj.id,
            internalIp
          ]);
        }
      } catch {}
    }

    if (proj.status !== 'running' || !internalIp) {
      if (['frozen', 'stopped', 'archived'].includes(proj.status)) {
        await this.orchestrator.requestWakeProject(proj.id);
      }
      reply.type('text/html; charset=utf-8').send(renderAutoWakeHtml(proj.id, proj.status));
      return;
    }

    if (!urlPath.includes('/health')) {
      this.db.query(`UPDATE projects SET last_activity_at = NOW() WHERE id = $1`, [proj.id]).catch(() => {});
    }

    await this.forwardHttpToVm(proj.id, internalIp, route, scoped.userId, req, reply);
  }

  private async servePrivatePublicationAsset(pubId: string, urlPath: string, reply: FastifyReply): Promise<void> {
    const pubRes = await this.db.query<{ artifact_storage_uri: string }>(
      `SELECT artifact_storage_uri FROM publications WHERE id = $1 AND status = 'ready'`,
      [pubId]
    );
    const uri = pubRes.rows[0]?.artifact_storage_uri;
    if (!uri) {
      reply.code(404).send({ error: 'Publication not found' });
      return;
    }

    let relPath: string;
    try {
      relPath = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    } catch {
      reply.code(400).send({ error: 'Invalid path encoding' });
      return;
    }
    if (relPath.includes('..') || relPath.includes('\0') || relPath.startsWith('_bionic_meta')) {
      reply.code(403).send({ error: 'Forbidden path' });
      return;
    }

    const mime = guessMimeType(relPath);
    if (uri.startsWith('gs://')) {
      const withoutScheme = uri.slice('gs://'.length);
      const slash = withoutScheme.indexOf('/');
      const bucket = withoutScheme.slice(0, slash);
      const prefix = withoutScheme.slice(slash + 1).replace(/\/+$/, '');
      const objectName = `${prefix}/${relPath}`;
      const client = await this.googleAuth.getClient();
      const { token } = await client.getAccessToken();
      const gcsRes = await fetch(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!gcsRes.ok) {
        reply.code(gcsRes.status === 404 ? 404 : 502).send({ error: 'Asset not found' });
        return;
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store'
      });
      if (gcsRes.body) {
        for await (const chunk of gcsRes.body as any) reply.raw.write(chunk);
      }
      reply.raw.end();
      return;
    }

    if (uri.startsWith('file://')) {
      const rootDir = path.resolve(uri.slice('file://'.length));
      const full = path.resolve(rootDir, relPath);
      if (full !== rootDir && !full.startsWith(rootDir + path.sep)) {
        reply.code(403).send({ error: 'Forbidden' });
        return;
      }
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store'
      });
      fs.createReadStream(full).pipe(reply.raw);
      return;
    }

    reply.code(404).send({ error: 'Unsupported publication artifact URI' });
  }

  /**
   * Demo-mode authenticated proxy for `public-reports.<domain>` so the publication GCS bucket
   * can enforce `public_access_prevention = "enforced"` (zero public IAM) while authenticated
   * demo users can still view all published reports seamlessly!
   */
  private async serveAuthenticatedPublicSiteAsset(urlPath: string, reply: FastifyReply): Promise<void> {
    let cleanPath: string;
    try {
      cleanPath = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
    } catch {
      reply.code(400).send({ error: 'Invalid path encoding' });
      return;
    }
    if (!cleanPath || cleanPath.includes('..') || cleanPath.includes('\0') || cleanPath.includes('_bionic_meta')) {
      reply.code(403).send({ error: 'Forbidden path' });
      return;
    }

    // Handle `/reports/<slug>/latest` or `/reports/<slug>/latest/*` redirects
    const latestMatch = cleanPath.match(/^reports\/([a-z0-9-]+)\/latest(?:\/(.*))?$/);
    if (latestMatch && this.publishService) {
      const slug = latestMatch[1];
      const rest = (latestMatch[2] || 'index.html').replace(/^\/+/, '') || 'index.html';
      const ver = await this.publishService.resolveLatestPublicVersion(slug);
      if (!ver) {
        reply.code(404).send({ error: 'No publication found for this project' });
        return;
      }
      reply.header('Cache-Control', 'private, no-store').redirect(`/reports/${slug}/v${ver}/${rest}`);
      return;
    }

    const effectivePath = cleanPath.endsWith('/') ? `${cleanPath}index.html` : cleanPath;
    const mime = guessMimeType(effectivePath);

    if (this.cfg.gcpStaticPublicBucket) {
      const client = await this.googleAuth.getClient();
      const { token } = await client.getAccessToken();
      const gcsRes = await fetch(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.cfg.gcpStaticPublicBucket)}/o/${encodeURIComponent(effectivePath)}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!gcsRes.ok) {
        reply.code(gcsRes.status === 404 ? 404 : 502).send({ error: 'Report asset not found' });
        return;
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store'
      });
      if (gcsRes.body) {
        for await (const chunk of gcsRes.body as any) reply.raw.write(chunk);
      }
      reply.raw.end();
      return;
    }

    const rootDir = path.resolve(this.cfg.localStorageDir, 'static-public');
    const full = path.resolve(rootDir, effectivePath);
    if (full !== rootDir && !full.startsWith(rootDir + path.sep)) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      reply.code(404).send({ error: 'Report asset not found' });
      return;
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store'
    });
    fs.createReadStream(full).pipe(reply.raw);
  }

  /**
   * Verifies the Editor VM daemon (and local bioniceditor service for editor scope) is actually
   * accepting mTLS requests before telling the auto-wake splash screen to reload.
   */
  private async isVmReady(projectId: string, internalIp: string, scope: OriginScope): Promise<boolean> {
    if (this.compute?.kind === 'local') return true;
    const creds = this.ca.getHubClientCredentials();
    const expectedSan = `spiffe://bionic/project/${projectId}`;
    const port = scope === 'editor' ? 3000 : 3002;
    const probePath = scope === 'editor' ? '/' : '/api/internal/health';

    return new Promise<boolean>((resolve) => {
      const req = https.request(
        {
          host: internalIp,
          port,
          path: probePath,
          method: 'GET',
          headers: scope === 'editor' ? { 'x-bionic-origin-scope': 'editor' } : undefined,
          key: creds.keyPem,
          cert: creds.certPem,
          ca: creds.caCertPem,
          rejectUnauthorized: true,
          timeout: 2500,
          checkServerIdentity: (_host, peerCert) => {
            const san = extractSpiffeSanFromPeerCert(peerCert);
            return san === expectedSan ? undefined : new Error(`VM SAN mismatch: ${san}`);
          }
        },
        (res) => {
          res.resume();
          const code = res.statusCode || 502;
          if (code >= 500) {
            console.warn(`[EditorProxy] VM readiness probe got HTTP ${code} for ${projectId} (${internalIp}:${port}${probePath})`);
          }
          resolve(code >= 200 && code < 500);
        }
      );
      req.on('timeout', () => {
        console.warn(`[EditorProxy] VM readiness probe timed out for ${projectId} (${internalIp}:${port}${probePath})`);
        req.destroy();
        resolve(false);
      });
      req.on('error', (err) => {
        console.warn(`[EditorProxy] VM readiness probe error for ${projectId} (${internalIp}:${port}${probePath}): ${err.message}`);
        resolve(false);
      });
      req.end();
    });
  }

  private async forwardHttpToVm(
    projectId: string,
    internalIp: string,
    route: ParsedOriginRoute,
    userId: string,
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const creds = this.ca.getHubClientCredentials();
    const expectedSan = `spiffe://bionic/project/${projectId}`;
    const wantsHtml = req.method === 'GET' && String(req.headers.accept || '').includes('text/html');

    const forwardHeaders: Record<string, any> = {
      ...req.headers,
      'x-bionic-user-id': userId,
      'x-bionic-project-id': projectId,
      'x-bionic-origin-scope': route.scope
    };
    delete forwardHeaders.cookie;

    reply.hijack();
    await new Promise<void>((resolve) => {
      const proxyReq = https.request(
        {
          host: internalIp,
          port: 3000,
          path: req.url,
          method: req.method,
          headers: forwardHeaders,
          key: creds.keyPem,
          cert: creds.certPem,
          ca: creds.caCertPem,
          rejectUnauthorized: true,
          checkServerIdentity: (_host, peerCert) => {
            const san = extractSpiffeSanFromPeerCert(peerCert);
            if (san !== expectedSan) {
              return new Error(`VM cert SAN mismatch: expected ${expectedSan}, got ${san}`);
            }
            return undefined;
          }
        },
        (proxyRes) => {
          if (wantsHtml && proxyRes.statusCode === 502 && !reply.raw.headersSent) {
            proxyRes.resume();
            reply.raw.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            reply.raw.end(renderAutoWakeHtml(projectId, 'starting'));
            resolve();
            return;
          }
          reply.raw.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(reply.raw);
          proxyRes.on('end', resolve);
        }
      );
      // In Node 18+/22, `req.raw` emits 'close' when the request body finishes reading (before
      // the VM responds!). Only abort `proxyReq` if the client disconnects before `reply.raw` finishes.
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded && !proxyReq.destroyed) proxyReq.destroy();
      });
      proxyReq.on('error', (err) => {
        if (!reply.raw.headersSent) {
          if (wantsHtml) {
            reply.raw.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            reply.raw.end(renderAutoWakeHtml(projectId, 'starting'));
          } else {
            reply.raw.writeHead(502, { 'Content-Type': 'application/json' });
            reply.raw.end(JSON.stringify({ error: `Editor VM upstream error: ${err.message}` }));
          }
        }
        resolve();
      });
      if (req.method === 'GET' || req.method === 'HEAD') {
        proxyReq.end();
      } else {
        req.raw.pipe(proxyReq);
      }
    });
  }

  async handleWebSocketUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const route = parseSubdomainHost(req.headers.host, this.cfg);
    if (!route || route.scope !== 'editor') {
      socket.destroy();
      return;
    }

    if (req.headers.origin && req.headers.origin.toLowerCase() !== route.origin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const cookies = parseCookieHeader(req.headers.cookie);
    const cookieName = cookieNameForScope('editor', this.cfg.devMode);
    const scoped = await this.sessions.validateScopedOriginCookie(
      cookies[cookieName] || '',
      route.origin,
      'editor',
      route.resourceId
    );
    if (!scoped) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const projRes = await this.db.query(
      `SELECT id, status, compute_internal_ip FROM projects WHERE id = $1 AND status = 'running'`,
      [route.resourceId]
    );
    const proj = projRes.rows[0];
    if (!proj?.compute_internal_ip) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    const creds = this.ca.getHubClientCredentials();
    const expectedSan = `spiffe://bionic/project/${proj.id}`;
    const headers: Record<string, any> = {
      ...req.headers,
      'x-bionic-user-id': scoped.userId,
      'x-bionic-project-id': proj.id,
      'x-bionic-origin-scope': 'editor'
    };
    delete headers.cookie;

    const upReq = https.request({
      host: proj.compute_internal_ip,
      port: 3000,
      path: req.url,
      method: 'GET',
      headers,
      key: creds.keyPem,
      cert: creds.certPem,
      ca: creds.caCertPem,
      rejectUnauthorized: true,
      checkServerIdentity: (_host, peerCert) => {
        const san = extractSpiffeSanFromPeerCert(peerCert);
        return san === expectedSan ? undefined : new Error(`WS VM SAN mismatch: ${san}`);
      }
    });

    upReq.on('response', (upRes) => {
      socket.write(`HTTP/1.1 ${upRes.statusCode || 502} Bad Gateway\r\n\r\n`);
      socket.destroy();
    });
    upReq.on('upgrade', (upRes, upSocket, upHead) => {
      const rawHeaders = Object.entries(upRes.headers)
        .map(([k, v]) => `${sanitizeHeaderLine(k)}: ${sanitizeHeaderLine(Array.isArray(v) ? v.join(', ') : String(v ?? ''))}`)
        .join('\r\n');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${rawHeaders}\r\n\r\n`);
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      socket.on('close', () => upSocket.destroy());
      upSocket.on('close', () => socket.destroy());
    });
    upReq.on('error', () => socket.destroy());
    upReq.end();
  }
}

function renderAutoWakeHtml(projectId: string, status: string): string {
  const safeId = projectId.replace(/[^a-z0-9-]/gi, '');
  const safeStatus = status.replace(/[^a-z_]/gi, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Waking ${safeId} — Bionic Hub</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1117; color: #e2e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #161a23; border: 1px solid #262c3a; border-radius: 12px; padding: 2rem 2.5rem; max-width: 440px; text-align: center; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #94a3b8; font-size: 0.9rem; }
    .badge { display: inline-block; margin-top: 0.75rem; padding: 0.25rem 0.75rem; border-radius: 999px; background: #1e293b; color: #38bdf8; font-family: monospace; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Waking your Bionic workspace…</h1>
    <p id="detail">Resuming compute instance and verifying workspace services for <code>${safeId}</code>.</p>
    <div id="status" class="badge">${safeStatus}</div>
  </div>
  <script>
    let reloading = false;
    const statusEl = document.getElementById('status');
    const detailEl = document.getElementById('detail');
    const es = new EventSource('/__bionic_wake/events');
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.detail) detailEl.textContent = ev.detail;
        statusEl.textContent = ev.status || 'starting';
        if (ev.ready === true && !reloading) {
          reloading = true;
          statusEl.textContent = 'ready — opening editor…';
          es.close();
          setTimeout(() => location.reload(), 2500);
        } else if (ev.status === 'error') {
          statusEl.textContent = 'error: ' + (ev.error || 'wake failed');
          es.close();
        }
      } catch {}
    };
  </script>
</body>
</html>`;
}
