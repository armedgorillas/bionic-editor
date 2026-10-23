import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';

interface MarkdownMessageProps {
  content: string;
  compact?: boolean;
}

export const MarkdownMessage: React.FC<MarkdownMessageProps> = ({ content, compact = false }) => {
  return (
    <div className={`markdown-content select-text ${compact ? 'text-[11.5px]' : 'text-xs'} leading-relaxed space-y-2`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="leading-relaxed mb-2 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="text-sm font-bold text-gray-900 mt-2.5 mb-1.5">{children}</h1>,
          h2: ({ children }) => <h2 className="text-xs font-bold text-gray-900 mt-2 mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-xs font-semibold text-gray-900 mt-1.5 mb-1">{children}</h3>,
          h4: ({ children }) => <h4 className="text-[11px] font-semibold text-gray-800 mt-1 mb-0.5">{children}</h4>,
          ul: ({ children }) => <ul className="list-disc pl-4 space-y-0.5 my-1.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-4 space-y-0.5 my-1.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-indigo-400 bg-indigo-50/40 rounded-r pl-2.5 py-1 my-1.5 italic text-gray-700">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 underline hover:text-blue-800 transition"
            >
              {children}
            </a>
          ),
          hr: () => <hr className="my-2.5 border-gray-200" />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2 border border-gray-200 rounded-lg">
              <table className="min-w-full divide-y divide-gray-200 text-[11px] text-left">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-gray-50">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-gray-100 bg-white">{children}</tbody>,
          tr: ({ children }) => <tr className="hover:bg-gray-50/50">{children}</tr>,
          th: ({ children }) => (
            <th className="px-2.5 py-1.5 font-semibold text-gray-700 border-b border-gray-200 whitespace-nowrap">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-2.5 py-1.5 text-gray-700 border-b border-gray-100">
              {children}
            </td>
          ),
          strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className, children, ...props }) => {
            const isInline = !className && typeof children === 'string' && !children.includes('\n');
            if (isInline) {
              return (
                <code
                  className="font-mono text-[11px] bg-gray-100 text-pink-600 px-1 py-0.5 rounded border border-gray-200/60 font-medium"
                  {...props}
                >
                  {children}
                </code>
              );
            }

            // Extract language if specified, e.g. language-python
            const match = /language-(\w+)/.exec(className || '');
            const lang = match ? match[1] : '';
            const codeText = String(children).replace(/\n$/, '');

            return (
              <CodeBlock code={codeText} language={lang} />
            );
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
