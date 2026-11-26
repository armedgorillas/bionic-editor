import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

/**
 * Unprivileged VM Control Daemon (`bionic-daemon.service`, User=bionic-daemon, zero root caps).
 *
 * Security-hardened after Reviews #1 & #2:
 * - Blocks `/api/hub-local` on `:3000` (403) and sends `X-Bionic-Daemon-Token` to local editor.
 * - Accepts shim token via `x-bionic-shim-token`, `authorization`, `x-api-key`, `x-goog-api-key`, `?key=`
 *   using constant-time comparison and strips it before forwarding to Hub.
 * - Periodic 24h mTLS cert renewal + suspend/resume jump detection -> `chronyc makestep` -> re-attest.
 * - MIME Content-Type on Live Reports, safe `decodeURIComponent`, 30 MB shim body cap,
 *   5-min TTL on daemon-tracked `activeUserId`, and `upReq.on('response')` + header CRLF strip on WS.
 */

const IDLE_PROCESS_ALLOWLIST = new Set(['bioniceditor', 'node', 'opencode', 'bash', 'sh', 'tmux', 'systemd', '(sd-pam)']);
const MAX_SHIM_BODY_BYTES = 30 * 1024 * 1024;
const ACTIVE_USER_TTL_MS = 5 * 60 * 1000;

export interface DaemonConfig {
  hubOrigin: string;
  projectId: string;
  workspaceDir: string;
  editorSocketPath: string;
  editorLoopbackPort: number;
  mtlsEditorPort: number;
  mtlsInternalPort: number;
  shimPort: number;
  shimToken: string;
  daemonToken: string;
  runtimeDir: string;
  workspaceUser: string;
}

export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  return {
    hubOrigin: (env.BIONIC_HUB_ORIGIN || 'https://hub.bionic.localhost').replace(/\/+$/, ''),
    projectId: env.BIONIC_PROJECT_ID || '',
    workspaceDir: env.WORKSPACE_DIR || '/var/lib/bionic/workspace',
    editorSocketPath: env.BIONIC_UNIX_SOCKET || '/run/bionic-editor/app.sock',
    editorLoopbackPort: parseInt(env.BIONIC_EDITOR_PORT || '3003', 10),
    mtlsEditorPort: parseInt(env.BIONIC_DAEMON_EDITOR_PORT || '3000', 10),
    mtlsInternalPort: parseInt(env.BIONIC_DAEMON_INTERNAL_PORT || '3002', 10),
    shimPort: parseInt(env.BIONIC_SHIM_PORT || '3001', 10),
    shimToken: env.BIONIC_LOCAL_SHIM_TOKEN || crypto.randomBytes(24).toString('hex'),
    daemonToken: env.BIONIC_DAEMON_TOKEN || '',
    runtimeDir: env.BIONIC_DAEMON_RUNTIME_DIR || '/run/bionic-daemon',
    workspaceUser: env.BIONIC_WORKSPACE_USER || 'bionic-user'
  };
}

export function detectResumeJump(prevWallMinusMonoMs: number, currentWallMinusMonoMs: number, thresholdMs = 5000): boolean {
  return Math.abs(currentWallMinusMonoMs - prevWallMinusMonoMs) > thresholdMs;
}

export async function countActiveComputeProcs(workspaceUser: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ps', ['-u', workspaceUser, '-o', 'comm='], { timeout: 3000 });
    const procs = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return procs.filter((comm) => !IDLE_PROCESS_ALLOWLIST.has(comm)).length;
  } catch {
    return 0;
  }
}

