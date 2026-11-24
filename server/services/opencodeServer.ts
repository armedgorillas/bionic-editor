import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn, ChildProcess } from 'child_process';
import {
  WORKSPACE_DIR,
  PORT,
  BASE_URL,
  GEMINI_API_KEY,
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  getTargetSpawnOptions
} from '../config.js';
import { atomicWriteFileSync } from './fsSafe.js';
import { ensureOpenCodeWorkspaceConfig } from './opencodeConfig.js';
import { getSession, saveSession } from './sessionManager.js';
import type { AgentConfig, StepEvent, TokenUsage } from './agent.js';

export interface SubagentJobView {
  jobId: string;
  sessionId: string; // Bionic session ID
  parentOpenCodeSessionId: string;
  childSessionId: string;
  agent: string;
  description: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  startedAt: number;
  completedAt?: number;
}

export type BridgeBroadcastPayload =
  | { type: 'subagent_updated'; sessionId: string; job: SubagentJobView }
  | { type: 'agent_event'; sessionId: string; event: StepEvent };

export type BroadcastFn = (payload: BridgeBroadcastPayload) => void;

interface ActiveTurnState {
  bionicSessionId: string;
  opencodeSessionId: string;
  isBackground: boolean;
  accumulatedText: string;
  accumulatedThought: string;
  lastAssistantMsgId: string | null;
  hadToolSinceLastText: boolean;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  toolNames: Map<string, { name: string; input: any; title: string; desc: string }>;
  onEvent?: (event: StepEvent) => void;
  resolve?: (result: { text: string; tokens: TokenUsage }) => void;
  reject?: (err: Error) => void;
  timelineForPersist: any[];
}

const SESSION_MAP_REL_PATH = '.bionic/opencode-sessions.json';

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function getBionicApiUrl(): string {
  return `http://127.0.0.1:${PORT}${BASE_URL}/api`;
}

function formatToolMeta(name: string, input: any): { title: string; desc: string } {
  const safeInput = input && typeof input === 'object' ? input : {};
  if (name === 'read') return { title: `read ${safeInput.path || ''}`, desc: 'Inspected workspace file' };
  if (name === 'edit') return { title: `edit ${safeInput.path || ''}`, desc: 'Updated file' };
  if (name === 'write') return { title: `write ${safeInput.path || ''}`, desc: 'Wrote file content' };
  if (name === 'shell' || name === 'bash' || name === 'terminal') {
    return { title: `$ ${safeInput.command || ''}`, desc: 'Executed command in .venv' };
  }
  if (name === 'glob') return { title: `glob ${safeInput.pattern || ''}`, desc: 'Scanned files' };
  if (name === 'grep') return { title: `grep "${safeInput.pattern || ''}"`, desc: 'Searched pattern' };
  if (name === 'subagent') {
    return {
      title: `subagent (${safeInput.agent || 'general'}): ${safeInput.description || 'Background task'}`,
      desc: 'Launched background subagent'
    };
  }
  return { title: name, desc: 'Executed tool' };
}

function extractToolOutputText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return JSON.stringify(part);
      })
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content, null, 2);
  }
  return '';
}

function parseModelRef(provider: string, model?: string): { providerID: string; id: string } | undefined {
  const raw = model?.trim() || '';
  if (!raw) {
    if (provider === 'gemini') return { providerID: 'google', id: 'gemini-2.5-flash' };
    if (provider === 'openai') return { providerID: 'openai', id: 'gpt-4o' };
    if (provider === 'anthropic') return { providerID: 'anthropic', id: 'claude-3-5-sonnet-20241022' };
    if (provider === 'ollama') return { providerID: 'ollama', id: 'llama3' };
    return undefined;
  }
  if (raw.includes('/')) {
    const [providerID, ...rest] = raw.split('/');
    return { providerID, id: rest.join('/') };
  }
  const providerID = provider === 'gemini' ? 'google' : provider;
  return { providerID, id: raw };
}

function mapProviderToIntegration(provider: string): string | null {
  if (provider === 'gemini' || provider === 'google') return 'google';
  if (provider === 'openai') return 'openai';
  if (provider === 'anthropic') return 'anthropic';
  return null;
}

