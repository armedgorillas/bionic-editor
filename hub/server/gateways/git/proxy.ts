import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { GoogleAuth } from 'google-auth-library';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { HubConfig } from '../../config.js';
import type { WorkloadJwtClaims } from '../../auth/ca.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_PUSH_BYTES = 25 * 1024 * 1024; // 25 MB hard cap per push pack
const MAX_GIT_UNCOMPRESSED_BYTES = 30 * 1024 * 1024; // 30 MB hard cap after gunzip (zip-bomb guard)

export interface GitBundleStore {
  uploadBundle(projectId: string, bundlePath: string): Promise<void>;
  downloadBundle(projectId: string, destPath: string): Promise<boolean>;
}

/**
 * Durable GCS-backed Git bundle persistence (`gs://<projectDataBucket>/projects/<prj-id>/git/repo.bundle`).
 * Survives Hub container restarts, redeploys, and multi-replica scaling with zero local PVC required.
 */
export class GcsGitBundleStore implements GitBundleStore {
  private readonly googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/devstorage.read_write']
  });

  constructor(private readonly bucket: string) {}

  private objectName(projectId: string): string {
    return `projects/${projectId}/git/repo.bundle`;
  }

  private async getToken(): Promise<string> {
    const client = await this.googleAuth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Failed to acquire GCS token for Git bundle persistence');
    return token;
  }

  async uploadBundle(projectId: string, bundlePath: string): Promise<void> {
    const token = await this.getToken();
    const buf = fs.readFileSync(bundlePath);
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(this.objectName(projectId))}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream'
      },
      body: buf
    });
    if (!res.ok) {
      throw new Error(`GCS Git bundle upload failed (${res.status}): ${await res.text()}`);
    }
  }

  async downloadBundle(projectId: string, destPath: string): Promise<boolean> {
    const token = await this.getToken();
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(this.objectName(projectId))}?alt=media`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(`GCS Git bundle download failed (${res.status})`);
    }
    const arr = await res.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(arr));
    return true;
  }
}

/**
 * Local directory bundle store (for dev/testing durability across bare-repo wipes).
 */
export class LocalDirGitBundleStore implements GitBundleStore {
  constructor(private readonly bundlesDir: string) {
    fs.mkdirSync(bundlesDir, { recursive: true });
  }

  private bundleFile(projectId: string): string {
    if (!/^prj-[a-z0-9-]+$/.test(projectId)) throw new Error('Invalid projectId for git bundle');
    return path.join(this.bundlesDir, `${projectId}.bundle`);
  }

  async uploadBundle(projectId: string, bundlePath: string): Promise<void> {
    fs.mkdirSync(this.bundlesDir, { recursive: true });
    fs.copyFileSync(bundlePath, this.bundleFile(projectId));
  }

  async downloadBundle(projectId: string, destPath: string): Promise<boolean> {
    const src = this.bundleFile(projectId);
    if (!fs.existsSync(src)) return false;
    fs.copyFileSync(src, destPath);
    return true;
  }
}

export interface GitProvider {
  ensureProjectRepo(projectId: string, forkFrom?: { sourceProjectId: string; commitSha: string }): Promise<string>;
  getUpstreamRepoUrl(projectId: string): string;
  verifyCommitExists(projectId: string, commitSha: string): Promise<boolean>;
  persistRepoBundle?(projectId: string): Promise<void>;
}

const PRE_RECEIVE_HOOK_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
MAX_BYTES=26214400
while read -r oldrev newrev refname; do
  if [[ "$newrev" == "0000000000000000000000000000000000000000" ]]; then
    continue
  fi
  RAW_FILES="$(git ls-tree -r --name-only "$newrev" -- 'data/raw/' | grep -v '^data/raw/\\.gitkeep$' || true)"
  if [[ -n "$RAW_FILES" ]]; then
    echo "REJECTED: Raw data files under data/raw/ cannot be committed to Git:" >&2
    echo "$RAW_FILES" >&2
    exit 1
  fi
  git rev-list --objects "$newrev" | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' | while read -r otype oid osize opath; do
    if [[ "$otype" == "blob" && "$osize" -gt "$MAX_BYTES" ]]; then
      echo "REJECTED: File $opath ($osize bytes) exceeds 25 MB Git limit; store in data/raw/ object storage." >&2
      exit 1
    fi
  done
done
`;

