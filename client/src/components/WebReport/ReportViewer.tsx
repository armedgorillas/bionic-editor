import React, { useRef, useState } from 'react';
import { RefreshCw, ExternalLink, LayoutDashboard, CheckCircle } from 'lucide-react';

interface ReportViewerProps {
  lastUpdated?: number;
}

export const ReportViewer: React.FC<ReportViewerProps> = ({ lastUpdated }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = () => {
    setIsRefreshing(true);
    if (iframeRef.current) {
      iframeRef.current.src = `/report/index.html?t=${Date.now()}`;
    }
    setTimeout(() => setIsRefreshing(false), 400);
  };

  const handleOpenExternal = () => {
    window.open('/report/index.html', '_blank');
  };

  return (
    <div className="flex flex-col h-full bg-gray-100 overflow-hidden">
      {/* Report Header Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200 select-none text-xs">
        <div className="flex items-center space-x-2">
          <LayoutDashboard className="w-4 h-4 text-orange-500" />
          <span className="font-semibold text-gray-800">Live Web Report</span>
          <span className="text-[10px] bg-green-50 text-green-700 border border-green-200 px-1.5 py-0.5 rounded flex items-center space-x-1">
            <CheckCircle className="w-2.5 h-2.5" />
            <span>Connected (/report/)</span>
          </span>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleRefresh}
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-gray-50 hover:bg-gray-100 text-gray-700 border border-gray-200 transition"
            title="Reload report"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-blue-600' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={handleOpenExternal}
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-gray-50 hover:bg-gray-100 text-gray-700 border border-gray-200 transition"
            title="Open in new browser tab"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>Open in Tab</span>
          </button>
        </div>
      </div>

      {/* Embedded Iframe */}
      <div className="flex-1 w-full h-full bg-white relative">
        <iframe
          ref={iframeRef}
          key={lastUpdated}
          src={`/report/index.html?t=${lastUpdated || Date.now()}`}
          className="w-full h-full border-none"
          title="Bionic Editor Web Report"
        />
      </div>
    </div>
  );
};
