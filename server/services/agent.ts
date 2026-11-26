import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  GEMINI_API_KEY,
  OLLAMA_BASE_URL,
  WORKSPACE_DIR,
  BIONIC_HUB_MODE,
  BIONIC_SANDBOX_MODE,
  BIONIC_SHIM_URL,
  BIONIC_LOCAL_SHIM_TOKEN
} from '../config.js';
import { readFileContent, writeFileContent, getFileTree, resolveSafePath } from './workspace.js';
import { runPythonScript, runBashCommand } from './venv.js';
import { getProjectRootFile } from './workspaceConfig.js';
import { buildBionicInstructions } from './agentPrompt.js';
import { opencodeServer, type SubagentJobView } from './opencodeServer.js';

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: any[];
  toolCallId?: string;
}

export interface AgentConfig {
  provider: 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'demo';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  sessionId?: string;
  maxTurns?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface StepEvent {
  type:
    | 'step_start'
    | 'step_progress'
    | 'step_done'
    | 'thought'
    | 'text_delta'
    | 'subagent_updated'
    | 'background_turn_start'
    | 'final'
    | 'error';
  title?: string;
  description?: string;
  details?: string;
  delta?: string;
  status?: 'running' | 'done' | 'error';
  tokens?: TokenUsage;
  job?: SubagentJobView;
}

const cancelledSessions = new Set<string>();

export function cancelAgentSession(sessionId: string): void {
  cancelledSessions.add(sessionId);
  opencodeServer.interruptSession(sessionId).catch(() => {});
}

export function clearSessionCancellation(sessionId: string): void {
  cancelledSessions.delete(sessionId);
}

export function isSessionCancelled(sessionId: string): boolean {
  return cancelledSessions.has(sessionId);
}

function getToolsSchemaOpenAI(rootFile: string): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the text content of a file in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: `Relative path to file, e.g. ${rootFile} or code/analyze.py` }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write or overwrite text content to a file in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: `Relative path to file, e.g. ${rootFile} or web-report/index.html` },
            content: { type: 'string', description: 'Full text content to write' }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files and directories in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            directory: { type: 'string', description: 'Optional relative directory path, defaults to workspace root' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_python',
        description: 'Execute a Python script using the project virtual environment.',
        parameters: {
          type: 'object',
          properties: {
            script_path: { type: 'string', description: 'Relative path to script, e.g. code/analyze.py' },
            args: { type: 'array', items: { type: 'string' }, description: 'Optional command line arguments' }
          },
          required: ['script_path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a shell command in the project directory using the virtual environment.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command, e.g. pip list or python -c "..."' }
          },
          required: ['command']
        }
      }
    }
  ];
}

export interface DetailedToolResult {
  output: string;
  isError: boolean;
  exitCode?: number;
}

export async function executeTool(name: string, args: any, sessionId?: string): Promise<string> {
  const res = await executeToolDetailed(name, args, sessionId);
  return res.output;
}

