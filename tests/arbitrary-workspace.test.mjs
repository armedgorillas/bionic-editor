import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function fetchUrl(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port,
      path: urlPath,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data
        });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

test('Arbitrary Workspace and Remote Installation Suite', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-arb-test-'));
  const customWorkspace = path.join(tempDir, 'custom-bio-study');
  fs.mkdirSync(customWorkspace, { recursive: true });

  // Place a unique marker file in the custom workspace
  const markerFile = path.join(customWorkspace, 'EXPERIMENT_MARKER.txt');
  fs.writeFileSync(markerFile, 'study_id=EXP-2026-ARBITRARY', 'utf-8');

  const PORT = 4000 + Math.floor(Math.random() * 4000);
  let serverProcess;

  await t.test('Server starts with --workspace CLI flag pointing to arbitrary folder from /tmp', async () => {
    // Run from /tmp to verify it works outside the project directory
    serverProcess = spawn(
      process.execPath,
      [
        path.resolve('dist-server/index.js'),
        '--workspace', customWorkspace,
        '--port', String(PORT)
      ],
      {
        cwd: os.tmpdir(),
        env: { ...process.env, NODE_ENV: 'production' },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server failed to start within 8s')), 8000);
      serverProcess.stdout.on('data', (d) => {
        if (d.toString().includes('Bionic Editor running at')) {
          clearTimeout(timeout);
          resolve(true);
        }
      });
      serverProcess.stderr.on('data', (d) => {
        // allow env notifications
      });
    });
  });

  await t.test('Client frontend is correctly served even when running outside project directory', async () => {
    const res = await fetchUrl(PORT, '/');
    assert.equal(res.status, 200);
    assert.ok(res.data.includes('Bionic Editor'));
  });

  await t.test('Workspace info API reports custom arbitrary workspace path', async () => {
    const res = await fetchUrl(PORT, '/api/workspace/info');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.data);
    assert.equal(body.workspaceDir, customWorkspace);
  });

  await t.test('File tree includes marker file from arbitrary workspace', async () => {
    const res = await fetchUrl(PORT, '/api/files/tree');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.data);
    const marker = body.tree.find((f) => f.name === 'EXPERIMENT_MARKER.txt');
    assert.ok(marker, 'EXPERIMENT_MARKER.txt must exist in file tree');
  });

  await t.test('Can read marker file from arbitrary workspace', async () => {
    const res = await fetchUrl(PORT, '/api/files/read?path=EXPERIMENT_MARKER.txt');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.data);
    assert.ok(body.content.includes('study_id=EXP-2026-ARBITRARY'));
  });

  t.after(() => {
    if (serverProcess) {
      serverProcess.stdout?.destroy();
      serverProcess.stderr?.destroy();
      serverProcess.kill('SIGKILL');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
