import crypto from 'crypto';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
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
  BASE_URL,
  BIONIC_HUB_MODE,
  BIONIC_SANDBOX_MODE,
  BIONIC_HUB_URL,
  BIONIC_PROJECT_ID,
  BIONIC_SHIM_URL,
  BIONIC_LOCAL_SHIM_TOKEN,
  BIONIC_DAEMON_TOKEN,
  BIONIC_UNIX_SOCKET,
  BIONIC_REPORTS_ORIGIN,
  getTargetSpawnOptions
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
import { refreshManagedSystemPrompt, applyHubManagedOpenCodeConfig } from './services/opencodeConfig.js';
import {
  isSensitiveEnvPath
} from './services/fsSafe.js';
import {
  getManifestSummary,
  registerDataFile,
  registerRemoteDataEntry,
  verifyManifest,
  removeManifestEntry,
  untrackRawFromGit,
  findManifestEntryByPath,
  updateManifestFilepath,
  readManifest,
  syncManifestArtifacts,
  syncRawDataDirectoryToManifest,
  refreshDerivedManifestMirrors,
  ensureDataGitignore,
  wasManifestWrittenInternallyRecently,
  MANIFEST_REL_PATH
} from './services/dataManifest.js';
import { scaffoldPortableProjectScripts, upgradeManagedScriptsIfLegacy } from './services/portableScripts.js';
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

const execFileAsync = promisify(execFile);

// Activity telemetry tracked for Hub idle detection
let lastUserActivityAt = Date.now();
let activeAgentTurns = 0;

if (!BIONIC_HUB_MODE) {
  app.use(cors());
}
app.use(express.json({ limit: BIONIC_HUB_MODE ? '25mb' : '50mb' }));
app.use(express.urlencoded({ extended: true, limit: BIONIC_HUB_MODE ? '25mb' : '50mb' }));
app.use((req, _res, next) => {
  if (!req.path.startsWith('/api/hub-local') && !req.path.includes('/health')) {
    lastUserActivityAt = Date.now();
  }
  next();
});

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
// In Hub Mode, cap at 25 MB and reject data/raw/* (large files must use Hub GCS resumable upload)
const DEFAULT_MAX_UPLOAD_MB = BIONIC_HUB_MODE ? '25' : '500';
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_MB || DEFAULT_MAX_UPLOAD_MB, 10) * 1024 * 1024;
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const targetDir = req.query.dir ? String(req.query.dir).replace(/^\/+/, '') : '';
      const safeTarget = targetDir ? resolveSafePath(targetDir) : WORKSPACE_DIR;
      if (BIONIC_HUB_MODE) {
        const canonicalRel = path.relative(path.resolve(WORKSPACE_DIR), safeTarget).replace(/\\/g, '/');
        if (canonicalRel === 'data/raw' || canonicalRel.startsWith('data/raw/')) {
          return cb(
            new Error('Direct uploads to data/raw/ are disabled in Hub Mode; use Hub GCS Resumable Upload instead.'),
            WORKSPACE_DIR
          );
        }
      }
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

// Web Report static server — in Hub Mode with isolated reports origin, block same-origin /report
const webReportDir = path.join(WORKSPACE_DIR, 'web-report');
const blockSameOriginReport: express.RequestHandler = (_req, res) => {
  res.status(403).json({
    error: 'Same-origin /report is disabled in Hub Mode for XSS isolation.',
    reportsOrigin: BIONIC_REPORTS_ORIGIN
  });
};
if (BIONIC_HUB_MODE && BIONIC_REPORTS_ORIGIN) {
  app.use('/report', blockSameOriginReport);
  if (BASE_URL) {
    app.use(`${BASE_URL}/report`, blockSameOriginReport);
  }
} else {
  app.use('/report', express.static(webReportDir));
  if (BASE_URL) {
    app.use(`${BASE_URL}/report`, express.static(webReportDir));
  }
}

const apiRouter = express.Router();

// Security guard for Sandbox Mode (blocks code execution AND workspace/file mutations for anonymous demo visitors)
const rejectInSandbox: express.RequestHandler = (_req, res, next) => {
  if (BIONIC_SANDBOX_MODE) {
    return res.status(403).json({ error: 'This operation is disabled in public Sandbox Mode.' });
  }
  next();
};

