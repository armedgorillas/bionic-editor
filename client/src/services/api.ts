import type {
  FileItem,
  WorkspaceInfo,
  VenvStatus,
  WorkspaceConfigResponse,
  DataManifestSummary,
  DataAcquisitionInfo,
  SubagentJobView
} from '../types';

export interface BionicRuntimeConfig {
  baseUrl: string;
  baseSpec: string;
  rootFile?: string;
  hubMode?: boolean;
  sandboxMode?: boolean;
  hubUrl?: string;
  projectId?: string;
  reportsOrigin?: string;
}

export function getBionicConfig(): BionicRuntimeConfig {
  if (typeof window !== 'undefined' && (window as any).__BIONIC_CONFIG__) {
    return (window as any).__BIONIC_CONFIG__;
  }
  return { baseUrl: '', baseSpec: 'SPEC.md', rootFile: 'SPEC.md' };
}

export async function fetchWorkspaceMeta(): Promise<{
  workspaceDir: string;
  rootFile: string;
  totalBytes: number;
  fileCount: number;
  lastEditedAt: string | null;
  bionicYaml: { title?: string; summary?: string; description?: string; name?: string } | null;
}> {
  const res = await fetch(`${API_BASE}/workspace/meta`);
  if (!res.ok) throw new Error('Failed to load workspace metadata');
  return res.json();
}

export async function saveProjectSnapshot(payload?: {
  title?: string;
  summary?: string;
  message?: string;
}): Promise<{ success: boolean; gitCommitSha?: string; hubSynced?: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/hub/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  return res.json();
}

export async function publishProjectReport(payload: {
  visibility: 'private' | 'org' | 'public';
  title: string;
  summary?: string;
  dryRun?: boolean;
}): Promise<{
  success: boolean;
  publication?: { publicationId: string; version: number; staticSiteUrl: string; visibility: string };
  stdout?: string;
  stderr?: string;
  error?: string;
}> {
  const res = await fetch(`${API_BASE}/hub/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
}

export const BASE_URL = getBionicConfig().baseUrl;
export const BASE_SPEC = getBionicConfig().rootFile || getBionicConfig().baseSpec;
export const API_BASE = `${BASE_URL}/api`;

export async function fetchWorkspaceInfo(): Promise<WorkspaceInfo> {
  const res = await fetch(`${API_BASE}/workspace/info`);
  if (!res.ok) throw new Error('Failed to fetch workspace info');
  return res.json();
}

export async function fetchWorkspaceConfig(): Promise<WorkspaceConfigResponse> {
  const res = await fetch(`${API_BASE}/workspace/config`);
  if (!res.ok) throw new Error('Failed to fetch workspace config');
  return res.json();
}

export async function updateWorkspaceConfig(payload: {
  rootFile: string;
  createIfMissing?: boolean;
}): Promise<WorkspaceConfigResponse> {
  const res = await fetch(`${API_BASE}/workspace/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to update workspace config');
  }
  return res.json();
}

export async function initWorkspaceTemplate(): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/workspace/init`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to init workspace template');
  return res.json();
}

export async function fetchFileTree(includeDotItems = true): Promise<FileItem[]> {
  const query = includeDotItems ? '?includeDotItems=true' : '';
  const res = await fetch(`${API_BASE}/files/tree${query}`);
  if (!res.ok) throw new Error('Failed to fetch file tree');
  const data = await res.json();
  return data.tree;
}

export async function readFile(path: string): Promise<{ content: string; isBinary: boolean; size: number }> {
  const res = await fetch(`${API_BASE}/files/read?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to read file: ${path}`);
  return res.json();
}

export async function writeFile(path: string, content: string): Promise<void> {
  const res = await fetch(`${API_BASE}/files/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content })
  });
  if (!res.ok) throw new Error(`Failed to write file: ${path}`);
}

export async function createItem(path: string, isDirectory: boolean): Promise<void> {
  const res = await fetch(`${API_BASE}/files/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, isDirectory })
  });
  if (!res.ok) throw new Error(`Failed to create item: ${path}`);
}

export async function renameItem(oldPath: string, newPath: string): Promise<{ success: boolean; manifestUpdated?: boolean }> {
  const res = await fetch(`${API_BASE}/files/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPath, newPath })
  });
  if (!res.ok) throw new Error(`Failed to rename ${oldPath}`);
  return res.json();
}

export async function deleteItem(path: string): Promise<{ success: boolean; manifestAffected?: boolean }> {
  const res = await fetch(`${API_BASE}/files/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  });
  if (!res.ok) throw new Error(`Failed to delete ${path}`);
  return res.json();
}

export async function uploadFile(file: File, targetDir: string = '', description?: string): Promise<any> {
  const formData = new FormData();
  formData.append('file', file);
  if (description) {
    formData.append('description', description);
  }
  const url = targetDir
    ? `${API_BASE}/files/upload?dir=${encodeURIComponent(targetDir)}`
    : `${API_BASE}/files/upload`;
  const res = await fetch(url, {
    method: 'POST',
    body: formData
  });
  if (!res.ok) throw new Error('File upload failed');
  return res.json();
}

// Data Provenance Manifest API
export async function fetchDataManifest(): Promise<DataManifestSummary> {
  const res = await fetch(`${API_BASE}/data/manifest`);
  if (!res.ok) throw new Error('Failed to load data provenance manifest');
  return res.json();
}

export async function registerDataManifestFile(payload: {
  filepath: string;
  description?: string;
  acquisition?: Partial<DataAcquisitionInfo>;
  id?: string;
}): Promise<{ success: boolean; entry: any }> {
  const res = await fetch(`${API_BASE}/data/manifest/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to register dataset');
  }
  return res.json();
}

