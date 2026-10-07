export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  updatedAt?: string;
  extension?: string;
  children?: FileItem[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface AgentStep {
  id: string;
  title: string;
  description: string;
  details?: string;
  status: 'running' | 'done' | 'error';
}

export type AgentTimelineItem =
  | { type: 'thought'; id: string; content: string }
  | { type: 'step'; id: string; title: string; description: string; details?: string; status: 'running' | 'done' | 'error' };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timeline?: AgentTimelineItem[];
  thoughts?: string[];
  steps?: AgentStep[];
  tokens?: TokenUsage;
  timestamp: number;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  tokens?: TokenUsage;
}

export interface VenvStatus {
  exists: boolean;
  pythonPath: string;
  hasRequirements: boolean;
}

export interface WorkspaceInfo {
  workspaceDir: string;
  venv: VenvStatus;
}
