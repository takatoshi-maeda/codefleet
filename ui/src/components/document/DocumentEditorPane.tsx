import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@react-navigation/native';

import { useCodefleetColors } from '../../theme/useCodefleetColors';
import { DocumentCodeEditor } from './DocumentCodeEditor';
import { DocumentFilePreview } from './DocumentFilePreview';
import type { DocumentTreeNode } from './documentTypes';

type Props = {
  openTabs: DocumentTreeNode[];
  activeTabId: string | null;
  activeFile: DocumentTreeNode | null;
  draft: string;
  assetUrl: string | null;
  dirtyTabIds: ReadonlySet<string>;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onChangeDraft: (next: string) => void;
};

function iconNameForNode(node: DocumentTreeNode): keyof typeof Ionicons.glyphMap {
  if (node.language === 'markdown') {
    return 'document-text-outline';
  }
  if (node.language === 'python') {
    return 'logo-python';
  }
  if (node.language === 'image') {
    return 'image-outline';
  }
  if (node.language === 'video') {
    return 'videocam-outline';
  }
  if (node.language === 'pdf') {
    return 'document-attach-outline';
  }
  return 'document-outline';
}

export function DocumentEditorPane({
  openTabs,
  activeTabId,
  activeFile,
  draft,
  assetUrl,
  dirtyTabIds,
  onSelectTab,
  onCloseTab,
  onChangeDraft,
}: Props) {
  const colors = useCodefleetColors();
  const { dark } = useTheme();
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
  const [hoveredCloseTabId, setHoveredCloseTabId] = useState<string | null>(null);
  const shouldInlinePreview =
    activeFile?.language === 'image' ||
    activeFile?.language === 'video' ||
    activeFile?.language === 'pdf' ||
    activeFile?.language === 'binary';

  if (!activeFile) {
    return (
      <View
        style={[
          styles.emptyContainer,
          { backgroundColor: colors.surface, borderColor: colors.surfaceBorder },
        ]}
      >
        <Text style={[styles.emptyTitle, { color: colors.text }]}>ファイルを選択してください</Text>
        <Text style={[styles.emptyBody, { color: colors.mutedText }]}>
          左のエクスプローラーまたはリリース一覧からドキュメントを開けます。
        </Text>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.surface, borderColor: colors.surfaceBorder },
      ]}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.tabStrip, { borderBottomColor: colors.surfaceBorder }]}
        contentContainerStyle={styles.tabStripContent}
      >
        {openTabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isHovered = hoveredTabId === tab.id;
          const isCloseHovered = hoveredCloseTabId === tab.id;
          const isCloseVisible = isHovered || isCloseHovered;
          const isDirty = dirtyTabIds.has(tab.id);
          return (
            <Pressable
              key={tab.id}
              onPress={() => onSelectTab(tab.id)}
              onHoverIn={() => setHoveredTabId(tab.id)}
              onHoverOut={() => setHoveredTabId((current) => (current === tab.id ? null : current))}
              style={[
                styles.tabButton,
                { borderRightColor: colors.surfaceBorder },
                isActive && { backgroundColor: colors.surfaceSelected },
                isActive && { borderBottomColor: colors.tint },
              ]}
            >
              {isDirty ? (
                <Text style={[styles.dirtyIndicator, { color: isActive ? colors.tint : colors.mutedText }]}>
                  *
                </Text>
              ) : (
                <View style={styles.dirtyIndicatorSpacer} />
              )}
              <Ionicons
                name={iconNameForNode(tab)}
                size={14}
                color={isActive ? colors.tint : colors.mutedText}
              />
              <Text
                style={[styles.tabText, { color: isActive ? colors.text : colors.mutedText }]}
                numberOfLines={1}
              >
                {tab.name}
              </Text>
              <Pressable
                onPress={() => onCloseTab(tab.id)}
                onHoverIn={() => setHoveredCloseTabId(tab.id)}
                onHoverOut={() =>
                  setHoveredCloseTabId((current) => (current === tab.id ? null : current))
                }
                hitSlop={8}
                style={[styles.closeButton, !isCloseVisible && styles.closeButtonHidden]}
              >
                <Ionicons name="close" size={14} color={colors.mutedText} />
              </Pressable>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.editorBody}>
        {shouldInlinePreview ? (
          <DocumentFilePreview
            assetUrl={assetUrl}
            language={activeFile.language ?? 'binary'}
            textColor={colors.text}
            mutedTextColor={colors.mutedText}
          />
        ) : (
          <DocumentCodeEditor
            value={draft}
            onChange={onChangeDraft}
            language={activeFile.language ?? 'text'}
            textColor={colors.text}
            mutedTextColor={colors.mutedText}
            backgroundColor={colors.surface}
            borderColor={colors.surfaceBorder}
            isDark={dark}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    borderWidth: 1,
    overflow: 'hidden',
  },
  emptyContainer: {
    flex: 1,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  emptyBody: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  tabStrip: {
    height: 43,
    borderBottomWidth: 1,
    flexGrow: 0,
    flexShrink: 0,
  },
  tabStripContent: {
    paddingHorizontal: 0,
    flexGrow: 0,
  },
  tabButton: {
    minWidth: 140,
    maxWidth: 220,
    height: 43,
    paddingLeft: 12,
    paddingRight: 8,
    margin: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    borderRightWidth: 1,
  },
  tabText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  dirtyIndicator: {
    width: 8,
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 16,
    textAlign: 'center',
  },
  dirtyIndicatorSpacer: {
    width: 8,
    height: 16,
  },
  closeButton: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonHidden: {
    opacity: 0,
  },
  editorBody: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
});
