import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

async function waitForServer(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test('Bionic Editor Hub Mode, Sandbox Mode & Portable Bash Scripts Suite', async (t) => {
  await t.test('Sandbox Mode hard-blocks /api/venv/*, save-config, WS terminal_start, and handleDemoAgent run_python RCE (H7)', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-sandbox-test-'));
    const markerFile = path.join(tmpWs, 'PWNED.txt');
    const port = 3421;
    let proc;

    try {
      // Plant a malicious code/analyze.py that would create PWNED.txt if executed
      fs.mkdirSync(path.join(tmpWs, 'code'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpWs, 'code', 'analyze.py'),
        `from pathlib import Path\nPath(${JSON.stringify(markerFile)}).write_text("pwned")\n`
      );
      fs.writeFileSync(path.join(tmpWs, 'SPEC.md'), '# Test\n');

      proc = spawn('node', ['dist-server/index.js', '--workspace', tmpWs, '--port', String(port), '--host', '127.0.0.1'], {
        env: {
          ...process.env,
          BIONIC_SANDBOX_MODE: 'true',
          BIONIC_HUB_MODE: 'false'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      await waitForServer(`http://127.0.0.1:${port}/api/workspace/info`);

      // 1. /api/venv/run must be 403
      const venvRes = await fetch(`http://127.0.0.1:${port}/api/venv/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scriptPath: 'code/analyze.py' })
      });
      assert.equal(venvRes.status, 403);

      // 2. /api/agent/save-config must be 403
      const saveCfgRes = await fetch(`http://127.0.0.1:${port}/api/agent/save-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openaiApiKey: 'sk-test' })
      });
      assert.equal(saveCfgRes.status, 403);

      // 3. Demo agent triggered with "run analyze" must NOT execute code/analyze.py!
      const chatRes = await fetch(`http://127.0.0.1:${port}/api/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'please run analyze script now' }],
          config: { provider: 'demo', sessionId: 'sandbox-test-1' }
        })
      });
      assert.equal(chatRes.status, 200);
      const sseText = await chatRes.text();
      assert.ok(sseText.includes('Sandbox Mode'), 'Expected sandbox message in demo response');
      assert.equal(fs.existsSync(markerFile), false, 'RCE GUARD FAILED: analyze.py was executed in Sandbox Mode!');

      // 4. Sandbox Mode blocks file mutations and uploads (Reviewer 2 #8)
      const writeRes = await fetch(`http://127.0.0.1:${port}/api/files/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'web-report/index.html', content: '<script>alert(1)</script>' })
      });
      assert.equal(writeRes.status, 403);

      // 5. WebSocket terminal_start must be blocked
      const wsMsg = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'terminal_start' })));
        ws.on('message', (data) => {
          ws.close();
          resolve(data.toString());
        });
        ws.on('error', reject);
      });
      assert.ok(String(wsMsg).includes('disabled in Sandbox Mode'));
    } finally {
      if (proc) proc.kill('SIGTERM');
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  await t.test('Hub Mode blocks same-origin /report, save-config, data/raw/ Multer uploads, and supports hub-local endpoints', async () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-hubmode-test-'));
    const port = 3422;
    let proc;

    try {
      proc = spawn('node', ['dist-server/index.js', '--workspace', tmpWs, '--port', String(port), '--host', '127.0.0.1'], {
        env: {
          ...process.env,
          BIONIC_HUB_MODE: 'true',
          BIONIC_PROJECT_ID: 'prj-01testproject00000000000000',
          BIONIC_REPORTS_ORIGIN: 'https://prj-01testproject00000000000000.reports.bionic.example.com',
          BIONIC_DAEMON_TOKEN: 'daemon-secret-xyz',
          SUPER_SECRET_DAEMON_KEY: 'must-not-leak-to-child'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      await waitForServer(`http://127.0.0.1:${port}/api/workspace/info`);

      // 1. Same-origin /report must return 403 when reportsOrigin is set (C1)
      const repRes = await fetch(`http://127.0.0.1:${port}/report/index.html`);
      assert.equal(repRes.status, 403);

      // 2. /api/agent/save-config must return 403
      const saveRes = await fetch(`http://127.0.0.1:${port}/api/agent/save-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geminiApiKey: 'AIzaTest' })
      });
      assert.equal(saveRes.status, 403);

      // 3. Direct Multer upload to data/raw (including non-canonical ./data/raw) must be rejected in Hub Mode (#21)
      const form = new FormData();
      form.append('file', new Blob(['col1,col2\n1,2\n']), 'counts.csv');
      const uploadRes = await fetch(`http://127.0.0.1:${port}/api/files/upload?dir=./data/raw`, {
        method: 'POST',
        body: form
      });
      assert.equal(uploadRes.status >= 400, true);

      // 3b. /api/hub-local/* without X-Bionic-Daemon-Token must return 403 (#2)
      const unauthActRes = await fetch(`http://127.0.0.1:${port}/api/hub-local/activity`);
      assert.equal(unauthActRes.status, 403);

      // 4. /api/hub-local/apply-manifest with valid daemon token registers remote_only GCS entries & preserves schemaVersion 2 (#25)
      const applyRes = await fetch(`http://127.0.0.1:${port}/api/hub-local/apply-manifest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bionic-Daemon-Token': 'daemon-secret-xyz' },
        body: JSON.stringify({
          filepath: 'data/raw/huge_cohort.h5ad',
          sha256: 'a'.repeat(64),
          sizeBytes: 5_000_000_000,
          description: '5 GB remote-only single-cell dataset',
          storage: {
            provider: 'gcs',
            dataObjectId: 'dat-01testobject000000000000000',
            uri: 'gs://bionic-project-data/projects/prj-01/blobs/dat-01/huge_cohort.h5ad',
            syncStatus: 'remote_only',
            readOnly: false
          }
        })
      });
      assert.equal(applyRes.status, 200);

      const summaryRes = await fetch(`http://127.0.0.1:${port}/api/data/manifest`);
      const summary = await summaryRes.json();
      assert.equal(summary.manifest.schemaVersion, 2);
      assert.equal(summary.entries.length, 1);
      assert.equal(summary.entries[0].status, 'remote_only');
      assert.equal(summary.hasIssues, false);

      // 5. /api/hub-local/activity with daemon token responds with live activity counters
      const actRes = await fetch(`http://127.0.0.1:${port}/api/hub-local/activity`, {
        headers: { 'X-Bionic-Daemon-Token': 'daemon-secret-xyz' }
      });
      assert.equal(actRes.status, 200);
      const act = await actRes.json();
      assert.equal(typeof act.activeAgentTurns, 'number');

      // 6. Portable scripts were scaffolded into scripts/
      for (const s of ['run.sh', 'publish.sh', 'data-pull.sh', 'data-push.sh', 'verify-data.sh']) {
        assert.ok(fs.existsSync(path.join(tmpWs, 'scripts', s)), `Missing portable script scripts/${s}`);
      }
      assert.ok(fs.existsSync(path.join(tmpWs, 'bionic.yaml')));
    } finally {
      if (proc) proc.kill('SIGTERM');
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  await t.test('Exported example project runs cold-start via portable bash scripts (data-pull -> run -> verify -> publish) with zero Hub', () => {
    const tmpCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-example-export-'));
    const pubOut = path.join(tmpCopy, 'published-site');
    const repoCopy = path.join(tmpCopy, 'demo-rnaseq-project');
    try {
      fs.cpSync(path.resolve('examples/demo-rnaseq-project'), repoCopy, { recursive: true });
      // Confirm raw data is NOT checked in, then run ./scripts/run.sh cold
      assert.equal(fs.existsSync(path.join(repoCopy, 'data/raw/kidney_cohort_counts.csv')), false);

      const runOut = execFileSync('bash', ['scripts/run.sh'], { cwd: repoCopy, encoding: 'utf-8' });
      assert.ok(runOut.includes('All 3 scientific validation tests PASSED'));
      assert.ok(fs.existsSync(path.join(repoCopy, 'data/raw/kidney_cohort_counts.csv')));

      const verifyOut = execFileSync('bash', ['scripts/verify-data.sh'], { cwd: repoCopy, encoding: 'utf-8' });
      assert.ok(verifyOut.includes('OK: Data manifest and web-report publication safety check passed'));

      const pubRes = execFileSync('bash', ['scripts/publish.sh', '--no-git'], {
        cwd: repoCopy,
        encoding: 'utf-8',
        env: { ...process.env, PUBLISH_TARGET: pubOut }
      });
      assert.ok(pubRes.includes('OK: Published web-report/'));
      assert.ok(fs.existsSync(path.join(pubOut, 'index.html')));
      // Verify raw data did NOT leak into published output
      assert.equal(fs.existsSync(path.join(pubOut, 'kidney_cohort_counts.csv')), false);
    } finally {
      fs.rmSync(tmpCopy, { recursive: true, force: true });
    }
  });
});
