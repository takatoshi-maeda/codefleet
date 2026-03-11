import { Platform, StyleSheet, Text, View } from 'react-native';
import type { CSSProperties } from 'react';

type Props = {
  assetUrl: string | null;
  language: 'markdown' | 'python' | 'text' | 'image' | 'video' | 'pdf' | 'binary';
  textColor: string;
  mutedTextColor: string;
};

export function DocumentFilePreview({ assetUrl, language, mutedTextColor }: Props) {
  if (Platform.OS === 'web') {
    return renderWebPreview({ assetUrl, language, mutedTextColor });
  }

  return (
    <View style={styles.unsupported}>
      <Text style={[styles.unsupportedTitle, { color: mutedTextColor }]}>
        {language === 'binary' ? 'このファイルはプレビューできません' : 'このプラットフォームではインライン表示に未対応です'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  unsupported: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  unsupportedTitle: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
});

function renderWebPreview({
  assetUrl,
  language,
  mutedTextColor,
}: Pick<Props, 'assetUrl' | 'language' | 'mutedTextColor'>) {
  if (!assetUrl) {
    return <div style={{ ...centeredStyle, color: mutedTextColor }}>プレビューを読み込めませんでした。</div>;
  }

  if (language === 'image') {
    return (
      <div style={centeredStyle}>
        <img
          src={assetUrl}
          alt=""
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
        />
      </div>
    );
  }

  if (language === 'video') {
    return <video src={assetUrl} style={{ ...frameStyle, background: '#000' }} controls playsInline />;
  }

  if (language === 'pdf') {
    return <iframe src={assetUrl} style={frameStyle} title="PDF preview" />;
  }

  return <div style={{ ...centeredStyle, color: mutedTextColor }}>このファイルはプレビューできません。</div>;
}

const frameStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  border: 'none',
  display: 'block',
};

const centeredStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px',
  boxSizing: 'border-box',
};
