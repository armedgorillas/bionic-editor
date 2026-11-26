import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root directory of the bionic-editor installation
export const PACKAGE_ROOT = path.resolve(__dirname, '..');

// Load environment files from multiple standard locations
if (process.env.ENV_FILE && fs.existsSync(process.env.ENV_FILE)) {
  dotenv.config({ path: process.env.ENV_FILE });
}
dotenv.config(); // Current working directory
if (PACKAGE_ROOT !== process.cwd()) {
  const pkgEnv = path.join(PACKAGE_ROOT, '.env');
  if (fs.existsSync(pkgEnv)) {
    dotenv.config({ path: pkgEnv });
  }
}
// Support standard Linux systemd /etc environment files if present
for (const sysEnv of ['/etc/bionic-editor.env', '/etc/default/bionic-editor']) {
  if (fs.existsSync(sysEnv)) {
    dotenv.config({ path: sysEnv });
  }
}

// Parse command line arguments
function parseCliArgs() {
  const args = process.argv.slice(2);
  let cliWorkspace: string | undefined;
  let cliPort: number | undefined;
  let cliHost: string | undefined;
  let cliBaseUrl: string | undefined;
  let cliBaseSpec: string | undefined;
  let cliUser: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') {
      console.log(`
Bionic Editor - Scientific Document & Analysis IDE

Usage:
  bioniceditor [workspace-path] [options]

Options:
  -w, --workspace <path>  Path to the workspace directory to serve
  -p, --port <number>     Port number to bind to (default: 3000 or $PORT)
  -h, --host <address>    Host address to bind to (default: 0.0.0.0 or $HOST)
  -b, --base-url <slug>   Base URL slug prefix (e.g. /ws-01 or ws-01)
  -s, --base-spec <file>  Default base specification file (default: SPEC.md or $BASE_SPEC)
  -u, --user <username>   System user to run workspace operations as ($SERVICE_USER)
      --help              Display this help message
  -v, --version           Display version information

Environment Variables:
  WORKSPACE_DIR           Path to the workspace directory to serve
  BIONIC_WORKSPACE        Alternative path to workspace directory
  PORT                    Server port (default: 3000)
  HOST                    Server bind address (default: 0.0.0.0)
  BASE_URL                Base URL slug prefix (e.g. /ws-01)
  BASE_SPEC               Default base specification file (default: SPEC.md)
  SERVICE_USER            System user to run operations and terminal as
  ENV_FILE                Path to custom .env configuration file
  GEMINI_API_KEY          Google Gemini API key
  OPENAI_API_KEY          OpenAI API key
  ANTHROPIC_API_KEY       Anthropic API key
  MAX_TURNS               Maximum turns limit (default: unlimited)
`);
      process.exit(0);
    }
    if (arg === '--version' || arg === '-v') {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
        console.log(`Bionic Editor v${pkg.version || '1.0.0'}`);
      } catch {
        console.log('Bionic Editor v1.0.0');
      }
      process.exit(0);
    }
    if (arg === '-w' || arg === '--workspace') {
      if (i + 1 < args.length) {
        cliWorkspace = args[++i];
      }
    } else if (arg.startsWith('--workspace=')) {
      cliWorkspace = arg.slice('--workspace='.length);
    } else if (arg === '-p' || arg === '--port') {
      if (i + 1 < args.length) {
        const p = parseInt(args[++i], 10);
        if (!isNaN(p)) cliPort = p;
      }
    } else if (arg.startsWith('--port=')) {
      const p = parseInt(arg.slice('--port='.length), 10);
      if (!isNaN(p)) cliPort = p;
    } else if (arg === '-h' || arg === '--host') {
      if (i + 1 < args.length) {
        cliHost = args[++i];
      }
    } else if (arg.startsWith('--host=')) {
      cliHost = arg.slice('--host='.length);
    } else if (arg === '-b' || arg === '--base-url') {
      if (i + 1 < args.length) {
        cliBaseUrl = args[++i];
      }
    } else if (arg.startsWith('--base-url=')) {
      cliBaseUrl = arg.slice('--base-url='.length);
    } else if (arg === '-s' || arg === '--base-spec') {
      if (i + 1 < args.length) {
        cliBaseSpec = args[++i];
      }
    } else if (arg.startsWith('--base-spec=')) {
      cliBaseSpec = arg.slice('--base-spec='.length);
    } else if (arg === '-u' || arg === '--user') {
      if (i + 1 < args.length) {
        cliUser = args[++i];
      }
    } else if (arg.startsWith('--user=')) {
      cliUser = arg.slice('--user='.length);
    } else if (!arg.startsWith('-') && !cliWorkspace) {
      cliWorkspace = arg;
    }
  }

  return { cliWorkspace, cliPort, cliHost, cliBaseUrl, cliBaseSpec, cliUser };
}

