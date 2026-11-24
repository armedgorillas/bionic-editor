import http from 'http';
import path from 'path';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';

import {
  PORT,
  HOST,
  WORKSPACE_DIR,
  PACKAGE_ROOT,
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  GEMINI_API_KEY,
  updateConfigKeys,
  BASE_URL
} from './config.js';
import {
  ensureWorkspaceDir,
  initDefaultTemplate,
  getFileTree,
  readFileContent,
  writeFileContent,
  createItem,
  renameItem,
  deleteItem,
  resolveSafePath,
  ensureDirWithOwnership,
  applyTargetOwnership
} from './services/workspace.js';
import {
  getProjectRootFile,
  getResolvedWorkspaceConfig,
  updateWorkspaceConfig
} from './services/workspaceConfig.js';
import { readUserInstructions, writeUserInstructions } from './services/agentPrompt.js';
import { refreshManagedSystemPrompt } from './services/opencodeConfig.js';
import {
  isSensitiveEnvPath
} from './services/fsSafe.js';
import {
  getManifestSummary,
  registerDataFile,
  verifyManifest,
  removeManifestEntry,
  untrackRawFromGit,
  findManifestEntryByPath,
  updateManifestFilepath,
  readManifest,
  syncManifestArtifacts,
  wasManifestWrittenInternallyRecently,
  MANIFEST_REL_PATH
} from './services/dataManifest.js';
import {
  getVenvStatus,
  createVenv,
  installRequirements,
  runPythonScript,
  killSessionProcesses
} from './services/venv.js';
import { runAgentConversation, StepEvent, cancelAgentSession, getOpenCodeBinary } from './services/agent.js';
import { opencodeServer } from './services/opencodeServer.js';
import { initFileWatcher, closeFileWatcher } from './services/fileWatcher.js';
import { TerminalSession } from './services/terminal.js';
import {
  listSessions,
  getSession,
  saveSession,
  deleteSession
} from './services/sessionManager.js';

// Initialize workspace on start (non-destructive if already populated)
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

// WebSocket client set & broadcast helper
interface ExtWebSocket extends WebSocket {
  isAlive?: boolean;
}
const activeClients = new Set<ExtWebSocket>();

function broadcastWs(payloadObj: Record<string, any>): void {
  const payload = JSON.stringify(payloadObj);
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
}

// Connect OpenCode persistent server bridge to WebSocket broadcast
opencodeServer.setBroadcast((evt) => {
  broadcastWs(evt);
});

// Hardened Multer upload config (sanitizes filename + blocks escaping symlinks + caps size)
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_MB || '500', 10) * 1024 * 1024;
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const targetDir = req.query.dir ? String(req.query.dir) : '';
      const safeTarget = targetDir ? resolveSafePath(targetDir) : WORKSPACE_DIR;
      ensureDirWithOwnership(safeTarget);
      cb(null, safeTarget);
    } catch (err: any) {
      cb(err, WORKSPACE_DIR);
    }
  },
  filename: (req, file, cb) => {
    try {
      const clean = path.basename(file.originalname || '').replace(/[\0\/\\]/g, '').trim();
      if (!clean || clean === '.' || clean === '..') {
        return cb(new Error('Invalid upload filename'), '');
      }
      const targetDir = req.query.dir ? String(req.query.dir) : '';
      const relCandidate = targetDir ? path.join(targetDir, clean) : clean;
      // Reject if destination is a symlink pointing outside WORKSPACE_DIR
      resolveSafePath(relCandidate);
      cb(null, clean);
    } catch (err: any) {
      cb(err, '');
    }
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } });

// Web Report static server - direct single-port serving
const webReportDir = path.join(WORKSPACE_DIR, 'web-report');
app.use('/report', express.static(webReportDir));
if (BASE_URL) {
  app.use(`${BASE_URL}/report`, express.static(webReportDir));
}

const apiRouter = express.Router();

