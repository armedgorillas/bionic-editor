import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OLLAMA_BASE_URL, WORKSPACE_DIR } from '../config.js';
import { readFileContent, writeFileContent, getFileTree, resolveSafePath } from './workspace.js';
import { runPythonScript, runBashCommand } from './venv.js';

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
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface StepEvent {
  type: 'step_start' | 'step_progress' | 'step_done' | 'thought' | 'text_delta' | 'final' | 'error';
  title?: string;
  description?: string;
  details?: string;
  delta?: string;
  status?: 'running' | 'done' | 'error';
  tokens?: TokenUsage;
}

const SYSTEM_PROMPT = `You are Bionic Editor's Scientific AI Agent—a powerful, transparent coding harness designed for analytical scientists and biologists.
You collaborate with researchers who understand biology and experimental design, but need your software engineering capabilities to write, execute, inspect, and debug reproducible pipelines.

HOW YOU OPERATE AS A CODING HARNESS:
1. Always state your reasoning and plan clearly before and during tool use. Explain what hypothesis you are testing, which file you are inspecting, and why you are running a command.
2. When executing bash or Python scripts, inspect stdout and stderr carefully. If any error, syntax issue, or non-zero exit code occurs, analyze the traceback thoroughly, explain what went wrong, and take corrective action (such as fixing syntax, installing dependencies, or fixing data file paths).
3. Be transparent and rigorous: show your computational logic so the scientist can audit and verify the work.
4. When refining the experimental protocol, modify SPEC.md directly.
5. When writing Python code, place reproducible scripts in src/ and run them using the isolated virtual environment.
6. Always save processed datasets to data/processed/ and interactive HTML reports to web-report/index.html.`;

const TOOLS_SCHEMA_OPENAI: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the text content of a file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to file, e.g. SPEC.md or src/analyze.py' }
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
          path: { type: 'string', description: 'Relative path to file, e.g. SPEC.md or web-report/index.html' },
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
          script_path: { type: 'string', description: 'Relative path to script, e.g. src/analyze.py' },
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
        const items = getFileTree(dir ? resolveSafePath(dir) : WORKSPACE_DIR, dir);
        return {
          output: JSON.stringify(items.map(i => ({ name: i.name, path: i.path, isDir: i.isDirectory })), null, 2),
          isError: false
        };
      }
      case 'run_python': {
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
  // Pricing estimate per 1M tokens
  let inputRate = 2.50; // $2.50 per 1M default
  let outputRate = 10.00; // $10 per 1M default

  if (model.includes('flash')) {
    // Gemini Flash: $0.075 / 1M prompt, $0.30 / 1M completion
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

export async function runAgentConversation(
  messages: AgentMessage[],
  config: AgentConfig,
  onEvent: (event: StepEvent) => void
): Promise<{ text: string; tokens: TokenUsage }> {
  if (config.provider === 'demo') {
    return handleDemoAgent(messages, onEvent);
  }

  if (config.provider === 'gemini') {
    const key = config.apiKey || GEMINI_API_KEY;
    if (!key) {
      throw new Error(
        'Google Gemini API key required. Please click the ⚙ Settings icon in the top right of the Agent panel and enter your Gemini API key.'
      );
    }
    return handleGeminiAgent(messages, config, onEvent);
  }

  if (config.provider === 'openai') {
    const key = config.apiKey || OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        'OpenAI API key required. Please click the ⚙ Settings icon in the top right of the Agent panel and enter your OpenAI API key.'
      );
    }
    return handleOpenAIAgent(messages, config, onEvent);
  }

  if (config.provider === 'anthropic') {
    const key = config.apiKey || ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        'Anthropic API key required. Please click the ⚙ Settings icon in the top right of the Agent panel and enter your Anthropic API key.'
      );
    }
    return handleAnthropicAgent(messages, config, onEvent);
  }

  if (config.provider === 'ollama') {
    return handleOpenAIAgent(messages, config, onEvent);
  }

  return handleDemoAgent(messages, onEvent);
}

