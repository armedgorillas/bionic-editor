import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseJsonc } from 'jsonc-parser';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-occfg-test-'));
process.env.WORKSPACE_DIR = tempDir;

const { ensureOpenCodeWorkspaceConfig } = await import('../dist-server/services/opencodeConfig.js');
const { updateWorkspaceConfig } = await import('../dist-server/services/workspaceConfig.js');
const { writeUserInstructions } = await import('../dist-server/services/agentPrompt.js');

test('OpenCode V2 Config & Markdown-First System Prompt Suite', async (t) => {
  await t.test('merges managed instructions & .env deny rules while preserving user JSONC comments and AGENTS.md', () => {
    const agentsMdPath = path.join(tempDir, 'AGENTS.md');
    fs.writeFileSync(agentsMdPath, '# User Custom Rules\n- Keep my rules intact\n', 'utf-8');

    const ocDir = path.join(tempDir, '.opencode');
    fs.mkdirSync(ocDir, { recursive: true });
    const configPath = path.join(ocDir, 'opencode.jsonc');
    fs.writeFileSync(
      configPath,
      `{
  // Important user comment that must survive
  "instructions": ["docs/custom.md"],
  "formatter": true
}
`,
      'utf-8'
    );

    writeUserInstructions('Prefer Okabe-Ito palettes for all figures.');
    updateWorkspaceConfig({ rootFile: 'PLAN.md', createIfMissing: true });

    const res = ensureOpenCodeWorkspaceConfig();
    assert.equal(res.configPath, configPath);

    const rawConfig = fs.readFileSync(configPath, 'utf-8');
    // User comment & existing keys preserved
    assert.ok(rawConfig.includes('// Important user comment that must survive'));
    const parsed = parseJsonc(rawConfig);
    assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
    assert.equal(parsed.formatter, true);
    assert.ok(parsed.instructions.includes('docs/custom.md'));
    assert.ok(parsed.instructions.some((p) => p.endsWith('.bionic/SYSTEM_PROMPT.md')));
    // USER_INSTRUCTIONS.md is embedded inside SYSTEM_PROMPT.md — must NOT be double-registered
    assert.equal(
      parsed.instructions.some((p) => p.endsWith('.bionic/USER_INSTRUCTIONS.md')),
      false
    );

    // Explicit .env* read-deny rule present
    assert.ok(
      parsed.permissions.some((r) => r.action === 'read' && r.resource === '*.env*' && r.effect === 'deny')
    );

    // User AGENTS.md untouched
    assert.equal(fs.readFileSync(agentsMdPath, 'utf-8'), '# User Custom Rules\n- Keep my rules intact\n');

    // System prompt includes Markdown-first rules, 5-section Plan Format, plans/ >3 rule, tests/scientific, DVC, and custom root file
    const sysPrompt = fs.readFileSync(res.systemPromptPath, 'utf-8');
    assert.ok(sysPrompt.includes('PLAN.md'));
    assert.ok(sysPrompt.includes('more than 3 Markdown'));
    assert.ok(sysPrompt.includes('plans/'));
    assert.ok(sysPrompt.includes('Research Question'));
    assert.ok(sysPrompt.includes('Data Sourcing'));
    assert.ok(sysPrompt.includes('Data Processing'));
    assert.ok(sysPrompt.includes('Data Display'));
    assert.ok(sysPrompt.includes('tests/scientific/'));
    assert.ok(sysPrompt.includes('panel_X_results.json'));
    assert.ok(sysPrompt.includes('data/manifest.json'));
    assert.ok(sysPrompt.includes('Prefer Okabe-Ito palettes'));

    // Calling again is idempotent (no duplicate instructions or permissions)
    ensureOpenCodeWorkspaceConfig();
    const parsedAgain = parseJsonc(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(
      parsedAgain.instructions.filter((p) => p.endsWith('.bionic/SYSTEM_PROMPT.md')).length,
      1
    );
  });

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