export class OpenCodeServerBridge {
  private proc: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private authHeader: string | null = null;
  private startPromise: Promise<void> | null = null;
  private sseAbort: AbortController | null = null;
  private broadcastFn: BroadcastFn | null = null;
  private isShuttingDown = false;
  private syncedCredentials = new Map<string, string>();

  // Bidirectional session mapping
  private bionicToOpenCode = new Map<string, string>();
  private openCodeToBionic = new Map<string, string>();

  // Active turns keyed by OpenCode sessionID
  private activeTurns = new Map<string, ActiveTurnState>();
  // Tracked subagent jobs keyed by jobId
  private subagentJobs = new Map<string, SubagentJobView>();

  constructor() {
    this.loadSessionMap();
  }

  public setBroadcast(fn: BroadcastFn): void {
    this.broadcastFn = fn;
  }

  public registerSessionMapping(bionicSessionId: string, opencodeSessionId: string): void {
    this.bionicToOpenCode.set(bionicSessionId, opencodeSessionId);
    this.openCodeToBionic.set(opencodeSessionId, bionicSessionId);
    this.persistSessionMap();
  }

  public getOpenCodeSessionId(bionicSessionId: string): string | undefined {
    return this.bionicToOpenCode.get(bionicSessionId);
  }

  public getTrackedSubagents(bionicSessionId?: string): SubagentJobView[] {
    const all = Array.from(this.subagentJobs.values());
    if (!bionicSessionId) return all.sort((a, b) => b.startedAt - a.startedAt);
    return all
      .filter((j) => j.sessionId === bionicSessionId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  private loadSessionMap(): void {
    try {
      const mapPath = path.join(WORKSPACE_DIR, SESSION_MAP_REL_PATH);
      if (!fs.existsSync(mapPath)) return;
      const raw = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
      if (raw && typeof raw === 'object') {
        for (const [bionicId, ocId] of Object.entries(raw)) {
          if (typeof ocId === 'string') {
            this.bionicToOpenCode.set(bionicId, ocId);
            this.openCodeToBionic.set(ocId, bionicId);
          }
        }
      }
    } catch {
      // ignore unreadable map
    }
  }

  private persistSessionMap(): void {
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.bionicToOpenCode.entries()) {
        obj[k] = v;
      }
      const mapPath = path.join(WORKSPACE_DIR, SESSION_MAP_REL_PATH);
      atomicWriteFileSync(mapPath, JSON.stringify(obj, null, 2) + '\n');
    } catch {
      // ignore if workspace not writable
    }
  }

  private getHeaders(): Record<string, string> {
    return {
      ...(this.authHeader ? { Authorization: this.authHeader } : {}),
      'Content-Type': 'application/json'
    };
  }

  private rejectAllPendingTurns(reason: string): void {
    for (const [ocId, turn] of this.activeTurns.entries()) {
      if (turn.reject) {
        turn.reject(new Error(reason));
      } else if (turn.isBackground && this.broadcastFn) {
        this.broadcastFn({
          type: 'agent_event',
          sessionId: turn.bionicSessionId,
          event: { type: 'error', description: reason }
        });
      }
      this.activeTurns.delete(ocId);
    }
  }