const { cliWorkspace, cliPort, cliHost, cliBaseUrl, cliBaseSpec, cliUser } = parseCliArgs();

function resolveWorkspaceDir(cliTarget?: string): string {
  // 1. Explicit CLI argument takes precedence
  if (cliTarget) {
    return path.resolve(cliTarget);
  }

  // 2. Explicit environment variable takes second precedence
  const envWorkspace = process.env.WORKSPACE_DIR || process.env.BIONIC_WORKSPACE;
  if (envWorkspace) {
    return path.resolve(envWorkspace);
  }

  // 3. Fallback when neither CLI arg nor env var is provided:
  // If running from repo root where dev/test workspace exists, default to ./workspace for test suite compatibility
  const localWorkspace = path.join(PACKAGE_ROOT, 'workspace');
  if (process.cwd() === PACKAGE_ROOT && fs.existsSync(localWorkspace)) {
    return localWorkspace;
  }

  // 4. Otherwise, default to current working directory
  return path.resolve(process.cwd());
}

export const HOST = cliHost || process.env.HOST || '0.0.0.0';
export const PORT = cliPort || parseInt(process.env.PORT || '3000', 10);
export const WORKSPACE_DIR = resolveWorkspaceDir(cliWorkspace);

export function normalizeBaseUrl(url?: string): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (!trimmed || trimmed === '/') return '';
  const leading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return leading.replace(/\/+$/, '');
}

export function normalizeBaseSpec(spec?: string): string {
  if (!spec) return 'SPEC.md';
  const trimmed = spec.trim();
  return trimmed || 'SPEC.md';
}

export const BASE_URL = normalizeBaseUrl(cliBaseUrl || process.env.BASE_URL || process.env.BASE_URL_SLUG || process.env.BASE_PATH);
export const BASE_SPEC = normalizeBaseSpec(cliBaseSpec || process.env.BASE_SPEC || process.env.SPEC_FILE);
export const SERVICE_USER = cliUser || process.env.SERVICE_USER || process.env.APP_USER || process.env.BIONIC_USER || '';

export interface TargetUser {
  username?: string;
  uid?: number;
  gid?: number;
  home?: string;
}