// Workspace info & dynamic configuration (Feature 7)
apiRouter.get('/workspace/info', (_req, res) => {
  const cfg = getResolvedWorkspaceConfig();
  res.json({
    workspaceDir: WORKSPACE_DIR,
    venv: getVenvStatus(),
    rootFile: cfg.rootFile,
    baseSpec: cfg.baseSpec,
    rootFileSource: cfg.source,
    baseUrl: BASE_URL
  });
});

apiRouter.get('/workspace/config', (_req, res) => {
  try {
    res.json(getResolvedWorkspaceConfig());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put('/workspace/config', (req, res) => {
  try {
    const { rootFile, createIfMissing } = req.body || {};
    if (rootFile !== undefined && typeof rootFile !== 'string') {
      return res.status(400).json({ error: 'rootFile must be a string' });
    }
    const updated = updateWorkspaceConfig({
      rootFile,
      createIfMissing: Boolean(createIfMissing)
    });
    // Refresh managed system prompt if .bionic/SYSTEM_PROMPT.md already exists
    try {
      const sysPromptPath = path.join(WORKSPACE_DIR, '.bionic', 'SYSTEM_PROMPT.md');
      if (fs.existsSync(sysPromptPath)) {
        refreshManagedSystemPrompt();
      }
    } catch {}
    broadcastWs({
      type: 'workspace_config_updated',
      rootFile: updated.rootFile,
      baseSpec: updated.baseSpec,
      source: updated.source
    });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
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
apiRouter.get('/files/tree', (req, res) => {
  try {
    const includeDotItems = req.query.includeDotItems === 'true';
    const tree = getFileTree(WORKSPACE_DIR, '', { includeDotItems });
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
  if (isSensitiveEnvPath(filePath)) {
    return res.status(403).json({ error: 'Access denied: .env files cannot be read via file API' });
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

apiRouter.post('/files/rename', async (req, res) => {
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) {
    return res.status(400).json({ error: 'Missing oldPath or newPath' });
  }

  try {
    renameItem(oldPath, newPath);
    let manifestUpdated = false;
    if (findManifestEntryByPath(oldPath)) {
      manifestUpdated = await updateManifestFilepath(oldPath, newPath);
    }
    res.json({ success: true, manifestUpdated });
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
    const manifestEntry = findManifestEntryByPath(targetPath);
    deleteItem(targetPath);
    res.json({
      success: true,
      manifestAffected: Boolean(manifestEntry),
      manifestEntryId: manifestEntry?.id
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/files/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  try {
    applyTargetOwnership(req.file.path);
    const relPath = path.relative(path.resolve(WORKSPACE_DIR), path.resolve(req.file.path)).replace(/\\/g, '/');
    const description = typeof req.body?.description === 'string' ? req.body.description : '';

    let manifestEntry = null;
    if (relPath.startsWith('data/raw/')) {
      manifestEntry = await registerDataFile({
        filepath: relPath,
        description: description || `Uploaded dataset (${req.file.filename})`,
        acquisition: {
          method: 'upload'
        }
      });
    }

    res.json({
      success: true,
      filename: req.file.filename,
      filepath: relPath,
      manifestEntry
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Stream raw local files (images, assets) for inline WYSIWYG editor
apiRouter.use('/files/raw', (req, res) => {
  try {
    let decoded = req.path.replace(/^\//, '');
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return res.status(400).send('Malformed file path');
    }
    if (isSensitiveEnvPath(decoded)) {
      return res.status(403).send('Access denied: .env files cannot be read via file API');
    }
    const fullPath = resolveSafePath(decoded);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).send('File not found');
    }
    const st = fs.statSync(fullPath);
    if (!st.isFile()) {
      return res.status(400).send('Path is not a file');
    }
    res.sendFile(fullPath);
  } catch (err: any) {
    res.status(400).send(err.message);
  }
});

// Data Provenance Manifest endpoints (Feature 6)
apiRouter.get('/data/manifest', (_req, res) => {
  try {
    res.json(getManifestSummary());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/data/manifest/register', async (req, res) => {
  try {
    const { filepath, description, acquisition, id, excludeFromGit, excludeFromPublication } = req.body || {};
    if (!filepath || typeof filepath !== 'string') {
      return res.status(400).json({ error: 'filepath is required' });
    }
    const entry = await registerDataFile({
      filepath,
      description,
      acquisition,
      id,
      excludeFromGit,
      excludeFromPublication
    });
    res.json({ success: true, entry });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/data/manifest/verify', async (_req, res) => {
  try {
    const report = await verifyManifest();
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/data/manifest/untrack-git', async (req, res) => {
  try {
    const { filepath } = req.body || {};
    if (!filepath || typeof filepath !== 'string') {
      return res.status(400).json({ error: 'filepath is required' });
    }
    const result = await untrackRawFromGit(filepath);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/data/manifest/:id', async (req, res) => {
  try {
    const removed = await removeManifestEntry(req.params.id);
    if (!removed) {
      return res.status(404).json({ error: 'Manifest entry not found' });
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
  const isOpenCodeInstalled = Boolean(getOpenCodeBinary());
  res.json({
    hasGeminiKey: Boolean(GEMINI_API_KEY),
    hasOpenaiKey: Boolean(OPENAI_API_KEY),
    hasAnthropicKey: Boolean(ANTHROPIC_API_KEY),
    isOpenCodeInstalled,
    harness: isOpenCodeInstalled ? 'opencode' : 'built-in',
    availableProviders: [
      { id: 'gemini', name: 'Google Gemini (Gemini 2.5 Flash / Pro)', active: Boolean(GEMINI_API_KEY) },
      { id: 'openai', name: 'OpenAI (GPT-4o)', active: Boolean(OPENAI_API_KEY) },
      { id: 'anthropic', name: 'Anthropic Claude (3.5 Sonnet)', active: Boolean(ANTHROPIC_API_KEY) },
      { id: 'ollama', name: 'Local Ollama / OpenAI-compatible', active: true },
      { id: 'demo', name: 'Demo / Scientific Assistant (Offline)', active: true }
    ],
    defaultProvider: GEMINI_API_KEY ? 'gemini' : (OPENAI_API_KEY ? 'openai' : (ANTHROPIC_API_KEY ? 'anthropic' : 'demo'))
  });
});

apiRouter.get('/agent/instructions', (_req, res) => {
  try {
    res.json({
      rootFile: getProjectRootFile(),
      userInstructions: readUserInstructions()
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/agent/instructions', (req, res) => {
  try {
    const { userInstructions } = req.body || {};
    if (typeof userInstructions !== 'string') {
      return res.status(400).json({ error: 'userInstructions must be a string' });
    }
    writeUserInstructions(userInstructions);
    try {
      const sysPromptPath = path.join(WORKSPACE_DIR, '.bionic', 'SYSTEM_PROMPT.md');
      if (fs.existsSync(sysPromptPath)) {
        refreshManagedSystemPrompt();
      }
    } catch {}
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Subagent inspection & control endpoints (Feature 3)
apiRouter.get('/agent/subagents', async (req, res) => {
  try {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const data = await opencodeServer.listRemoteSubagents(sessionId);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/agent/subagents/:childSessionId', async (req, res) => {
  try {
    const details = await opencodeServer.getChildSessionDetails(req.params.childSessionId);
    res.json(details);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/agent/subagents/:jobId/cancel', async (req, res) => {
  try {
    const cancelled = await opencodeServer.cancelSubagentJob(req.params.jobId);
    res.json({ success: cancelled });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/agent/save-config', async (req, res) => {
  const sanitizeKey = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const cleaned = v.replace(/[\r\n\0]/g, '').trim();
    return cleaned || undefined;
  };

  const geminiApiKey = sanitizeKey(req.body?.geminiApiKey);
  const openaiApiKey = sanitizeKey(req.body?.openaiApiKey);
  const anthropicApiKey = sanitizeKey(req.body?.anthropicApiKey);

  updateConfigKeys({
    geminiApiKey,
    openaiApiKey,
    anthropicApiKey
  });

  // Sync updated keys into running OpenCode V2 server via Credential API
  opencodeServer
    .syncProviderCredentials({ geminiApiKey, openaiApiKey, anthropicApiKey })
    .catch(() => {});

  // Write/append to .env so server restarts retain the keys (0600 permissions)
  try {
    let envPath = process.env.ENV_FILE || path.join(PACKAGE_ROOT, '.env');
    try {
      fs.accessSync(path.dirname(envPath), fs.constants.W_OK);
    } catch {
      envPath = path.join(WORKSPACE_DIR, '.env');
    }
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';

    const upsertEnv = (keyName: string, val?: string) => {
      if (!val) return;
      const re = new RegExp(`^${keyName}=.*`, 'm');
      if (re.test(envContent)) {
        envContent = envContent.replace(re, () => `${keyName}=${val}`);
      } else {
        envContent += `\n${keyName}=${val}`;
      }
    };

    upsertEnv('GEMINI_API_KEY', geminiApiKey);
    upsertEnv('OPENAI_API_KEY', openaiApiKey);
    upsertEnv('ANTHROPIC_API_KEY', anthropicApiKey);

    fs.writeFileSync(envPath, envContent.trim() + '\n', { encoding: 'utf-8', mode: 0o600 });
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {}
    applyTargetOwnership(envPath);
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

apiRouter.get('/agent/sessions/:id/sync', async (req, res) => {
  try {
    const synced = await opencodeServer.syncSession(req.params.id);
    res.json(synced);
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

// Agent chat with Server-Sent Events (SSE) — emits exactly ONE final event per turn
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (event: StepEvent) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  try {
    const result = await runAgentConversation(messages, config || { provider: 'demo' }, (evt) => {
      // Prevent duplicate final events if a runner emits one
      if (evt.type !== 'final') {
        sendEvent(evt);
      }
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
    } catch {
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

// File watcher broadcast + auto-sync DATA_MANIFEST.md only on external edits to data/manifest.json
let isSyncingManifestFromWatch = false;
initFileWatcher((event, relPath) => {
  if (
    relPath === MANIFEST_REL_PATH &&
    (event === 'add' || event === 'change') &&
    !isSyncingManifestFromWatch &&
    !wasManifestWrittenInternallyRecently()
  ) {
    isSyncingManifestFromWatch = true;
    try {
      syncManifestArtifacts(readManifest());
    } catch {
      // ignore invalid partial JSON
    } finally {
      setTimeout(() => {
        isSyncingManifestFromWatch = false;
      }, 400).unref();
    }
  }

  broadcastWs({
    type: 'file_changed',
    event,
    path: relPath
  });
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
      const rootFile = getProjectRootFile();
      const safeJson = JSON.stringify({
        baseUrl: basePrefix,
        baseSpec: rootFile,
        rootFile
      })
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
      const configScript = `<script>window.__BIONIC_CONFIG__ = ${safeJson};</script><base href="${baseHref}">`;

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

    for (const client of activeClients) {
      if (client.readyState !== WebSocket.OPEN) {
        activeClients.delete(client);
        try {
          client.terminate();
        } catch {}
      }
    }

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
  const rootFile = getProjectRootFile();
  console.log(`\n======================================================`);
  console.log(`🔬 Bionic Editor running at http://${displayHost}:${PORT}/${baseDisplay}`);
  console.log(`📁 Workspace: ${WORKSPACE_DIR}`);
  console.log(`📄 Project Root Plan: ${rootFile}`);
  if (BASE_URL) {
    console.log(`🔗 Base URL Slug: ${BASE_URL}`);
  }
  console.log(`📊 Web Report: http://${displayHost}:${PORT}/${BASE_URL ? BASE_URL.slice(1) + '/' : ''}report/`);
  console.log(`======================================================\n`);
});

const shutdownGracefully = () => {
  opencodeServer.stop();
  closeFileWatcher();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', shutdownGracefully);
process.on('SIGTERM', shutdownGracefully);