  public async ensureStarted(opencodeBin: string): Promise<void> {
    if (this.proc && this.baseUrl && this.authHeader && this.proc.exitCode === null) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.isShuttingDown = false;
    this.startPromise = this.startInternal(opencodeBin).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(opencodeBin: string): Promise<void> {
    const port = await findFreePort();
    const extraEnv: Record<string, string> = {
      BIONIC_API_URL: getBionicApiUrl(),
      PATH: `${path.join(WORKSPACE_DIR, '.venv', 'bin')}:${process.env.PATH || ''}`
    };
    if (GEMINI_API_KEY) {
      extraEnv.GEMINI_API_KEY = GEMINI_API_KEY;
      extraEnv.GOOGLE_API_KEY = GEMINI_API_KEY;
    }
    if (OPENAI_API_KEY) extraEnv.OPENAI_API_KEY = OPENAI_API_KEY;
    if (ANTHROPIC_API_KEY) extraEnv.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;

    const spawnOpts = getTargetSpawnOptions(extraEnv);
    const proc = spawn(opencodeBin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: WORKSPACE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOpts
    });

    this.proc = proc;
    let password = '';
    let stdoutBuf = '';
    let stderr = '';
    let settled = false;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            proc.kill('SIGTERM');
          } catch {}
          this.proc = null;
          reject(new Error(`Timed out waiting for opencode serve to start. ${stderr}`));
        }
      }, 15000);

      let listening = false;

      const checkReady = () => {
        if (!settled && listening && password) {
          settled = true;
          clearTimeout(timeout);
          this.baseUrl = `http://127.0.0.1:${port}`;
          this.authHeader = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
          resolve();
        }
      };

      proc.stdout?.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';
        for (const line of [...lines, stdoutBuf]) {
          if (line.includes('server listening on')) listening = true;
          const m = line.match(/server password (\S+)/);
          if (m) password = m[1];
        }
        checkReady();
      });

      proc.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.proc = null;
          reject(err);
        }
      });

      proc.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.proc = null;
          reject(new Error(`opencode serve exited prematurely with code ${code}: ${stderr}`));
        } else {
          this.baseUrl = null;
          this.authHeader = null;
          this.proc = null;
          this.syncedCredentials.clear();
          this.rejectAllPendingTurns(`OpenCode server exited unexpectedly (code ${code ?? 'unknown'})`);
        }
      });
    });

    // Await initial SSE subscription handshake before accepting prompts (prevents cold-start missed events!)
    await this.startEventSubscription();
  }

  private async startEventSubscription(): Promise<void> {
    if (!this.baseUrl || !this.authHeader || this.isShuttingDown) return;
    if (this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }

    const abort = new AbortController();
    this.sseAbort = abort;

    const res = await fetch(`${this.baseUrl}/api/event`, {
      headers: { Authorization: this.authHeader },
      signal: abort.signal
    });

    if (!res.ok || !res.body) {
      throw new Error(`OpenCode event stream failed with status ${res.status}`);
    }

    const reader = res.body.getReader();

    // Pump SSE events in background after initial 200 OK connection is established
    const pump = async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!abort.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() || '';
          for (const chunk of chunks) {
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payloadStr = line.slice(6).trim();
              if (!payloadStr) continue;
              try {
                const evt = JSON.parse(payloadStr);
                this.handleOpenCodeEvent(evt);
              } catch {
                // ignore malformed JSON
              }
            }
          }
        }
      } catch {
        // Reconnect shortly if server is still alive and not shutting down
        if (!this.isShuttingDown && this.proc && this.proc.exitCode === null) {
          setTimeout(() => {
            this.startEventSubscription().catch(() => {});
          }, 1500).unref();
        }
      }
    };

    pump();
  }

  /**
   * Registers/activates provider API keys via OpenCode V2's Credential API
   * (instead of leaking secrets into the shell tool environment!).
   */
  public async syncProviderCredentials(keys: {
    geminiApiKey?: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
  }): Promise<void> {
    if (!this.baseUrl || !this.authHeader) return;

    const pairs: Array<[string, string | undefined]> = [
      ['google', keys.geminiApiKey],
      ['openai', keys.openaiApiKey],
      ['anthropic', keys.anthropicApiKey]
    ];

    for (const [integrationID, key] of pairs) {
      const trimmed = key?.trim();
      if (!trimmed) continue;
      if (this.syncedCredentials.get(integrationID) === trimmed) continue;

      try {
        const res = await fetch(`${this.baseUrl}/api/credential`, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({
            integrationID,
            label: 'Bionic Editor',
            value: { type: 'key', key: trimmed },
            activate: true
          })
        });
        if (res.ok) {
          this.syncedCredentials.set(integrationID, trimmed);
        }
      } catch {
        // best-effort sync
      }
    }
  }

  private emitToTurnOrBroadcast(turn: ActiveTurnState, event: StepEvent): void {
    if (turn.onEvent) {
      turn.onEvent(event);
    }
    if (turn.isBackground && this.broadcastFn) {
      this.broadcastFn({
        type: 'agent_event',
        sessionId: turn.bionicSessionId,
        event
      });
    }
  }

  private autoReplyPermission(sessionID: string, requestID: string, action: string, resources: string[]): void {
    if (!this.baseUrl || !this.authHeader) return;
    const isFileAccessAction = action === 'read' || action === 'edit' || action === 'write' || action === 'patch';
    const touchesEnv =
      isFileAccessAction &&
      resources.some((r) => {
        const str = String(r).toLowerCase();
        return /(^|[\/\\])\.env(\.|$)/.test(str) && !str.endsWith('.env.example');
      });
    const decision = touchesEnv ? 'reject' : 'once';

    fetch(`${this.baseUrl}/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ decision })
    }).catch(() => {});
  }

  private persistBackgroundTurn(turn: ActiveTurnState, tokens: TokenUsage): void {
    try {
      const existing = getSession(turn.bionicSessionId);
      const msgs = existing?.messages ? [...existing.messages] : [];
      msgs.push({
        id: `asst_bg_${Date.now()}`,
        role: 'assistant',
        content: turn.accumulatedText,
        timeline: turn.timelineForPersist,
        tokens,
        timestamp: Date.now()
      });

      const prevTokens = existing?.tokens || {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0
      };

      saveSession({
        id: turn.bionicSessionId,
        title: existing?.title || 'Analysis Session',
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
        messages: msgs,
        tokens: {
          promptTokens: (prevTokens.promptTokens || 0) + tokens.promptTokens,
          completionTokens: (prevTokens.completionTokens || 0) + tokens.completionTokens,
          totalTokens: (prevTokens.totalTokens || 0) + tokens.totalTokens,
          estimatedCostUsd: (prevTokens.estimatedCostUsd || 0) + tokens.estimatedCostUsd
        }
      });
    } catch {
      // ignore persistence errors
    }
  }

  /**
   * Public event processor (also directly unit-testable with recorded OpenCode V2 events).
   */
  public handleOpenCodeEvent(evt: any): void {
    if (!evt || typeof evt !== 'object') return;
    const type = evt.type;
    const data = evt.data || {};

    if (type === 'permission.asked') {
      this.autoReplyPermission(data.sessionID, data.id, data.action, data.resources || []);
      return;
    }

    if (type === 'experimental.job.updated') {
      const info = data.info;
      if (info && info.kind === 'subagent') {
        const parentOcId = info.sessionID;
        const bionicSessionId = this.openCodeToBionic.get(parentOcId) || parentOcId;
        const job: SubagentJobView = {
          jobId: info.id,
          sessionId: bionicSessionId,
          parentOpenCodeSessionId: parentOcId,
          childSessionId: info.childSessionID,
          agent: info.agent || 'general',
          description: info.description || info.title || 'Background subagent',
          status: info.status || 'running',
          startedAt: info.time?.started || Date.now(),
          ...(info.time?.completed ? { completedAt: info.time.completed } : {})
        };
        this.subagentJobs.set(job.jobId, job);

        // Broadcast once over /ws (avoid duplicating over both SSE and /ws)
        if (this.broadcastFn) {
          this.broadcastFn({
            type: 'subagent_updated',
            sessionId: bionicSessionId,
            job
          });
        }
      }
      return;
    }

    const ocSessionId: string | undefined = data.sessionID;
    if (!ocSessionId) return;

    const bionicSessionId = this.openCodeToBionic.get(ocSessionId);
    if (!bionicSessionId) return;

    if (type === 'session.execution.started') {
      if (!this.activeTurns.has(ocSessionId)) {
        const bgTurn: ActiveTurnState = {
          bionicSessionId,
          opencodeSessionId: ocSessionId,
          isBackground: true,
          accumulatedText: '',
          accumulatedThought: '',
          lastAssistantMsgId: null,
          hadToolSinceLastText: false,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          toolNames: new Map(),
          timelineForPersist: []
        };
        this.activeTurns.set(ocSessionId, bgTurn);
        this.emitToTurnOrBroadcast(bgTurn, { type: 'background_turn_start' });
      }
      return;
    }

    const turn = this.activeTurns.get(ocSessionId);
    if (!turn) return;

    if (type === 'session.reasoning.delta') {
      const delta = typeof data.delta === 'string' ? data.delta : '';
      if (delta) {
        turn.accumulatedThought += delta;
        this.emitToTurnOrBroadcast(turn, { type: 'thought', delta });
      }
      return;
    }

    if (type === 'session.text.delta') {
      const rawDelta = typeof data.delta === 'string' ? data.delta : '';
      if (rawDelta) {
        const msgId = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : null;
        const needsSeparator =
          turn.accumulatedText.length > 0 &&
          !turn.accumulatedText.endsWith('\n') &&
          (turn.hadToolSinceLastText || (msgId && turn.lastAssistantMsgId && msgId !== turn.lastAssistantMsgId));

        const delta = needsSeparator ? `\n\n${rawDelta}` : rawDelta;
        turn.accumulatedText += delta;
        turn.lastAssistantMsgId = msgId || turn.lastAssistantMsgId;
        turn.hadToolSinceLastText = false;
        this.emitToTurnOrBroadcast(turn, { type: 'text_delta', delta });
      }
      return;
    }

    if (type === 'session.tool.input.started') {
      const toolId = data.id;
      const name = data.name || 'tool';
      turn.toolNames.set(toolId, { name, input: {}, title: name, desc: 'Preparing action...' });
      return;
    }

    if (type === 'session.tool.called') {
      const toolId = data.id;
      const existing = turn.toolNames.get(toolId);
      const name = existing?.name || 'tool';
      const meta = formatToolMeta(name, data.input);
      turn.toolNames.set(toolId, { name, input: data.input, ...meta });
      turn.hadToolSinceLastText = true;

      this.emitToTurnOrBroadcast(turn, {
        type: 'step_start',
        title: meta.title,
        description: meta.desc,
        status: 'running'
      });
      return;
    }

    if (type === 'session.tool.success' || type === 'session.tool.failed') {
      const toolId = data.id;
      const meta = turn.toolNames.get(toolId) || { name: 'tool', input: {}, title: 'tool', desc: 'Executed tool' };
      const isErr = type === 'session.tool.failed';
      const details = isErr
        ? (data.error?.message || extractToolOutputText(data.content) || 'Tool failed')
        : extractToolOutputText(data.content);

      const stepEvt: StepEvent = {
        type: 'step_done',
        title: meta.title,
        description: isErr ? 'Execution failed' : meta.desc,
        details,
        status: isErr ? 'error' : 'done'
      };
      turn.timelineForPersist.push({
        type: 'step',
        id: `step_${toolId || Date.now()}`,
        title: stepEvt.title,
        description: stepEvt.description,
        details: stepEvt.details,
        status: stepEvt.status
      });
      this.emitToTurnOrBroadcast(turn, stepEvt);
      return;
    }

    if (type === 'session.step.ended') {
      if (data.tokens) {
        turn.promptTokens += data.tokens.input || 0;
        turn.completionTokens += (data.tokens.output || 0) + (data.tokens.reasoning || 0);
      }
      if (typeof data.cost === 'number') {
        turn.costUsd += data.cost;
      }
      return;
    }

    if (type === 'session.execution.failed') {
      const errMsg = data.error?.message || 'OpenCode execution failed';
      this.emitToTurnOrBroadcast(turn, { type: 'error', description: errMsg });
      if (!turn.accumulatedText) {
        turn.accumulatedText = `Error: ${errMsg}`;
      }
      return;
    }

    if (type === 'session.execution.interrupted') {
      if (!turn.accumulatedText) {
        turn.accumulatedText = 'Execution was cancelled.';
      }
      return;
    }

    if (type === 'session.idle') {
      this.activeTurns.delete(ocSessionId);
      const tokens: TokenUsage = {
        promptTokens: turn.promptTokens,
        completionTokens: turn.completionTokens,
        totalTokens: turn.promptTokens + turn.completionTokens,
        estimatedCostUsd: turn.costUsd
      };

      if (turn.isBackground) {
        if (turn.accumulatedThought.trim()) {
          turn.timelineForPersist.unshift({
            type: 'thought',
            id: `thought_bg_${Date.now()}`,
            content: turn.accumulatedThought.trim()
          });
        }
        this.persistBackgroundTurn(turn, tokens);
        if (this.broadcastFn) {
          this.broadcastFn({
            type: 'agent_event',
            sessionId: turn.bionicSessionId,
            event: {
              type: 'final',
              delta: turn.accumulatedText,
              tokens
            }
          });
        }
      } else if (turn.resolve) {
        turn.resolve({
          text: turn.accumulatedText,
          tokens
        });
      }
    }
  }

  private async ensureOpenCodeSession(bionicSessionId: string, config: AgentConfig): Promise<string> {
    // Sync provider credentials through OpenCode's Credential API (never into shell env!)
    const integrationID = mapProviderToIntegration(config.provider);
    await this.syncProviderCredentials({
      geminiApiKey: integrationID === 'google' ? (config.apiKey || GEMINI_API_KEY) : GEMINI_API_KEY,
      openaiApiKey: integrationID === 'openai' ? (config.apiKey || OPENAI_API_KEY) : OPENAI_API_KEY,
      anthropicApiKey: integrationID === 'anthropic' ? (config.apiKey || ANTHROPIC_API_KEY) : ANTHROPIC_API_KEY
    });

    let ocId = this.bionicToOpenCode.get(bionicSessionId);

    if (ocId) {
      const check = await fetch(`${this.baseUrl}/api/session/${encodeURIComponent(ocId)}`, {
        headers: this.getHeaders()
      });
      if (!check.ok) {
        ocId = undefined;
      }
    }

    const modelRef = parseModelRef(config.provider, config.model);

    if (!ocId) {
      const createRes = await fetch(`${this.baseUrl}/api/session`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          title: `Bionic ${bionicSessionId}`,
          location: { directory: WORKSPACE_DIR },
          ...(modelRef ? { model: modelRef } : {}),
          permissions: [
            { action: '*', resource: '*', effect: 'allow' },
            { action: 'read', resource: '*.env*', effect: 'deny' },
            { action: 'read', resource: '**/.env*', effect: 'deny' },
            { action: 'edit', resource: '*.env*', effect: 'deny' },
            { action: 'edit', resource: '**/.env*', effect: 'deny' }
          ]
        })
      });

      if (!createRes.ok) {
        const errBody = await createRes.text();
        throw new Error(`Failed to create OpenCode session (${createRes.status}): ${errBody}`);
      }
      const created = await createRes.json();
      ocId = created.id || created.data?.id;
      if (!ocId) {
        throw new Error('OpenCode session creation did not return a session id');
      }
      this.registerSessionMapping(bionicSessionId, ocId);
    } else if (modelRef) {
      await fetch(`${this.baseUrl}/api/session/${encodeURIComponent(ocId)}/model`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ model: modelRef })
      }).catch(() => {});
    }

    // Pass ONLY safe non-secret workspace env vars to shell tool environment (preserve .venv PATH!)
    await fetch(`${this.baseUrl}/api/session/${encodeURIComponent(ocId)}/environment`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify({
        variables: {
          BIONIC_API_URL: getBionicApiUrl(),
          PATH: `${path.join(WORKSPACE_DIR, '.venv', 'bin')}:${process.env.PATH || ''}`
        }
      })
    }).catch(() => {});

    return ocId;
  }

  public async promptSession(
    opencodeBin: string,
    bionicSessionId: string,
    userText: string,
    config: AgentConfig,
    onEvent: (event: StepEvent) => void
  ): Promise<{ text: string; tokens: TokenUsage }> {
    ensureOpenCodeWorkspaceConfig();
    await this.ensureStarted(opencodeBin);
    const ocSessionId = await this.ensureOpenCodeSession(bionicSessionId, config);

    // Settle any previous pending turn cleanly before starting a new one
    const prevTurn = this.activeTurns.get(ocSessionId);
    if (prevTurn && prevTurn.resolve) {
      prevTurn.resolve({
        text: prevTurn.accumulatedText || 'Superseded by follow-up prompt.',
        tokens: {
          promptTokens: prevTurn.promptTokens,
          completionTokens: prevTurn.completionTokens,
          totalTokens: prevTurn.promptTokens + prevTurn.completionTokens,
          estimatedCostUsd: prevTurn.costUsd
        }
      });
      this.activeTurns.delete(ocSessionId);
    }

    return new Promise((resolve, reject) => {
      const turn: ActiveTurnState = {
        bionicSessionId,
        opencodeSessionId: ocSessionId,
        isBackground: false,
        accumulatedText: '',
        accumulatedThought: '',
        lastAssistantMsgId: null,
        hadToolSinceLastText: false,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        toolNames: new Map(),
        onEvent,
        resolve,
        reject,
        timelineForPersist: []
      };
      this.activeTurns.set(ocSessionId, turn);

      fetch(`${this.baseUrl}/api/session/${encodeURIComponent(ocSessionId)}/prompt`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ text: userText })
      })
        .then(async (res) => {
          if (!res.ok) {
            const errText = await res.text();
            this.activeTurns.delete(ocSessionId);
            reject(new Error(`OpenCode prompt failed (${res.status}): ${errText}`));
          }
        })
        .catch((err) => {
          this.activeTurns.delete(ocSessionId);
          reject(err);
        });
    });
  }

  public async interruptSession(bionicSessionId: string): Promise<boolean> {
    const ocId = this.bionicToOpenCode.get(bionicSessionId);
    if (!ocId || !this.baseUrl || !this.authHeader) return false;

    try {
      const res = await fetch(`${this.baseUrl}/api/session/${encodeURIComponent(ocId)}/interrupt`, {
        method: 'POST',
        headers: this.getHeaders()
      });
      const turn = this.activeTurns.get(ocId);
      if (turn && !turn.isBackground && turn.resolve) {
        this.activeTurns.delete(ocId);
        turn.resolve({
          text: turn.accumulatedText || 'Execution was cancelled.',
          tokens: {
            promptTokens: turn.promptTokens,
            completionTokens: turn.completionTokens,
            totalTokens: turn.promptTokens + turn.completionTokens,
            estimatedCostUsd: turn.costUsd
          }
        });
      }
      return res.ok;
    } catch {
      return false;
    }
  }

  public async listRemoteSubagents(bionicSessionId?: string): Promise<{
    jobs: SubagentJobView[];
    availableAgents: Array<{ id: string; description?: string; mode?: string }>;
  }> {
    const jobs = this.getTrackedSubagents(bionicSessionId);
    let availableAgents: Array<{ id: string; description?: string; mode?: string }> = [
      { id: 'explore', description: 'Fast read-only subagent for searching files and answering questions', mode: 'subagent' },
      { id: 'general', description: 'General-purpose subagent for multi-step background tasks', mode: 'subagent' }
    ];

    if (!this.baseUrl || !this.authHeader) {
      return { jobs, availableAgents };
    }

    try {
      const ocId = bionicSessionId ? this.bionicToOpenCode.get(bionicSessionId) : undefined;
      const jobQuery = new URLSearchParams({ kind: 'subagent' });
      if (ocId) jobQuery.set('sessionID', ocId);
      const agentQuery = new URLSearchParams({ 'location[directory]': WORKSPACE_DIR });

      const [jobsRes, agentsRes] = await Promise.all([
        fetch(`${this.baseUrl}/api/experimental/job?${jobQuery.toString()}`, { headers: this.getHeaders() }),
        fetch(`${this.baseUrl}/api/agent?${agentQuery.toString()}`, { headers: this.getHeaders() })
      ]);

      if (jobsRes.ok) {
        const body = await jobsRes.json();
        const remoteList = Array.isArray(body?.data) ? body.data : [];
        for (const info of remoteList) {
          if (info?.kind !== 'subagent') continue;
          const mappedSessionId = this.openCodeToBionic.get(info.sessionID) || info.sessionID;
          const view: SubagentJobView = {
            jobId: info.id,
            sessionId: mappedSessionId,
            parentOpenCodeSessionId: info.sessionID,
            childSessionId: info.childSessionID,
            agent: info.agent || 'general',
            description: info.description || info.title || 'Background subagent',
            status: info.status || 'running',
            startedAt: info.time?.started || Date.now(),
            ...(info.time?.completed ? { completedAt: info.time.completed } : {})
          };
          this.subagentJobs.set(view.jobId, view);
        }
      }

      if (agentsRes.ok) {
        const body = await agentsRes.json();
        const list = Array.isArray(body?.data) ? body.data : [];
        const subagents = list
          .filter((a: any) => a && (a.mode === 'subagent' || a.mode === 'all') && !a.hidden)
          .map((a: any) => ({
            id: a.id || a.name,
            description: a.description || '',
            mode: a.mode
          }));
        if (subagents.length > 0) {
          availableAgents = subagents;
        }
      }
    } catch {
      // return cached tracked jobs
    }

    return {
      jobs: this.getTrackedSubagents(bionicSessionId),
      availableAgents
    };
  }

  /**
   * Formats OpenCode V2 `Session.Message.Assistant` parts (where tool args live in
   * `p.state.input` and outputs live in `p.state.content`).
   */
  public formatOpenCodeMessages(rawMsgs: any[]): Array<{
    role: string;
    text: string;
    tools: Array<{ title: string; status: string; output?: string }>;
  }> {
    return rawMsgs
      .filter((m: any) => m && (m.type === 'user' || m.type === 'assistant'))
      .map((m: any) => {
        if (m.type === 'user') {
          return {
            role: 'user',
            text: typeof m.text === 'string' ? m.text : '',
            tools: []
          };
        }
        const parts = Array.isArray(m.content) ? m.content : [];
        const textParts: string[] = [];
        const tools: Array<{ title: string; status: string; output?: string }> = [];
        for (const p of parts) {
          if (p?.type === 'text' && typeof p.text === 'string') {
            textParts.push(p.text);
          } else if (p?.type === 'tool') {
            const toolInput = p.state?.input ?? p.input ?? {};
            const meta = formatToolMeta(p.name || p.tool || 'tool', toolInput);
            const rawStatus = p.state?.status || p.state?.type || 'done';
            const output = extractToolOutputText(p.state?.content ?? p.state?.output ?? p.content);
            tools.push({
              title: meta.title,
              status: rawStatus === 'error' ? 'error' : rawStatus === 'running' ? 'running' : 'done',
              output
            });
          }
        }
        return {
          role: 'assistant',
          text: textParts.join('\n\n'),
          tools
        };
      });
  }

  public async getChildSessionDetails(childSessionId: string): Promise<{
    childSessionId: string;
    messages: Array<{ role: string; text: string; tools: Array<{ title: string; status: string; output?: string }> }>;
  }> {
    if (!this.baseUrl || !this.authHeader) {
      return { childSessionId, messages: [] };
    }

    const res = await fetch(`${this.baseUrl}/api/session/${encodeURIComponent(childSessionId)}/message?order=asc`, {
      headers: this.getHeaders()
    });
    if (!res.ok) {
      throw new Error(`Could not fetch subagent session messages (${res.status})`);
    }
    const body = await res.json();
    const rawMsgs = Array.isArray(body?.data) ? body.data : (Array.isArray(body?.messages) ? body.messages : []);

    return {
      childSessionId,
      messages: this.formatOpenCodeMessages(rawMsgs)
    };
  }

  /**
   * Reconciles Bionic's stored session + active subagent jobs on browser reload/reconnect.
   */
  public async syncSession(bionicSessionId: string): Promise<{
    session: any | null;
    subagents: SubagentJobView[];
  }> {
    const saved = getSession(bionicSessionId);
    const { jobs } = await this.listRemoteSubagents(bionicSessionId);
    return {
      session: saved,
      subagents: jobs
    };
  }

  public async cancelSubagentJob(jobId: string): Promise<boolean> {
    if (!this.baseUrl || !this.authHeader) return false;
    const res = await fetch(`${this.baseUrl}/api/experimental/job/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      headers: this.getHeaders()
    });
    if (res.ok) {
      const existing = this.subagentJobs.get(jobId);
      if (existing) {
        existing.status = 'cancelled';
        existing.completedAt = Date.now();
        if (this.broadcastFn) {
          this.broadcastFn({
            type: 'subagent_updated',
            sessionId: existing.sessionId,
            job: existing
          });
        }
      }
      return true;
    }
    return false;
  }

  public stop(): void {
    this.isShuttingDown = true;
    this.rejectAllPendingTurns('OpenCode server stopped.');
    if (this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {}
      this.proc = null;
    }
    this.baseUrl = null;
    this.authHeader = null;
    this.syncedCredentials.clear();
  }
}

export const opencodeServer = new OpenCodeServerBridge();

process.on('exit', () => opencodeServer.stop());
