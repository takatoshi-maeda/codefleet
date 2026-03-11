import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { Extension } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import { Table } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { Markdown } from '@tiptap/markdown';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import CodeMirror from '@uiw/react-codemirror';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { CSSProperties } from 'react';

type Props = {
  value: string;
  onChange: (next: string) => void;
  language: 'markdown' | 'python' | 'text' | 'image' | 'video' | 'pdf' | 'binary';
  textColor: string;
  mutedTextColor: string;
  backgroundColor: string;
  borderColor: string;
  isDark: boolean;
};

type MarkdownEditorMode = 'live' | 'source';

function extensionForLanguage(language: Props['language']) {
  switch (language) {
    case 'markdown':
      return [markdown()];
    case 'python':
      return [python()];
    default:
      return [];
  }
}

export function DocumentCodeEditor(props: Props) {
  if (props.language === 'markdown') {
    return <DocumentMarkdownEditor {...props} />;
  }

  return <DocumentSourceEditor {...props} />;
}

function DocumentSourceEditor({
  value,
  onChange,
  language,
  textColor,
  mutedTextColor,
  backgroundColor,
  borderColor,
  isDark,
}: Props) {
  const chromeTheme = useMemo(
    () =>
      isDark
        ? null
        : EditorView.theme({
            '&': {
              backgroundColor,
              color: textColor,
            },
            '.cm-content': {
              caretColor: textColor,
              fontFamily: 'monospace',
              fontSize: '14px',
            },
            '.cm-gutters': {
              backgroundColor,
              color: mutedTextColor,
              borderRight: `1px solid ${borderColor}`,
            },
            '.cm-activeLineGutter, .cm-activeLine': {
              backgroundColor: '#00000008',
            },
            '.cm-cursor': {
              borderLeftColor: textColor,
            },
            '.cm-selectionBackground, .cm-content ::selection': {
              backgroundColor: '#0a7ea433',
            },
            '.cm-focused': {
              outline: 'none',
            },
          }),
    [backgroundColor, borderColor, isDark, mutedTextColor, textColor],
  );
  const extensions = useMemo(() => {
    const languageExtensions = extensionForLanguage(language);
    return chromeTheme ? [...languageExtensions, chromeTheme] : languageExtensions;
  }, [chromeTheme, language]);

  return (
    <View style={styles.container}>
      <CodeMirror
        value={value}
        height="100%"
        extensions={extensions}
        theme={isDark ? oneDark : 'light'}
        onChange={onChange}
        basicSetup={{
          foldGutter: false,
          dropCursor: false,
          allowMultipleSelections: false,
        }}
      />
    </View>
  );
}