function gunzipWithCap(compressed: Buffer, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    gunzip.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        gunzip.destroy();
        reject(Object.assign(new Error(`Decompressed Git payload exceeds ${maxBytes} byte cap`), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', (err) => reject(Object.assign(new Error(`Invalid gzip Git payload: ${err.message}`), { statusCode: 400 })));
    gunzip.end(compressed);
  });
}

/**
 * Local bare-repo GitProvider with optional durable GCS/dir bundle persistence.
 * Installs a root-commit-aware server-side `pre-receive` hook enforcing the 25 MB blob & `data/raw/` guard.
 */
export class LocalBareGitProvider implements GitProvider {
  private readonly locks = new Map<string, Promise<any>>();

  constructor(
    private readonly reposDir: string,
    private readonly bundleStore?: GitBundleStore
  ) {
    fs.mkdirSync(reposDir, { recursive: true });
  }

  private withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(projectId, next);
    next.finally(() => {
      if (this.locks.get(projectId) === next) this.locks.delete(projectId);
    });
    return next;
  }

  private repoPath(projectId: string): string {
    if (!/^prj-[a-z0-9-]+$/.test(projectId)) throw new Error('Invalid projectId for git repo');
    return path.join(this.reposDir, `${projectId}.git`);
  }

  private installPreReceiveHook(repoDir: string): void {
    const hooksDir = path.join(repoDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-receive'), PRE_RECEIVE_HOOK_SCRIPT, { mode: 0o755 });
  }

  private async ensureMainSymbolicRef(repoDir: string): Promise<void> {
    try {
      // If refs/heads/main exists, always point HEAD to it; if repo is empty, also default HEAD to refs/heads/main
      const { stdout } = await execFileAsync('git', ['--git-dir', repoDir, 'for-each-ref', '--format=%(refname)', 'refs/heads/']);
      const refs = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      if (refs.length === 0 || refs.includes('refs/heads/main')) {
        await execFileAsync('git', ['--git-dir', repoDir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
      } else {
        await execFileAsync('git', ['--git-dir', repoDir, 'symbolic-ref', 'HEAD', refs[0]]);
      }
    } catch {
      // best-effort
    }
  }

  private async restoreFromBundle(projectId: string, forceRefresh = false): Promise<boolean> {
    if (!this.bundleStore) return false;
    const target = this.repoPath(projectId);
    if (!forceRefresh && fs.existsSync(target)) return true;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-git-restore-'));
    try {
      const bundleFile = path.join(tmpDir, 'repo.bundle');
      const found = await this.bundleStore.downloadBundle(projectId, bundleFile);
      if (!found) return false;

      fs.mkdirSync(this.reposDir, { recursive: true });
      const stageRepo = path.join(this.reposDir, `.${projectId}.restore-${process.pid}-${Date.now()}.git`);
      try {
        await execFileAsync('git', ['clone', '--bare', bundleFile, stageRepo]);
        this.installPreReceiveHook(stageRepo);
        await this.ensureMainSymbolicRef(stageRepo);
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
        }
        fs.renameSync(stageRepo, target);
      } catch (err) {
        fs.rmSync(stageRepo, { recursive: true, force: true });
        throw err;
      }
      return true;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  async persistRepoBundle(projectId: string): Promise<void> {
    if (!this.bundleStore) return;
    await this.withProjectLock(projectId, async () => {
      const repoDir = this.repoPath(projectId);
      if (!fs.existsSync(repoDir)) return;

      // Never run `git bundle create --all` on a 0-ref repository (git exits fatal on empty bundle)
      const { stdout: refsOut } = await execFileAsync('git', ['--git-dir', repoDir, 'for-each-ref', '--format=%(refname)']);
      if (!refsOut.trim()) return;

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-git-bundle-'));
      try {
        const bundleFile = path.join(tmpDir, 'repo.bundle');
        await execFileAsync('git', ['--git-dir', repoDir, 'bundle', 'create', bundleFile, '--all']);
        await this.bundleStore!.uploadBundle(projectId, bundleFile);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }

  async ensureProjectRepo(projectId: string, forkFrom?: { sourceProjectId: string; commitSha: string }): Promise<string> {
    return this.withProjectLock(projectId, async () => {
      fs.mkdirSync(this.reposDir, { recursive: true });
      const target = this.repoPath(projectId);

      if (!fs.existsSync(target)) {
        if (forkFrom) {
          // Ensure source repo is present on disk and contains the pinned commitSha (restoring from GCS bundle if needed)
          const src = this.repoPath(forkFrom.sourceProjectId);
          let hasSourceCommit = false;
          if (fs.existsSync(src) && /^[0-9a-f]{7,40}$/i.test(forkFrom.commitSha || '')) {
            try {
              await execFileAsync('git', ['--git-dir', src, 'cat-file', '-e', `${forkFrom.commitSha}^{commit}`]);
              hasSourceCommit = true;
            } catch {
              hasSourceCommit = false;
            }
          }
          if (!fs.existsSync(src) || (forkFrom.commitSha && /^[0-9a-f]{7,40}$/i.test(forkFrom.commitSha) && !hasSourceCommit)) {
            await this.restoreFromBundle(forkFrom.sourceProjectId, true);
          }

          if (fs.existsSync(src)) {
            await execFileAsync('git', ['clone', '--bare', src, target]);
            if (forkFrom.commitSha && /^[0-9a-f]{7,40}$/i.test(forkFrom.commitSha)) {
              try {
                await execFileAsync('git', ['--git-dir', target, 'cat-file', '-e', `${forkFrom.commitSha}^{commit}`]);
                await execFileAsync('git', ['--git-dir', target, 'update-ref', 'refs/heads/main', forkFrom.commitSha]);
                await execFileAsync('git', ['--git-dir', target, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
              } catch {
                await this.ensureMainSymbolicRef(target);
              }
            } else {
              await this.ensureMainSymbolicRef(target);
            }
          } else {
            await execFileAsync('git', ['init', '--bare', '-b', 'main', target]);
          }
          this.installPreReceiveHook(target);
          // Immediately persist forked bundle to GCS so the forked VM can always hydrate even after Hub restart
          if (this.bundleStore) {
            const { stdout: refsOut } = await execFileAsync('git', ['--git-dir', target, 'for-each-ref', '--format=%(refname)']);
            if (refsOut.trim()) {
              const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-git-fork-bundle-'));
              try {
                const bundleFile = path.join(tmpDir, 'repo.bundle');
                await execFileAsync('git', ['--git-dir', target, 'bundle', 'create', bundleFile, '--all']);
                await this.bundleStore.uploadBundle(projectId, bundleFile);
              } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
              }
            }
          }
        } else {
          // Try restoring an existing repo from durable bundle store first (e.g. after Hub container restart)
          const restored = await this.restoreFromBundle(projectId, false);
          if (!restored) {
            await execFileAsync('git', ['init', '--bare', '-b', 'main', target]);
            this.installPreReceiveHook(target);
          }
        }
      } else {
        this.installPreReceiveHook(target);
        await this.ensureMainSymbolicRef(target);
      }
      return `file://${target}`;
    });
  }

  getUpstreamRepoUrl(projectId: string): string {
    return `file://${this.repoPath(projectId)}`;
  }

  async verifyCommitExists(projectId: string, commitSha: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/i.test(commitSha)) return false;
    const target = this.repoPath(projectId);
    const checkLocal = async () => {
      if (!fs.existsSync(target)) return false;
      try {
        await execFileAsync('git', ['--git-dir', target, 'cat-file', '-e', `${commitSha}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    };

    if (await checkLocal()) return true;
    // Restore or refresh from durable bundle store in case Hub restarted or another replica handled the push
    const restored = await this.withProjectLock(projectId, () => this.restoreFromBundle(projectId, true));
    if (!restored) return false;
    return checkLocal();
  }
}

/**
 * Forgejo / Gitea GitProvider (used behind Hub's Central Git Smart HTTP Proxy
 * so VMs never receive Forgejo user tokens — fixes Iteration 2 H3!).
 */
export class ForgejoGitProvider implements GitProvider {
  constructor(private readonly cfg: HubConfig) {}

  async ensureProjectRepo(projectId: string): Promise<string> {
    const res = await fetch(`${this.cfg.gitUpstreamUrl}/api/v1/user/repos`, {
      method: 'POST',
      headers: {
        Authorization: `token ${this.cfg.gitServiceToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: projectId,
        private: true,
        auto_init: false
      })
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`Forgejo repo creation failed (${res.status})`);
    }
    return this.getUpstreamRepoUrl(projectId);
  }

  getUpstreamRepoUrl(projectId: string): string {
    return `${this.cfg.gitUpstreamUrl}/bionic/${projectId}.git`;
  }

  async verifyCommitExists(projectId: string, commitSha: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/i.test(commitSha)) return false;
    const res = await fetch(`${this.cfg.gitUpstreamUrl}/api/v1/repos/bionic/${projectId}/git/commits/${commitSha}`, {
      headers: { Authorization: `token ${this.cfg.gitServiceToken}` }
    });
    return res.ok;
  }
}

/**
 * Central Hub Git Smart HTTP Proxy (`GET/POST /api/internal/git/*`).
 * Enforces Workload JWT `project_id === :projectId` + central 25 MB push guard.
 */
export class GitSmartHttpProxy {
  constructor(private readonly cfg: HubConfig, private readonly provider: GitProvider) {}

  async handleProxyRequest(
    projectId: string,
    gitSubPath: string,
    workload: WorkloadJwtClaims,
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (workload.projectId !== projectId) {
      reply.code(403).send({ error: 'Workload JWT project_id mismatch for Git repository' });
      return;
    }

    // Security #3: Strictly allowlist Git Smart HTTP endpoints & methods (blocks `..` traversal to Forgejo API/other repos!)
    const normalizedSub = gitSubPath.replace(/^\/+/, '');
    const lowerRawUrl = (req.url || '').toLowerCase();
    if (normalizedSub.includes('..') || lowerRawUrl.includes('%2e') || lowerRawUrl.includes('..')) {
      reply.code(400).send({ error: 'Invalid Git path' });
      return;
    }
    const allowedMethodForPath: Record<string, string> = {
      'info/refs': 'GET',
      'git-upload-pack': 'POST',
      'git-receive-pack': 'POST'
    };
    const expectedMethod = allowedMethodForPath[normalizedSub];
    if (!expectedMethod || req.method !== expectedMethod) {
      reply.code(403).send({ error: `Forbidden Git Smart HTTP operation: ${req.method} ${normalizedSub}` });
      return;
    }

    const bodyLen = Buffer.isBuffer(req.body) ? req.body.length : 0;
    const contentLen = Math.max(Number(req.headers['content-length'] || 0), bodyLen);
    if (normalizedSub === 'git-receive-pack' && contentLen > MAX_GIT_PUSH_BYTES) {
      reply.code(413).send({ error: 'Git push exceeds 25 MB limit; store large files in data/raw/ object storage.' });
      return;
    }

    if (this.cfg.gitProvider === 'local') {
      await this.handleLocalSmartHttp(projectId, normalizedSub, req, reply);
      return;
    }

    const upstreamBase = this.provider.getUpstreamRepoUrl(projectId);
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const upstreamUrl = `${upstreamBase}/${normalizedSub}${query}`;
    const parsedUpstream = new URL(upstreamUrl);
    if (!parsedUpstream.pathname.endsWith(`/${projectId}.git/${normalizedSub}`)) {
      reply.code(403).send({ error: 'Resolved Git upstream path escapes project repository' });
      return;
    }

    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${this.cfg.gitServiceToken}`,
        ...(req.headers['content-type'] ? { 'Content-Type': String(req.headers['content-type']) } : {}),
        ...(req.headers['accept'] ? { Accept: String(req.headers['accept']) } : {})
      },
      body: req.method === 'POST' ? (req.body as any) : undefined,
      redirect: 'manual'
    });

    reply.hijack();
    reply.raw.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream'
    });
    if (upstream.body) {
      for await (const chunk of upstream.body as any) {
        reply.raw.write(chunk);
      }
    }
    reply.raw.end();
  }

  private async handleLocalSmartHttp(
    projectId: string,
    normalizedSub: string,
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    await this.provider.ensureProjectRepo(projectId);
    const repoUrl = this.provider.getUpstreamRepoUrl(projectId);
    const repoDir = repoUrl.startsWith('file://') ? repoUrl.slice('file://'.length) : repoUrl;

    const pktLine = (line: string): Buffer => {
      const len = Buffer.byteLength(line) + 4;
      return Buffer.from(len.toString(16).padStart(4, '0') + line);
    };

    if (normalizedSub === 'info/refs') {
      const parsed = new URL(req.url || '/', 'http://localhost');
      const service = parsed.searchParams.get('service') || '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        reply.code(403).send({ error: 'Unsupported Git service' });
        return;
      }
      const gitSubCmd = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
      const { stdout } = await execFileAsync('git', [gitSubCmd, '--stateless-rpc', '--advertise-refs', repoDir], {
        encoding: 'buffer' as any,
        maxBuffer: 10 * 1024 * 1024
      });
      const header = Buffer.concat([pktLine(`# service=${service}\n`), Buffer.from('0000')]);
      reply
        .code(200)
        .header('Content-Type', `application/x-${service}-advertisement`)
        .header('Cache-Control', 'no-cache')
        .send(Buffer.concat([header, Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)]));
      return;
    }

    if (normalizedSub === 'git-upload-pack' || normalizedSub === 'git-receive-pack') {
      const gitSubCmd = normalizedSub === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
      let bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
      const contentEncoding = String(req.headers['content-encoding'] || '').toLowerCase().trim();
      if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
        bodyBuf = await gunzipWithCap(bodyBuf, MAX_GIT_UNCOMPRESSED_BYTES);
      }

      if (normalizedSub === 'git-receive-pack') {
        // Buffer receive-pack stdout & drain stderr, wait for exit, then synchronously upload durable GCS bundle
        // BEFORE sending HTTP 200 so immediate follow-up publish-intake/fork never races bundle durability!
        const result = await new Promise<{ code: number; stdout: Buffer; stderr: string }>((resolve, reject) => {
          const proc = spawn('git', [gitSubCmd, '--stateless-rpc', repoDir], { stdio: ['pipe', 'pipe', 'pipe'] });
          const outChunks: Buffer[] = [];
          const errChunks: Buffer[] = [];
          proc.stdout.on('data', (c: Buffer) => outChunks.push(c));
          proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
          proc.on('error', reject);
          proc.on('close', (code) => {
            resolve({
              code: code ?? 1,
              stdout: Buffer.concat(outChunks),
              stderr: Buffer.concat(errChunks).toString('utf-8')
            });
          });
          proc.stdin.end(bodyBuf);
        });

        if (result.code === 0 && this.provider.persistRepoBundle) {
          await this.provider.persistRepoBundle(projectId);
        }

        reply
          .code(result.code === 0 ? 200 : 500)
          .header('Content-Type', `application/x-${normalizedSub}-result`)
          .header('Cache-Control', 'no-cache')
          .send(result.stdout);
        return;
      }

      // git-upload-pack (clone/fetch) — stream stdout while draining stderr to avoid 64 KB pipe deadlocks
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': `application/x-${normalizedSub}-result`,
        'Cache-Control': 'no-cache'
      });
      await new Promise<void>((resolve) => {
        const proc = spawn('git', [gitSubCmd, '--stateless-rpc', repoDir], { stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stderr.resume();
        proc.stdout.pipe(reply.raw);
        proc.on('close', () => {
          if (!reply.raw.writableEnded) reply.raw.end();
          resolve();
        });
        proc.on('error', () => {
          if (!reply.raw.writableEnded) reply.raw.end();
          resolve();
        });
        proc.stdin.end(bodyBuf);
      });
      return;
    }

    reply.code(404).send({ error: 'Not found' });
  }
}
