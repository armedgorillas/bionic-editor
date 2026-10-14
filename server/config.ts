import fs from 'fs';
import path from 'path';
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
      --help              Display this help message
  -v, --version           Display version information

Environment Variables:
  WORKSPACE_DIR           Path to the workspace directory to serve
  BIONIC_WORKSPACE        Alternative path to workspace directory
  PORT                    Server port (default: 3000)
  HOST                    Server bind address (default: 0.0.0.0)
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
    } else if (!arg.startsWith('-') && !cliWorkspace) {
      cliWorkspace = arg;
    }
  }

  return { cliWorkspace, cliPort, cliHost };
}

const { cliWorkspace, cliPort, cliHost } = parseCliArgs();

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

export let OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
export let GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
export let OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';

export function updateConfigKeys(keys: { geminiApiKey?: string; openaiApiKey?: string; anthropicApiKey?: string }) {
  if (keys.geminiApiKey) GEMINI_API_KEY = keys.geminiApiKey;
  if (keys.openaiApiKey) OPENAI_API_KEY = keys.openaiApiKey;
  if (keys.anthropicApiKey) ANTHROPIC_API_KEY = keys.anthropicApiKey;
}
