import http from 'http';
import path from 'path';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';

import { PORT, HOST, WORKSPACE_DIR, PACKAGE_ROOT, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OLLAMA_BASE_URL, updateConfigKeys, BASE_URL, BASE_SPEC } from './config.js';
import {
  ensureWorkspaceDir,
  initDefaultTemplate,
  getFileTree,
  readFileContent,
  writeFileContent,
  createItem,
  renameItem,
  deleteItem,
  resolveSafePath
} from './services/workspace.js';
import {
  getVenvStatus,
  createVenv,
  installRequirements,
  runPythonScript,
  killSessionProcesses
} from './services/venv.js';
import { runAgentConversation, StepEvent, cancelAgentSession } from './services/agent.js';
import { initFileWatcher } from './services/fileWatcher.js';
import { TerminalSession } from './services/terminal.js';
import {
  listSessions,
  getSession,
  saveSession,
  deleteSession
} from './services/sessionManager.js';

// Initialize workspace on start
ensureWorkspaceDir();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  try {
    const host = request.headers.host || 'localhost';
    const pathname = new URL(request.url || '', `http://${host}`).pathname;
    const isWsPath = pathname === '/ws' || (BASE_URL && pathname === `${BASE_URL}/ws`);
    if (isWsPath) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
});

// Track active HTTP sockets to mitigate and recover from socket/file descriptor limits
const activeSockets = new Set<import('net').Socket>();

