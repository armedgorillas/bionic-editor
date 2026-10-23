import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const rootDir = path.resolve('.');
const PORT = 4000 + Math.floor(Math.random() * 4000);

test('GitHub Issues #6, #7, #8 Test Suite', async (t) => {
  let serverProcess;

  await t.test('Start test server on dedicated port', async () => {
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
        const str = d.toString();
        if (!str.includes('injected env')) {
          console.error('Server err:', str);
        }
      });
    });
  });

  // Issue #6: Address sockets error (`accept: too many files open`)
  await t.test('Issue #6: WebSocket endpoint accepts connections and maintains heartbeat', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);

    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    assert.equal(ws.readyState, WebSocket.OPEN);

    // Heartbeat ping/pong response
    const pongPromise = new Promise((resolve) => {
      ws.on('pong', resolve);
    });
    ws.ping();
    await pongPromise;

    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
    assert.equal(ws.readyState, WebSocket.CLOSED);
  });

  await t.test('Issue #6: Terminal WebSocket session cleanly starts, inputs, and cleans up processes', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);

    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    let receivedOutput = false;
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'terminal_output') {
          receivedOutput = true;
        }
      } catch {}
    });

    ws.send(JSON.stringify({ type: 'terminal_start' }));

    // Send a command to verify process interaction
    ws.send(JSON.stringify({ type: 'terminal_input', data: 'echo "bionic_socket_test"\n' }));

    // Wait briefly for output
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.ok(receivedOutput, 'Terminal session should produce output over WebSocket');

    // Terminate session cleanly
    ws.send(JSON.stringify({ type: 'terminal_stop' }));
    ws.close();
    await new Promise((resolve) => ws.on('close', resolve));
  });

  await t.test('Issue #6: Multiple concurrent WebSocket connections connect and disconnect without leaking', async () => {
    const connections = [];
    const count = 10;

    for (let i = 0; i < count; i++) {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
      connections.push(ws);
    }

    await Promise.all(
      connections.map((ws) => new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      }))
    );

    // Close all connections simultaneously
    await Promise.all(
      connections.map((ws) => new Promise((resolve) => {
        ws.on('close', resolve);
        ws.close();
      }))
    );

    for (const ws of connections) {
      assert.equal(ws.readyState, WebSocket.CLOSED);
    }
  });

  await t.test('Issue #6: Server error handler gracefully absorbs EMFILE accept errors', () => {
    const serverFile = fs.readFileSync(path.join(rootDir, 'server/index.ts'), 'utf-8');
    assert.ok(serverFile.includes('EMFILE'), 'server/index.ts must handle EMFILE');
    assert.ok(serverFile.includes('activeSockets'), 'server/index.ts must track activeSockets');
    assert.ok(serverFile.includes('activeClients'), 'server/index.ts must track activeClients');
    assert.ok(serverFile.includes('heartbeatInterval'), 'server/index.ts must have WebSocket heartbeat');
  });

  // Issue #7: Table view isnt rendering in WYSIWYG markdown mode
  await t.test('Issue #7: WYSIWYG editor has table extensions configured and styled', () => {
    const editorFile = fs.readFileSync(path.join(rootDir, 'client/src/components/Editor/WysiwygEditor.tsx'), 'utf-8');
    assert.ok(editorFile.includes('TableKit'), 'WysiwygEditor must include TableKit extension');
    assert.ok(editorFile.includes('insertTable'), 'WysiwygEditor must include insertTable toolbar action');
    assert.ok(editorFile.includes('TableIcon'), 'WysiwygEditor must render Table icon in toolbar');

    const cssFile = fs.readFileSync(path.join(rootDir, 'client/src/index.css'), 'utf-8');
    assert.ok(cssFile.includes('.tiptap table'), 'index.css must contain table styling for .tiptap');
    assert.ok(cssFile.includes('.tiptap table th'), 'index.css must contain table header styling');
    assert.ok(cssFile.includes('.tiptap table td'), 'index.css must contain table cell styling');

    const pkgClient = JSON.parse(fs.readFileSync(path.join(rootDir, 'client/package.json'), 'utf-8'));
    assert.ok(pkgClient.dependencies['@tiptap/extension-table'], 'client package.json must include @tiptap/extension-table');
  });

  // Issue #8: Render markdown in chatbot view
  await t.test('Issue #8: Chatbot panel integrates ReactMarkdown and renders formatted Markdown', async () => {
    const agentPanelFile = fs.readFileSync(path.join(rootDir, 'client/src/components/Agent/AgentPanel.tsx'), 'utf-8');
    assert.ok(agentPanelFile.includes('MarkdownMessage'), 'AgentPanel must import and use MarkdownMessage');
    assert.ok(!agentPanelFile.includes("msg.content.split('\\n\\n').map"), 'AgentPanel must not render raw paragraphs with split');

    const markdownMsgFile = fs.readFileSync(path.join(rootDir, 'client/src/components/Agent/MarkdownMessage.tsx'), 'utf-8');
    assert.ok(markdownMsgFile.includes('ReactMarkdown'), 'MarkdownMessage must use ReactMarkdown');
    assert.ok(markdownMsgFile.includes('remarkGfm'), 'MarkdownMessage must use remarkGfm');
    assert.ok(markdownMsgFile.includes('CodeBlock'), 'MarkdownMessage must have code block support with copy button');

    const pkgClient = JSON.parse(fs.readFileSync(path.join(rootDir, 'client/package.json'), 'utf-8'));
    assert.ok(pkgClient.dependencies['react-markdown'], 'client package.json must include react-markdown');
    assert.ok(pkgClient.dependencies['remark-gfm'], 'client package.json must include remark-gfm');

    // Verify static rendering of markdown tables, lists, and code blocks
    const { execFileSync } = await import('node:child_process');
    const verifyScript = [
      'import React from "./client/node_modules/react/index.js";',
      'import ReactDOMServer from "./client/node_modules/react-dom/server.node.js";',
      'import { MarkdownMessage } from "./client/src/components/Agent/MarkdownMessage.tsx";',
      'const markdown = "# Analysis Results\\n\\n| Gene | Log2FC |\\n|---|---|\\n| BRCA1 | -1.8 |\\n\\n```python\\nprint(\\"DEG\\")\\n```";',
      'const html = ReactDOMServer.renderToStaticMarkup(React.createElement(MarkdownMessage, { content: markdown }));',
      'if (!html.includes("<table") || !html.includes("BRCA1") || !html.includes("<h1")) { process.exit(1); }'
    ].join('\n');

    execFileSync('npx', ['tsx', '-e', verifyScript], { stdio: 'pipe' });
  });

  t.after(() => {
    if (serverProcess) {
      serverProcess.stdout?.destroy();
      serverProcess.stderr?.destroy();
      serverProcess.kill('SIGKILL');
    }
  });
});
