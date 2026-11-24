import fs from 'fs';
import path from 'path';
import { modify, applyEdits, parse as parseJsonc } from 'jsonc-parser';
import { WORKSPACE_DIR } from '../config.js';
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
