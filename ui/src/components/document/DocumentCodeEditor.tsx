import { Platform, StyleSheet, TextInput } from 'react-native';

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

export function DocumentCodeEditor({ value, onChange, textColor, mutedTextColor }: Props) {
  return (
    <TextInput
      multiline
      value={value}
      onChangeText={onChange}
      style={[
        styles.editorInput,
        Platform.OS === 'web' ? styles.editorInputWeb : null,
        { color: textColor },
      ]}
      placeholder="Mock editor"
      placeholderTextColor={mutedTextColor}
      textAlignVertical="top"
      scrollEnabled
    />
  );
}

const styles = StyleSheet.create({
  editorInput: {
    height: '100%',
    paddingHorizontal: 18,
    paddingVertical: 16,
    fontSize: 14,
    lineHeight: 22,
    fontFamily: 'monospace',
  },
  editorInputWeb: {
    outlineWidth: 0,
    outlineColor: 'transparent',
  },
});
