import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check, FileText } from 'lucide-react';

interface MarkdownMessageProps {
  content: string;
  compact?: boolean;
  onOpenFile?: (path: string) => void;
  workspacePaths?: Set<string>;
}

function normalizeCandidatePath(raw: string): string {
  const withoutHashOrQuery = raw.trim().split('#')[0].split('?')[0];
  let decoded = withoutHashOrQuery;
  try {
    decoded = decodeURIComponent(withoutHashOrQuery);
  } catch {}
  return decoded.replace(/^\.\//, '').replace(/^\/+/, '');
}

function isRelativeWorkspaceHref(href: string): boolean {
  if (!href) return false;
  const trimmed = href.trim();
  if (trimmed.startsWith('//')) return false;
  if (/^(https?:|mailto:|tel:|#|data:|javascript:|vbscript:)/i.test(trimmed)) return false;
  return true;
}

export const MarkdownMessage: React.FC<MarkdownMessageProps> = ({
  content,
  compact = false,
  onOpenFile,
  workspacePaths
}) => {
  const resolveWorkspacePath = (raw: string): string | null => {
    if (!onOpenFile) return null;
    const candidate = normalizeCandidatePath(raw);
    if (!candidate || candidate.includes('..')) return null;
    if (workspacePaths && workspacePaths.has(candidate)) {
      return candidate;
    }
    // Also recognize newly written .md files even before tree refresh completes
    if (!candidate.includes(' ') && /^[a-zA-Z0-9_./-]+\.md$/i.test(candidate)) {
      return candidate;
    }
    return null;
  };

  return (
    <div className={`markdown-content select-text ${compact ? 'text-[11.5px]' : 'text-xs'} leading-relaxed space-y-2 text-ink`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="leading-relaxed mb-2 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="text-sm font-bold text-ink mt-2.5 mb-1.5">{children}</h1>,
          h2: ({ children }) => <h2 className="text-xs font-bold text-ink mt-2 mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-xs font-semibold text-ink mt-1.5 mb-1">{children}</h3>,
          h4: ({ children }) => <h4 className="text-[11px] font-semibold text-ink mt-1 mb-0.5">{children}</h4>,
          ul: ({ children }) => <ul className="list-disc pl-4 space-y-0.5 my-1.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-4 space-y-0.5 my-1.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-indigo-400 bg-indigo-50/40 dark:bg-indigo-950/30 rounded-r pl-2.5 py-1 my-1.5 italic text-muted">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => {
            if (href && isRelativeWorkspaceHref(href) && onOpenFile) {
              const target = normalizeCandidatePath(href.split('#')[0]);
              return (
                <button
                  type="button"
                  onClick={() => onOpenFile(target)}
                  className="inline-flex items-center space-x-1 text-accent underline hover:opacity-80 transition cursor-pointer align-baseline"
                  title={`Open ${target} in editor`}
                >
                  <span>{children}</span>
                </button>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline hover:opacity-80 transition"
              >
                {children}
              </a>
            );
          },
          hr: () => <hr className="my-2.5 border-edge" />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2 border border-edge rounded-lg">
              <table className="min-w-full divide-y divide-edge text-[11px] text-left">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-panel">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-edge bg-surface">{children}</tbody>,
          tr: ({ children }) => <tr className="hover:bg-panel/60">{children}</tr>,
          th: ({ children }) => (
            <th className="px-2.5 py-1.5 font-semibold text-ink border-b border-edge whitespace-nowrap">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-2.5 py-1.5 text-ink border-b border-edge/60">
              {children}
            </td>
          ),
          strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className, children, ...props }) => {
            const isInline = !className && typeof children === 'string' && !children.includes('\n');
            if (isInline) {
              const rawText = String(children);
              const matchedFile = resolveWorkspacePath(rawText);
              if (matchedFile && onOpenFile) {
                return (
                  <button
                    type="button"
                    onClick={() => onOpenFile(matchedFile)}
                    className="inline-flex items-center space-x-1 font-mono text-[11px] bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/60 font-medium transition cursor-pointer align-baseline"
                    title={`Open ${matchedFile} in editor`}
                  >
                    <FileText className="w-2.5 h-2.5 flex-shrink-0" />
                    <span>{rawText}</span>
                  </button>
                );
              }

              return (
                <code
                  className="font-mono text-[11px] bg-panel text-pink-600 dark:text-orange-300 px-1 py-0.5 rounded border border-edge font-medium"
                  {...props}
                >
                  {children}
                </code>
              );
            }

            const match = /language-(\w+)/.exec(className || '');
            const lang = match ? match[1] : '';
            const codeText = String(children).replace(/\n$/, '');

            return <CodeBlock code={codeText} language={lang} />;
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

const CodeBlock: React.FC<{ code: string; language: string }> = ({ code, language }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-2 rounded-lg bg-[#18181b] border border-[#27272a] overflow-hidden text-gray-100 shadow-xs">
      <div className="flex items-center justify-between px-3 py-1 bg-[#202024] border-b border-[#2d2d32] text-[10px] text-gray-400 font-mono">
        <span>{language || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center space-x-1 hover:text-gray-200 px-1.5 py-0.5 rounded hover:bg-[#2c2c32] transition cursor-pointer"
          title="Copy code"
        >
          {copied ? (
            <>
              <Check className="w-2.5 h-2.5 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-2.5 h-2.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-3 text-[11px] font-mono overflow-x-auto leading-relaxed select-text">
        <code>{code}</code>
      </pre>
    </div>
  );
};
