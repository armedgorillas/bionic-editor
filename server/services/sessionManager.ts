import fs from 'fs';
import path from 'path';
import { WORKSPACE_DIR } from '../config.js';

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: any[];
  tokens?: any;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  tokens?: any;
}

function getSessionsDir(): string {
  const dir = path.join(WORKSPACE_DIR, '.bionic', 'sessions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function listSessions(): ChatSessionSummary[] {
  const dir = getSessionsDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

  const summaries: ChatSessionSummary[] = [];

  for (const file of files) {
    try {
      const fullPath = path.join(dir, file);
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const data: ChatSession = JSON.parse(raw);
      summaries.push({
        id: data.id,
        title: data.title || 'Untitled Session',
        createdAt: data.createdAt || Date.now(),
        updatedAt: data.updatedAt || Date.now(),
        messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
        tokens: data.tokens
      });
    } catch {
      // ignore corrupted file
    }
  }

  // Sort newest first
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSession(id: string): ChatSession | null {
  const dir = getSessionsDir();
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '');
  const fullPath = path.join(dir, `${sanitized}.json`);

  if (!fs.existsSync(fullPath)) return null;

  try {
    const raw = fs.readFileSync(fullPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveSession(session: ChatSession): ChatSession {
  const dir = getSessionsDir();
  const sanitized = session.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const fullPath = path.join(dir, `${sanitized}.json`);

  const updated: ChatSession = {
    ...session,
    id: sanitized,
    title: session.title || 'Analysis Session',
    createdAt: session.createdAt || Date.now(),
    updatedAt: Date.now()
  };

  fs.writeFileSync(fullPath, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

export function deleteSession(id: string): boolean {
  const dir = getSessionsDir();
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '');
  const fullPath = path.join(dir, `${sanitized}.json`);

  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
    return true;
  }
  return false;
}