function DocumentMarkdownEditor({
  value,
  onChange,
  textColor,
  mutedTextColor,
  backgroundColor,
  borderColor,
  isDark,
}: Props) {
  const [mode, setMode] = useState<MarkdownEditorMode>('live');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const shortcutExtension = useMemo(
    () =>
      Extension.create({
        name: 'documentMarkdownShortcuts',
        addKeyboardShortcuts() {
          return {
            'Mod-Alt-1': () => this.editor.chain().focus().toggleHeading({ level: 1 }).run(),
            'Mod-Alt-2': () => this.editor.chain().focus().toggleHeading({ level: 2 }).run(),
            'Mod-Alt-3': () => this.editor.chain().focus().toggleHeading({ level: 3 }).run(),
            'Mod-Alt-7': () => this.editor.chain().focus().toggleOrderedList().run(),
            'Mod-Alt-8': () => this.editor.chain().focus().toggleBulletList().run(),
            'Mod-Alt-9': () => this.editor.chain().focus().toggleTaskList().run(),
            'Mod-Alt-C': () => this.editor.chain().focus().toggleCodeBlock().run(),
            'Mod-Alt-T': () =>
              this.editor
                .chain()
                .focus()
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                .run(),
            'Mod-k': () => {
              promptForLink(this.editor);
              return true;
            },
          };
        },
      }),
    [],
  );

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        codeBlock: {
          HTMLAttributes: {
            class: 'document-markdown-editor__code-block',
          },
        },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: {
            rel: 'noopener noreferrer nofollow',
            target: '_blank',
          },
        },
      }),
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({
        placeholder:
          'Markdown をそのまま保存するライブプレビューです。"/" は不要で、そのまま入力してください。',
      }),
      shortcutExtension,
      // Persisted source remains markdown so the existing save pipeline stays unchanged.
      Markdown.configure({
        indentation: {
          style: 'space',
          size: 2,
        },
      }),
    ],
    [shortcutExtension],
  );

  const editor = useEditor({
    extensions,
    content: value,
    contentType: 'markdown',
    immediatelyRender: true,
    editorProps: {
      attributes: {
        class: 'document-markdown-editor__content tiptap',
        'data-editor-mode': mode,
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      onChangeRef.current(currentEditor.getMarkdown());
    },
  });

  useEffect(() => {
    if (!editor) {
      return;
    }

    const currentValue = editor.getMarkdown();
    if (currentValue === value) {
      return;
    }

    editor.commands.setContent(value, { contentType: 'markdown' });
  }, [editor, value]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.setOptions({
      editorProps: {
        ...(editor.options.editorProps ?? {}),
        attributes: {
          ...editor.options.editorProps?.attributes,
          class: 'document-markdown-editor__content tiptap',
          'data-editor-mode': mode,
        },
      },
    });
  }, [editor, mode]);

  const surfaceTone = isDark
    ? {
        toolbar: '#0f141a',
        panel: '#10161d',
        panelAlt: '#151c25',
        selected: '#17324d',
        selectedBorder: '#35516d',
        inlineCode: '#082f49',
        codeBlock: '#111827',
      }
    : {
        toolbar: '#f5f7fb',
        panel: '#ffffff',
        panelAlt: '#f8fafc',
        selected: '#e0f2fe',
        selectedBorder: '#7dd3fc',
        inlineCode: '#e0f2fe',
        codeBlock: '#eff3f8',
      };

  const shellStyle = useMemo<CSSProperties>(
    () => ({
      ...markdownShellStyle,
      background: backgroundColor,
      color: textColor,
    }),
    [backgroundColor, textColor],
  );

  const topbarStyle = useMemo<CSSProperties>(
    () => ({
      ...markdownTopbarStyle,
      borderBottom: `1px solid ${borderColor}`,
      background: surfaceTone.toolbar,
    }),
    [borderColor, surfaceTone.toolbar],
  );

  const groupStyle = useMemo<CSSProperties>(
    () => ({
      ...markdownButtonGroupStyle,
      background: surfaceTone.panel,
      border: `1px solid ${borderColor}`,
    }),
    [borderColor, surfaceTone.panel],
  );

  const toolbarButtonStyle = useMemo<CSSProperties>(
    () => ({
      border: `1px solid ${borderColor}`,
      background: surfaceTone.panelAlt,
      color: textColor,
      borderRadius: '8px',
      padding: '7px 10px',
      fontSize: '12px',
      fontWeight: 600,
      lineHeight: 1,
      cursor: 'pointer',
    }),
    [borderColor, surfaceTone.panelAlt, textColor],
  );

  const toolbarActiveButtonStyle = useMemo<CSSProperties>(
    () => ({
      background: surfaceTone.selected,
      borderColor: surfaceTone.selectedBorder,
    }),
    [surfaceTone.selected, surfaceTone.selectedBorder],
  );

  const editorSurfaceStyle = useMemo<CSSProperties>(
    () => ({
      ...markdownSurfaceStyle,
      ['--document-editor-border' as string]: borderColor,
      ['--document-editor-muted' as string]: mutedTextColor,
      ['--document-editor-link' as string]: isDark ? '#7dd3fc' : '#0369a1',
      ['--document-editor-selection' as string]: isDark ? '#7dd3fc33' : '#0a7ea433',
      ['--document-editor-inline-code' as string]: surfaceTone.inlineCode,
      ['--document-editor-code-block' as string]: surfaceTone.codeBlock,
      ['--document-editor-panel' as string]: surfaceTone.panel,
      ['--document-editor-panel-alt' as string]: surfaceTone.panelAlt,
    }),
    [
      borderColor,
      isDark,
      mutedTextColor,
      surfaceTone.codeBlock,
      surfaceTone.inlineCode,
      surfaceTone.panel,
      surfaceTone.panelAlt,
    ],
  );

  const showTableTools = Boolean(editor?.isActive('table'));

  if (mode === 'source') {
    return (
      <div style={shellStyle}>
        <style>{markdownEditorCss}</style>
        <div style={topbarStyle}>
          <div style={groupStyle}>
            <ModeButton
              label="Live"
              active={false}
              onClick={() => setMode('live')}
              buttonStyle={toolbarButtonStyle}
              activeStyle={toolbarActiveButtonStyle}
            />
            <ModeButton
              label="Source"
              active
              onClick={() => setMode('source')}
              buttonStyle={toolbarButtonStyle}
              activeStyle={toolbarActiveButtonStyle}
            />
          </div>
        </div>
        <div style={markdownSourceBodyStyle}>
          <DocumentSourceEditor
            value={value}
            onChange={onChange}
            language="markdown"
            textColor={textColor}
            mutedTextColor={mutedTextColor}
            backgroundColor={backgroundColor}
            borderColor={borderColor}
            isDark={isDark}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={shellStyle}>
      <style>{markdownEditorCss}</style>
      <div style={topbarStyle}>
        <div style={groupStyle}>
          <ModeButton
            label="Live"
            active
            onClick={() => setMode('live')}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
          <ModeButton
            label="Source"
            active={false}
            onClick={() => setMode('source')}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
        </div>

        <div style={groupStyle}>
          <ToolbarButton
            editor={editor}
            label="H1"
            title="見出し 1 (Mod+Alt+1)"
            isActive={(currentEditor) => currentEditor.isActive('heading', { level: 1 })}
            onClick={(currentEditor) => currentEditor.chain().focus().toggleHeading({ level: 1 }).run()}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
          <ToolbarButton
            editor={editor}
            label="H2"
            title="見出し 2 (Mod+Alt+2)"
            isActive={(currentEditor) => currentEditor.isActive('heading', { level: 2 })}
            onClick={(currentEditor) => currentEditor.chain().focus().toggleHeading({ level: 2 }).run()}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
          <ToolbarButton
            editor={editor}
            label="H3"
            title="見出し 3 (Mod+Alt+3)"
            isActive={(currentEditor) => currentEditor.isActive('heading', { level: 3 })}
            onClick={(currentEditor) => currentEditor.chain().focus().toggleHeading({ level: 3 }).run()}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
          <ToolbarButton
            editor={editor}
            label="B"
            title="太字 (Mod+B)"
            isActive={(currentEditor) => currentEditor.isActive('bold')}
            onClick={(currentEditor) => currentEditor.chain().focus().toggleBold().run()}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
          <ToolbarButton
            editor={editor}
            label="I"
            title="斜体 (Mod+I)"
            isActive={(currentEditor) => currentEditor.isActive('italic')}
            onClick={(currentEditor) => currentEditor.chain().focus().toggleItalic().run()}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
          <ToolbarButton
            editor={editor}
            label="S"
            title="打ち消し"
            isActive={(currentEditor) => currentEditor.isActive('strike')}
            onClick={(currentEditor) => currentEditor.chain().focus().toggleStrike().run()}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
        </div>

        <div style={groupStyle}>
          <ToolbarButton
            editor={editor}
            label="UL"
            title="箇条書き (Mod+Alt+8)"
            isActive={(currentEditor) => currentEditor.isActive('bulletList')}
            onClick={(currentEditor) => currentEditor.chain().focus().toggleBulletList().run()}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
          <ToolbarButton
            editor={editor}
            label="OL"
            title="番号付きリスト (Mod+Alt+7)"
            isActive={(currentEditor) => currentEditor.isActive('orderedList')}
            onClick={(currentEditor) => currentEditor.chain().focus().toggleOrderedList().run()}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
          <ToolbarButton
            editor={editor}
            label="Task"
            title="チェックリスト (Mod+Alt+9)"
            isActive={(currentEditor) => currentEditor.isActive('taskList')}
            onClick={(currentEditor) => currentEditor.chain().focus().toggleTaskList().run()}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
          <ToolbarButton
            editor={editor}
            label="Quote"
            title="引用"
            isActive={(currentEditor) => currentEditor.isActive('blockquote')}
            onClick={(currentEditor) => currentEditor.chain().focus().toggleBlockquote().run()}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
          <ToolbarButton
            editor={editor}
            label="Code"
            title="コードブロック (Mod+Alt+C)"
            isActive={(currentEditor) => currentEditor.isActive('codeBlock')}
            onClick={(currentEditor) => currentEditor.chain().focus().toggleCodeBlock().run()}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
          <ToolbarButton
            editor={editor}
            label="Link"
            title="リンク (Mod+K)"
            isActive={(currentEditor) => currentEditor.isActive('link')}
            onClick={promptForLink}
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
        </div>

        <div style={groupStyle}>
          <ToolbarButton
            editor={editor}
            label="Table"
            title="3x3 の表を挿入 (Mod+Alt+T)"
            isActive={(currentEditor) => currentEditor.isActive('table')}
            onClick={(currentEditor) =>
              currentEditor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
            }
            buttonStyle={toolbarButtonStyle}
            activeStyle={toolbarActiveButtonStyle}
          />
          {showTableTools ? (
            <>
              <ToolbarButton
                editor={editor}
                label="+Row"
                title="行を追加"
                isActive={() => false}
                onClick={(currentEditor) => currentEditor.chain().focus().addRowAfter().run()}
                buttonStyle={toolbarButtonStyle}
                activeStyle={toolbarActiveButtonStyle}
              />
              <ToolbarButton
                editor={editor}
                label="+Col"
                title="列を追加"
                isActive={() => false}
                onClick={(currentEditor) => currentEditor.chain().focus().addColumnAfter().run()}
                buttonStyle={toolbarButtonStyle}
                activeStyle={toolbarActiveButtonStyle}
              />
              <ToolbarButton
                editor={editor}
                label="-Row"
                title="行を削除"
                isActive={() => false}
                onClick={(currentEditor) => currentEditor.chain().focus().deleteRow().run()}
                buttonStyle={toolbarButtonStyle}
                activeStyle={toolbarActiveButtonStyle}
              />
              <ToolbarButton
                editor={editor}
                label="-Col"
                title="列を削除"
                isActive={() => false}
                onClick={(currentEditor) => currentEditor.chain().focus().deleteColumn().run()}
                buttonStyle={toolbarButtonStyle}
                activeStyle={toolbarActiveButtonStyle}
              />
              <ToolbarButton
                editor={editor}
                label="Header"
                title="ヘッダー行の切り替え"
                isActive={() => false}
                onClick={(currentEditor) => currentEditor.chain().focus().toggleHeaderRow().run()}
                buttonStyle={toolbarButtonStyle}
                activeStyle={toolbarActiveButtonStyle}
              />
              <ToolbarButton
                editor={editor}
                label="Drop"
                title="表を削除"
                isActive={() => false}
                onClick={(currentEditor) => currentEditor.chain().focus().deleteTable().run()}
                buttonStyle={toolbarButtonStyle}
                activeStyle={toolbarActiveButtonStyle}
              />
            </>
          ) : null}
        </div>
      </div>

      <div style={editorSurfaceStyle}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

type ToolbarButtonProps = {
  editor: Editor | null;
  label: string;
  title: string;
  isActive: (editor: Editor) => boolean;
  onClick: (editor: Editor) => void;
  buttonStyle: CSSProperties;
  activeStyle: CSSProperties;
};

type ModeButtonProps = {
  label: string;
  active: boolean;
  onClick: () => void;
  buttonStyle: CSSProperties;
  activeStyle: CSSProperties;
};

function ToolbarButton({
  editor,
  label,
  title,
  isActive,
  onClick,
  buttonStyle,
  activeStyle,
}: ToolbarButtonProps) {
  const active = editor ? isActive(editor) : false;

  return (
    <button
      type="button"
      title={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!editor) {
          return;
        }

        onClick(editor);
      }}
      style={active ? { ...buttonStyle, ...activeStyle } : buttonStyle}
    >
      {label}
    </button>
  );
}

