import type { FileItem, WorkspaceInfo, VenvStatus } from '../types';

export const API_BASE = '/api';

export async function fetchWorkspaceInfo(): Promise<WorkspaceInfo> {
  const res = await fetch(`${API_BASE}/workspace/info`);
  if (!res.ok) throw new Error('Failed to fetch workspace info');
  return res.json();
}

export async function initWorkspaceTemplate(): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/workspace/init`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to init workspace template');
  return res.json();
}

export async function fetchFileTree(): Promise<FileItem[]> {
  const res = await fetch(`${API_BASE}/files/tree`);
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

export async function renameItem(oldPath: string, newPath: string): Promise<void> {
  const res = await fetch(`${API_BASE}/files/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPath, newPath })
  });
  if (!res.ok) throw new Error(`Failed to rename ${oldPath}`);
}

export async function deleteItem(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}/files/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  });
  if (!res.ok) throw new Error(`Failed to delete ${path}`);
}

export async function uploadFile(file: File, targetDir: string = ''): Promise<void> {
  const formData = new FormData();
  formData.append('file', file);
  const url = targetDir 
    ? `${API_BASE}/files/upload?dir=${encodeURIComponent(targetDir)}` 
    : `${API_BASE}/files/upload`;
  const res = await fetch(url, {
    method: 'POST',
    body: formData
  });
  if (!res.ok) throw new Error('File upload failed');
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

export async function fetchAgentConfig(): Promise<{ 
  hasGeminiKey: boolean;
  hasOpenaiKey: boolean;
  hasAnthropicKey: boolean;
  availableProviders: any[]; 
  defaultProvider: string 
}> {
  const res = await fetch(`${API_BASE}/agent/config`);
  return res.json();
}

export async function saveAgentConfig(config: any): Promise<{ success: boolean; hasGeminiKey: boolean }> {
  const res = await fetch(`${API_BASE}/agent/save-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
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
        } catch (e) {
          // ignore parse error
        }
      }
    }
  }
}
