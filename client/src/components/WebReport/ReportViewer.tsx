import React, { useRef, useState } from 'react';
import { RefreshCw, ExternalLink, LayoutDashboard, CheckCircle } from 'lucide-react';
import { getBionicConfig } from '../../services/api';

interface ReportViewerProps {
  lastUpdated?: number;
  isDragging?: boolean;
}

export const ReportViewer: React.FC<ReportViewerProps> = ({ lastUpdated, isDragging = false }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [mountTs] = useState<number>(() => Date.now());
  const baseUrl = getBionicConfig().baseUrl;
  const reportUrl = `${baseUrl}/report/index.html`;

  const handleRefresh = () => {
    setIsRefreshing(true);
    if (iframeRef.current) {
      iframeRef.current.src = `${reportUrl}?t=${Date.now()}`;
    }
    setTimeout(() => setIsRefreshing(false), 400);
  };

  const handleOpenExternal = () => {
    window.open(reportUrl, '_blank');
  };

  return (
    <div className="flex flex-col h-full bg-panel overflow-hidden">
      {/* Report Header Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-elevated border-b border-edge select-none text-xs text-ink">
        <div className="flex items-center space-x-2">
          <LayoutDashboard className="w-4 h-4 text-orange-500" />
          <span className="font-semibold text-ink">Live Web Report</span>
          <span className="text-[10px] bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 px-1.5 py-0.5 rounded flex items-center space-x-1">
            <CheckCircle className="w-2.5 h-2.5" />
            <span>Publication ({baseUrl}/report/)</span>
          </span>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleRefresh}
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-panel hover:bg-surface text-ink border border-edge transition cursor-pointer"
            title="Reload report"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-accent' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={handleOpenExternal}
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-panel hover:bg-surface text-ink border border-edge transition cursor-pointer"
            title="Open in new browser tab"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>Open in Tab</span>
          </button>
        </div>
      </div>

      {/* Embedded Iframe (never force-inverted; pointer-events disabled during separator drags) */}
      <div className={`flex-1 w-full h-full bg-white relative ${isDragging ? 'pointer-events-none' : ''}`}>
        <iframe
          ref={iframeRef}
          key={lastUpdated}
          src={`${reportUrl}?t=${lastUpdated || mountTs}`}
          className="w-full h-full border-none"
          title="Bionic Editor Web Report"
        />
      </div>
    </div>
  );
};