// Security #2: Authenticate /api/hub-local/* strictly via daemon-only X-Bionic-Daemon-Token
const requireDaemonToken: express.RequestHandler = (req, res, next) => {
  if (!BIONIC_HUB_MODE || !BIONIC_DAEMON_TOKEN) return next();
  const provided = String(req.headers['x-bionic-daemon-token'] || '');
  const expectedBuf = Buffer.from(BIONIC_DAEMON_TOKEN, 'utf-8');
  const providedBuf = Buffer.from(provided, 'utf-8');
  if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return res.status(403).json({ error: 'Forbidden: daemon token required' });
  }
  next();
};

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

apiRouter.put('/workspace/config', rejectInSandbox, (req, res) => {
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
apiRouter.post('/workspace/init', rejectInSandbox, (_req, res) => {
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

apiRouter.post('/files/write', rejectInSandbox, (req, res) => {
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

apiRouter.post('/files/create', rejectInSandbox, (req, res) => {
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

apiRouter.post('/files/rename', rejectInSandbox, async (req, res) => {
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

apiRouter.post('/files/delete', rejectInSandbox, (req, res) => {
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

apiRouter.post('/files/upload', rejectInSandbox, upload.single('file'), async (req, res) => {
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

// Venv endpoints (blocked in Sandbox Mode)
apiRouter.get('/venv/status', (_req, res) => {
  if (BIONIC_SANDBOX_MODE) {
    return res.json({ exists: false, pythonPath: '', packages: [], sandboxDisabled: true });
  }
  res.json(getVenvStatus());
});

apiRouter.post('/venv/create', rejectInSandbox, async (_req, res) => {
  try {
    const result = await createVenv();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/venv/install', rejectInSandbox, async (_req, res) => {
  try {
    const result = await installRequirements();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/venv/run', rejectInSandbox, async (req, res) => {
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

// Dynamic model registry endpoint (fetches admin-managed models from Hub shim in Hub Mode)
apiRouter.get('/models', async (_req, res) => {
  if (BIONIC_HUB_MODE) {
    try {
      const resp = await fetch(`${BIONIC_SHIM_URL}/models`, {
        headers: { 'X-Bionic-Shim-Token': BIONIC_LOCAL_SHIM_TOKEN }
      });
      if (resp.ok) {
        const data = await resp.json();
        return res.json(data);
      }
    } catch {
      // Fall through to empty managed list
    }
    return res.json({ hubManaged: true, models: [] });
  }
  res.json({
    hubManaged: false,
    models: [
      { slug: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', provider: 'gemini', protocol: 'google', active: Boolean(GEMINI_API_KEY) },
      { slug: 'gpt-4o', displayName: 'GPT-4o', provider: 'openai', protocol: 'openai', active: Boolean(OPENAI_API_KEY) },
      { slug: 'claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet', provider: 'anthropic', protocol: 'anthropic', active: Boolean(ANTHROPIC_API_KEY) }
    ]
  });
});

// Lightweight workspace metadata endpoint for Editor Publish/Save modal (reads bionic.yaml + stats)
apiRouter.get('/workspace/meta', (_req, res) => {
  try {
    res.json(collectWorkspaceMeta());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Unified Save Snapshot endpoint:
// 1. Update data/manifest.json (+ DATA_MANIFEST.md + web-report/data/data_manifest.json) & bionic.yaml
// 2. Push un-synced raw data via scripts/data-push.sh -> GCS & refresh derived manifest mirrors
// 3. Git commit code/spec/manifest & push to Hub Git proxy (durable GCS bundle backup)
// 4. Sync metadata & latest commit SHA to Hub DB so the Project Homepage updates immediately
apiRouter.post('/hub/save', rejectInSandbox, async (req, res) => {
  try {
    scaffoldPortableProjectScripts(WORKSPACE_DIR);
    upgradeManagedScriptsIfLegacy(WORKSPACE_DIR);

    const title = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.replace(/[\r\n\0]/g, ' ').trim().slice(0, 160)
      : undefined;
    const summary = typeof req.body?.summary === 'string'
      ? req.body.summary.replace(/\0/g, '').trim().slice(0, 4000)
      : undefined;
    const message = typeof req.body?.message === 'string' && req.body.message.trim()
      ? req.body.message.replace(/[\r\n\0]/g, ' ').trim().slice(0, 140)
      : (title ? `save: ${title}` : 'save: workspace snapshot');

    // Step 1: Refresh manifest + bionic.yaml + .gitignore
    const manifestSync = await syncRawDataDirectoryToManifest();
    if (title !== undefined || summary !== undefined) {
      updateBionicYamlFields(WORKSPACE_DIR, { title, summary });
    }
    ensureDataGitignore();

    // Step 2: Push raw datasets to GCS & synchronously refresh manifest mirrors before Git commit
    const spawnOpts = getTargetSpawnOptions();
    let dataPushStdout = '';
    const dataPushScript = path.join(WORKSPACE_DIR, 'scripts', 'data-push.sh');
    if (fs.existsSync(dataPushScript)) {
      const dp = await execFileAsync('bash', [dataPushScript], {
        cwd: WORKSPACE_DIR,
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        ...spawnOpts
      });
      dataPushStdout = dp.stdout.trim();
      await refreshDerivedManifestMirrors();
    }

    // Step 3: Git commit workspace-local repo & push to Hub Git proxy
    let gitCommitSha = '';
    if (!fs.existsSync(path.join(WORKSPACE_DIR, '.git'))) {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: WORKSPACE_DIR, timeout: 15_000, ...spawnOpts }).catch(
        () => execFileAsync('git', ['init'], { cwd: WORKSPACE_DIR, timeout: 15_000, ...spawnOpts })
      );
    }
    await execFileAsync('git', ['config', 'user.name'], { cwd: WORKSPACE_DIR, ...spawnOpts }).catch(() =>
      execFileAsync('git', ['config', 'user.name', 'Bionic Researcher'], { cwd: WORKSPACE_DIR, ...spawnOpts })
    );
    await execFileAsync('git', ['config', 'user.email'], { cwd: WORKSPACE_DIR, ...spawnOpts }).catch(() =>
      execFileAsync('git', ['config', 'user.email', 'researcher@bionic.local'], { cwd: WORKSPACE_DIR, ...spawnOpts })
    );
    await execFileAsync('git', ['add', '-A'], { cwd: WORKSPACE_DIR, timeout: 30_000, ...spawnOpts });
    let hasStaged = false;
    try {
      await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: WORKSPACE_DIR, ...spawnOpts });
    } catch {
      hasStaged = true;
    }
    if (hasStaged) {
      await execFileAsync('git', ['commit', '-m', message], { cwd: WORKSPACE_DIR, timeout: 30_000, ...spawnOpts });
    }
    try {
      const { stdout: shaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: WORKSPACE_DIR, ...spawnOpts });
      gitCommitSha = shaOut.trim();
    } catch {
      gitCommitSha = '';
    }

    if (BIONIC_HUB_MODE && BIONIC_SHIM_URL && BIONIC_PROJECT_ID && BIONIC_LOCAL_SHIM_TOKEN && gitCommitSha) {
      const hubGitUrl = `${BIONIC_SHIM_URL}/git/${BIONIC_PROJECT_ID}.git`;
      await execFileAsync(
        'git',
        ['-c', `http.extraHeader=X-Bionic-Shim-Token: ${BIONIC_LOCAL_SHIM_TOKEN}`, 'push', hubGitUrl, 'HEAD:refs/heads/main', '--force'],
        { cwd: WORKSPACE_DIR, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, ...spawnOpts }
      );
    }

    // Step 4: Sync workspace stats, bionic.yaml, manifest pointers & gitCommitSha to Hub DB (non-fatal on 404)
    const meta = collectWorkspaceMeta();
    let hubSynced = false;
    if (BIONIC_HUB_MODE && BIONIC_SHIM_URL && BIONIC_LOCAL_SHIM_TOKEN) {
      try {
        const syncRes = await fetch(`${BIONIC_SHIM_URL}/sync-meta`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Bionic-Shim-Token': BIONIC_LOCAL_SHIM_TOKEN
          },
          body: JSON.stringify({ ...meta, gitCommitSha })
        });
        hubSynced = syncRes.ok;
      } catch {
        hubSynced = false;
      }
    }

    res.json({
      success: true,
      gitCommitSha,
      manifestSync,
      dataPushStdout,
      hubSynced
    });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: err.stderr?.trim() || err.message || 'Save snapshot failed',
      stdout: err.stdout?.trim() || ''
    });
  }
});

// Unified Portable Publish endpoint — leak-safe ordered pipeline delegating to scripts/*.sh:
// 1. Update data/manifest.json + bionic.yaml + .gitignore (upgrade legacy managed scripts if unmodified)
// 2. Run ./scripts/verify-data.sh BEFORE pushing blobs or Git (fail fast on leaks/missing report)
// 3. Push raw datasets via ./scripts/data-push.sh & synchronously refresh manifest mirrors
// 4. Commit & push code/spec/manifest to Hub Git + stream web-report/ & _bionic_meta/ via ./scripts/publish.sh
apiRouter.post('/hub/publish', rejectInSandbox, async (req, res) => {
  try {
    scaffoldPortableProjectScripts(WORKSPACE_DIR);
    upgradeManagedScriptsIfLegacy(WORKSPACE_DIR);

    const scriptPath = path.join(WORKSPACE_DIR, 'scripts', 'publish.sh');
    if (!fs.existsSync(scriptPath)) {
      return res.status(400).json({ error: 'Workspace is missing scripts/publish.sh' });
    }
    const visibility = ['private', 'org', 'public'].includes(req.body?.visibility) ? req.body.visibility : 'private';
    const title = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.replace(/[\r\n\0]/g, ' ').trim().slice(0, 140)
      : 'Published Report';
    const summary = typeof req.body?.summary === 'string'
      ? req.body.summary.replace(/\0/g, '').trim().slice(0, 4000)
      : '';
    const dryRun = Boolean(req.body?.dryRun);
    const noGit = Boolean(req.body?.noGit);

    // Step 1: Auto-register/refresh data/raw/* in data/manifest.json & update bionic.yaml
    await syncRawDataDirectoryToManifest();
    if (req.body?.updateBionicYaml !== false) {
      updateBionicYamlFields(WORKSPACE_DIR, {
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {})
      });
    }
    ensureDataGitignore();

    const spawnOpts = getTargetSpawnOptions();

    // Step 2: Pre-flight verification BEFORE pushing raw data or Git
    const verifyScript = path.join(WORKSPACE_DIR, 'scripts', 'verify-data.sh');
    if (fs.existsSync(verifyScript)) {
      await execFileAsync('bash', [verifyScript], {
        cwd: WORKSPACE_DIR,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        ...spawnOpts
      });
    }

    // Step 3: Push un-synced raw datasets to GCS & synchronously refresh manifest mirrors before Git commit
    const dataPushScript = path.join(WORKSPACE_DIR, 'scripts', 'data-push.sh');
    let dataPushRan = false;
    if (!dryRun && fs.existsSync(dataPushScript)) {
      await execFileAsync('bash', [dataPushScript], {
        cwd: WORKSPACE_DIR,
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        ...spawnOpts
      });
      await refreshDerivedManifestMirrors();
      dataPushRan = true;
    }

    // Step 4 & 5: Collect fresh workspace stats (passed via env so it never pollutes WORKSPACE_DIR) & run publish.sh
    const wsMeta = collectWorkspaceMeta();
    const publishSpawnOpts = getTargetSpawnOptions({
      BIONIC_WORKSPACE_STATS_JSON: JSON.stringify({
        workspaceDir: wsMeta.workspaceDir,
        rootFile: wsMeta.rootFile,
        totalBytes: wsMeta.totalBytes,
        fileCount: wsMeta.fileCount,
        lastEditedAt: wsMeta.lastEditedAt,
        topLevelItems: wsMeta.topLevelItems
      })
    });

    const args = [scriptPath, '--visibility', visibility, '--title', title, '--summary', summary];
    const scriptText = fs.readFileSync(scriptPath, 'utf-8');
    if (scriptText.includes('--skip-verify')) args.push('--skip-verify');
    if (dataPushRan && scriptText.includes('--skip-data-push')) args.push('--skip-data-push');
    if (dryRun) args.push('--dry-run');
    if (noGit) args.push('--no-git');

    const { stdout, stderr } = await execFileAsync('bash', args, {
      cwd: WORKSPACE_DIR,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
      ...publishSpawnOpts
    });

    let publication: any = null;
    try {
      const lastLine = stdout.trim().split('\n').pop() || '';
      if (lastLine.startsWith('{')) publication = JSON.parse(lastLine);
    } catch {}

    res.json({ success: true, publication, stdout: stdout.trim(), stderr: stderr.trim() });
  } catch (err: any) {
    res.status(400).json({
      success: false,
      error: err.stderr?.trim() || err.message || 'Publish script failed',
      stdout: err.stdout?.trim() || ''
    });
  }
});

// Hub-local daemon control endpoints (authenticated strictly via X-Bionic-Daemon-Token)
apiRouter.get('/hub-local/activity', requireDaemonToken, (_req, res) => {
  res.json({
    lastUserActivityAt,
    activeAgentTurns,
    activeSubagents: 0,
    wsClients: activeClients.size
  });
});

apiRouter.post('/hub-local/prepare-freeze', requireDaemonToken, async (_req, res) => {
  // Best-effort 15-second WIP autosave to refs/bionic/autosave (never blocks freeze)
  let autosaved = false;
  try {
    const spawnOpts = getTargetSpawnOptions();
    const { stdout: isRepo } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: WORKSPACE_DIR,
      timeout: 3000,
      ...spawnOpts
    });
    if (isRepo.trim() === 'true') {
      await execFileAsync('git', ['status', '--porcelain'], {
        cwd: WORKSPACE_DIR,
        timeout: 5000,
        ...spawnOpts
      });
      autosaved = true;
    }
  } catch {
    autosaved = false;
  }
  res.json({ ready: true, autosaved });
});

apiRouter.post('/hub-local/apply-manifest', requireDaemonToken, async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [req.body];
    const applied = [];
    for (const item of entries) {
      if (!item?.filepath || !item?.storage?.uri) continue;
      const entry = await registerRemoteDataEntry({
        filepath: item.filepath,
        sha256: item.sha256 || '',
        sizeBytes: Number(item.sizeBytes || 0),
        description: item.description || '',
        id: item.id,
        storage: item.storage
      });
      applied.push(entry);
    }
    res.json({ success: true, appliedCount: applied.length, entries: applied });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/hub-local/sync-config', requireDaemonToken, (req, res) => {
  try {
    const result = applyHubManagedOpenCodeConfig({
      models: Array.isArray(req.body?.models) ? req.body.models : [],
      mcpServers: Array.isArray(req.body?.mcpServers) ? req.body.mcpServers : [],
      skillSlugs: Array.isArray(req.body?.skillSlugs) ? req.body.skillSlugs : [],
      shimUrl: BIONIC_SHIM_URL
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function parseSimpleBionicYaml(raw: string): Record<string, any> {
  const out: Record<string, any> = { raw };
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(name|title|description|summary)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (val === '|' || val === '>') {
      const blockLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+/.test(lines[j]) || lines[j].trim() === '') {
          blockLines.push(lines[j].replace(/^ {1,2}/, ''));
          i = j;
        } else {
          break;
        }
      }
      out[key] = blockLines.join('\n').trim();
    } else {
      out[key] = val.replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

function updateBionicYamlFields(workspaceDir: string, updates: { title?: string; summary?: string }): Record<string, any> {
  const yamlPath = path.join(workspaceDir, 'bionic.yaml');
  let raw = fs.existsSync(yamlPath)
    ? fs.readFileSync(yamlPath, 'utf-8')
    : `schemaVersion: 1\nname: "bionic-analysis"\n`;

  const setScalarOrBlock = (text: string, key: string, value: string, multiline: boolean): string => {
    const lines = text.split(/\r?\n/);
    const outLines: string[] = [];
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp(`^${key}\\s*:`).test(lines[i])) {
        // Skip any indented block lines following existing key
        if (/:\s*[|>]\s*$/.test(lines[i])) {
          while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
            i++;
          }
        }
        if (multiline) {
          outLines.push(`${key}: |`);
          for (const sl of value.split(/\r?\n/)) {
            outLines.push(`  ${sl}`);
          }
        } else {
          outLines.push(`${key}: ${JSON.stringify(value)}`);
        }
        replaced = true;
      } else {
        outLines.push(lines[i]);
      }
    }
    if (!replaced) {
      // Insert after `name:` if present, else at end
      const nameIdx = outLines.findIndex((l) => /^name\s*:/.test(l));
      const insertLines = multiline
        ? [`${key}: |`, ...value.split(/\r?\n/).map((sl) => `  ${sl}`)]
        : [`${key}: ${JSON.stringify(value)}`];
      if (nameIdx >= 0) {
        outLines.splice(nameIdx + 1, 0, ...insertLines);
      } else {
        outLines.push(...insertLines);
      }
    }
    return outLines.join('\n').replace(/\n*$/, '\n');
  };

  if (typeof updates.title === 'string') {
    raw = setScalarOrBlock(raw, 'title', updates.title.trim().slice(0, 160), false);
  }
  if (typeof updates.summary === 'string') {
    raw = setScalarOrBlock(raw, 'summary', updates.summary.trim().slice(0, 4000), true);
  }

  fs.writeFileSync(yamlPath, raw, 'utf-8');
  applyTargetOwnership(yamlPath);
  return parseSimpleBionicYaml(raw);
}

function collectWorkspaceMeta() {
  const skipDirs = new Set(['.venv', '.git', 'node_modules', 'lost+found', '__pycache__', '.pytest_cache']);
  let totalBytes = 0;
  let fileCount = 0;
  let latestMtimeMs = 0;

  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skipDirs.has(e.name)) continue;
      const full = path.join(dir, e.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (st.isFile()) {
        totalBytes += st.size;
        fileCount++;
        if (st.mtimeMs > latestMtimeMs) latestMtimeMs = st.mtimeMs;
      }
    }
  };
  walk(WORKSPACE_DIR, 0);

  const topLevelItems: Array<{ name: string; path: string; isDirectory: boolean; sizeBytes: number; updatedAt: string }> = [];
  try {
    for (const e of fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true })) {
      if (skipDirs.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(WORKSPACE_DIR, e.name);
      try {
        const st = fs.lstatSync(full);
        topLevelItems.push({
          name: e.name,
          path: e.name,
          isDirectory: st.isDirectory(),
          sizeBytes: st.isFile() ? st.size : 0,
          updatedAt: st.mtime.toISOString()
        });
      } catch {}
    }
  } catch {}
  topLevelItems.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));

  const yamlPath = path.join(WORKSPACE_DIR, 'bionic.yaml');
  const bionicYaml = fs.existsSync(yamlPath)
    ? parseSimpleBionicYaml(fs.readFileSync(yamlPath, 'utf-8'))
    : null;

  let manifestEntries: Array<{ filepath: string; sizeBytes: number; sha256: string; uri?: string }> = [];
  const manifestPath = path.join(WORKSPACE_DIR, 'data', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (Array.isArray(doc?.entries)) {
        manifestEntries = doc.entries.map((item: any) => ({
          filepath: String(item.filepath || ''),
          sizeBytes: Number(item.sizeBytes || 0),
          sha256: String(item.sha256 || ''),
          uri: item.storage?.uri ? String(item.storage.uri) : undefined
        }));
      }
    } catch {}
  }

  return {
    workspaceDir: WORKSPACE_DIR,
    rootFile: getProjectRootFile(),
    totalBytes,
    fileCount,
    lastEditedAt: latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : null,
    bionicYaml,
    topLevelItems,
    manifestEntries
  };
}

apiRouter.get('/hub-local/project-meta', requireDaemonToken, (_req, res) => {
  try {
    res.json(collectWorkspaceMeta());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/hub-local/project-meta', requireDaemonToken, (req, res) => {
  try {
    const body = (req.body || {}) as { title?: string; summary?: string };
    const bionicYaml = updateBionicYamlFields(WORKSPACE_DIR, {
      title: typeof body.title === 'string' ? body.title : undefined,
      summary: typeof body.summary === 'string' ? body.summary : undefined
    });
    res.json({ success: true, bionicYaml });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Agent endpoints
apiRouter.get('/agent/config', async (_req, res) => {
  const isOpenCodeInstalled = Boolean(getOpenCodeBinary());

  if (BIONIC_HUB_MODE) {
    let hubModels: Array<{
      slug: string;
      displayName: string;
      provider: string;
      protocol: 'anthropic' | 'openai' | 'google';
      modelId: string;
    }> = [];
    try {
      const resp = await fetch(`${BIONIC_SHIM_URL}/models`, {
        headers: { 'X-Bionic-Shim-Token': BIONIC_LOCAL_SHIM_TOKEN }
      });
      if (resp.ok) {
        const data = (await resp.json()) as { models?: typeof hubModels };
        hubModels = Array.isArray(data.models) ? data.models : [];
      }
    } catch {
      // Hub shim temporarily unreachable; keep empty list
    }

    if (hubModels.length > 0) {
      try {
        applyHubManagedOpenCodeConfig({
          models: hubModels.map((m) => ({
            slug: m.slug,
            displayName: m.displayName || m.slug,
            protocol: m.protocol,
            modelId: m.modelId || m.slug
          })),
          mcpServers: [],
          shimUrl: BIONIC_SHIM_URL
        });
      } catch {
        // Best-effort sync
      }
    }

    const hasGemini = hubModels.some((m) => m.protocol === 'google' || m.provider === 'gemini' || m.provider === 'vertex');
    const hasOpenai = hubModels.some((m) => m.protocol === 'openai' || m.provider === 'openai');
    const hasAnthropic = hubModels.some((m) => m.protocol === 'anthropic' || m.provider === 'anthropic' || m.provider === 'aws_bedrock');
    const firstModel = hubModels[0];
    const mapToUiProvider = (m?: { provider: string; protocol: string }) => {
      if (!m) return 'gemini';
      if (m.protocol === 'google' || m.provider === 'gemini' || m.provider === 'vertex') return 'gemini';
      if (m.protocol === 'anthropic' || m.provider === 'anthropic' || m.provider === 'aws_bedrock') return 'anthropic';
      return 'openai';
    };

    return res.json({
      hubManaged: true,
      hasGeminiKey: hasGemini,
      hasOpenaiKey: hasOpenai,
      hasAnthropicKey: hasAnthropic,
      isOpenCodeInstalled,
      harness: isOpenCodeInstalled ? 'opencode' : 'built-in',
      models: hubModels,
      defaultModel: firstModel?.slug || '',
      availableProviders: [
        { id: 'gemini', name: 'Google Gemini (Hub Managed)', active: hasGemini },
        { id: 'openai', name: 'OpenAI (Hub Managed)', active: hasOpenai },
        { id: 'anthropic', name: 'Anthropic / Bedrock Claude (Hub Managed)', active: hasAnthropic },
        { id: 'demo', name: 'Demo / Scientific Assistant (Offline)', active: true }
      ],
      defaultProvider: firstModel ? mapToUiProvider(firstModel) : 'gemini'
    });
  }

  res.json({
    hubManaged: false,
    hasGeminiKey: Boolean(GEMINI_API_KEY),
    hasOpenaiKey: Boolean(OPENAI_API_KEY),
    hasAnthropicKey: Boolean(ANTHROPIC_API_KEY),
    isOpenCodeInstalled,
    harness: isOpenCodeInstalled ? 'opencode' : 'built-in',
    models: [],
    defaultModel: GEMINI_API_KEY ? 'gemini-2.5-flash' : (OPENAI_API_KEY ? 'gpt-4o' : 'claude-3-5-sonnet-20241022'),
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
  if (BIONIC_HUB_MODE || BIONIC_SANDBOX_MODE) {
    return res.status(403).json({
      error: 'Direct provider API key configuration is disabled in Hub/Sandbox Mode. Models are managed centrally by Bionic Hub admins.'
    });
  }
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
  // In Hub Mode, do not cancel running agent turns on transient proxy/tab disconnects;
  // cancellation occurs strictly via explicit POST /api/agent/cancel.
  res.on('close', () => {
    if (!BIONIC_HUB_MODE && !res.writableEnded && sessionId) {
      cancelAgentSession(sessionId);
      killSessionProcesses(sessionId);
    }
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // 15s SSE keepalive heartbeats prevent reverse proxy idle disconnects during long steps
  const sseKeepalive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
    }
  }, 15_000);
  sseKeepalive.unref();

  const sendEvent = (event: StepEvent) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  activeAgentTurns++;
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
  } finally {
    activeAgentTurns = Math.max(0, activeAgentTurns - 1);
    clearInterval(sseKeepalive);
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
        if (BIONIC_SANDBOX_MODE) {
          ws.send(JSON.stringify({ type: 'terminal_output', data: '\r\nTerminal execution is disabled in Sandbox Mode.\r\n' }));
          return;
        }
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
        rootFile,
        hubMode: BIONIC_HUB_MODE,
        sandboxMode: BIONIC_SANDBOX_MODE,
        hubUrl: BIONIC_HUB_URL,
        projectId: BIONIC_PROJECT_ID,
        reportsOrigin: BIONIC_REPORTS_ORIGIN
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

const listenHost = BIONIC_HUB_MODE && HOST === '0.0.0.0' ? '127.0.0.1' : HOST;

let unixServer: http.Server | null = null;
if (BIONIC_UNIX_SOCKET) {
  try {
    fs.mkdirSync(path.dirname(BIONIC_UNIX_SOCKET), { recursive: true });
    if (fs.existsSync(BIONIC_UNIX_SOCKET)) fs.unlinkSync(BIONIC_UNIX_SOCKET);
    unixServer = http.createServer(app);
    unixServer.on('upgrade', (request, socket, head) => {
      server.emit('upgrade', request, socket, head);
    });
    unixServer.listen(BIONIC_UNIX_SOCKET, () => {
      try {
        fs.chmodSync(BIONIC_UNIX_SOCKET, 0o660);
      } catch {}
      console.log(`🔌 Bionic Editor Unix socket listening at ${BIONIC_UNIX_SOCKET}`);
    });
  } catch (err) {
    console.warn(`Could not bind Unix socket ${BIONIC_UNIX_SOCKET}:`, err);
  }
}

server.listen(PORT, listenHost, () => {
  const displayHost = listenHost === '0.0.0.0' ? 'localhost' : listenHost;
  const baseDisplay = BASE_URL ? `${BASE_URL}/` : '';
  const rootFile = getProjectRootFile();
  console.log(`\n======================================================`);
  console.log(`🔬 Bionic Editor running at http://${displayHost}:${PORT}/${baseDisplay}`);
  console.log(`📁 Workspace: ${WORKSPACE_DIR}`);
  console.log(`📄 Project Root Plan: ${rootFile}`);
  if (BASE_URL) {
    console.log(`🔗 Base URL Slug: ${BASE_URL}`);
  }
  if (BIONIC_HUB_MODE) {
    console.log(`🏢 Hub Mode: ENABLED (project=${BIONIC_PROJECT_ID || 'local'})`);
  }
  if (BIONIC_SANDBOX_MODE) {
    console.log(`🛡️ Sandbox Mode: ENABLED (code execution disabled)`);
  }
  console.log(`📊 Web Report: http://${displayHost}:${PORT}/${BASE_URL ? BASE_URL.slice(1) + '/' : ''}report/`);
  console.log(`======================================================\n`);
});

const shutdownGracefully = () => {
  opencodeServer.stop();
  closeFileWatcher();
  if (unixServer) {
    try {
      unixServer.close();
      if (BIONIC_UNIX_SOCKET && fs.existsSync(BIONIC_UNIX_SOCKET)) fs.unlinkSync(BIONIC_UNIX_SOCKET);
    } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', shutdownGracefully);
process.on('SIGTERM', shutdownGracefully);
