import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { CodefleetEpic, CodefleetItem } from '../mcp/types';
import { useCodefleetColors } from '../theme/useCodefleetColors';

type Props = {
  title: string;
  epics: CodefleetEpic[];
  itemsByEpicId: Record<string, CodefleetItem[]>;
  selectedEpicId: string | null;
  onEpicPress: (epic: CodefleetEpic) => void;
};

function normalizeItemStatus(status?: string): string {
  return (status ?? '').trim().toLowerCase();
}

function formatDevelopmentScopes(scopes?: string[]): string {
  if (!scopes || scopes.length === 0) {
    return '-';
  }
  return scopes.join(', ');
}

function buildItemStatusSummary(epicStatus: string | undefined, items: CodefleetItem[]): {
  doneCount: number;
  totalCount: number;
  isLoading: boolean;
} {
  let doneCount = 0;
  const normalizedEpicStatus = normalizeItemStatus(epicStatus);
  const isLoading =
    normalizedEpicStatus === 'in-progress' ||
    normalizedEpicStatus === 'in-review' ||
    normalizedEpicStatus === 'changes-requested';

  for (const item of items) {
    const status = normalizeItemStatus(item.status) || '-';
    if (status === 'done') {
      doneCount += 1;
      continue;
    }
  }

  return {
    doneCount,
    totalCount: items.length,
    isLoading,
  };
}

export function Column({ title, epics, itemsByEpicId, selectedEpicId, onEpicPress }: Props) {
  const colors = useCodefleetColors();
  const textColor = colors.text;
  const subTextColor = colors.mutedText;
  const borderColor = colors.surfaceBorder;
  const bgColor = colors.surface;
  const selectedBg = colors.surfaceSelected;
  const hiddenBg = colors.surfaceBorder;

  return (
    <View style={[styles.column, { borderColor, backgroundColor: bgColor }]}> 
      <View style={styles.header}>
        <Text style={[styles.title, { color: textColor }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.count, { color: subTextColor }]}>{epics.length}</Text>
      </View>
      <View style={styles.list}>
        {epics.length === 0 ? (
          <Text style={[styles.emptyText, { color: subTextColor }]}>No epics</Text>
        ) : (
          epics.map((epic) => {
            const summary = buildItemStatusSummary(epic.status, itemsByEpicId[epic.id] ?? []);
            const isHidden = epic.visibilityState?.isVisible === false;
            return (
              <Pressable
                key={epic.id}
                style={[
                  styles.epicSection,
                  {
                    borderColor,
                    backgroundColor:
                      selectedEpicId === epic.id ? selectedBg : isHidden ? hiddenBg : 'transparent',
                  },
                ]}
                onPress={() => onEpicPress(epic)}
              >
                <View style={styles.idRow}>
                  <View style={styles.idLeft}>
                    {summary.isLoading ? (
                      <ActivityIndicator size="small" color={subTextColor} style={styles.itemStatusSpinner} />
                    ) : null}
                    <Text style={[styles.epicId, { color: subTextColor }]} numberOfLines={1}>
                      {epic.id}
                    </Text>
                  </View>
                  <View style={styles.itemStatusRow}>
                    <Text style={[styles.itemStatusText, { color: subTextColor }]} numberOfLines={1}>
                      {`${summary.doneCount}/${summary.totalCount}`}
                    </Text>
                  </View>
                </View>
                <Text style={[styles.epicTitle, { color: textColor }]} numberOfLines={2}>
                  {epic.title}
                </Text>
                <View style={styles.metaRow}>
                  <Text style={[styles.epicMeta, { color: subTextColor }]}>{epic.status ?? '-'}</Text>
                  <Text style={[styles.epicMeta, { color: subTextColor }]} numberOfLines={1}>
                    {formatDevelopmentScopes(epic.developmentScopes)}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    width: 320,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    flex: 1,
  },
  count: {
    fontSize: 12,
    fontWeight: '700',
  },
  list: {
    gap: 10,
  },
  epicSection: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  epicTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  epicId: {
    fontSize: 11,
  },
  idRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  idLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  epicMeta: {
    fontSize: 11,
    textTransform: 'lowercase',
  },
  itemStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    justifyContent: 'flex-end',
  },
  itemStatusText: {
    fontSize: 11,
    textAlign: 'right',
  },
  itemStatusSpinner: {
    transform: [{ scale: 0.68 }],
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  emptyText: {
    fontSize: 12,
  },
});
