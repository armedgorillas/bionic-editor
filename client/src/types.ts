export type FileCategory =
  | 'document'
  | 'plan'
  | 'data'
  | 'figure'
  | 'report'
  | 'code'
  | 'aux-code'
  | 'config'
  | 'other';

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  updatedAt?: string;
  extension?: string;
  isDotItem?: boolean;
  category?: FileCategory;
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

export interface SubagentJobView {
  jobId: string;
  sessionId: string;
  parentOpenCodeSessionId?: string;
  childSessionId: string;
  agent: string;
  description: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  startedAt: number;
  completedAt?: number;
}

export type AgentTimelineItem =
  | { type: 'thought'; id: string; content: string }
  | { type: 'step'; id: string; title: string; description: string; details?: string; status: 'running' | 'done' | 'error' }
  | { type: 'subagent'; id: string; job: SubagentJobView };

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
  rootFile?: string;
  baseSpec?: string;
  rootFileSource?: 'workspace' | 'env' | 'default';
  baseUrl?: string;
}

export interface WorkspaceConfigResponse {
  rootFile: string;
  baseSpec: string;
  source: 'workspace' | 'env' | 'default';
}

export interface DataAcquisitionInfo {
  method: 'script' | 'upload' | 'url' | 'manual';
  scriptPath?: string;
  command?: string;
  codeSnippet?: string;
  scriptSha256?: string;
  sourceUrl?: string;
}

export interface DataManifestEntrySummary {
  id: string;
  filepath: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs?: number;
  acquiredAt: string;
  acquisition: DataAcquisitionInfo;
  description: string;
  excludeFromGit: boolean;
  excludeFromPublication: boolean;
  status: 'present' | 'size_changed' | 'missing' | 'verified' | 'modified';
  diskSizeBytes?: number;
  actualSha256?: string;
  scriptChanged?: boolean;
}

export interface PublicationLeak {
  path: string;
  reason: 'symlink_to_raw' | 'symlink_outside_workspace' | 'hash_match' | 'raw_extension' | 'oversized_file';
  matchedEntryId?: string;
  matchedFilepath?: string;
  sizeBytes?: number;
}

export interface LeakAuditResult {
  isGitRepo: boolean;
  gitTrackedRawFiles: string[];
  publicationLeaks: PublicationLeak[];
}

export interface DataManifestSummary {
  manifest: {
    schemaVersion: 1;
    updatedAt: string;
    entries: any[];
  };
  entries: DataManifestEntrySummary[];
  untrackedRawFiles: Array<{ filepath: string; sizeBytes: number; mtimeMs: number }>;
  lastVerifiedAt: string | null;
  hasIssues: boolean;
  leaks?: LeakAuditResult;
}