server.on('connection', (socket) => {
  activeSockets.add(socket);
  socket.on('close', () => {
    activeSockets.delete(socket);
  });
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Multer upload config
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const targetDir = req.query.dir ? String(req.query.dir) : '';
    const safeTarget = targetDir ? resolveSafePath(targetDir) : WORKSPACE_DIR;
    if (!fs.existsSync(safeTarget)) {
      fs.mkdirSync(safeTarget, { recursive: true });
    }
    cb(null, safeTarget);
  },
  filename: (_req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

// Web Report static server - direct single-port serving
const webReportDir = path.join(WORKSPACE_DIR, 'web-report');
app.use('/report', express.static(webReportDir));
if (BASE_URL) {
  app.use(`${BASE_URL}/report`, express.static(webReportDir));
}

const apiRouter = express.Router();

// Workspace info
apiRouter.get('/workspace/info', (_req, res) => {
  res.json({
    workspaceDir: WORKSPACE_DIR,
    venv: getVenvStatus(),
    baseSpec: BASE_SPEC,
    baseUrl: BASE_URL
  });
});

// Reinitialize default template
apiRouter.post('/workspace/init', (_req, res) => {
  try {
    initDefaultTemplate();
    res.json({ success: true, message: 'Initialized scientific template.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// File explorer endpoints
apiRouter.get('/files/tree', (_req, res) => {
  try {
    const tree = getFileTree();
    res.json({ tree });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/files/read', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    return res.status(400).json({ error: 'Missing path query parameter' });
  }

  try {
    const data = readFileContent(filePath);
    res.json(data);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

apiRouter.post('/files/write', (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'Missing path or content' });
  }

  try {
    writeFileContent(filePath, content);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/files/create', (req, res) => {
  const { path: targetPath, isDirectory } = req.body;
  if (!targetPath) {
    return res.status(400).json({ error: 'Missing path' });
  }

  try {
    createItem(targetPath, Boolean(isDirectory));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/files/rename', (req, res) => {
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) {
    return res.status(400).json({ error: 'Missing oldPath or newPath' });
  }

  try {
    renameItem(oldPath, newPath);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/files/delete', (req, res) => {
  const { path: targetPath } = req.body;
  if (!targetPath) {
    return res.status(400).json({ error: 'Missing path' });
  }

  try {
    deleteItem(targetPath);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/files/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  res.json({ success: true, filename: req.file.originalname });
});

// Stream raw local files (images, assets) for inline WYSIWYG editor
apiRouter.use('/files/raw', (req, res) => {
  try {
    const rawPath = req.path.replace(/^\//, '');
    const fullPath = resolveSafePath(rawPath);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).send('File not found');
    }
    res.sendFile(fullPath);
  } catch (err: any) {
    res.status(400).send(err.message);
  }
});

// Venv endpoints
apiRouter.get('/venv/status', (_req, res) => {
  res.json(getVenvStatus());
});

apiRouter.post('/venv/create', async (_req, res) => {
  try {
    const result = await createVenv();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/venv/install', async (_req, res) => {
  try {
    const result = await installRequirements();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/venv/run', async (req, res) => {
  const { scriptPath, args } = req.body;
  if (!scriptPath) {
    return res.status(400).json({ error: 'Missing scriptPath' });
  }

  try {
    const result = await runPythonScript(scriptPath, args || []);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Agent endpoints
apiRouter.get('/agent/config', (_req, res) => {
  res.json({
    hasGeminiKey: Boolean(GEMINI_API_KEY),
    hasOpenaiKey: Boolean(OPENAI_API_KEY),
    hasAnthropicKey: Boolean(ANTHROPIC_API_KEY),
    availableProviders: [
      { id: 'gemini', name: 'Google Gemini (Gemini 2.5 Flash / Pro)', active: Boolean(GEMINI_API_KEY) },
      { id: 'openai', name: 'OpenAI (GPT-4o)', active: Boolean(OPENAI_API_KEY) },
      { id: 'anthropic', name: 'Anthropic (Claude 3.5 Sonnet)', active: Boolean(ANTHROPIC_API_KEY) },
      { id: 'ollama', name: 'Local Ollama / OpenAI-compatible', active: true },
      { id: 'demo', name: 'Demo / Scientific Assistant (Offline)', active: true }
    ],
    defaultProvider: GEMINI_API_KEY ? 'gemini' : (OPENAI_API_KEY ? 'openai' : (ANTHROPIC_API_KEY ? 'anthropic' : 'demo'))
  });
});

apiRouter.post('/agent/save-config', (req, res) => {
  const { geminiApiKey, openaiApiKey, anthropicApiKey } = req.body;
  
  updateConfigKeys({
    geminiApiKey,
    openaiApiKey,
    anthropicApiKey
  });

  // Write/append to .env so server restarts retain the keys
  try {
    let envPath = process.env.ENV_FILE || path.join(PACKAGE_ROOT, '.env');
    try {
      fs.accessSync(path.dirname(envPath), fs.constants.W_OK);
    } catch {
      envPath = path.join(WORKSPACE_DIR, '.env');
    }
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    
    if (geminiApiKey) {
      if (/^GEMINI_API_KEY=.*/m.test(envContent)) {
        envContent = envContent.replace(/^GEMINI_API_KEY=.*/m, `GEMINI_API_KEY=${geminiApiKey}`);
      } else {
        envContent += `\nGEMINI_API_KEY=${geminiApiKey}`;
      }
    }
    if (openaiApiKey) {
      if (/^OPENAI_API_KEY=.*/m.test(envContent)) {
        envContent = envContent.replace(/^OPENAI_API_KEY=.*/m, `OPENAI_API_KEY=${openaiApiKey}`);
      } else {
        envContent += `\nOPENAI_API_KEY=${openaiApiKey}`;
      }
    }
    if (anthropicApiKey) {
      if (/^ANTHROPIC_API_KEY=.*/m.test(envContent)) {
        envContent = envContent.replace(/^ANTHROPIC_API_KEY=.*/m, `ANTHROPIC_API_KEY=${anthropicApiKey}`);
      } else {
        envContent += `\nANTHROPIC_API_KEY=${anthropicApiKey}`;
      }
    }
    fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf-8');
  } catch (err) {
    console.warn('Could not write to .env:', err);
  }

  res.json({
    success: true,
    hasGeminiKey: Boolean(GEMINI_API_KEY),
    hasOpenaiKey: Boolean(OPENAI_API_KEY),
    hasAnthropicKey: Boolean(ANTHROPIC_API_KEY)
  });
});

// Session history endpoints
apiRouter.get('/agent/sessions', (_req, res) => {
  try {
    const list = listSessions();
    res.json({ sessions: list });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/agent/sessions/:id', (req, res) => {
  try {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/agent/sessions', (req, res) => {
  try {
    const saved = saveSession(req.body);
    res.json(saved);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete('/agent/sessions/:id', (req, res) => {
  try {
    const deleted = deleteSession(req.params.id);
    res.json({ success: deleted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Process cancellation endpoint (Stopping work)
apiRouter.post('/agent/cancel', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  cancelAgentSession(sessionId);
  const count = killSessionProcesses(sessionId);
  res.json({ success: true, killedCount: count });
});

// Agent chat with Server-Sent Events (SSE)
apiRouter.post('/agent/chat', async (req, res) => {
  const { messages, config } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  const sessionId = config?.sessionId;
  res.on('close', () => {
    if (!res.writableEnded && sessionId) {
      cancelAgentSession(sessionId);
      killSessionProcesses(sessionId);
    }
  });

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (event: StepEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const result = await runAgentConversation(messages, config || { provider: 'demo' }, (evt) => {
      sendEvent(evt);
    });

    sendEvent({
      type: 'final',
      delta: result.text,
      tokens: result.tokens
    });
    res.end();
  } catch (err: any) {
    sendEvent({
      type: 'error',
      description: err.message
    });
    res.end();
  }
});

// Mount API router on root /api and on ${BASE_URL}/api if configured
app.use('/api', apiRouter);
if (BASE_URL) {
  app.use(`${BASE_URL}/api`, apiRouter);
}

// WebSocket management with heartbeat and socket reclamation
interface ExtWebSocket extends WebSocket {
  isAlive?: boolean;
}

const activeClients = new Set<ExtWebSocket>();

// Heartbeat every 30s to terminate zombie / leaked sockets
const heartbeatInterval = setInterval(() => {
  for (const ws of activeClients) {
    if (ws.isAlive === false) {
      activeClients.delete(ws);
      try {
        ws.terminate();
      } catch {}
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      activeClients.delete(ws);
      try {
        ws.terminate();
      } catch {}
    }
  }
}, 30000);

heartbeatInterval.unref();

wss.on('error', (err) => {
  console.error('WebSocket server error:', err);
});

wss.on('connection', (rawWs) => {
  const ws = rawWs as ExtWebSocket;
  ws.isAlive = true;
  activeClients.add(ws);
  let terminalSession: TerminalSession | null = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('error', (err) => {
    console.error('WebSocket client error:', err);
    activeClients.delete(ws);
    if (terminalSession) {
      terminalSession.kill();
      terminalSession = null;
    }
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'terminal_start') {
        if (!terminalSession) {
          terminalSession = new TerminalSession(ws);
        }
      } else if (data.type === 'terminal_input') {
        if (terminalSession) {
          terminalSession.handleInput(data.data);
        }
      } else if (data.type === 'terminal_stop') {
        if (terminalSession) {
          terminalSession.kill();
          terminalSession = null;
        }
      }
    } catch (e) {
      // ignore
    }
  });

  ws.on('close', () => {
    activeClients.delete(ws);
    if (terminalSession) {
      terminalSession.kill();
      terminalSession = null;
    }
  });
});

// File watcher broadcast
initFileWatcher((event, relPath) => {
  const payload = JSON.stringify({
    type: 'file_changed',
    event,
    path: relPath
  });

  for (const client of activeClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch {
        activeClients.delete(client);
      }
    } else if (client.readyState === WebSocket.CLOSED || client.readyState === WebSocket.CLOSING) {
      activeClients.delete(client);
    }
  }
});

// Serve frontend static build
const possibleClientDistPaths = [
  process.env.CLIENT_DIST_DIR,
  path.join(PACKAGE_ROOT, 'client', 'dist'),
  path.join(process.cwd(), 'client', 'dist')
].filter(Boolean) as string[];

const clientDist = possibleClientDistPaths.find(p => fs.existsSync(p)) || path.join(PACKAGE_ROOT, 'client', 'dist');

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false }));
  if (BASE_URL) {
    app.use(BASE_URL, express.static(clientDist, { index: false }));
  }

  const sendIndexHtml = (_req: express.Request, res: express.Response) => {
    try {
      let html = fs.readFileSync(path.join(clientDist, 'index.html'), 'utf-8');
      const basePrefix = BASE_URL || '';
      const baseHref = BASE_URL ? `${BASE_URL}/` : '/';
      const configScript = `<script>window.__BIONIC_CONFIG__ = ${JSON.stringify({
        baseUrl: basePrefix,
        baseSpec: BASE_SPEC
      })};</script><base href="${baseHref}">`;

      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>\n  ${configScript}`);
      } else {
        html = configScript + html;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err: any) {
      res.status(500).send(`Error reading index.html: ${err.message}`);
    }
  };

  if (BASE_URL) {
    app.use((req, res, next) => {
      // If requested exact slug without trailing slash (e.g. /ws-01 or /ws-01?query), redirect to /ws-01/
      const urlWithoutQuery = (req.originalUrl || req.url || '').split('?')[0];
      if (req.method === 'GET' && urlWithoutQuery === BASE_URL) {
        const query = (req.originalUrl || req.url || '').includes('?')
          ? '?' + (req.originalUrl || req.url || '').split('?')[1]
          : '';
        return res.redirect(301, `${BASE_URL}/${query}`);
      }
      next();
    });
  }

  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    const p = req.path;
    if (p.startsWith('/api') || p.startsWith('/report')) return next();
    if (BASE_URL && (p.startsWith(`${BASE_URL}/api`) || p.startsWith(`${BASE_URL}/report`))) return next();

    // Match root, slug root, or subpaths
    if (p === '/' || !BASE_URL || p === `${BASE_URL}/` || p.startsWith(`${BASE_URL}/`)) {
      return sendIndexHtml(req, res);
    }
    next();
  });
} else {
  console.warn(`⚠️ Client frontend build not found at: ${clientDist}`);
  console.warn(`💡 Run 'npm run build' to build the client static assets.`);
}

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Error: Port ${PORT} is already in use by another process.`);
    console.error(`💡 To free port ${PORT}, run: fuser -k ${PORT}/tcp (or set PORT=${PORT + 1})\n`);
    process.exit(1);
  } else if (
    err.code === 'EMFILE' ||
    err.code === 'ENFILE' ||
    err.syscall === 'accept' ||
    String(err.message).toLowerCase().includes('too many') ||
    String(err.message).toLowerCase().includes('emfile')
  ) {
    console.error(`\n⚠️ Sockets / File descriptor limit encountered: ${err.message || err.code}`);
    console.error('💡 Reclaiming idle sockets and purging disconnected clients...\n');

    // Purge non-open or unresponsive WebSocket clients
    for (const client of activeClients) {
      if (client.readyState !== WebSocket.OPEN) {
        activeClients.delete(client);
        try {
          client.terminate();
        } catch {}
      }
    }

    // Clean up idle HTTP sockets
    for (const socket of activeSockets) {
      try {
        socket.destroy();
      } catch {}
    }
    activeSockets.clear();
  } else {
    console.error('Server error:', err);
  }
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  const baseDisplay = BASE_URL ? `${BASE_URL}/` : '';
  console.log(`\n======================================================`);
  console.log(`🔬 Bionic Editor running at http://${displayHost}:${PORT}/${baseDisplay}`);
  console.log(`📁 Workspace: ${WORKSPACE_DIR}`);
  console.log(`📄 Base Spec: ${BASE_SPEC}`);
  if (BASE_URL) {
    console.log(`🔗 Base URL Slug: ${BASE_URL}`);
  }
  console.log(`📊 Web Report: http://${displayHost}:${PORT}/${BASE_URL ? BASE_URL.slice(1) + '/' : ''}report/`);
  console.log(`======================================================\n`);
});