export function resolveTargetUser(workspaceDir: string, explicitUser?: string): TargetUser {
  const configuredUser = explicitUser || SERVICE_USER;
  if (configuredUser) {
    try {
      if (/^\d+$/.test(configuredUser)) {
        const uid = parseInt(configuredUser, 10);
        return { username: configuredUser, uid, gid: uid };
      }
      try {
        const info = os.userInfo();
        if (info.username === configuredUser) {
          return { username: info.username, uid: info.uid, gid: info.gid, home: info.homedir };
        }
      } catch {}

      if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(configuredUser)) {
        return { username: configuredUser };
      }
      const uidStr = execFileSync('id', ['-u', configuredUser], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      const gidStr = execFileSync('id', ['-g', configuredUser], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      return {
        username: configuredUser,
        uid: parseInt(uidStr, 10),
        gid: parseInt(gidStr, 10),
        home: `/home/${configuredUser}`
      };
    } catch {
      return { username: configuredUser };
    }
  }

  // If running as root on Linux/POSIX, check SUDO_USER or workspace owner
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const sudoUser = process.env.SUDO_USER;
    if (sudoUser && sudoUser !== 'root' && /^[a-z_][a-z0-9_-]*[$]?$/i.test(sudoUser)) {
      try {
        const uidStr = execFileSync('id', ['-u', sudoUser], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        const gidStr = execFileSync('id', ['-g', sudoUser], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        return {
          username: sudoUser,
          uid: parseInt(uidStr, 10),
          gid: parseInt(gidStr, 10),
          home: `/home/${sudoUser}`
        };
      } catch {}
    }

    try {
      if (fs.existsSync(workspaceDir)) {
        const stat = fs.statSync(workspaceDir);
        if (stat.uid !== 0) {
          return { uid: stat.uid, gid: stat.gid };
        }
      }
    } catch {}
  }

  try {
    const info = os.userInfo();
    return { username: info.username, uid: info.uid, gid: info.gid, home: info.homedir };
  } catch {
    return {};
  }
}

export const TARGET_USER = resolveTargetUser(WORKSPACE_DIR, SERVICE_USER);

export const BIONIC_HUB_MODE = process.env.BIONIC_HUB_MODE === 'true' || process.env.BIONIC_HUB_MODE === '1';
export const BIONIC_IS_FORK = process.env.BIONIC_IS_FORK === 'true' || process.env.BIONIC_IS_FORK === '1';
export const BIONIC_SANDBOX_MODE = process.env.BIONIC_SANDBOX_MODE === 'true' || process.env.BIONIC_SANDBOX_MODE === '1';
export const BIONIC_HUB_URL = (process.env.BIONIC_HUB_URL || '').replace(/\/+$/, '');
export const BIONIC_PROJECT_ID = process.env.BIONIC_PROJECT_ID || '';
export const BIONIC_SHIM_URL = (process.env.BIONIC_SHIM_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
export const BIONIC_LOCAL_SHIM_TOKEN = process.env.BIONIC_LOCAL_SHIM_TOKEN || '';
export const BIONIC_DAEMON_TOKEN = process.env.BIONIC_DAEMON_TOKEN || '';
export const BIONIC_UNIX_SOCKET = process.env.BIONIC_UNIX_SOCKET || '';
export const BIONIC_REPORTS_ORIGIN = (process.env.BIONIC_REPORTS_ORIGIN || '').replace(/\/+$/, '');
export const BIONIC_MANAGED_SKILLS_DIR = process.env.BIONIC_MANAGED_SKILLS_DIR || '/var/lib/bionic/managed-skills';

// Strict env allowlist used when spawning untrusted workspace processes in Hub Mode
const HUB_SAFE_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'TMPDIR',
  'VIRTUAL_ENV',
  'PYTHONUNBUFFERED',
  'BIONIC_API_URL',
  'BIONIC_SHIM_URL',
  'BIONIC_DATA_PROXY_URL',
  'BIONIC_GIT_PROXY_URL',
  'BIONIC_HUB_PUBLISH_URL',
  'BIONIC_LOCAL_SHIM_TOKEN',
  'BIONIC_PROJECT_ID',
  'BIONIC_HUB_MODE',
  'BIONIC_DATA_BUCKET',
  'PUBLISH_TARGET',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'OPENCODE_BIN'
]);

export function buildSafeChildEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const target = TARGET_USER;
  if (!BIONIC_HUB_MODE) {
    return {
      ...process.env,
      ...(target.username ? { USER: target.username, LOGNAME: target.username } : {}),
      ...(target.home ? { HOME: target.home } : {}),
      ...extraEnv
    };
  }

  // In Hub Mode, never spread raw process.env (prevents leaking daemon/hub secrets)
  const allowedWorkloadKeys = new Set(
    (process.env.BIONIC_ALLOWED_WORKLOAD_ENV || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
  );
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (HUB_SAFE_ENV_KEYS.has(k) || allowedWorkloadKeys.has(k))) {
      env[k] = v;
    }
  }
  if (target.username) {
    env.USER = target.username;
    env.LOGNAME = target.username;
  }
  if (target.home) {
    env.HOME = target.home;
  }
  if (BIONIC_SHIM_URL) {
    env.BIONIC_SHIM_URL = BIONIC_SHIM_URL;
    env.BIONIC_DATA_PROXY_URL = `${BIONIC_SHIM_URL}/data`;
    env.BIONIC_HUB_PUBLISH_URL = `${BIONIC_SHIM_URL}/publish`;
    if (BIONIC_PROJECT_ID) {
      env.BIONIC_GIT_PROXY_URL = `${BIONIC_SHIM_URL}/git/${BIONIC_PROJECT_ID}.git`;
    }
  }
  if (BIONIC_LOCAL_SHIM_TOKEN) {
    env.BIONIC_LOCAL_SHIM_TOKEN = BIONIC_LOCAL_SHIM_TOKEN;
  }
  if (extraEnv) {
    Object.assign(env, extraEnv);
  }
  return env;
}

export function getTargetSpawnOptions(extraEnv?: NodeJS.ProcessEnv): {
  uid?: number;
  gid?: number;
  env: NodeJS.ProcessEnv;
} {
  const target = TARGET_USER;
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const spawnOpts: { uid?: number; gid?: number; env: NodeJS.ProcessEnv } = {
    env: buildSafeChildEnv(extraEnv)
  };

  if (isRoot && target.uid !== undefined && target.uid !== 0) {
    spawnOpts.uid = target.uid;
    if (target.gid !== undefined) {
      spawnOpts.gid = target.gid;
    }
  }

  return spawnOpts;
}

export let OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
export let GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
export let OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';

export function updateConfigKeys(keys: { geminiApiKey?: string; openaiApiKey?: string; anthropicApiKey?: string }) {
  if (keys.geminiApiKey) GEMINI_API_KEY = keys.geminiApiKey;
  if (keys.openaiApiKey) OPENAI_API_KEY = keys.openaiApiKey;
  if (keys.anthropicApiKey) ANTHROPIC_API_KEY = keys.anthropicApiKey;
}
