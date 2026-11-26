#!/usr/bin/env node
/**
 * CI Live Editor VM Verification Harness (runs on GitHub Actions ubuntu-24.04 after provision.sh).
 *
 * 1. Starts a local mock Bionic Hub (real HubCertificateAuthority mTLS CA + Ed25519 Workload JWTs + /api/internal/models).
 * 2. Seeds `/var/lib/bionic/workspace/lost+found` (0700 root:root) to simulate a freshly formatted ext4 GCE Persistent Disk.
 * 3. Writes `/etc/bionic-daemon.env` and `/etc/bionic-editor.env` and starts the real systemd services (`bionic-daemon`, `bioniceditor`).
 * 4. Executes `sudo /usr/local/bin/bionic-vm-selftest --ci-live`.
 * 5. Sends a real Node 22 mTLS GET `/` request to `bionic-daemon` (:3000) -> `app.sock` -> `bioniceditor` and asserts HTTP 200.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const { HubCertificateAuthority, extractSpiffeSanFromPeerCert } = await import(
  path.join(repoRoot, 'hub/dist/server/auth/ca.js')
);

const projectId = 'prj-ci123456';
const shimToken = crypto.randomBytes(24).toString('hex');
const daemonToken = crypto.randomBytes(24).toString('hex');

// 1. Start mock Hub control plane on localhost
const ca = await HubCertificateAuthority.create({ issuer: 'http://127.0.0.1:4199' });
const mockHub = http.createServer((req, res) => {
  const url = req.url || '/';
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      if (url === '/api/internal/vm/attest' && req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const issued = await ca.signVmCsr({
          csrPem: body.csrPem,
          projectId,
          instanceId: 'ci-vm-001',
          ttlHours: 72
        });
        const workloadJwt = await ca.mintWorkloadJwt(
          { projectId, vmInstanceId: 'ci-vm-001', kind: 'editor' },
          900
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ certPem: issued.certPem, caCertPem: issued.caCertPem, workloadJwt }));
        return;
      }
      if (url === '/api/internal/models' && req.method === 'GET') {
        const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        await ca.verifyWorkloadJwt(auth);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            hubManaged: true,
            models: [
              {
                slug: 'gemini-3-8-flash',
                displayName: 'Gemini 3.8 Flash',
                provider: 'gemini',
                protocol: 'google',
                modelId: 'gemini-3.8-flash'
              }
            ]
          })
        );
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

await new Promise((r) => mockHub.listen(0, '127.0.0.1', r));
const hubPort = mockHub.address().port;
const hubOrigin = `http://127.0.0.1:${hubPort}`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (${code}): ${cmd} ${args.join(' ')}`));
    });
  });
}

try {
  // 2. Simulate freshly formatted ext4 disk containing root-owned `lost+found`
  await run('sudo', ['rm', '-rf', '/var/lib/bionic/workspace']);
  await run('sudo', ['mkdir', '-p', '/var/lib/bionic/workspace/lost+found']);
  await run('sudo', ['chown', 'bionic-user:bionic-user', '/var/lib/bionic/workspace']);
  await run('sudo', ['chown', 'root:root', '/var/lib/bionic/workspace/lost+found']);
  await run('sudo', ['chmod', '0700', '/var/lib/bionic/workspace/lost+found']);

  // 3. Write env files matching bionic-vm-bootstrap
  const daemonEnv = [
    `BIONIC_HUB_ORIGIN=${hubOrigin}`,
    `BIONIC_PROJECT_ID=${projectId}`,
    `BIONIC_LOCAL_SHIM_TOKEN=${shimToken}`,
    `BIONIC_DAEMON_TOKEN=${daemonToken}`,
    'WORKSPACE_DIR=/var/lib/bionic/workspace'
  ].join('\n') + '\n';

  const editorEnv = [
    'BIONIC_HUB_MODE=true',
    `BIONIC_HUB_URL=${hubOrigin}`,
    `BIONIC_PROJECT_ID=${projectId}`,
    `BIONIC_REPORTS_ORIGIN=https://${projectId}.reports.example.test`,
    `BIONIC_LOCAL_SHIM_TOKEN=${shimToken}`,
    `BIONIC_DAEMON_TOKEN=${daemonToken}`,
    'BIONIC_SHIM_URL=http://127.0.0.1:3001'
  ].join('\n') + '\n';

  fs.writeFileSync('/tmp/ci-daemon.env', daemonEnv);
  fs.writeFileSync('/tmp/ci-editor.env', editorEnv);
  await run('sudo', ['install', '-o', 'bionic-daemon', '-g', 'bionic-daemon', '-m', '0600', '/tmp/ci-daemon.env', '/etc/bionic-daemon.env']);
  await run('sudo', ['install', '-o', 'bionic-user', '-g', 'bionic-user', '-m', '0600', '/tmp/ci-editor.env', '/etc/bionic-editor.env']);

  // 4. Start real systemd units and wait for listeners
  await run('sudo', ['systemctl', 'restart', 'bionic-daemon.service', 'bioniceditor.service']);

  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:3003/');
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    await run('sudo', ['journalctl', '-u', 'bionic-daemon', '-u', 'bioniceditor', '-n', '60', '--no-pager']);
    throw new Error('Timed out waiting for bioniceditor.service on 127.0.0.1:3003');
  }

  // 5. Run the VM self-test suite in --ci-live mode (async so mockHub stays responsive on the event loop!)
  await run('sudo', ['/usr/local/bin/bionic-vm-selftest', '--ci-live']);

  // 6. Verify end-to-end Hub mTLS proxy (:3000) -> bionic-daemon -> app.sock -> bioniceditor returns HTTP 200
  const creds = ca.getHubClientCredentials();
  const expectedSan = `spiffe://bionic/project/${projectId}`;
  const mtlsRes = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: 3000,
        path: '/',
        method: 'GET',
        headers: {
          'x-bionic-origin-scope': 'editor',
          'x-bionic-user-id': 'usr-ci'
        },
        key: creds.keyPem,
        cert: creds.certPem,
        ca: creds.caCertPem,
        rejectUnauthorized: true,
        timeout: 5000,
        checkServerIdentity: (_host, peerCert) => {
          const san = extractSpiffeSanFromPeerCert(peerCert);
          return san === expectedSan ? undefined : new Error(`SAN mismatch: ${san}`);
        }
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('mTLS GET / timed out')));
    req.end();
  });

  if (mtlsRes.status !== 200 || !mtlsRes.body.includes('__BIONIC_CONFIG__')) {
    throw new Error(`Expected HTTP 200 HTML from mTLS :3000, got ${mtlsRes.status}: ${mtlsRes.body.slice(0, 200)}`);
  }
  console.log('✔ PASS  End-to-end Hub mTLS (:3000) -> bionic-daemon -> app.sock -> bioniceditor returned HTTP 200 HTML');
} finally {
  try {
    await run('sudo', ['systemctl', 'stop', 'bionic-daemon.service', 'bioniceditor.service']);
  } catch {}
  mockHub.close();
}