function guessMime(filePath: string): string {
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

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function sanitizeHeaderLine(s: string): string {
  return s.replace(/[\r\n\0]/g, '');
}

export class BionicVmDaemon {
  private workloadJwt = '';
  private activeUserId = '';
  private activeUserUpdatedAt = 0;
  private activeDataTransfers = 0;
  private keyPem = '';
  private certPem = '';
  private caCertPem = '';
  private editorMtlsServer: https.Server | null = null;
  private internalMtlsServer: https.Server | null = null;
  private shimServer: http.Server | null = null;
  private wakePollTimer: NodeJS.Timeout | null = null;
  private certRenewTimer: NodeJS.Timeout | null = null;
  private lastClockOffsetMs = Date.now() - Math.floor(process.uptime() * 1000);

  constructor(private readonly cfg: DaemonConfig) {}

  async start(): Promise<void> {
    fs.mkdirSync(this.cfg.runtimeDir, { recursive: true, mode: 0o700 });
    await this.attestWithHub();
    this.startShimServer();
    this.startMtlsServers();
    this.startSuspendResumeWatcher();
    // Periodic 24h cert renewal so continuously running VMs never hit 72h cert expiry (#17)
    this.certRenewTimer = setInterval(() => {
      this.attestWithHub().catch((err) => console.error('[bionic-daemon] periodic cert renewal failed:', err));
    }, 24 * 3600 * 1000);
    this.certRenewTimer.unref();
  }

  stop(): void {
    if (this.wakePollTimer) clearInterval(this.wakePollTimer);
    if (this.certRenewTimer) clearInterval(this.certRenewTimer);
    this.editorMtlsServer?.close();
    this.internalMtlsServer?.close();
    this.shimServer?.close();
  }

  private getEffectiveActiveUser(): string {
    if (!this.activeUserId) return '';
    if (Date.now() - this.activeUserUpdatedAt > ACTIVE_USER_TTL_MS) {
      this.activeUserId = '';
      return '';
    }
    return this.activeUserId;
  }

  private async ensureKeyAndCsr(): Promise<string> {
    const keyPath = path.join(this.cfg.runtimeDir, 'vm.key');
    const csrPath = path.join(this.cfg.runtimeDir, 'vm.csr');
    if (!fs.existsSync(keyPath)) {
      await execFileAsync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
      fs.chmodSync(keyPath, 0o600);
    }
    this.keyPem = fs.readFileSync(keyPath, 'utf-8');
    await execFileAsync('openssl', [
      'req', '-new', '-key', keyPath, '-subj', `/CN=${this.cfg.projectId || os.hostname()}`, '-out', csrPath
    ]);
    return fs.readFileSync(csrPath, 'utf-8');
  }

  async attestWithHub(): Promise<void> {
    const csrPem = await this.ensureKeyAndCsr();
    let identityJwt: string | undefined;
    try {
      const metaUrl = `http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(`${this.cfg.hubOrigin}/attest`)}&format=full`;
      const metaRes = await fetch(metaUrl, { headers: { 'Metadata-Flavor': 'Google' } });
      if (metaRes.ok) identityJwt = await metaRes.text();
    } catch {
      // Non-GCP dev fallback
    }

    const res = await fetch(`${this.cfg.hubOrigin}/api/internal/vm/attest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identityJwt,
        csrPem,
        ...(identityJwt ? {} : { devProjectId: this.cfg.projectId, devInstanceId: os.hostname() })
      })
    });
    if (!res.ok) {
      throw new Error(`Hub VM attestation failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { certPem: string; caCertPem: string; workloadJwt: string };
    this.certPem = data.certPem;
    this.caCertPem = data.caCertPem;
    this.workloadJwt = data.workloadJwt;

    const ctx = { key: this.keyPem, cert: this.certPem, ca: this.caCertPem };
    this.editorMtlsServer?.setSecureContext(ctx);
    this.internalMtlsServer?.setSecureContext(ctx);
  }

  private startSuspendResumeWatcher(): void {
    this.wakePollTimer = setInterval(async () => {
      const currentOffsetMs = Date.now() - Math.floor(process.uptime() * 1000);
      if (detectResumeJump(this.lastClockOffsetMs, currentOffsetMs, 5000)) {
        this.lastClockOffsetMs = currentOffsetMs;
        try {
          await execFileAsync('sudo', ['/usr/bin/chronyc', 'makestep'], { timeout: 5000 });
        } catch {}
        try {
          await this.attestWithHub();
        } catch (err) {
          console.error('[bionic-daemon] post-resume re-attestation failed:', err);
        }
      } else {
        this.lastClockOffsetMs = currentOffsetMs;
      }
    }, 1000);
    this.wakePollTimer.unref();
  }

  private verifyHubClientCert(req: http.IncomingMessage): boolean {
    const tlsSock = req.socket as any;
    if (!tlsSock?.authorized) return false;
    const peerCert = tlsSock.getPeerCertificate?.();
    const san = String(peerCert?.subjectaltname || '');
    return san.includes('URI:spiffe://bionic/hub');
  }

  private startShimServer(): void {
    this.shimServer = http.createServer(async (req, res) => {
      const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      // Security #7: Support Anthropic (x-api-key), Google (x-goog-api-key / ?key=), OpenAI (Authorization), & custom header
      const candidateToken =
        String(req.headers['x-bionic-shim-token'] || '') ||
        String(req.headers['x-api-key'] || '') ||
        String(req.headers['x-goog-api-key'] || '') ||
        String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
        String(parsedUrl.searchParams.get('key') || '');

      if (!candidateToken || !constantTimeEquals(candidateToken, this.cfg.shimToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid local shim token' }));
        return;
      }

      // Strip local shim ?key= query param before forwarding upstream
      parsedUrl.searchParams.delete('key');
      const cleanUrlPath = parsedUrl.pathname + (parsedUrl.search || '');

      let hubTargetPath = '';
      if (cleanUrlPath.startsWith('/llm/')) hubTargetPath = cleanUrlPath;
      else if (cleanUrlPath.startsWith('/mcp/')) hubTargetPath = cleanUrlPath;
      else if (cleanUrlPath.startsWith('/git/')) hubTargetPath = `/api/internal${cleanUrlPath}`;
      else if (cleanUrlPath.startsWith('/data/')) hubTargetPath = `/api/internal${cleanUrlPath}`;
      else if (cleanUrlPath === '/models') hubTargetPath = '/api/internal/models';
      else if (cleanUrlPath === '/publish') hubTargetPath = `/api/internal/projects/${this.cfg.projectId}/publish-intake`;
      else {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // Enforce 30 MB shim body cap to prevent OOM (#17)
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const c of req) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
        totalBytes += b.length;
        if (totalBytes > MAX_SHIM_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request payload exceeds 30 MB shim cap' }));
          return;
        }
        chunks.push(b);
      }
      const bodyBuf = Buffer.concat(chunks);

      const isTransfer = cleanUrlPath.startsWith('/data/') || cleanUrlPath === '/publish';
      if (isTransfer) this.activeDataTransfers++;
      try {
        const doForward = async () => {
          const headers: Record<string, string> = {
            Authorization: `Bearer ${this.workloadJwt}`
          };
          const activeUser = this.getEffectiveActiveUser();
          if (activeUser) headers['X-Bionic-Triggering-User'] = activeUser;
          for (const passthrough of [
            'content-type',
            'content-encoding',
            'accept',
            'anthropic-beta',
            'mcp-session-id',
            'x-bionic-git-commit',
            'x-bionic-visibility',
            'x-bionic-title',
            'x-bionic-summary'
          ]) {
            if (req.headers[passthrough]) headers[passthrough] = String(req.headers[passthrough]);
          }
          return fetch(`${this.cfg.hubOrigin}${hubTargetPath}`, {
            method: req.method,
            headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuf
          });
        };

        let upstream = await doForward();
        if (upstream.status === 401) {
          await this.attestWithHub();
          upstream = await doForward();
        }

        const respHeaders: Record<string, string> = {};
        upstream.headers.forEach((v, k) => {
          if (k.toLowerCase() !== 'transfer-encoding') respHeaders[k] = v;
        });
        res.writeHead(upstream.status, respHeaders);
        if (upstream.body) {
          for await (const chunk of upstream.body as any) res.write(chunk);
        }
        res.end();
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Shim upstream error: ${err.message}` }));
        }
      } finally {
        if (isTransfer) this.activeDataTransfers = Math.max(0, this.activeDataTransfers - 1);
      }
    });

    this.shimServer.listen(this.cfg.shimPort, '127.0.0.1');
  }

  private startMtlsServers(): void {
    const tlsOpts: https.ServerOptions = {
      key: this.keyPem,
      cert: this.certPem,
      ca: this.caCertPem,
      requestCert: true,
      rejectUnauthorized: true
    };

    // 1. VPC :3000 — Editor + Isolated Live Report Preview mTLS terminator
    this.editorMtlsServer = https.createServer(tlsOpts, (req, res) => {
      if (!this.verifyHubClientCert(req)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const scope = String(req.headers['x-bionic-origin-scope'] || 'editor');
      const verifiedUser = String(req.headers['x-bionic-user-id'] || '');
      const urlPath = req.url || '/';

      if (scope === 'editor' && verifiedUser && req.method === 'POST' && (urlPath.includes('/api/agent/chat') || urlPath.includes('/api/hub/publish'))) {
        this.activeUserId = verifiedUser;
        this.activeUserUpdatedAt = Date.now();
      }

      if (scope === 'live_report') {
        this.serveSafeLiveReportFile(urlPath, res);
        return;
      }

      // Security C1 & #2: Block same-origin /report AND daemon-only /api/hub-local on Editor origin!
      if (urlPath === '/report' || urlPath.startsWith('/report/') || urlPath.includes('/api/hub-local')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden path on Editor origin' }));
        return;
      }

      const forwardHeaders: Record<string, any> = { ...req.headers };
      delete forwardHeaders['x-bionic-daemon-token'];

      const upOpts: http.RequestOptions = fs.existsSync(this.cfg.editorSocketPath)
        ? { socketPath: this.cfg.editorSocketPath, path: urlPath, method: req.method, headers: forwardHeaders }
        : { host: '127.0.0.1', port: this.cfg.editorLoopbackPort, path: urlPath, method: req.method, headers: forwardHeaders };

      const up = http.request(upOpts, (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      });
      // In Node 18+/22, `req` emits 'close' as soon as the request body finishes reading (before the
      // upstream responds!). Only abort `up` if the client disconnects before `res` finishes.
      res.on('close', () => {
        if (!res.writableEnded && !up.destroyed) up.destroy();
      });
      up.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(`bioniceditor local error: ${err.message}`);
        }
      });
      if (req.method === 'GET' || req.method === 'HEAD') {
        up.end();
      } else {
        req.pipe(up);
      }
    });

    this.editorMtlsServer.on('upgrade', (req, socket, head) => {
      if (!this.verifyHubClientCert(req)) {
        socket.destroy();
        return;
      }
      const upOpts: http.RequestOptions = fs.existsSync(this.cfg.editorSocketPath)
        ? { socketPath: this.cfg.editorSocketPath, path: req.url, method: 'GET', headers: req.headers }
        : { host: '127.0.0.1', port: this.cfg.editorLoopbackPort, path: req.url, method: 'GET', headers: req.headers };
      const upReq = http.request(upOpts);
      upReq.on('response', (upRes) => {
        socket.write(`HTTP/1.1 ${upRes.statusCode || 502} Bad Gateway\r\n\r\n`);
        socket.destroy();
      });
      upReq.on('upgrade', (upRes, upSock, upHead) => {
        const hdrs = Object.entries(upRes.headers)
          .map(([k, v]) => `${sanitizeHeaderLine(k)}: ${sanitizeHeaderLine(Array.isArray(v) ? v.join(', ') : String(v ?? ''))}`)
          .join('\r\n');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${hdrs}\r\n\r\n`);
        if (upHead.length) socket.write(upHead);
        if (head.length) upSock.write(head);
        upSock.pipe(socket);
        socket.pipe(upSock);
      });
      upReq.on('error', () => socket.destroy());
      upReq.end();
    });

    this.editorMtlsServer.listen(this.cfg.mtlsEditorPort, '0.0.0.0');

    // 2. VPC :3002 — Internal Control Plane endpoints (/api/internal/*)
    this.internalMtlsServer = https.createServer(tlsOpts, async (req, res) => {
      if (!this.verifyHubClientCert(req)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const urlPath = req.url || '/';
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      let parsedBody: any = {};
      if (chunks.length) {
        try {
          parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {}
      }

      try {
        if (urlPath === '/api/internal/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, projectId: this.cfg.projectId }));
          return;
        }
        if (urlPath === '/api/internal/activity') {
          const [activeComputeProcs, editorAct] = await Promise.all([
            countActiveComputeProcs(this.cfg.workspaceUser),
            this.callLocalEditor('/api/hub-local/activity', 'GET').catch(() => ({ activeAgentTurns: 0, activeSubagents: 0 }))
          ]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...editorAct, activeComputeProcs, activeDataTransfers: this.activeDataTransfers }));
          return;
        }
        if (urlPath === '/api/internal/prepare-freeze') {
          const out = await this.callLocalEditor('/api/hub-local/prepare-freeze', 'POST', {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
          return;
        }
        if (urlPath === '/api/internal/post-resume') {
          // Restart host-namespace gcsfuse mount unit (Reviewer 2 #9)
          await execFileAsync('sudo', ['/usr/bin/systemctl', 'restart', 'bionic-mount-shared-data.service'], { timeout: 10000 }).catch(() => {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (urlPath === '/api/internal/sync-config') {
          const out = await this.callLocalEditor('/api/hub-local/sync-config', 'POST', parsedBody);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
          return;
        }
        if (urlPath === '/api/internal/apply-manifest') {
          const out = await this.callLocalEditor('/api/hub-local/apply-manifest', 'POST', parsedBody);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
          return;
        }
        if (urlPath === '/api/internal/project-meta') {
          const isPost = req.method === 'POST';
          const out = await this.callLocalEditor(
            '/api/hub-local/project-meta',
            isPost ? 'POST' : 'GET',
            isPost ? parsedBody : undefined
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
          return;
        }
        res.writeHead(404);
        res.end('Not found');
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    this.internalMtlsServer.listen(this.cfg.mtlsInternalPort, '0.0.0.0');
  }

  private serveSafeLiveReportFile(urlPath: string, res: http.ServerResponse): void {
    try {
      const cleanRel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const reportRoot = path.resolve(this.cfg.workspaceDir, 'web-report');
      const candidate = path.resolve(reportRoot, cleanRel);
      const realRoot = fs.realpathSync(reportRoot);
      const realTarget = fs.realpathSync(candidate);
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const stat = fs.statSync(realTarget);
      if (!stat.isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': guessMime(realTarget),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(realTarget).pipe(res);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  private callLocalEditor(endpoint: string, method: 'GET' | 'POST', body?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const headers: Record<string, string | number> = {};
      if (this.cfg.daemonToken) headers['X-Bionic-Daemon-Token'] = this.cfg.daemonToken;
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const opts: http.RequestOptions = fs.existsSync(this.cfg.editorSocketPath)
        ? { socketPath: this.cfg.editorSocketPath, path: endpoint, method, headers }
        : { host: '127.0.0.1', port: this.cfg.editorLoopbackPort, path: endpoint, method, headers };
      const req = http.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch {
            resolve({});
          }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const daemon = new BionicVmDaemon(loadDaemonConfig());
  daemon
    .start()
    .then(() => console.log('🛡️ bionic-daemon started (mTLS + localhost gateway shim active)'))
    .catch((err) => {
      console.error('bionic-daemon fatal error:', err);
      process.exit(1);
    });
}
