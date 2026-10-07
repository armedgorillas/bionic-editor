import http from 'http';
import path from 'path';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';

import { PORT, WORKSPACE_DIR, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OLLAMA_BASE_URL, updateConfigKeys } from './config.js';
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
import { runAgentConversation, StepEvent } from './services/agent.js';
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
const wss = new WebSocketServer({ server, path: '/ws' });

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

// Workspace info
app.get('/api/workspace/info', (_req, res) => {
  res.json({
    workspaceDir: WORKSPACE_DIR,
    venv: getVenvStatus()
  });
});

// Reinitialize default template
app.post('/api/workspace/init', (_req, res) => {
  try {
    initDefaultTemplate();
    res.json({ success: true, message: 'Initialized scientific template.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// File explorer endpoints
app.get('/api/files/tree', (_req, res) => {
  try {
    const tree = getFileTree();
    res.json({ tree });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/files/read', (req, res) => {
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

app.post('/api/files/write', (req, res) => {
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

app.post('/api/files/create', (req, res) => {
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

app.post('/api/files/rename', (req, res) => {
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

app.post('/api/files/delete', (req, res) => {
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

app.post('/api/files/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  res.json({ success: true, filename: req.file.originalname });
});

// Stream raw local files (images, assets) for inline WYSIWYG editor
app.use('/api/files/raw', (req, res) => {
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
app.get('/api/venv/status', (_req, res) => {
  res.json(getVenvStatus());
});

app.post('/api/venv/create', async (_req, res) => {
  try {
    const result = await createVenv();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/venv/install', async (_req, res) => {
  try {
    const result = await installRequirements();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/venv/run', async (req, res) => {
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
app.get('/api/agent/config', (_req, res) => {
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

app.post('/api/agent/save-config', (req, res) => {
  const { geminiApiKey, openaiApiKey, anthropicApiKey } = req.body;
  
  updateConfigKeys({
    geminiApiKey,
    openaiApiKey,
    anthropicApiKey
  });

  // Write/append to .env in root so server restarts retain the keys
  try {
    const envPath = path.join(process.cwd(), '.env');
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
app.get('/api/agent/sessions', (_req, res) => {
  try {
    const list = listSessions();
    res.json({ sessions: list });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agent/sessions/:id', (req, res) => {
  try {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/sessions', (req, res) => {
  try {
    const saved = saveSession(req.body);
    res.json(saved);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/agent/sessions/:id', (req, res) => {
  try {
    const deleted = deleteSession(req.params.id);
    res.json({ success: deleted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Process cancellation endpoint (Stopping work)
app.post('/api/agent/cancel', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  const count = killSessionProcesses(sessionId);
  res.json({ success: true, killedCount: count });
});

// Agent chat with Server-Sent Events (SSE)
app.post('/api/agent/chat', async (req, res) => {
  const { messages, config } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  const sessionId = config?.sessionId;
  req.on('close', () => {
    if (sessionId) {
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

// WebSocket management
const activeClients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  activeClients.add(ws);
  let terminalSession: TerminalSession | null = null;

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
      client.send(payload);
    }
  }
});

// Serve frontend static build if exists
const clientDist = path.join(process.cwd(), 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/report')) {
      return res.sendFile(path.join(clientDist, 'index.html'));
    }
    next();
  });
}

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Error: Port ${PORT} is already in use by another process.`);
    console.error(`💡 To free port ${PORT}, run: fuser -k ${PORT}/tcp (or set PORT=${PORT + 1})\n`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🔬 Bionic Editor running at http://localhost:${PORT}`);
  console.log(`📁 Workspace: ${WORKSPACE_DIR}`);
  console.log(`📊 Web Report: http://localhost:${PORT}/report/`);
  console.log(`======================================================\n`);
});
