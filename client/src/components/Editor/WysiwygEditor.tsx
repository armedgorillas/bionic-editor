import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Code,
  Link as LinkIcon,
  Image as ImageIcon,
  Table as TableIcon,
  CheckCircle2,
  Clock,
  Code2
} from 'lucide-react';
import { API_BASE } from '../../services/api';

interface WysiwygEditorProps {
  filePath: string;
  initialContent: string;
  onSave: (path: string, content: string) => Promise<void>;
  onDirtyChange?: (isDirty: boolean) => void;
  codingMode: boolean;
}

const rawPrefix = `${API_BASE}/files/raw/`;

function resolveRawImageUrl(src: string | null): string | null {
  if (!src) return src;
  if (
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('data:') ||
    src.startsWith(rawPrefix) ||
    src.startsWith('/api/files/raw/')
  ) {
    // Rebase legacy /api/files/raw/ to API_BASE when deployed under a BASE_URL slug
    if (src.startsWith('/api/files/raw/') && rawPrefix !== '/api/files/raw/') {
      return `${rawPrefix}${src.slice('/api/files/raw/'.length)}`;
    }
    return src;
  }
  const cleanPath = src.replace(/^\.\//, '').replace(/^\/+/, '');
  return `${rawPrefix}${cleanPath}`;
}

function stripRawImagePrefix(src: string | null): string | null {
  if (!src) return src;
  if (src.startsWith(rawPrefix)) {
    return src.slice(rawPrefix.length);
  }
  if (src.startsWith('/api/files/raw/')) {
    return src.slice('/api/files/raw/'.length);
  }
  return src;
}

// Custom Image extension: stores clean portable relative paths in Markdown,
// and resolves to ${API_BASE}/files/raw/... only at renderHTML time.
const CustomImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element) => stripRawImagePrefix(element.getAttribute('src')),
        renderHTML: (attributes) => ({
          src: resolveRawImageUrl(attributes.src),
          alt: attributes.alt,
          title: attributes.title
        })
      }
    };
  }
});