export async function executeToolDetailed(name: string, args: any, sessionId?: string): Promise<DetailedToolResult> {
  try {
    switch (name) {
      case 'read_file': {
        const file = readFileContent(args.path);
        const text = file.isBinary ? `[Binary file, size: ${file.size} bytes]` : file.content;
        return { output: text, isError: false };
      }
      case 'write_file': {
        writeFileContent(args.path, args.content);
        return {
          output: `Successfully wrote ${args.content?.length || 0} characters to ${args.path}`,
          isError: false
        };
      }
      case 'list_files': {
        const dir = args.directory || '';
        const items = getFileTree(dir ? resolveSafePath(dir) : WORKSPACE_DIR, dir, { includeDotItems: false });
        return {
          output: JSON.stringify(items.map(i => ({ name: i.name, path: i.path, isDir: i.isDirectory })), null, 2),
          isError: false
        };
      }
      case 'run_python': {
        if (BIONIC_SANDBOX_MODE) {
          return { output: 'Code execution is disabled in Bionic Sandbox Mode.', isError: true };
        }
        const res = await runPythonScript(args.script_path, args.args || [], undefined, sessionId);
        const output = [
          `Exit code: ${res.code}`,
          res.stdout ? `\n--- STDOUT ---\n${res.stdout}` : '',
          res.stderr ? `\n--- STDERR ---\n${res.stderr}` : ''
        ].filter(Boolean).join('');
        return {
          output: output.trim(),
          isError: res.code !== 0,
          exitCode: res.code
        };
      }
      case 'run_command': {
        if (BIONIC_SANDBOX_MODE) {
          return { output: 'Shell execution is disabled in Bionic Sandbox Mode.', isError: true };
        }
        const res = await runBashCommand(args.command, undefined, sessionId);
        const output = [
          `Exit code: ${res.code}`,
          res.stdout ? `\n--- STDOUT ---\n${res.stdout}` : '',
          res.stderr ? `\n--- STDERR ---\n${res.stderr}` : ''
        ].filter(Boolean).join('');
        return {
          output: output.trim(),
          isError: res.code !== 0,
          exitCode: res.code
        };
      }
      default:
        return { output: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err: any) {
    return { output: `Tool execution error: ${err.message}`, isError: true };
  }
}

export function estimateCost(promptTokens: number, completionTokens: number, model: string = 'gpt-4o'): number {
  let inputRate = 2.50;
  let outputRate = 10.00;

  if (model.includes('flash')) {
    inputRate = 0.075;
    outputRate = 0.30;
  } else if (model.includes('gemini') && model.includes('pro')) {
    inputRate = 1.25;
    outputRate = 5.00;
  } else if (model.includes('mini') || model.includes('haiku')) {
    inputRate = 0.15;
    outputRate = 0.60;
  }
  return (promptTokens / 1_000_000) * inputRate + (completionTokens / 1_000_000) * outputRate;
}

export function getOpenCodeBinary(): string | null {
  if (process.env.OPENCODE_BIN && fs.existsSync(process.env.OPENCODE_BIN)) {
    return process.env.OPENCODE_BIN;
  }
  const homeBin = path.join(os.homedir(), '.opencode', 'bin', 'opencode');
  if (fs.existsSync(homeBin)) {
    return homeBin;
  }
  try {
    const which = execSync('which opencode', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (which && fs.existsSync(which)) return which;
  } catch {}

  for (const candidate of ['/usr/local/bin/opencode', '/usr/bin/opencode', '/bin/opencode']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export async function runOpenCodeAgent(
  messages: AgentMessage[],
  config: AgentConfig,
  onEvent: (event: StepEvent) => void
): Promise<{ text: string; tokens: TokenUsage }> {
  const opencodeBin = getOpenCodeBinary();
  if (!opencodeBin) {
    throw new Error('OpenCode executable not found. Please install OpenCode (https://opencode.ai).');
  }

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  if (!lastUserMsg.trim()) {
    return { text: 'No message provided.', tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 } };
  }

  const bionicSessionId = config.sessionId || `bionic_${Date.now()}`;
  return opencodeServer.promptSession(opencodeBin, bionicSessionId, lastUserMsg, config, onEvent);
}

export async function runAgentConversation(
  messages: AgentMessage[],
  config: AgentConfig,
  onEvent: (event: StepEvent) => void
): Promise<{ text: string; tokens: TokenUsage }> {
  if (config.sessionId) {
    clearSessionCancellation(config.sessionId);
  }

  try {
    // In Hub Mode, never honor client-supplied apiKey or baseUrl overrides
    const effectiveConfig: AgentConfig = BIONIC_HUB_MODE
      ? { ...config, apiKey: undefined, baseUrl: undefined }
      : config;

    if (effectiveConfig.provider === 'demo') {
      return await handleDemoAgent(messages, onEvent);
    }

    // Security H7: Never launch OpenCode subprocesses in public sandbox mode
    const opencodeBin = BIONIC_SANDBOX_MODE ? null : getOpenCodeBinary();
    if (opencodeBin && process.env.USE_OPENCODE !== 'false') {
      return await runOpenCodeAgent(messages, effectiveConfig, onEvent);
    }

    // In Hub Mode fallback (when OpenCode isn't installed), route through bionic-daemon localhost shim
    if (BIONIC_HUB_MODE) {
      const shimClient = new OpenAI({
        apiKey: BIONIC_LOCAL_SHIM_TOKEN || 'hub-shim',
        baseURL: `${BIONIC_SHIM_URL}/llm/openai/v1`
      });
      return await runOpenAILoop(shimClient, effectiveConfig.model || 'default', messages, effectiveConfig, onEvent);
    }

    if (effectiveConfig.provider === 'gemini') {
      const key = effectiveConfig.apiKey || GEMINI_API_KEY;
      if (!key) {
        throw new Error(
          'Google Gemini API key required. Please click the ⚙ Settings icon in the top right of the Agent panel and enter your Gemini API key.'
        );
      }
      return await handleGeminiAgent(messages, effectiveConfig, onEvent);
    }

    if (effectiveConfig.provider === 'openai') {
      const key = effectiveConfig.apiKey || OPENAI_API_KEY;
      if (!key) {
        throw new Error(
          'OpenAI API key required. Please click the ⚙ Settings icon in the top right of the Agent panel and enter your OpenAI API key.'
        );
      }
      return await handleOpenAIAgent(messages, effectiveConfig, onEvent);
    }

    if (effectiveConfig.provider === 'anthropic') {
      const key = effectiveConfig.apiKey || ANTHROPIC_API_KEY;
      if (!key) {
        throw new Error(
          'Anthropic API key required. Please click the ⚙ Settings icon in the top right of the Agent panel and enter your Anthropic API key.'
        );
      }
      return await handleAnthropicAgent(messages, effectiveConfig, onEvent);
    }

    if (effectiveConfig.provider === 'ollama') {
      return await handleOpenAIAgent(messages, effectiveConfig, onEvent);
    }

    return await handleDemoAgent(messages, onEvent);
  } finally {
    if (config.sessionId) {
      clearSessionCancellation(config.sessionId);
    }
  }
}

// Built-in Demo / Offline Agent for testing without requiring external API keys
async function handleDemoAgent(
  messages: AgentMessage[],
  onEvent: (event: StepEvent) => void
): Promise<{ text: string; tokens: TokenUsage }> {
  const rootFile = getProjectRootFile();
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const lower = lastUserMsg.toLowerCase();

  const tokens: TokenUsage = {
    promptTokens: 450,
    completionTokens: 210,
    totalTokens: 660,
    estimatedCostUsd: 0.0032
  };

  if (lower.includes('run') || lower.includes('analyze') || lower.includes('script') || lower.includes('pipeline')) {
    const candidateScript = ['code/analyze.py', 'src/analyze.py'].find((p) =>
      fs.existsSync(path.join(WORKSPACE_DIR, p))
    );

    onEvent({
      type: 'step_start',
      title: candidateScript ? `Inspecting ${candidateScript}` : 'Checking workspace scripts',
      description: candidateScript
        ? `Checking ${candidateScript} and data files...`
        : 'Scanning code/ and data/raw/ for analysis scripts...'
    });
    await new Promise(r => setTimeout(r, 300));

    if (candidateScript) {
      // Security H7: Never execute workspace Python scripts in public sandbox mode
      if (BIONIC_SANDBOX_MODE) {
        onEvent({
          type: 'step_done',
          title: `Inspected ${candidateScript} (Sandbox Mode)`,
          description: 'Code execution is disabled in the public interactive sandbox. Showing pre-computed results instead.'
        });
        const reply =
          `- Inspected \`${candidateScript}\` (live code execution is disabled in the public sandbox).\n` +
          `- Explore the pre-computed interactive dashboard in **Web Report** (\`web-report/index.html\`) and scientific test results in \`tests/scientific/\`.\n` +
          `- Sign in to Bionic Hub with an authorized account to run live analyses on dedicated cloud VMs.`;
        return { text: reply, tokens };
      }

      const toolResult = await executeTool('run_python', { script_path: candidateScript });
      onEvent({
        type: 'step_done',
        title: `Executed ${candidateScript}`,
        description: `Ran ${candidateScript} inside isolated virtual environment.`,
        details: toolResult
      });

      const reply = `- Ran \`${candidateScript}\` inside \`.venv\`.\n` +
        `- Review outputs in \`data/processed/\` and your publication in **Web Report** (\`web-report/index.html\`).\n` +
        `- Document key takeaways in \`${rootFile}\` or \`RESULTS.md\`.`;

      return { text: reply, tokens };
    }

    onEvent({
      type: 'step_done',
      title: 'Workspace Ready for Pipeline',
      description: 'No analysis script found in code/ yet.'
    });

    const reply = `- No analysis script exists in \`code/\` yet.\n` +
      `- Upload raw datasets into \`data/raw/\` (tracked in **Data Provenance** / \`data/DATA_MANIFEST.md\`) and outline your plan in \`${rootFile}\`.\n` +
      `- Connect a live AI model in Settings to generate scripts in \`code/\` and scientific tests in \`tests/scientific/\`.`;

    return { text: reply, tokens };
  }

  if (lower.includes('spec') || lower.includes('plan') || lower.includes('hypothesis') || lower.includes('update')) {
    onEvent({
      type: 'step_start',
      title: `Reading ${rootFile}`,
      description: `Checking ${rootFile} for Research Question, Data Sourcing, Processing, Display, and Tests...`
    });
    await new Promise(r => setTimeout(r, 300));

    onEvent({
      type: 'step_done',
      title: 'Plan Checked',
      description: `Reviewed ${rootFile} against the 5-section scientific plan format.`
    });

    const reply = `- Reviewed \`${rootFile}\`.\n` +
      `- Organize sections under **Research Question**, **Data Sourcing**, **Data Processing**, **Data Display**, and **Tests** (\`tests/scientific/\`).\n` +
      `- If you add more than 3 Markdown files in the root folder, consider moving additional plans into \`plans/\`.`;

    return { text: reply, tokens };
  }

  onEvent({
    type: 'step_start',
    title: 'Scanning Workspace',
    description: 'Scanning project files and virtual environment status...'
  });
  await new Promise(r => setTimeout(r, 250));

  const files = getFileTree(WORKSPACE_DIR);
  onEvent({
    type: 'step_done',
    title: 'Workspace Ready',
    description: `Found ${files.length} top-level entries ready for analysis.`
  });

  const reply = `- Workspace scanned (${files.length} top-level items).\n` +
    `- Manage your analysis plan in \`${rootFile}\` (additional plans belong in \`plans/\`).\n` +
    `- Keep raw datasets in \`data/raw/\` (registered in \`data/DATA_MANIFEST.md\`) and scripts in \`code/\`.`;

  return { text: reply, tokens };
}

async function runOpenAILoop(
  client: OpenAI,
  model: string,
  messages: AgentMessage[],
  config: AgentConfig,
  onEvent: (event: StepEvent) => void
): Promise<{ text: string; tokens: TokenUsage }> {
  let promptTokens = 0;
  let completionTokens = 0;

  const rootFile = getProjectRootFile();
  const systemPrompt = buildBionicInstructions(rootFile);
  const toolsSchema = getToolsSchemaOpenAI(rootFile);

  const conversation: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.toolCallId || 'call_default'
        };
      }
      if (m.role === 'assistant' && m.toolCalls) {
        return {
          role: 'assistant' as const,
          content: m.content || null,
          tool_calls: m.toolCalls
        };
      }
      return {
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content
      };
    })
  ];

  let turns = 0;
  let finalText = '';
  const maxTurnsLimit = typeof config.maxTurns === 'number' && config.maxTurns > 0
    ? config.maxTurns
    : (process.env.MAX_TURNS ? parseInt(process.env.MAX_TURNS, 10) : Infinity);

  while (turns < maxTurnsLimit) {
    if (config.sessionId && isSessionCancelled(config.sessionId)) {
      finalText = 'Execution was cancelled.';
      break;
    }
    turns++;
    const response = await client.chat.completions.create({
      model,
      messages: conversation,
      tools: toolsSchema,
      tool_choice: 'auto'
    });

    const choice = response.choices[0];
    const usage = response.usage;
    if (usage) {
      promptTokens += usage.prompt_tokens;
      completionTokens += usage.completion_tokens;
    }

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      const thoughtText = choice.message.content;
      if (thoughtText && thoughtText.trim()) {
        onEvent({
          type: 'thought',
          delta: thoughtText.trim()
        });
      }

      conversation.push(choice.message);

      let wasCancelled = false;
      for (const tc of choice.message.tool_calls) {
        if (config.sessionId && isSessionCancelled(config.sessionId)) {
          finalText = 'Execution was cancelled.';
          wasCancelled = true;
          break;
        }

        if (tc.type !== 'function') continue;
        const fnName = tc.function.name;
        let fnArgs: any = {};
        try {
          fnArgs = JSON.parse(tc.function.arguments);
        } catch {
          fnArgs = {};
        }

        let title = fnName;
        let desc = 'Executing action...';

        if (fnName === 'run_command') {
          title = `$ ${fnArgs.command || 'bash'}`;
          desc = 'Running shell command in .venv';
        } else if (fnName === 'run_python') {
          title = `python ${fnArgs.script_path || ''}${fnArgs.args ? ' ' + fnArgs.args.join(' ') : ''}`;
          desc = 'Executing Python script in .venv';
        } else if (fnName === 'read_file') {
          title = `read ${fnArgs.path || ''}`;
          desc = 'Inspecting workspace file';
        } else if (fnName === 'write_file') {
          title = `write ${fnArgs.path || ''}`;
          desc = `Writing ${fnArgs.content ? fnArgs.content.length : 0} bytes to ${fnArgs.path || ''}`;
        } else if (fnName === 'list_files') {
          title = `ls ${fnArgs.directory || '.'}`;
          desc = 'Listing workspace directory';
        }

        onEvent({
          type: 'step_start',
          title,
          description: desc,
          status: 'running'
        });

        const result = await executeToolDetailed(fnName, fnArgs, config.sessionId);

        onEvent({
          type: 'step_done',
          title,
          description: result.isError
            ? `Failed (Exit code ${result.exitCode ?? 1})`
            : 'Execution completed',
          details: result.output,
          status: result.isError ? 'error' : 'done'
        });

        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.output
        });

        if (config.sessionId && isSessionCancelled(config.sessionId)) {
          finalText = 'Execution was cancelled.';
          wasCancelled = true;
          break;
        }
      }

      if (wasCancelled) {
        break;
      }
    } else {
      finalText = choice.message.content || '';
      break;
    }
  }

  if (!finalText) {
    finalText = turns >= maxTurnsLimit
      ? `Completed task steps (reached ${maxTurnsLimit} turn limit). You can prompt me to continue with further analysis if needed.`
      : 'Task completed.';
  }

  const finalUsage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedCostUsd: estimateCost(promptTokens, completionTokens, model)
  };

  return { text: finalText, tokens: finalUsage };
}

