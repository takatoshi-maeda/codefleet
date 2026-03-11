import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

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

export function DocumentCodeEditor({
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
  },
});
