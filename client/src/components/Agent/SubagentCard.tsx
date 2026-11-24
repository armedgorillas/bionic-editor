import React, { useState, useEffect } from 'react';
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  XCircle,
  ChevronDown,
  ChevronRight,
  Square,
  GitBranch
} from 'lucide-react';
import type { SubagentJobView } from '../../types';
import { fetchSubagentDetails } from '../../services/api';
import { MarkdownMessage } from './MarkdownMessage';

interface SubagentCardProps {
  job: SubagentJobView;
  onCancel?: (jobId: string) => void;
  onOpenFile?: (path: string) => void;
  workspacePaths?: Set<string>;
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

export const SubagentCard: React.FC<SubagentCardProps> = ({
  job,
  onCancel,
  onOpenFile,
  workspacePaths
}) => {
  const [expanded, setExpanded] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [details, setDetails] = useState<Array<{
    role: string;
    text: string;
    tools: Array<{ title: string; status: string; output?: string }>;
  }> | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [fetchedForStatus, setFetchedForStatus] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (job.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job.status]);

  const loadDetails = async () => {
    if (!job.childSessionId || loadingDetails) return;
    setLoadingDetails(true);
    setDetailsError(null);
    try {
      const res = await fetchSubagentDetails(job.childSessionId);
      setDetails(res.messages || []);
      setFetchedForStatus(job.status);
    } catch (err: any) {
      setDetailsError(err.message || 'Could not load subagent output');
    } finally {
      setLoadingDetails(false);
    }
  };

  // Automatically re-fetch details if card is open and job transitions out of running
  useEffect(() => {
    if (!expanded || job.status === 'running' || fetchedForStatus === job.status || !job.childSessionId) {
      return;
    }
    let active = true;
    fetchSubagentDetails(job.childSessionId)
      .then((res) => {
        if (active) {
          setDetails(res.messages || []);
          setFetchedForStatus(job.status);
          setDetailsError(null);
        }
      })
      .catch((err: any) => {
        if (active) setDetailsError(err.message || 'Could not load subagent output');
      });
    return () => {
      active = false;
    };
  }, [expanded, job.status, job.childSessionId, fetchedForStatus]);

  const elapsedMs = (job.completedAt || now) - job.startedAt;

  const handleToggleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && (!details || fetchedForStatus !== job.status || job.status === 'running')) {
      await loadDetails();
    }
  };

  const isRunning = job.status === 'running';
  const isError = job.status === 'error';
  const isCancelled = job.status === 'cancelled';

  return (
    <div
      className={`rounded-lg border p-2.5 text-xs transition ${
        isRunning
          ? 'bg-blue-50/60 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800/70'
          : isError
            ? 'bg-red-50/40 dark:bg-red-950/25 border-red-200 dark:border-red-800/70'
            : 'bg-elevated border-edge'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleToggleExpand}
          className="flex items-center space-x-2 text-left min-w-0 flex-1 cursor-pointer"
        >
          {isRunning && <Loader2 className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 animate-spin flex-shrink-0" />}
          {job.status === 'completed' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />}
          {isError && <AlertCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400 flex-shrink-0" />}
          {isCancelled && <XCircle className="w-3.5 h-3.5 text-muted flex-shrink-0" />}

          <GitBranch className="w-3 h-3 text-muted flex-shrink-0" />
          <span className="font-medium text-ink truncate">
            Subagent: {job.description}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-panel border border-edge text-muted font-mono flex-shrink-0">
            {job.agent}
          </span>
        </button>

        <div className="flex items-center space-x-1.5 flex-shrink-0">
          <span className="text-[10px] text-muted font-mono">
            {isRunning ? `Running · ${formatDuration(elapsedMs)}` : `${job.status} · ${formatDuration(elapsedMs)}`}
          </span>

          {isRunning && onCancel && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCancel(job.jobId);
              }}
              className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-red-600 hover:bg-red-700 text-white text-[10px] font-medium transition cursor-pointer"
              title="Stop this subagent"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
              <span>Stop</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleToggleExpand}
            className="p-0.5 text-muted hover:text-ink rounded"
            title={expanded ? 'Hide details' : 'Show details'}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-edge space-y-2">
          {loadingDetails && (
            <div className="flex items-center space-x-1.5 text-[11px] text-muted">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Loading subagent output...</span>
            </div>
          )}
          {detailsError && (
            <div className="text-[11px] text-red-600 dark:text-red-400">{detailsError}</div>
          )}
          {!loadingDetails && !detailsError && details && details.length === 0 && (
            <div className="text-[11px] text-muted">
              {isRunning ? 'Subagent is still working in the background...' : 'No detailed transcript available.'}
            </div>
          )}
          {!loadingDetails && details && details.length > 0 && (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {details
                .filter((m) => m.role === 'assistant' && (m.text || m.tools.length > 0))
                .map((m, idx) => (
                  <div key={idx} className="space-y-1">
                    {m.tools.length > 0 && (
                      <div className="text-[10px] text-muted font-mono">
                        Actions: {m.tools.map((t) => t.title).join(', ')}
                      </div>
                    )}
                    {m.text && (
                      <div className="p-2 rounded bg-panel border border-edge text-ink">
                        <MarkdownMessage
                          content={m.text}
                          compact
                          onOpenFile={onOpenFile}
                          workspacePaths={workspacePaths}
                        />
                      </div>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