async function handleOpenAIAgent(
  messages: AgentMessage[],
  config: AgentConfig,
  onEvent: (event: StepEvent) => void
): Promise<{ text: string; tokens: TokenUsage }> {
  const apiKey = config.apiKey || OPENAI_API_KEY || 'ollama';
  const baseURL = config.provider === 'ollama' ? (config.baseUrl || OLLAMA_BASE_URL) : undefined;
  const model = config.model || (config.provider === 'ollama' ? 'llama3' : 'gpt-4o');

  const client = new OpenAI({
    apiKey,
    baseURL
  });

  return runOpenAILoop(client, model, messages, config, onEvent);
}

async function handleGeminiAgent(
  messages: AgentMessage[],
  config: AgentConfig,
  onEvent: (event: StepEvent) => void
): Promise<{ text: string; tokens: TokenUsage }> {
  const apiKey = config.apiKey || GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini API key is not configured. Please enter your Gemini API key in settings.');
  }

  const baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
  const model = config.model || 'gemini-2.5-flash';

  const client = new OpenAI({
    apiKey,
    baseURL
  });

  return runOpenAILoop(client, model, messages, config, onEvent);
}

async function handleAnthropicAgent(
  messages: AgentMessage[],
  config: AgentConfig,
  onEvent: (event: StepEvent) => void
): Promise<{ text: string; tokens: TokenUsage }> {
  const apiKey = config.apiKey || ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Anthropic API key is not configured.');
  }

  const client = new Anthropic({ apiKey });
  const model = config.model || 'claude-3-5-sonnet-20241022';
  const rootFile = getProjectRootFile();
  const systemPrompt = buildBionicInstructions(rootFile);
  const toolsSchema = getToolsSchemaOpenAI(rootFile);

  const tools: Anthropic.Tool[] = toolsSchema.map((t: any) => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters as Anthropic.Tool.InputSchema
  }));

  const anthropicMessages: Anthropic.MessageParam[] = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

  let promptTokens = 0;
  let completionTokens = 0;
  let finalText = '';
  const maxTurnsLimit = typeof config.maxTurns === 'number' && config.maxTurns > 0
    ? config.maxTurns
    : (process.env.MAX_TURNS ? parseInt(process.env.MAX_TURNS, 10) : 25);

  for (let turn = 0; turn < maxTurnsLimit; turn++) {
    if (config.sessionId && isSessionCancelled(config.sessionId)) {
      finalText = 'Execution was cancelled.';
      break;
    }

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: anthropicMessages,
      tools
    });

    promptTokens += response.usage.input_tokens;
    completionTokens += response.usage.output_tokens;

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const turnText = textBlocks.map(b => b.text).join('\n').trim();

    if (toolUses.length === 0) {
      finalText = turnText;
      break;
    }

    if (turnText) {
      onEvent({ type: 'thought', delta: turnText });
    }

    anthropicMessages.push({
      role: 'assistant',
      content: response.content
    });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      if (config.sessionId && isSessionCancelled(config.sessionId)) {
        finalText = 'Execution was cancelled.';
        break;
      }
      const toolName = block.name;
      const input = block.input as any;
      let title = toolName;
      if (toolName === 'run_command') title = `$ ${input?.command || 'bash'}`;
      else if (toolName === 'run_python') title = `python ${input?.script_path || ''}`;
      else if (toolName === 'read_file') title = `read ${input?.path || ''}`;
      else if (toolName === 'write_file') title = `write ${input?.path || ''}`;

      onEvent({
        type: 'step_start',
        title,
        description: `Executing ${toolName}...`,
        status: 'running'
      });

      const res = await executeToolDetailed(toolName, input, config.sessionId);

      onEvent({
        type: 'step_done',
        title,
        description: res.isError ? 'Execution failed' : 'Execution completed',
        details: res.output,
        status: res.isError ? 'error' : 'done'
      });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: res.output,
        is_error: res.isError
      });
    }

    if (config.sessionId && isSessionCancelled(config.sessionId)) {
      break;
    }

    anthropicMessages.push({
      role: 'user',
      content: toolResults
    });
  }

  const tokens: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedCostUsd: estimateCost(promptTokens, completionTokens, model)
  };

  return { text: finalText || 'Task completed.', tokens };
}
