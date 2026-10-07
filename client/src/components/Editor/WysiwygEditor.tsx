import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
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
  CheckCircle2,
  Clock,
  Code2
} from 'lucide-react';

interface WysiwygEditorProps {
  filePath: string;
  initialContent: string;
  onSave: (path: string, content: string) => Promise<void>;
  codingMode: boolean;
}

// Custom Image extension to resolve local relative paths to /api/files/raw/...
const CustomImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: element => {
          const src = element.getAttribute('src');
          if (src && !src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('/api/files/raw/')) {
            const cleanPath = src.replace(/^\.\//, '');
            return `/api/files/raw/${cleanPath}`;
          }
          return src;
        },
        renderHTML: attributes => {
          let src = attributes.src;
          if (src && !src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('/api/files/raw/')) {
            const cleanPath = src.replace(/^\.\//, '');
            src = `/api/files/raw/${cleanPath}`;
          }
          return {
            src,
            alt: attributes.alt,
            title: attributes.title,
          };
        },
      },
    };
  },
});

export const WysiwygEditor: React.FC<WysiwygEditorProps> = ({
  filePath,
  initialContent,
  onSave,
  codingMode
}) => {
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [showRawMarkdown, setShowRawMarkdown] = useState<boolean>(false);
  const [rawText, setRawText] = useState<string>(initialContent);
  const saveTimeoutRef = useRef<any>(null);
  const isExternalUpdate = useRef<boolean>(false);

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
          class: 'text-blue-600 underline cursor-pointer hover:text-blue-800'
        }
      }),
      Placeholder.configure({
        placeholder: 'Write your scientific experiment notes or instructions...'
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
    onUpdate: ({ editor }) => {
      if (isExternalUpdate.current) return;
      setSaveStatus('unsaved');
      const md = (editor.storage as any).markdown?.getMarkdown() || editor.getText();
      setRawText(md);

      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        setSaveStatus('saving');
        try {
          await onSave(filePath, md);
          setSaveStatus('saved');
        } catch (e) {
          setSaveStatus('unsaved');
        }
      }, 700);
    }
  });

  // Sync external changes (e.g., when agent updates SPEC.md or user switches files)
  useEffect(() => {
    if (editor && initialContent !== rawText) {
      isExternalUpdate.current = true;
      (editor.commands as any).setContent(initialContent, { emitUpdate: false });
      setRawText(initialContent);
      setSaveStatus('saved');
      setTimeout(() => {
        isExternalUpdate.current = false;
      }, 100);
    }
  }, [initialContent, editor]);

  // Handle raw markdown editor direct editing
  const handleRawChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setRawText(val);
    setSaveStatus('unsaved');

    if (editor) {
      isExternalUpdate.current = true;
      (editor.commands as any).setContent(val, { emitUpdate: false });
      setTimeout(() => { isExternalUpdate.current = false; }, 50);
    }

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        await onSave(filePath, val);
        setSaveStatus('saved');
      } catch (e) {
        setSaveStatus('unsaved');
      }
    }, 700);
  };

  const addImage = useCallback(() => {
    const url = window.prompt('Enter local image path (e.g. figures/volcano_plot.png):', 'figures/volcano_plot.png');
    if (url && editor) {
      const cleanUrl = url.replace(/^\.\//, '');
      const fullUrl = cleanUrl.startsWith('http') ? cleanUrl : `/api/files/raw/${cleanUrl}`;
      editor.chain().focus().setImage({ src: fullUrl }).run();
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

  return (
    <div className="flex flex-col h-full bg-[#fdfdfd] overflow-hidden">
      {/* Minimal WYSIWYG Toolbar */}
      <div className="flex items-center justify-between px-6 py-2 border-b border-gray-200/80 bg-white/95 backdrop-blur-sm select-none">
        <div className="flex items-center space-x-1 text-gray-600">
          <button
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            className={`p-1.5 rounded hover:bg-gray-100 ${editor.isActive('heading', { level: 1 }) ? 'bg-gray-200 text-gray-900 font-bold' : ''}`}
            title="Heading 1"
          >
            <Heading1 className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            className={`p-1.5 rounded hover:bg-gray-100 ${editor.isActive('heading', { level: 2 }) ? 'bg-gray-200 text-gray-900 font-bold' : ''}`}
            title="Heading 2"
          >
            <Heading2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            className={`p-1.5 rounded hover:bg-gray-100 ${editor.isActive('heading', { level: 3 }) ? 'bg-gray-200 text-gray-900 font-bold' : ''}`}
            title="Heading 3"
          >
            <Heading3 className="w-4 h-4" />
          </button>

          <div className="h-4 w-[1px] bg-gray-200 mx-1" />

          <button
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={`p-1.5 rounded hover:bg-gray-100 ${editor.isActive('bold') ? 'bg-gray-200 text-gray-900 font-bold' : ''}`}
            title="Bold (Ctrl+B)"
          >
            <Bold className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={`p-1.5 rounded hover:bg-gray-100 ${editor.isActive('italic') ? 'bg-gray-200 text-gray-900 italic' : ''}`}
            title="Italic (Ctrl+I)"
          >
            <Italic className="w-4 h-4" />
          </button>

          <div className="h-4 w-[1px] bg-gray-200 mx-1" />

          <button
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            className={`p-1.5 rounded hover:bg-gray-100 ${editor.isActive('bulletList') ? 'bg-gray-200 text-gray-900' : ''}`}
            title="Bullet List"
          >
            <List className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            className={`p-1.5 rounded hover:bg-gray-100 ${editor.isActive('orderedList') ? 'bg-gray-200 text-gray-900' : ''}`}
            title="Numbered List"
          >
            <ListOrdered className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            className={`p-1.5 rounded hover:bg-gray-100 ${editor.isActive('blockquote') ? 'bg-gray-200 text-gray-900' : ''}`}
            title="Quote"
          >
            <Quote className="w-4 h-4" />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            className={`p-1.5 rounded hover:bg-gray-100 ${editor.isActive('codeBlock') ? 'bg-gray-200 text-gray-900' : ''}`}
            title="Code Block"
          >
            <Code className="w-4 h-4" />
          </button>

          <div className="h-4 w-[1px] bg-gray-200 mx-1" />

          <button
            onClick={addLink}
            className={`p-1.5 rounded hover:bg-gray-100 ${editor.isActive('link') ? 'bg-gray-200 text-blue-600' : ''}`}
            title="Insert Link"
          >
            <LinkIcon className="w-4 h-4" />
          </button>
          <button
            onClick={addImage}
            className="p-1.5 rounded hover:bg-gray-100 hover:text-gray-900"
            title="Insert Local Image"
          >
            <ImageIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Right side: Save indicator & Raw Markdown toggle */}
        <div className="flex items-center space-x-3 text-xs text-gray-500">
          <div className="flex items-center space-x-1">
            {saveStatus === 'saved' && (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                <span className="text-gray-500">Saved</span>
              </>
            )}
            {saveStatus === 'saving' && (
              <>
                <Clock className="w-3.5 h-3.5 text-amber-500 animate-spin" />
                <span className="text-amber-600">Saving...</span>
              </>
            )}
            {saveStatus === 'unsaved' && (
              <>
                <div className="w-2 h-2 rounded-full bg-amber-500" />
                <span className="text-gray-500">Unsaved changes</span>
              </>
            )}
          </div>

          {(codingMode || showRawMarkdown) && (
            <button
              onClick={() => setShowRawMarkdown(!showRawMarkdown)}
              className={`flex items-center space-x-1 px-2 py-1 rounded text-xs transition border ${
                showRawMarkdown 
                  ? 'bg-blue-50 text-blue-700 border-blue-200' 
                  : 'bg-gray-50 text-gray-600 hover:bg-gray-100 border-gray-200'
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
            className="w-full h-full font-mono text-sm leading-relaxed p-4 bg-gray-50 text-gray-800 border border-gray-200 rounded-lg outline-none resize-none"
            spellCheck={false}
          />
        ) : (
          <div className="prose max-w-none text-gray-800">
            <EditorContent editor={editor} />
          </div>
        )}
      </div>
    </div>
  );
};

export const BearEditor = WysiwygEditor;
