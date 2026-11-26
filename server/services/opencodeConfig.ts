import fs from 'fs';
import os from 'os';
import path from 'path';
import { modify, applyEdits, parse as parseJsonc } from 'jsonc-parser';
import { WORKSPACE_DIR, BIONIC_SHIM_URL, BIONIC_MANAGED_SKILLS_DIR } from '../config.js';
import { atomicWriteFileSync } from './fsSafe.js';
import { getProjectRootFile } from './workspaceConfig.js';
import {
  buildBionicInstructions,
  SYSTEM_PROMPT_REL_PATH,
  USER_INSTRUCTIONS_REL_PATH
} from './agentPrompt.js';

const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';

function resolveOpenCodeConfigPath(): string {
  const jsonPath = path.join(WORKSPACE_DIR, '.opencode', 'opencode.json');
  const jsoncPath = path.join(WORKSPACE_DIR, '.opencode', 'opencode.jsonc');
  if (fs.existsSync(jsonPath) && !fs.existsSync(jsoncPath)) {
    return jsonPath;
  }
  return jsoncPath;
}

/**
 * Refreshes `.bionic/SYSTEM_PROMPT.md` with the current Project Root File.
 * Safe to call whenever the Project Root File or user instructions change.
 */
export function refreshManagedSystemPrompt(): string {
  const rootFile = getProjectRootFile();
  const promptText = buildBionicInstructions(rootFile);
  const fullPromptPath = path.join(WORKSPACE_DIR, SYSTEM_PROMPT_REL_PATH);
  atomicWriteFileSync(fullPromptPath, promptText);
  return fullPromptPath;
}

/**
 * Lazily ensures OpenCode V2 workspace configuration exists and references
 * Bionic's managed instructions without overwriting user comments, settings,
 * or AGENTS.md. Never call on server startup — call only during explicit
 * template init or right before launching an OpenCode session.
 */
export function ensureOpenCodeWorkspaceConfig(): {
  configPath: string;
  systemPromptPath: string;
} {
  const systemPromptPath = refreshManagedSystemPrompt();
  const userInstructionsFull = path.join(WORKSPACE_DIR, USER_INSTRUCTIONS_REL_PATH);
  const configPath = resolveOpenCodeConfigPath();

  const existingText = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, 'utf-8')
    : '{\n}\n';

  let parsed: Record<string, any> = {};
  try {
    const p = parseJsonc(existingText);
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      parsed = p;
    }
  } catch {
    parsed = {};
  }

  let updatedText = existingText.trim() ? existingText : '{\n}\n';
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

  // 1. Ensure $schema is present
  if (!parsed.$schema) {
    const edits = modify(updatedText, ['$schema'], OPENCODE_SCHEMA_URL, { formattingOptions });
    updatedText = applyEdits(updatedText, edits);
  }

  // 2. Register Bionic's single managed SYSTEM_PROMPT.md (which already embeds
  //    .bionic/USER_INSTRUCTIONS.md cleanly, avoiding double-injection!).
  const managedInstructions: string[] = [systemPromptPath];
  const userInstructionsRel = USER_INSTRUCTIONS_REL_PATH;

  const rawCurrent: string[] = Array.isArray(parsed.instructions)
    ? [...parsed.instructions]
    : [];

  // Remove any legacy duplicate USER_INSTRUCTIONS.md entry if previously added
  const currentInstructions = rawCurrent.filter(
    (entry) => entry !== userInstructionsFull && entry !== userInstructionsRel
  );
  let instructionsChanged = currentInstructions.length !== rawCurrent.length;

  for (const entry of managedInstructions) {
    const relVariant = path.relative(WORKSPACE_DIR, entry).replace(/\\/g, '/');
    if (!currentInstructions.includes(entry) && !currentInstructions.includes(relVariant)) {
      currentInstructions.push(entry);
      instructionsChanged = true;
    }
  }

  if (instructionsChanged || !Array.isArray(parsed.instructions)) {
    const edits = modify(updatedText, ['instructions'], currentInstructions, { formattingOptions });
    updatedText = applyEdits(updatedText, edits);
  }

  // 3. Ensure explicit .env* read-deny rule so auto-approved sessions never leak API keys
  const currentPermissions: any[] = Array.isArray(parsed.permissions) ? [...parsed.permissions] : [];
  const hasEnvDeny = currentPermissions.some(
    (rule) =>
      rule &&
      rule.action === 'read' &&
      (rule.resource === '*.env*' || rule.resource === '**/.env*') &&
      rule.effect === 'deny'
  );

  if (!hasEnvDeny) {
    currentPermissions.push(
      { action: 'read', resource: '*.env*', effect: 'deny' },
      { action: 'read', resource: '**/.env*', effect: 'deny' }
    );
    const edits = modify(updatedText, ['permissions'], currentPermissions, { formattingOptions });
    updatedText = applyEdits(updatedText, edits);
  }

  if (!updatedText.endsWith('\n')) {
    updatedText += '\n';
  }

  if (!fs.existsSync(configPath) || updatedText !== existingText) {
    atomicWriteFileSync(configPath, updatedText);
  }

  return { configPath, systemPromptPath };
}

export interface HubSyncModelSpec {
  slug: string;
  displayName: string;
  protocol: 'anthropic' | 'openai' | 'google';
  modelId: string;
}

export interface HubSyncMcpSpec {
  slug: string;
  transport: 'streamable_http' | 'sse' | 'stdio';
  routing: 'hub_gateway' | 'vm_local';
  command?: string[];
}

