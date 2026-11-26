import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { HubConfig } from '../../config.js';
import type { WorkloadJwtClaims } from '../../auth/ca.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_PUSH_BYTES = 25 * 1024 * 1024; // 25 MB hard cap per push pack

export interface GitProvider {
  ensureProjectRepo(projectId: string, forkFrom?: { sourceProjectId: string; commitSha: string }): Promise<string>;
  getUpstreamRepoUrl(projectId: string): string;
  verifyCommitExists(projectId: string, commitSha: string): Promise<boolean>;
}

/**
 * Local bare-repo GitProvider for self-contained dev/testing.
 * Also installs a server-side `pre-receive` hook enforcing the 25 MB blob & `data/raw/` guard.
 */
export class LocalBareGitProvider implements GitProvider {
  constructor(private readonly reposDir: string) {
    fs.mkdirSync(reposDir, { recursive: true });
  }

  private repoPath(projectId: string): string {
    if (!/^prj-[a-z0-9-]+$/.test(projectId)) throw new Error('Invalid projectId for git repo');
    return path.join(this.reposDir, `${projectId}.git`);
  }

  async ensureProjectRepo(projectId: string, forkFrom?: { sourceProjectId: string; commitSha: string }): Promise<string> {
    const target = this.repoPath(projectId);
    if (!fs.existsSync(target)) {
      if (forkFrom) {
        const src = this.repoPath(forkFrom.sourceProjectId);
        if (fs.existsSync(src)) {
          await execFileAsync('git', ['clone', '--bare', src, target]);
          if (forkFrom.commitSha && /^[0-9a-f]{7,40}$/i.test(forkFrom.commitSha)) {
            try {
              await execFileAsync('git', ['--git-dir', target, 'cat-file', '-e', `${forkFrom.commitSha}^{commit}`]);
              await execFileAsync('git', ['--git-dir', target, 'update-ref', 'refs/heads/main', forkFrom.commitSha]);
              await execFileAsync('git', ['--git-dir', target, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
            } catch {
              // Keep cloned default HEAD if commitSha not found
            }
          }
        } else {
          await execFileAsync('git', ['init', '--bare', target]);
        }
      } else {
        await execFileAsync('git', ['init', '--bare', target]);
      }

      // Install server-side pre-receive hook rejecting data/raw/* and blobs > 25 MB
      const hookPath = path.join(target, 'hooks', 'pre-receive');
      const hookScript = `#!/usr/bin/env bash
set -euo pipefail
MAX_BYTES=26214400
while read -r oldrev newrev refname; do
  if [[ "$newrev" == "0000000000000000000000000000000000000000" ]]; then
    continue
  fi
  RAW_FILES="$(git diff-tree --no-commit-id --name-only -r "$newrev" -- 'data/raw/' | grep -v '^data/raw/\\.gitkeep$' || true)"
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
      fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
    }
    return `file://${target}`;
  }

  getUpstreamRepoUrl(projectId: string): string {
    return `file://${this.repoPath(projectId)}`;
  }

  async verifyCommitExists(projectId: string, commitSha: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/i.test(commitSha)) return false;
    const target = this.repoPath(projectId);
    if (!fs.existsSync(target)) return false;
    try {
      await execFileAsync('git', ['--git-dir', target, 'cat-file', '-e', `${commitSha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
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
 * Central Hub Git Smart HTTP Proxy (`GET/POST /api/internal/git/:projectId.git/*`).
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
      const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': `application/x-${normalizedSub}-result`,
        'Cache-Control': 'no-cache'
      });
      await new Promise<void>((resolve) => {
        const proc = spawn('git', [gitSubCmd, '--stateless-rpc', repoDir], { stdio: ['pipe', 'pipe', 'pipe'] });
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