export async function verifyDataManifest(): Promise<DataManifestSummary> {
  const res = await fetch(`${API_BASE}/data/manifest/verify`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to verify data manifest');
  return res.json();
}

export async function untrackRawFromGit(filepath: string): Promise<{
  success: boolean;
  filepath: string;
  inGitHistory: boolean;
  warning?: string;
}> {
  const res = await fetch(`${API_BASE}/data/manifest/untrack-git`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filepath })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to untrack file from Git');
  }
  return res.json();
}

export async function deleteDataManifestEntry(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/data/manifest/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error('Failed to remove manifest entry');
}

export async function fetchVenvStatus(): Promise<VenvStatus> {
  const res = await fetch(`${API_BASE}/venv/status`);
  if (!res.ok) throw new Error('Failed to fetch venv status');
  return res.json();
}

export async function createVenv(): Promise<{ success: boolean; output: string }> {
  const res = await fetch(`${API_BASE}/venv/create`, { method: 'POST' });
  return res.json();
}

export async function installRequirements(): Promise<{ success: boolean; output: string }> {
  const res = await fetch(`${API_BASE}/venv/install`, { method: 'POST' });
  return res.json();
}

export async function runPython(scriptPath: string, args: string[] = []): Promise<{ success: boolean; code: number; stdout: string; stderr: string }> {
  const res = await fetch(`${API_BASE}/venv/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scriptPath, args })
  });
  return res.json();
}

export interface HubManagedModel {
  slug: string;
  displayName: string;
  provider: string;
  protocol: 'anthropic' | 'openai' | 'google';
  modelId: string;
}

export async function fetchAgentConfig(): Promise<{
  hubManaged?: boolean;
  hasGeminiKey: boolean;
  hasOpenaiKey: boolean;
  hasAnthropicKey: boolean;
  isOpenCodeInstalled: boolean;
  harness: 'opencode' | 'built-in';
  models?: HubManagedModel[];
  defaultModel?: string;
  availableProviders: any[];
  defaultProvider: string;
}> {
  const res = await fetch(`${API_BASE}/agent/config`);
  return res.json();
}

export async function saveAgentConfig(config: any): Promise<{
  success: boolean;
  hasGeminiKey: boolean;
  hasOpenaiKey: boolean;
  hasAnthropicKey: boolean;
}> {
  const res = await fetch(`${API_BASE}/agent/save-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  return res.json();
}

export async function fetchAgentInstructions(): Promise<{ rootFile: string; userInstructions: string }> {
  const res = await fetch(`${API_BASE}/agent/instructions`);
  if (!res.ok) throw new Error('Failed to fetch agent instructions');
  return res.json();
}

export async function saveAgentInstructions(userInstructions: string): Promise<void> {
  const res = await fetch(`${API_BASE}/agent/instructions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userInstructions })
  });
  if (!res.ok) throw new Error('Failed to save agent instructions');
}

export async function fetchSubagents(sessionId?: string): Promise<{
  jobs: SubagentJobView[];
  availableAgents: Array<{ id: string; description?: string; mode?: string }>;
}> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const res = await fetch(`${API_BASE}/agent/subagents${query}`);
  if (!res.ok) throw new Error('Failed to fetch subagents');
  return res.json();
}

export async function fetchSubagentDetails(childSessionId: string): Promise<{
  childSessionId: string;
  messages: Array<{ role: string; text: string; tools: Array<{ title: string; status: string; output?: string }> }>;
}> {
  const res = await fetch(`${API_BASE}/agent/subagents/${encodeURIComponent(childSessionId)}`);
  if (!res.ok) throw new Error('Failed to load subagent details');
  return res.json();
}

export async function cancelSubagentJob(jobId: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/agent/subagents/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST'
  });
  if (!res.ok) throw new Error('Failed to cancel subagent');
  return res.json();
}

export async function fetchChatSessions(): Promise<any[]> {
  const res = await fetch(`${API_BASE}/agent/sessions`);
  if (!res.ok) throw new Error('Failed to fetch chat sessions');
  const data = await res.json();
  return data.sessions;
}

export async function fetchChatSession(id: string): Promise<any> {
  const res = await fetch(`${API_BASE}/agent/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to load chat session ${id}`);
  return res.json();
}

export async function syncChatSession(id: string): Promise<{ session: any | null; subagents: SubagentJobView[] }> {
  const res = await fetch(`${API_BASE}/agent/sessions/${encodeURIComponent(id)}/sync`);
  if (!res.ok) throw new Error(`Failed to sync chat session ${id}`);
  return res.json();
}

export async function saveChatSession(session: any): Promise<any> {
  const res = await fetch(`${API_BASE}/agent/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session)
  });
  if (!res.ok) throw new Error('Failed to save session');
  return res.json();
}

export async function deleteChatSession(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/agent/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error('Failed to delete session');
}

export async function cancelAgentExecution(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/agent/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });
}

export async function streamAgentChat(
  messages: any[],
  config: any,
  onEvent: (event: any) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${API_BASE}/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, config }),
    signal
  });

  if (!res.ok) {
    throw new Error('Failed to contact agent');
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No readable stream');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() || '';

    for (const chunk of lines) {
      if (chunk.startsWith('data: ')) {
        const jsonStr = chunk.slice(6);
        try {
          const eventData = JSON.parse(jsonStr);
          onEvent(eventData);
        } catch {
          // ignore parse error
        }
      }
    }
  }
}