/**
 * Syncs read-only Hub-managed skill symlinks into `~bionic-user/.config/opencode/skills/`
 * (outside WORKSPACE_DIR so admin skills are never accidentally committed to project Git repos).
 */
export function syncManagedSkillSymlinks(
  skillSlugs: string[],
  managedDir: string = BIONIC_MANAGED_SKILLS_DIR
): string[] {
  const userSkillsRoot = path.join(os.homedir(), '.config', 'opencode', 'skills');
  fs.mkdirSync(userSkillsRoot, { recursive: true });

  const allowedSet = new Set(skillSlugs);
  const managedPrefix = managedDir.endsWith(path.sep) ? managedDir : managedDir + path.sep;
  // Remove stale managed symlinks pointing into managedDir
  for (const entry of fs.readdirSync(userSkillsRoot, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const full = path.join(userSkillsRoot, entry.name);
    try {
      const target = fs.readlinkSync(full);
      if (target.startsWith(managedPrefix) && !allowedSet.has(entry.name)) {
        fs.unlinkSync(full);
      }
    } catch {
      // ignore
    }
  }

  const linked: string[] = [];
  for (const slug of skillSlugs) {
    if (!/^[a-z0-9-]+$/.test(slug)) continue;
    const src = path.join(managedDir, slug);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(userSkillsRoot, slug);
    try {
      if (fs.existsSync(dest) || fs.lstatSync(dest).isSymbolicLink()) {
        fs.unlinkSync(dest);
      }
    } catch {}
    fs.symlinkSync(src, dest, 'dir');
    linked.push(slug);
  }
  return linked;
}

/**
 * Updates `.opencode/opencode.jsonc` with Hub-provisioned models (pointing at
 * bionic-daemon's localhost shim `127.0.0.1:3001/llm/{anthropic,openai,google}`)
 * and MCP servers (pointing at `127.0.0.1:3001/mcp/<slug>` for hub_gateway).
 */
export function applyHubManagedOpenCodeConfig(payload: {
  models: HubSyncModelSpec[];
  mcpServers: HubSyncMcpSpec[];
  skillSlugs?: string[];
  shimUrl?: string;
}): { configPath: string; linkedSkills: string[] } {
  const { configPath } = ensureOpenCodeWorkspaceConfig();
  const shim = (payload.shimUrl || BIONIC_SHIM_URL).replace(/\/+$/, '');
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

  let updatedText = fs.readFileSync(configPath, 'utf-8');
  let parsed: Record<string, any> = {};
  try {
    parsed = parseJsonc(updatedText) || {};
  } catch {
    parsed = {};
  }

  const anthropicModels: Record<string, any> = {};
  const openaiModels: Record<string, any> = {};
  const googleModels: Record<string, any> = {};

  for (const m of payload.models) {
    const entry = { name: m.displayName };
    if (m.protocol === 'anthropic') anthropicModels[m.slug] = entry;
    else if (m.protocol === 'google') googleModels[m.slug] = entry;
    else openaiModels[m.slug] = entry;
  }

  const providerBlock: Record<string, any> = {
    ...(parsed.provider && typeof parsed.provider === 'object' ? parsed.provider : {})
  };
  if (Object.keys(anthropicModels).length > 0) {
    providerBlock['bionic-anthropic'] = {
      npm: '@ai-sdk/anthropic',
      name: 'Bionic Hub (Anthropic / Bedrock Claude)',
      options: { baseURL: `${shim}/llm/anthropic/v1`, apiKey: '{env:BIONIC_LOCAL_SHIM_TOKEN}' },
      models: anthropicModels
    };
  }
  if (Object.keys(openaiModels).length > 0) {
    providerBlock['bionic-openai'] = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Bionic Hub (OpenAI / Bedrock / Ollama)',
      options: { baseURL: `${shim}/llm/openai/v1`, apiKey: '{env:BIONIC_LOCAL_SHIM_TOKEN}' },
      models: openaiModels
    };
  }
  if (Object.keys(googleModels).length > 0) {
    providerBlock['bionic-google'] = {
      npm: '@ai-sdk/google',
      name: 'Bionic Hub (Gemini / Vertex)',
      options: { baseURL: `${shim}/llm/google/v1beta`, apiKey: '{env:BIONIC_LOCAL_SHIM_TOKEN}' },
      models: googleModels
    };
  }

  updatedText = applyEdits(updatedText, modify(updatedText, ['provider'], providerBlock, { formattingOptions }));

  const mcpBlock: Record<string, any> = {
    ...(parsed.mcp && typeof parsed.mcp === 'object' ? parsed.mcp : {})
  };
  for (const srv of payload.mcpServers) {
    if (srv.routing === 'hub_gateway') {
      mcpBlock[srv.slug] = {
        type: 'remote',
        url: `${shim}/mcp/${srv.slug}`,
        headers: { 'X-Bionic-Shim-Token': '{env:BIONIC_LOCAL_SHIM_TOKEN}' },
        enabled: true
      };
    } else if (srv.transport === 'stdio' && srv.command && srv.command.length > 0) {
      mcpBlock[srv.slug] = {
        type: 'local',
        command: srv.command,
        enabled: true
      };
    }
  }
  updatedText = applyEdits(updatedText, modify(updatedText, ['mcp'], mcpBlock, { formattingOptions }));

  if (!updatedText.endsWith('\n')) updatedText += '\n';
  atomicWriteFileSync(configPath, updatedText);

  const linkedSkills = payload.skillSlugs ? syncManagedSkillSymlinks(payload.skillSlugs) : [];
  return { configPath, linkedSkills };
}