function ModeButton({ label, active, onClick, buttonStyle, activeStyle }: ModeButtonProps) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      style={active ? { ...buttonStyle, ...activeStyle } : buttonStyle}
    >
      {label}
    </button>
  );
}

function promptForLink(editor: Editor) {
  const previousUrl = editor.getAttributes('link').href as string | undefined;
  const nextUrl = window.prompt('リンクURLを入力してください', previousUrl ?? 'https://');

  if (nextUrl === null) {
    return;
  }

  if (nextUrl.trim().length === 0) {
    editor.chain().focus().unsetLink().run();
    return;
  }

  editor.chain().focus().extendMarkRange('link').setLink({ href: nextUrl.trim() }).run();
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
  },
});

const markdownShellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  minHeight: 0,
};

const markdownTopbarStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '10px',
  padding: '10px 12px',
};

const markdownButtonGroupStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
  padding: '6px',
  borderRadius: '12px',
};

const markdownSourceBodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
};

const markdownSurfaceStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: '20px 24px 80px',
};

const markdownEditorCss = `
.document-markdown-editor__content {
  min-height: 100%;
}

.document-markdown-editor__content.tiptap,
.document-markdown-editor__content .tiptap {
  max-width: 860px;
  min-height: 100%;
  margin: 0 auto;
  padding: 28px 36px 48px;
  border: 1px solid var(--document-editor-border);
  border-radius: 16px;
  background: var(--document-editor-panel);
  box-sizing: border-box;
  outline: none;
  font-size: 15px;
  line-height: 1.75;
  white-space: pre-wrap;
  box-shadow: 0 18px 40px -28px rgba(15, 23, 42, 0.45);
}

.document-markdown-editor__content.tiptap :first-child,
.document-markdown-editor__content .tiptap :first-child {
  margin-top: 0;
}

.document-markdown-editor__content.tiptap p,
.document-markdown-editor__content.tiptap ul,
.document-markdown-editor__content.tiptap ol,
.document-markdown-editor__content.tiptap blockquote,
.document-markdown-editor__content.tiptap pre,
.document-markdown-editor__content.tiptap table,
.document-markdown-editor__content .tiptap p,
.document-markdown-editor__content .tiptap ul,
.document-markdown-editor__content .tiptap ol,
.document-markdown-editor__content .tiptap blockquote,
.document-markdown-editor__content .tiptap pre,
.document-markdown-editor__content .tiptap table {
  margin: 0 0 1em;
}

.document-markdown-editor__content.tiptap h1,
.document-markdown-editor__content.tiptap h2,
.document-markdown-editor__content.tiptap h3,
.document-markdown-editor__content .tiptap h1,
.document-markdown-editor__content .tiptap h2,
.document-markdown-editor__content .tiptap h3 {
  line-height: 1.2;
  margin: 1.4em 0 0.6em;
}

.document-markdown-editor__content.tiptap h1,
.document-markdown-editor__content .tiptap h1 {
  font-size: 2rem;
}

.document-markdown-editor__content.tiptap h2,
.document-markdown-editor__content .tiptap h2 {
  font-size: 1.5rem;
}

.document-markdown-editor__content.tiptap ul,
.document-markdown-editor__content.tiptap ol,
.document-markdown-editor__content .tiptap ul,
.document-markdown-editor__content .tiptap ol {
  padding-left: 1.5em;
}

.document-markdown-editor__content.tiptap ul[data-type="taskList"],
.document-markdown-editor__content .tiptap ul[data-type="taskList"] {
  list-style: none;
  padding-left: 0.25em;
}

.document-markdown-editor__content.tiptap ul[data-type="taskList"] li,
.document-markdown-editor__content .tiptap ul[data-type="taskList"] li {
  display: flex;
  align-items: flex-start;
  gap: 0.55em;
}

.document-markdown-editor__content.tiptap ul[data-type="taskList"] li > label,
.document-markdown-editor__content .tiptap ul[data-type="taskList"] li > label {
  margin-top: 0.35em;
}

.document-markdown-editor__content.tiptap ul[data-type="taskList"] li > div,
.document-markdown-editor__content .tiptap ul[data-type="taskList"] li > div {
  flex: 1;
}

.document-markdown-editor__content.tiptap blockquote,
.document-markdown-editor__content .tiptap blockquote {
  border-left: 4px solid var(--document-editor-border);
  padding-left: 1em;
  color: var(--document-editor-muted);
}

.document-markdown-editor__content.tiptap code,
.document-markdown-editor__content .tiptap code {
  background: var(--document-editor-inline-code);
  border-radius: 6px;
  padding: 0.15em 0.35em;
  font-size: 0.92em;
}

.document-markdown-editor__content.tiptap pre,
.document-markdown-editor__content .tiptap pre {
  background: var(--document-editor-code-block);
  border-radius: 12px;
  padding: 14px 16px;
  overflow-x: auto;
}

.document-markdown-editor__content.tiptap pre code,
.document-markdown-editor__content .tiptap pre code {
  background: transparent;
  padding: 0;
}

.document-markdown-editor__content.tiptap a,
.document-markdown-editor__content .tiptap a {
  color: var(--document-editor-link);
  text-decoration: underline;
}

.document-markdown-editor__content.tiptap table,
.document-markdown-editor__content .tiptap table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
  overflow: hidden;
  border: 1px solid var(--document-editor-border);
  border-radius: 12px;
  background: var(--document-editor-panel);
}

.document-markdown-editor__content.tiptap .tableWrapper,
.document-markdown-editor__content .tiptap .tableWrapper {
  margin: 0 0 1em;
  overflow-x: auto;
}

.document-markdown-editor__content.tiptap .tableWrapper table,
.document-markdown-editor__content .tiptap .tableWrapper table {
  margin: 0;
}

.document-markdown-editor__content.tiptap table th,
.document-markdown-editor__content.tiptap table td,
.document-markdown-editor__content .tiptap table th,
.document-markdown-editor__content .tiptap table td {
  position: relative;
  min-width: 80px;
  border-right: 1px solid var(--document-editor-border) !important;
  border-bottom: 1px solid var(--document-editor-border) !important;
  padding: 10px 12px;
  vertical-align: top;
  background: var(--document-editor-panel);
}

.document-markdown-editor__content.tiptap table tr > *:last-child,
.document-markdown-editor__content .tiptap table tr > *:last-child {
  border-right: none !important;
}

.document-markdown-editor__content.tiptap table tbody tr:last-child > *,
.document-markdown-editor__content .tiptap table tbody tr:last-child > * {
  border-bottom: none !important;
}

.document-markdown-editor__content.tiptap table th,
.document-markdown-editor__content .tiptap table th {
  background: var(--document-editor-panel-alt);
  font-weight: 700;
}

.document-markdown-editor__content.tiptap .selectedCell::after,
.document-markdown-editor__content .tiptap .selectedCell::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--document-editor-selection);
  pointer-events: none;
}

.document-markdown-editor__content.tiptap .column-resize-handle,
.document-markdown-editor__content .tiptap .column-resize-handle {
  position: absolute;
  top: 0;
  right: -2px;
  bottom: 0;
  width: 4px;
  background: var(--document-editor-link);
  pointer-events: none;
}

.document-markdown-editor__content.tiptap p.is-editor-empty:first-child::before,
.document-markdown-editor__content .tiptap p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  color: var(--document-editor-muted);
  float: left;
  height: 0;
  pointer-events: none;
}

.document-markdown-editor__content.tiptap ::selection,
.document-markdown-editor__content .tiptap ::selection {
  background: var(--document-editor-selection);
}

.document-markdown-editor__content.tiptap.ProseMirror-focused,
.document-markdown-editor__content .tiptap.ProseMirror-focused {
  outline: none;
}

@media (max-width: 900px) {
  .document-markdown-editor__content.tiptap,
  .document-markdown-editor__content .tiptap {
    padding: 22px 18px 36px;
    border-radius: 12px;
  }
}
`;