export const WysiwygEditor: React.FC<WysiwygEditorProps> = ({
  filePath,
  initialContent,
  onSave,
  onDirtyChange,
  codingMode
}) => {
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [showRawMarkdown, setShowRawMarkdown] = useState<boolean>(false);
  const [rawText, setRawText] = useState<string>(initialContent);
  const saveTimeoutRef = useRef<any>(null);
  const isExternalUpdate = useRef<boolean>(false);
  const saveStatusRef = useRef<'saved' | 'saving' | 'unsaved'>('saved');
  const lastSavedTextRef = useRef<string>(initialContent);
  const latestTextRef = useRef<string>(initialContent);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onSaveRef = useRef(onSave);
  const filePathRef = useRef(filePath);

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
    onSaveRef.current = onSave;
    filePathRef.current = filePath;
  }, [onDirtyChange, onSave, filePath]);

  const updateSaveStatus = useCallback((status: 'saved' | 'saving' | 'unsaved') => {
    saveStatusRef.current = status;
    setSaveStatus(status);
    onDirtyChangeRef.current?.(status !== 'saved');
  }, []);

  // Only run on true unmount — flush any pending unsaved changes instead of discarding them!
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
        if (saveStatusRef.current === 'unsaved' && latestTextRef.current !== lastSavedTextRef.current) {
          onSaveRef.current(filePathRef.current, latestTextRef.current).catch(() => {});
        }
      }
      onDirtyChangeRef.current?.(false);
    };
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3]
        }
      }),
      CustomImage.configure({
        inline: true,
        allowBase64: true
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: 'text-accent underline cursor-pointer hover:opacity-80'
        }
      }),
      Placeholder.configure({
        placeholder: 'Write your scientific plan, research question, or analysis notes...'
      }),
      TableKit.configure({
        table: {
          resizable: true
        }
      }),
      Markdown.configure({
        html: true,
        tightLists: true,
        bulletListMarker: '-',
        linkify: true,
        breaks: false
      })
    ],
    content: initialContent,
    onUpdate: ({ editor: ed }) => {
      if (isExternalUpdate.current) return;
      updateSaveStatus('unsaved');
      const md = (ed.storage as any).markdown?.getMarkdown() || ed.getText();
      latestTextRef.current = md;
      setRawText(md);

      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        updateSaveStatus('saving');
        try {
          lastSavedTextRef.current = md;
          await onSave(filePath, md);
          updateSaveStatus('saved');
        } catch {
          updateSaveStatus('unsaved');
        }
      }, 700);
    }
  });

  // Sync external changes ONLY when editor is clean and content differs from our own last save
  useEffect(() => {
    if (!editor) return;
    if (saveStatusRef.current !== 'saved') return;
    if (initialContent === rawText || initialContent === lastSavedTextRef.current) return;

    isExternalUpdate.current = true;
    (editor.commands as any).setContent(initialContent, { emitUpdate: false });
    setRawText(initialContent);
    lastSavedTextRef.current = initialContent;
    updateSaveStatus('saved');
    setTimeout(() => {
      isExternalUpdate.current = false;
    }, 100);
  }, [initialContent, editor, rawText, updateSaveStatus]);

  const handleRawChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    latestTextRef.current = val;
    setRawText(val);
    updateSaveStatus('unsaved');

    if (editor) {
      isExternalUpdate.current = true;
      (editor.commands as any).setContent(val, { emitUpdate: false });
      setTimeout(() => {
        isExternalUpdate.current = false;
      }, 50);
    }

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      updateSaveStatus('saving');
      try {
        lastSavedTextRef.current = val;
        await onSave(filePath, val);
        updateSaveStatus('saved');
      } catch {
        updateSaveStatus('unsaved');
      }
    }, 700);
  };

  const addImage = useCallback(() => {
    const url = window.prompt('Enter local image path (e.g. figures/volcano_plot.png):', 'figures/volcano_plot.png');
    if (url && editor) {
      const cleanPath = stripRawImagePrefix(url.trim().replace(/^\.\//, ''));
      if (cleanPath) {
        editor.chain().focus().setImage({ src: cleanPath }).run();
      }
    }
  }, [editor]);

  const addLink = useCallback(() => {
    const previousUrl = editor?.getAttributes('link').href;
    const url = window.prompt('Enter URL:', previousUrl || 'https://');
    if (url === null) return;
    if (url === '') {
      editor?.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor?.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  if (!editor) return null;

  const btnClass = (active: boolean) =>
    `p-1.5 rounded transition ${
      active
        ? 'bg-panel text-ink font-semibold ring-1 ring-edge'
        : 'text-muted hover:bg-panel hover:text-ink'
    }`;

  return (
    <div className="flex flex-col h-full bg-surface text-ink overflow-hidden">
      {/* Minimal WYSIWYG Toolbar */}
      <div className="flex items-center justify-between px-6 py-2 border-b border-edge bg-elevated/95 backdrop-blur-sm select-none">
        <div className="flex items-center space-x-1">
          <button
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            className={btnClass(editor.isActive('heading', { level: 1 }))}
            title="Heading 1"
          >
            <Heading1 className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            className={btnClass(editor.isActive('heading', { level: 2 }))}
            title="Heading 2"
          >
            <Heading2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            className={btnClass(editor.isActive('heading', { level: 3 }))}
            title="Heading 3"
          >
            <Heading3 className="w-4 h-4" />
          </button>

          <div className="h-4 w-[1px] bg-edge mx-1" />

          <button
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={btnClass(editor.isActive('bold'))}
            title="Bold (Ctrl+B)"
          >
            <Bold className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={btnClass(editor.isActive('italic'))}
            title="Italic (Ctrl+I)"
          >
            <Italic className="w-4 h-4" />
          </button>

          <div className="h-4 w-[1px] bg-edge mx-1" />

          <button
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            className={btnClass(editor.isActive('bulletList'))}
            title="Bullet List"
          >
            <List className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            className={btnClass(editor.isActive('orderedList'))}
            title="Numbered List"
          >
            <ListOrdered className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            className={btnClass(editor.isActive('blockquote'))}
            title="Quote"
          >
            <Quote className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            className={btnClass(editor.isActive('codeBlock'))}
            title="Code Block"
          >
            <Code className="w-4 h-4" />
          </button>

          <div className="h-4 w-[1px] bg-edge mx-1" />

          <button
            onClick={addLink}
            className={btnClass(editor.isActive('link'))}
            title="Insert Link"
          >
            <LinkIcon className="w-4 h-4" />
          </button>
          <button
            onClick={addImage}
            className={btnClass(false)}
            title="Insert Local Image"
          >
            <ImageIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => (editor.chain().focus() as any).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
            className={btnClass(editor.isActive('table'))}
            title="Insert Table (3x3)"
          >
            <TableIcon className="w-4 h-4" />
          </button>

          {editor.isActive('table') && (
            <div className="flex items-center space-x-1 pl-1 ml-1 border-l border-edge">
              <button
                onClick={() => (editor.chain().focus() as any).addRowAfter().run()}
                className="px-1.5 py-0.5 text-[11px] rounded bg-panel hover:bg-surface border border-edge text-ink font-medium cursor-pointer"
                title="Add Row Below"
              >
                + Row
              </button>
              <button
                onClick={() => (editor.chain().focus() as any).addColumnAfter().run()}
                className="px-1.5 py-0.5 text-[11px] rounded bg-panel hover:bg-surface border border-edge text-ink font-medium cursor-pointer"
                title="Add Column Right"
              >
                + Col
              </button>
              <button
                onClick={() => (editor.chain().focus() as any).deleteRow().run()}
                className="px-1.5 py-0.5 text-[11px] rounded bg-panel hover:bg-surface border border-edge text-ink font-medium cursor-pointer"
                title="Delete Current Row"
              >
                - Row
              </button>
              <button
                onClick={() => (editor.chain().focus() as any).deleteColumn().run()}
                className="px-1.5 py-0.5 text-[11px] rounded bg-panel hover:bg-surface border border-edge text-ink font-medium cursor-pointer"
                title="Delete Current Column"
              >
                - Col
              </button>
              <button
                onClick={() => (editor.chain().focus() as any).deleteTable().run()}
                className="px-1.5 py-0.5 text-[11px] rounded bg-red-50 dark:bg-red-950/60 hover:opacity-90 text-red-600 dark:text-red-300 font-medium cursor-pointer"
                title="Delete Table"
              >
                Del Table
              </button>
            </div>
          )}
        </div>

        {/* Right side: Save indicator & Raw Markdown toggle */}
        <div className="flex items-center space-x-3 text-xs text-muted">
          <div className="flex items-center space-x-1">
            {saveStatus === 'saved' && (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>Saved</span>
              </>
            )}
            {saveStatus === 'saving' && (
              <>
                <Clock className="w-3.5 h-3.5 text-amber-500 animate-spin" />
                <span className="text-amber-600 dark:text-amber-400">Saving...</span>
              </>
            )}
            {saveStatus === 'unsaved' && (
              <>
                <div className="w-2 h-2 rounded-full bg-amber-500" />
                <span>Unsaved changes</span>
              </>
            )}
          </div>

          {(codingMode || showRawMarkdown) && (
            <button
              onClick={() => setShowRawMarkdown(!showRawMarkdown)}
              className={`flex items-center space-x-1 px-2 py-1 rounded text-xs transition border ${
                showRawMarkdown
                  ? 'bg-blue-50 dark:bg-blue-950/60 text-accent border-blue-200 dark:border-blue-800'
                  : 'bg-panel text-muted hover:text-ink border-edge'
              }`}
              title="Toggle Raw Markdown Source"
            >
              <Code2 className="w-3.5 h-3.5" />
              <span>{showRawMarkdown ? 'WYSIWYG View' : 'Raw Markdown'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Editor Content Area */}
      <div className="flex-1 overflow-y-auto px-8 py-8 max-w-4xl w-full mx-auto">
        {showRawMarkdown ? (
          <textarea
            value={rawText}
            onChange={handleRawChange}
            className="w-full h-full font-mono text-sm leading-relaxed p-4 bg-panel text-ink border border-edge rounded-lg outline-none resize-none"
            spellCheck={false}
          />
        ) : (
          <div className="prose max-w-none text-ink">
            <EditorContent editor={editor} />
          </div>
        )}
      </div>
    </div>
  );
};

export const BearEditor = WysiwygEditor;
