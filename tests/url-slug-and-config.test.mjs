import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('URL Slug, Base Spec, and Target User Test Suite', async (t) => {
  // 1. Unit tests for config normalizers
  await t.test('normalizeBaseUrl correctly normalizes URL slugs', async () => {
    const { normalizeBaseUrl } = await import('../dist-server/config.js');
    assert.equal(normalizeBaseUrl(''), '');
    assert.equal(normalizeBaseUrl('/'), '');
    assert.equal(normalizeBaseUrl('   '), '');
    assert.equal(normalizeBaseUrl('ws-01'), '/ws-01');
    assert.equal(normalizeBaseUrl('/ws-01'), '/ws-01');
    assert.equal(normalizeBaseUrl('/ws-01/'), '/ws-01');
    assert.equal(normalizeBaseUrl('ws-01/'), '/ws-01');
    assert.equal(normalizeBaseUrl('/nested/slug/path/'), '/nested/slug/path');
  });

  await t.test('normalizeBaseSpec defaults to SPEC.md and handles custom filenames', async () => {
    const { normalizeBaseSpec } = await import('../dist-server/config.js');
    assert.equal(normalizeBaseSpec(''), 'SPEC.md');
    assert.equal(normalizeBaseSpec(undefined), 'SPEC.md');
    assert.equal(normalizeBaseSpec('   '), 'SPEC.md');
    assert.equal(normalizeBaseSpec('EXPERIMENT_PLAN.md'), 'EXPERIMENT_PLAN.md');
    assert.equal(normalizeBaseSpec('notes/protocol.md'), 'notes/protocol.md');
  });

  await t.test('resolveTargetUser resolves configured and system users', async () => {
    const { resolveTargetUser, getTargetSpawnOptions } = await import('../dist-server/config.js');
    const currentUser = os.userInfo().username;
    
    // Explicit user
    const resolvedExplicit = resolveTargetUser('/tmp', currentUser);
    assert.equal(resolvedExplicit.username, currentUser);
    
    // Spawn options have valid environment
    const spawnOpts = getTargetSpawnOptions({ CUSTOM_TEST_VAR: '123' });
    assert.ok(spawnOpts.env);
    assert.equal(spawnOpts.env.CUSTOM_TEST_VAR, '123');
  });

  // 2. Integration test: start server with custom --base-url and --base-spec
  const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-slug-test-'));
  const testPort = 3987;
  const testSlug = '/ws-01';
  const customSpec = 'CUSTOM_SPEC.md';

  let serverProc = null;

  try {
    await t.test('Start Bionic Editor server with --base-url and --base-spec', async () => {
      serverProc = spawn('node', [
        path.join(rootDir, 'bin', 'bioniceditor.js'),
        '--workspace', tempWorkspace,
        '--port', String(testPort),
        '--host', '127.0.0.1',
        '--base-url', testSlug,
        '--base-spec', customSpec
      ], {
        cwd: rootDir,
        env: {
          ...process.env,
          NODE_ENV: 'test'
        }
      });

      // Wait for server to listen
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Server failed to start within 6 seconds'));
        }, 6000);

        serverProc.stdout.on('data', (d) => {
          const str = d.toString();
          if (str.includes(`http://127.0.0.1:${testPort}`) || str.includes('Bionic Editor running')) {
            clearTimeout(timeout);
            resolve();
          }
        });

        serverProc.stderr.on('data', (d) => {
          // Output server errors to assist debugging if startup fails
          const errStr = d.toString();
          if (!errStr.includes('injected env')) {
            process.stderr.write(`[Server test err] ${errStr}`);
          }
        });

        serverProc.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    });

    const baseUrl = `http://127.0.0.1:${testPort}`;

    await t.test('Redirects /ws-01 to /ws-01/', async () => {
      const res = await fetch(`${baseUrl}${testSlug}`, { redirect: 'manual' });
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), `${testSlug}/`);
    });

    await t.test('Serves client frontend at /ws-01/ with injected config and <base href>', async () => {
      const res = await fetch(`${baseUrl}${testSlug}/`);
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/html'));
      const text = await res.text();
      assert.ok(text.includes('window.__BIONIC_CONFIG__'), 'Should inject __BIONIC_CONFIG__');
      assert.ok(text.includes(`"baseUrl":"${testSlug}"`), 'Should contain configured baseUrl');
      assert.ok(text.includes(`"baseSpec":"${customSpec}"`), 'Should contain configured baseSpec');
      assert.ok(text.includes(`<base href="${testSlug}/">`), 'Should inject <base href="/ws-01/"> tag');
    });

    await t.test('Serves API at /ws-01/api/workspace/info with baseSpec and baseUrl', async () => {
      const res = await fetch(`${baseUrl}${testSlug}/api/workspace/info`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.baseUrl, testSlug);
      assert.equal(json.baseSpec, customSpec);
      assert.equal(json.workspaceDir, tempWorkspace);
    });

    await t.test('Serves Web Report at /ws-01/report/index.html', async () => {
      const res = await fetch(`${baseUrl}${testSlug}/report/index.html`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Bionic Editor - Scientific Analysis Report'));
    });

    await t.test('Template initialization creates overridden base spec file', async () => {
      const res = await fetch(`${baseUrl}${testSlug}/api/workspace/init`, { method: 'POST' });
      assert.equal(res.status, 200);
      const createdPath = path.join(tempWorkspace, customSpec);
      assert.ok(fs.existsSync(createdPath), `Should create ${customSpec}`);
      const content = fs.readFileSync(createdPath, 'utf-8');
      assert.ok(content.includes('Scientific Experiment & Analysis Plan'));
    });

    await t.test('Accepts WebSocket connections at /ws-01/ws', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${testPort}${testSlug}/ws`);
      
      const opened = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS connection timeout')), 3000);
        ws.on('open', () => {
          clearTimeout(timeout);
          resolve(true);
        });
        ws.on('error', (e) => {
          clearTimeout(timeout);
          reject(e);
        });
      });

      assert.equal(opened, true);
      ws.close();
    });

    await t.test('Backward compatibility: API and WebSocket still respond at root paths', async () => {
      const apiRes = await fetch(`${baseUrl}/api/workspace/info`);
      assert.equal(apiRes.status, 200);
      const info = await apiRes.json();
      assert.equal(info.baseSpec, customSpec);

      const ws = new WebSocket(`ws://127.0.0.1:${testPort}/ws`);
      const opened = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Root WS connection timeout')), 3000);
        ws.on('open', () => {
          clearTimeout(timeout);
          resolve(true);
        });
        ws.on('error', (e) => {
          clearTimeout(timeout);
          reject(e);
        });
      });
      assert.equal(opened, true);
      ws.close();
    });

    await t.test('Moving/renaming files sets read/write permissions accessible by user and agent', async () => {
      // Create a test file
      const createRes = await fetch(`${baseUrl}${testSlug}/api/files/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'src/origin_file.py',
          content: 'print("move test")\n'
        })
      });
      assert.equal(createRes.status, 200);

      // Move / rename it
      const renameRes = await fetch(`${baseUrl}${testSlug}/api/files/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPath: 'src/origin_file.py',
          newPath: 'src/moved_file.py'
        })
      });
      assert.equal(renameRes.status, 200);

      // Verify file exists and is accessible
      const movedFullPath = path.join(tempWorkspace, 'src/moved_file.py');
      assert.ok(fs.existsSync(movedFullPath));
      const stat = fs.statSync(movedFullPath);
      // Ensure file has read and write permissions (mode & 0o600 === 0o600)
      assert.ok((stat.mode & 0o600) === 0o600, 'Moved file must have user read and write permissions');

      // Verify agent / api can read it
      const readRes = await fetch(`${baseUrl}${testSlug}/api/files/read?path=src/moved_file.py`);
      assert.equal(readRes.status, 200);
      const readData = await readRes.json();
      assert.equal(readData.content, 'print("move test")\n');
    });

    await t.test('Agent API reports harness configuration appropriately', async () => {
      const { getOpenCodeBinary } = await import('../dist-server/services/agent.js');
      const bin = getOpenCodeBinary();

      const res = await fetch(`${baseUrl}${testSlug}/api/agent/config`);
      assert.equal(res.status, 200);
      const config = await res.json();
      if (bin) {
        assert.equal(config.isOpenCodeInstalled, true);
        assert.equal(config.harness, 'opencode');
      } else {
        assert.equal(config.isOpenCodeInstalled, false);
        assert.equal(config.harness, 'built-in');
      }
      assert.ok(config.availableProviders.some(p => p.id === 'gemini'));
    });

    await t.test('getOpenCodeBinary detects binary via OPENCODE_BIN override', async () => {
      const { getOpenCodeBinary } = await import('../dist-server/services/agent.js');
      const mockBin = path.join(os.tmpdir(), `mock-opencode-${Date.now()}`);
      fs.writeFileSync(mockBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const orig = process.env.OPENCODE_BIN;
      try {
        process.env.OPENCODE_BIN = mockBin;
        const detected = getOpenCodeBinary();
        assert.equal(detected, mockBin);
      } finally {
        if (orig !== undefined) {
          process.env.OPENCODE_BIN = orig;
        } else {
          delete process.env.OPENCODE_BIN;
        }
        try { fs.unlinkSync(mockBin); } catch {}
      }
    });

  } finally {
    if (serverProc) {
      serverProc.kill('SIGTERM');
    }
    // Clean up temporary workspace
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {}
  }
});
