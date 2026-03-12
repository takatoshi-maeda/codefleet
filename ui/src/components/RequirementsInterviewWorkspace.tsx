import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import type { CodefleetClient } from '../mcp/client';
import { useCodefleetColors } from '../theme/useCodefleetColors';
import { ThreadPane } from './ThreadPane';

type Props = {
  client: CodefleetClient;
};

const WIDE_LAYOUT_BREAKPOINT = 1120;

export function RequirementsInterviewWorkspace({ client }: Props) {
  const colors = useCodefleetColors();
  const { width } = useWindowDimensions();
  const isWide = width >= WIDE_LAYOUT_BREAKPOINT;

  return (
    <View
      style={[
        styles.container,
        isWide ? styles.containerWide : styles.containerStacked,
        { backgroundColor: colors.background },
      ]}
    >
      <View
        style={[
          styles.conversationPane,
          isWide ? [styles.paneWide, styles.conversationPaneWide] : styles.conversationPaneStacked,
          { borderRightColor: colors.surfaceBorder, borderBottomColor: colors.surfaceBorder },
        ]}
      >
        <ThreadPane client={client} title="" agentId="requirements-interviewer" />
      </View>

      <View
        style={[
          styles.artifactsPane,
          isWide ? styles.paneWide : null,
          { backgroundColor: colors.surface },
        ]}
      >
        <View style={[styles.artifactsHeader, { borderBottomColor: colors.surfaceBorder }]}>
          <Text style={[styles.artifactsEyebrow, { color: colors.mutedText }]}>Artifacts</Text>
          <Text style={[styles.artifactsTitle, { color: colors.text }]}>Planned Area</Text>
        </View>
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>Artifacts pane is empty</Text>
          <Text style={[styles.emptyBody, { color: colors.mutedText }]}>
            What appears here will be decided as the workflow takes shape.
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  containerWide: {
    flexDirection: 'row',
  },
  containerStacked: {
    flexDirection: 'column',
  },
  conversationPane: {
    minWidth: 0,
    minHeight: 0,
  },
  conversationPaneWide: {
    borderRightWidth: 1,
  },
  conversationPaneStacked: {
    flex: 1,
    minHeight: 360,
    borderBottomWidth: 1,
  },
  artifactsPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  paneWide: {
    flex: 1,
  },
  artifactsHeader: {
    minHeight: 72,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    justifyContent: 'center',
  },
  artifactsEyebrow: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  artifactsTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyBody: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
});