// Built-in Demo / Offline Agent for testing without requiring external API keys
async function handleDemoAgent(
  messages: AgentMessage[],
  onEvent: (event: StepEvent) => void
): Promise<{ text: string; tokens: TokenUsage }> {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const lower = lastUserMsg.toLowerCase();

  let tokens: TokenUsage = {
    promptTokens: 450,
    completionTokens: 210,
    totalTokens: 660,
    estimatedCostUsd: 0.0032
  };

  if (lower.includes('run') || lower.includes('analyze') || lower.includes('script') || lower.includes('pipeline')) {
    onEvent({
      type: 'step_start',
      title: 'Reading Analysis Script',
      description: 'Inspecting src/analyze.py and verifying data files...'
    });
    await new Promise(r => setTimeout(r, 600));

    const toolResult = await executeTool('run_python', { script_path: 'src/analyze.py' });
    onEvent({
      type: 'step_done',
      title: 'Executed Python Analysis',
      description: 'Successfully ran src/analyze.py inside isolated virtual environment.',
      details: toolResult
    });

    const reply = `I have executed the scientific analysis pipeline (\`src/analyze.py\`) within your project's virtual environment.\n\n` +
      `**Summary of actions:**\n` +
      `- Loaded gene expression data from \`data/raw/gene_expression_sample.csv\`\n` +
      `- Calculated control and treatment replicate means\n` +
      `- Computed Log2 Fold Changes across all biomarker candidates\n` +
      `- Stored results in \`data/processed/deg_results.csv\`\n\n` +
      `You can inspect the generated table in the file explorer, or preview the interactive visual dashboard in the **Web Report** tab.`;

    onEvent({ type: 'final', delta: reply, tokens });
    return { text: reply, tokens };
  }

  if (lower.includes('spec') || lower.includes('plan') || lower.includes('hypothesis') || lower.includes('update')) {
    onEvent({
      type: 'step_start',
      title: 'Reading Experiment Plan',
      description: 'Checking SPEC.md for existing hypotheses and objectives...'
    });
    await new Promise(r => setTimeout(r, 500));

    onEvent({
      type: 'step_progress',
      title: 'Fleshing out Analysis Plan',
      description: 'Adding statistical validation parameters and QC checkpoints...'
    });
    await new Promise(r => setTimeout(r, 600));

    onEvent({
      type: 'step_done',
      title: 'Plan Updated',
      description: 'Updated SPEC.md with refined hypotheses and methodology.'
    });

    const reply = `I have reviewed and refined your scientific specification in \`SPEC.md\`.\n\n` +
      `**Key additions:**\n` +
      `- Added specific statistical thresholding criteria (Benjamini-Hochberg FDR < 0.05, |Log2FC| > 1.0)\n` +
      `- Defined quality control steps for replicate variance\n` +
      `- Scheduled automated visual synthesis into \`web-report/index.html\`\n\n` +
      `Take a look at the editor on your left to review the plan. Let me know if you would like me to proceed with running the analysis!`;

    onEvent({ type: 'final', delta: reply, tokens });
    return { text: reply, tokens };
  }

  // General scientific assistant response
  onEvent({
    type: 'step_start',
    title: 'Scanning Workspace',
    description: 'Scanning project files and virtual environment status...'
  });
  await new Promise(r => setTimeout(r, 500));

  const files = getFileTree(WORKSPACE_DIR);
  onEvent({
    type: 'step_done',
    title: 'Workspace Ready',
    description: `Found ${files.length} top-level directories/files ready for analysis.`
  });

  const reply = `Hello! I am your Bionic Editor Scientific Assistant.\n\n` +
    `I can help you:\n` +
    `1. **Draft & Refine Plans**: Write or edit hypotheses in \`SPEC.md\`.\n` +
    `2. **Analyze Data**: Run Python analyses on datasets in \`data/raw/\` using your isolated virtual environment.\n` +
    `3. **Generate Reports**: Build interactive charts and summaries viewable in the **Web Report** panel.\n\n` +
    `How would you like to start? For example, you can ask me to *"Analyze the gene expression sample"* or *"Flesh out the SPEC.md plan"*!`;

  onEvent({ type: 'final', delta: reply, tokens });
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

  const conversation: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
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
  const MAX_TURNS = 25;

  while (turns < MAX_TURNS) {
    turns++;
    const response = await client.chat.completions.create({
      model,
      messages: conversation,
      tools: TOOLS_SCHEMA_OPENAI,
      tool_choice: 'auto'
    });

    const choice = response.choices[0];
    const usage = response.usage;
    if (usage) {
      promptTokens += usage.prompt_tokens;
      completionTokens += usage.completion_tokens;
    }

    const currentUsage: TokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCostUsd: estimateCost(promptTokens, completionTokens, model)
    };

    // If the model produced thought/reasoning text before tool calls, emit it live
    const thoughtText = choice.message.content;
    if (thoughtText && thoughtText.trim()) {
      onEvent({
        type: 'thought',
        delta: thoughtText.trim()
      });
    }

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      conversation.push(choice.message);

      for (const tc of choice.message.tool_calls) {
        if (tc.type !== 'function') continue;
        const fnName = tc.function.name;
        let fnArgs: any = {};
        try {
          fnArgs = JSON.parse(tc.function.arguments);
        } catch {
          fnArgs = {};
        }

        // Generate clean, developer-harness style titles and descriptions
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
          details: result.output, // Full unabridged output, NO truncation!
          status: result.isError ? 'error' : 'done'
        });

        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.output
        });
      }
    } else {
      finalText = choice.message.content || '';
      onEvent({
        type: 'final',
        delta: finalText,
        tokens: currentUsage
      });
      break;
    }
  }

  if (!finalText) {
    finalText = 'Completed task steps (reached 25 turn limit). You can prompt me to continue with further analysis if needed.';
    onEvent({
      type: 'final',
      delta: finalText,
      tokens: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimatedCostUsd: estimateCost(promptTokens, completionTokens, model)
      }
    });
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

  // Google Gemini OpenAI-compatible official endpoint
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

  const tools: Anthropic.Tool[] = TOOLS_SCHEMA_OPENAI.map((t: any) => ({
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

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: anthropicMessages,
    tools
  });

  promptTokens += response.usage.input_tokens;
  completionTokens += response.usage.output_tokens;

  let textOutput = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      textOutput += block.text;
      onEvent({
        type: 'thought',
        delta: block.text
      });
    } else if (block.type === 'tool_use') {
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

      const res = await executeToolDetailed(toolName, input);

      onEvent({
        type: 'step_done',
        title,
        description: res.isError ? 'Execution failed' : 'Execution completed',
        details: res.output,
        status: res.isError ? 'error' : 'done'
      });
    }
  }

  const tokens: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedCostUsd: estimateCost(promptTokens, completionTokens, model)
  };

  onEvent({
    type: 'final',
    delta: textOutput,
    tokens
  });

  return { text: textOutput, tokens };
}
