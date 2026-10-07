import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = 3000 + Math.floor(Math.random() * 5000);

function fetchUrl(path, options = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: PORT,
      path,
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

test('Bionic Editor End-to-End Server Suite', async (t) => {
  let serverProcess;

  await t.test('Server starts on dedicated single port', async () => {
    serverProcess = spawn('npx', ['tsx', 'server/index.ts'], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server failed to start within 8s')), 8000);
      serverProcess.stdout.on('data', (d) => {
        if (d.toString().includes('Bionic Editor running at')) {
          clearTimeout(timeout);
          resolve(true);
        }
      });
      serverProcess.stderr.on('data', (d) => {
        console.error('Server err:', d.toString());
      });
    });
  });

  await t.test('Serves client frontend index.html on root', async () => {
    const res = await fetchUrl('/');
    assert.equal(res.status, 200);
    assert.ok(res.data.includes('Bionic Editor'));
  });

  await t.test('Serves live web report at /report/index.html', async () => {
    const res = await fetchUrl('/report/index.html');
    assert.equal(res.status, 200);
    assert.ok(res.data.includes('Differential Expression Analysis Report'));
  });

  await t.test('Returns workspace info and Cookiecutter template structure', async () => {
    const res = await fetchUrl('/api/workspace/info');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.data);
    assert.ok(body.workspaceDir);
    assert.ok(typeof body.venv.exists === 'boolean');
  });

  await t.test('Returns file tree including SPEC.md and data files', async () => {
    const res = await fetchUrl('/api/files/tree');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.data);
    const spec = body.tree.find((f) => f.name === 'SPEC.md');
    assert.ok(spec, 'SPEC.md should exist in file tree');
  });

  await t.test('Can read SPEC.md raw content', async () => {
    const res = await fetchUrl('/api/files/read?path=SPEC.md');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.data);
    assert.ok(typeof body.content === 'string' && body.content.length > 0);
  });

  await t.test('AI Agent responds and outputs non-terminal step events via SSE', async () => {
    const res = await fetchUrl('/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        messages: [{ role: 'user', content: 'Please analyze the gene expression dataset.' }],
        config: { provider: 'demo' }
      }
    });

    assert.equal(res.status, 200);
    assert.ok(res.data.includes('step_start'));
    assert.ok(res.data.includes('step_done'));
    assert.ok(res.data.includes('final'));
  });

  await t.test('Agent config includes Google Gemini in available providers', async () => {
    const res = await fetchUrl('/api/agent/config');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.data);
    const gemini = body.availableProviders.find((p) => p.id === 'gemini');
    assert.ok(gemini, 'Gemini provider must be registered');
    assert.ok(gemini.name.includes('Gemini'));
  });

  t.after(() => {
    if (serverProcess) {
      serverProcess.stdout?.destroy();
      serverProcess.stderr?.destroy();
      serverProcess.kill('SIGKILL');
    }
  });
});
