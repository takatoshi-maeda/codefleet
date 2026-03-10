import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { decodeCodefleetWatchNotification } from '../mcp/decoders';
import type { CodefleetClient } from '../mcp/client';
import type { CodefleetEpic, CodefleetFleetAgent, CodefleetItem } from '../mcp/types';
import { useCodefleetColors } from '../theme/useCodefleetColors';
import { Column } from './Column';
import {
  formatCodefleetTimestamp,
  formatExecutionDuration,
  formatStatusTimestamp,
  getStatusTimeline,
} from './statusTiming';

type Props = {
  client: CodefleetClient;
  epics: CodefleetEpic[];
  itemsByEpicId: Record<string, CodefleetItem[]>;
  isLoading: boolean;
  errorMessage: string | null;
  showDashboard?: boolean;
  onCloseDashboard?: () => void;
  onBacklogChanged?: () => Promise<void> | void;
  onDashboardActivityChange?: (hasActiveAgents: boolean) => void;
};

type BoardStatusColumn = {
  key: 'todo' | 'in-progress' | 'failed' | 'done';
  title: 'Todo' | 'In Progress' | 'Failed' | 'Done';
};

const WIDE_BREAKPOINT = 960;

const STATUS_COLUMNS: BoardStatusColumn[] = [
  { key: 'todo', title: 'Todo' },
  { key: 'in-progress', title: 'In Progress' },
  { key: 'failed', title: 'Failed' },
  { key: 'done', title: 'Done' },
];
const CONSOLE_HEADER_TOP_PADDING = 5;
const CONSOLE_LOG_LIMIT_PER_AGENT = 300;
const CONSOLE_STREAM_RECONNECT_DELAY_MS = 1200;
const CONSOLE_LOG_BOTTOM_THRESHOLD_PX = 20;
const BACKLOG_REFRESH_DEBOUNCE_MS = 300;

function normalizeAgent(agent: CodefleetFleetAgent): CodefleetFleetAgent {
  if (!agent.busy && agent.status.toLowerCase() === 'running') {
    return { ...agent, status: 'idle' };
  }
  return agent;
}

function flattenAgents(roles: { agents: CodefleetFleetAgent[] }[]): CodefleetFleetAgent[] {
  const byAgentId = new Map<string, CodefleetFleetAgent>();
  for (const role of roles) {
    for (const agent of role.agents) {
      byAgentId.set(agent.agentId, normalizeAgent(agent));
    }
  }
  return Array.from(byAgentId.values()).sort((a, b) => a.agentId.localeCompare(b.agentId));
}

function toStatusColumnKey(status?: string): BoardStatusColumn['key'] {
  const normalized = (status ?? '').trim().toLowerCase();
  if (normalized === 'done') return 'done';
  if (normalized === 'failed') return 'failed';
  if (
    normalized === 'in-progress' ||
    normalized === 'in-review' ||
    normalized === 'changes-requested'
  ) {
    return 'in-progress';
  }
  return 'todo';
}

function groupEpicsByStatus(epics: CodefleetEpic[]): Record<BoardStatusColumn['key'], CodefleetEpic[]> {
  const grouped: Record<BoardStatusColumn['key'], CodefleetEpic[]> = {
    todo: [],
    'in-progress': [],
    failed: [],
    done: [],
  };

  for (const epic of epics) {
    grouped[toStatusColumnKey(epic.status)].push(epic);
  }

  return grouped;
}

function formatNoteDate(value?: string): string | null {
  return formatCodefleetTimestamp(value);
}

function formatDate(value?: string): string {
  return formatCodefleetTimestamp(value) ?? '-';
}

function formatEpicVisibility(epic: CodefleetEpic): string {
  const type = epic.visibility?.type;
  if (!type) return '-';

  const dependsOnEpicIds = epic.visibility?.dependsOnEpicIds ?? [];
  if (dependsOnEpicIds.length === 0) {
    return type;
  }

  return `${type} (${dependsOnEpicIds.join(', ')})`;
}

function formatIdList(ids?: string[]): string {
  if (!ids || ids.length === 0) return '-';
  return ids.join(', ');
}

function formatDevelopmentScopes(scopes?: string[]): string {
  if (!scopes || scopes.length === 0) return '-';
  return scopes.join(', ');
}

function isInProgressStatus(status?: string): boolean {
  const normalized = (status ?? '').trim().toLowerCase();
  return (
    normalized === 'in-progress' ||
    normalized === 'in-review' ||
    normalized === 'changes-requested'
  );
}

export function Board({
  client,
  epics,
  itemsByEpicId,
  isLoading,
  errorMessage,
  showDashboard = true,
  onCloseDashboard,
  onBacklogChanged,
  onDashboardActivityChange,
}: Props) {
  const { width, height } = useWindowDimensions();
  const isWide = width >= WIDE_BREAKPOINT;
  const paneWidth = Math.min(700, Math.max(320, Math.floor(width * 0.92)));
  const dashboardHeight = Math.max(220, Math.floor(height * 0.4));

  const [selectedEpicId, setSelectedEpicId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [isPaneVisible, setIsPaneVisible] = useState(false);
  const [isDashboardMounted, setIsDashboardMounted] = useState(showDashboard);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [consoleAgents, setConsoleAgents] = useState<CodefleetFleetAgent[]>([]);
  const [consoleLogsByAgentId, setConsoleLogsByAgentId] = useState<Record<string, string[]>>({});
  const [consoleErrorMessage, setConsoleErrorMessage] = useState<string | null>(null);
  const [isLogPinnedToBottom, setIsLogPinnedToBottom] = useState(true);
  const paneProgress = useRef(new Animated.Value(0)).current;
  const dashboardSlide = useRef(new Animated.Value(showDashboard ? 0 : 1)).current;
  const previousShowDashboard = useRef(showDashboard);
  const logScrollRef = useRef<ScrollView | null>(null);
  const isLogPinnedToBottomRef = useRef(true);
  const onBacklogChangedRef = useRef<Props['onBacklogChanged']>(onBacklogChanged);
  const backlogRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isBacklogRefreshRunningRef = useRef(false);
  const shouldRerunBacklogRefreshRef = useRef(false);

  useEffect(() => {
    onBacklogChangedRef.current = onBacklogChanged;
  }, [onBacklogChanged]);

  const runBacklogRefresh = useCallback(async () => {
    if (!onBacklogChangedRef.current) return;
    if (isBacklogRefreshRunningRef.current) {
      shouldRerunBacklogRefreshRef.current = true;
      return;
    }

    isBacklogRefreshRunningRef.current = true;
    try {
      await onBacklogChangedRef.current();
    } finally {
      isBacklogRefreshRunningRef.current = false;
      if (shouldRerunBacklogRefreshRef.current) {
        shouldRerunBacklogRefreshRef.current = false;
        void runBacklogRefresh();
      }
    }
  }, []);

  const scheduleBacklogRefresh = useCallback(() => {
    if (!onBacklogChangedRef.current) return;
    if (backlogRefreshTimerRef.current) return;
    backlogRefreshTimerRef.current = setTimeout(() => {
      backlogRefreshTimerRef.current = null;
      void runBacklogRefresh();
    }, BACKLOG_REFRESH_DEBOUNCE_MS);
  }, [runBacklogRefresh]);

  const selectedEpic = useMemo(
    () => epics.find((epic) => epic.id === selectedEpicId) ?? null,
    [epics, selectedEpicId],
  );

  useEffect(() => {
    if (!selectedEpicId) return;
    if (!selectedEpic) {
      setSelectedEpicId(null);
      setSelectedItemId(null);
      setIsPaneVisible(false);
      paneProgress.setValue(0);
    }
  }, [paneProgress, selectedEpic, selectedEpicId]);

  useEffect(() => {
    const wasVisible = previousShowDashboard.current;
    previousShowDashboard.current = showDashboard;
    if (wasVisible === showDashboard) return;

    if (showDashboard) {
      setIsDashboardMounted(true);
      dashboardSlide.setValue(1);
      Animated.timing(dashboardSlide, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }).start();
      return;
    }

    Animated.timing(dashboardSlide, {
      toValue: 1,
      duration: 160,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      setIsDashboardMounted(false);
    });
  }, [dashboardSlide, showDashboard]);

  useEffect(() => {
    if (consoleAgents.length === 0) {
      if (selectedAgentId !== null) setSelectedAgentId(null);
      return;
    }
    if (selectedAgentId === null) return;
    if (consoleAgents.some((agent) => agent.agentId === selectedAgentId)) return;
    setSelectedAgentId(consoleAgents[0]?.agentId ?? null);
  }, [consoleAgents, selectedAgentId]);

  useEffect(() => {
    if (!onDashboardActivityChange) return;
    onDashboardActivityChange(consoleAgents.some((agent) => agent.busy));
  }, [consoleAgents, onDashboardActivityChange]);

  useEffect(() => {
    const shouldWatch = isDashboardMounted || Boolean(onBacklogChanged);
    if (!shouldWatch) return;

    const watchAbort = new AbortController();
    const watchToken = `watch-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

    const delay = async (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    const runFleetWatch = async (): Promise<void> => {
      while (!watchAbort.signal.aborted) {
        try {
          await client.watchFleet(
            {
              heartbeatSec: 15,
              notificationToken: watchToken,
            },
            {
              signal: watchAbort.signal,
              onNotification: (message) => {
                const event = decodeCodefleetWatchNotification(message);
                if (!event) return;
                if (event.params.notificationToken !== watchToken) return;

                if (event.method === 'fleet.activity.snapshot') {
                  setConsoleAgents(flattenAgents(event.params.roles));
                  return;
                }

                if (event.method === 'fleet.activity.changed') {
                  const fallbackAgentId = event.params.agentId;
                  const next = event.params.after;
                  if (!next && !fallbackAgentId) return;
                  setConsoleAgents((previous) => {
                    const byAgentId = new Map(previous.map((agent) => [agent.agentId, agent]));
                    if (next) {
                      byAgentId.set(next.agentId, normalizeAgent(next));
                    } else if (fallbackAgentId && !byAgentId.has(fallbackAgentId)) {
                      byAgentId.set(fallbackAgentId, {
                        agentId: fallbackAgentId,
                        status: 'running',
                        busy: false,
                      });
                    }
                    return Array.from(byAgentId.values()).sort((a, b) =>
                      a.agentId.localeCompare(b.agentId),
                    );
                  });
                  return;
                }
                if (event.method === 'fleet.logs.chunk') {
                  if (!isDashboardMounted) return;
                  if (!event.params.agentId || event.params.lines.length === 0) return;
                  const agentId = event.params.agentId;

                  setConsoleLogsByAgentId((previous) => {
                    const merged = [...(previous[agentId] ?? []), ...event.params.lines];
                    const capped = merged.slice(-CONSOLE_LOG_LIMIT_PER_AGENT);
                    return {
                      ...previous,
                      [agentId]: capped,
                    };
                  });
                  return;
                }

                if (event.method === 'backlog.changed') {
                  if (!onBacklogChangedRef.current) return;
                  scheduleBacklogRefresh();
                  return;
                }

                if (event.method === 'fleet.watch.error') {
                  const target = event.params.target ?? 'unknown';
                  const messageText = event.params.message ?? `fleet.watch error (${target})`;
                  setConsoleErrorMessage(messageText);
                  return;
                }

                if (event.method === 'fleet.watch.complete') {
                  setConsoleErrorMessage(null);
                }
              },
            },
          );
          setConsoleErrorMessage(null);
          await delay(CONSOLE_STREAM_RECONNECT_DELAY_MS);
        } catch (error) {
          if (watchAbort.signal.aborted) return;
          setConsoleErrorMessage(error instanceof Error ? error.message : 'Failed to watch fleet.');
          await delay(CONSOLE_STREAM_RECONNECT_DELAY_MS);
        }
      }
    };

    void runFleetWatch();

    return () => {
      watchAbort.abort();
      if (backlogRefreshTimerRef.current) {
        clearTimeout(backlogRefreshTimerRef.current);
        backlogRefreshTimerRef.current = null;
      }
    };
  }, [client, isDashboardMounted, onBacklogChanged, scheduleBacklogRefresh]);

  const openEpicDetail = (epic: CodefleetEpic) => {
    setSelectedEpicId(epic.id);
    setSelectedItemId(null);
    setIsPaneVisible(true);
    Animated.timing(paneProgress, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  };

  const closeEpicDetail = () => {
    Animated.timing(paneProgress, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      setIsPaneVisible(false);
      setSelectedEpicId(null);
      setSelectedItemId(null);
    });
  };

  const colors = useCodefleetColors();
  const subTextColor = colors.mutedText;
  const textColor = colors.text;
  const errorColor = colors.error;
  const bgColor = colors.background;
  const borderColor = colors.surfaceBorder;
  const sidebarBg = colors.surface;
  const selectedRowBg = colors.surfaceSelected;
  const epicsByStatus = groupEpicsByStatus(epics);
  const detailItems = useMemo(
    () => (selectedEpic ? (itemsByEpicId[selectedEpic.id] ?? []) : []),
    [itemsByEpicId, selectedEpic],
  );
  const selectedAgent = useMemo(
    () => consoleAgents.find((agent) => agent.agentId === selectedAgentId) ?? null,
    [consoleAgents, selectedAgentId],
  );
  const logsForSelectedAgent = useMemo(() => {
    if (selectedAgentId) {
      const lines = consoleLogsByAgentId[selectedAgentId] ?? [];
      return lines.map((line, index) => ({
        id: `${selectedAgentId}-${index}`,
        line,
      }));
    }
    const agentIds = Object.keys(consoleLogsByAgentId).sort((a, b) => a.localeCompare(b));
    return agentIds.flatMap((agentId) =>
      (consoleLogsByAgentId[agentId] ?? []).map((line, index) => ({
        id: `${agentId}-${index}`,
        line: `[${agentId}] ${line}`,
      })),
    );
  }, [consoleLogsByAgentId, selectedAgentId]);
  const paneTranslateX = paneProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [paneWidth, 0],
  });
  const handleLogScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const nextPinned = distanceFromBottom <= CONSOLE_LOG_BOTTOM_THRESHOLD_PX;
    if (isLogPinnedToBottomRef.current === nextPinned) return;
    isLogPinnedToBottomRef.current = nextPinned;
    setIsLogPinnedToBottom(nextPinned);
  }, []);

  const stickLogToBottom = useCallback((animated: boolean) => {
    if (!isLogPinnedToBottomRef.current) return;
    logScrollRef.current?.scrollToEnd({ animated });
  }, []);

  const handleLogContentSizeChange = useCallback(() => {
    stickLogToBottom(false);
  }, [stickLogToBottom]);

  useEffect(() => {
    if (!selectedItemId) return;
    if (detailItems.some((item) => item.id === selectedItemId)) return;
    setSelectedItemId(null);
  }, [detailItems, selectedItemId]);

  useEffect(() => {
    if (!isLogPinnedToBottom) return;
    const frame = requestAnimationFrame(() => {
      stickLogToBottom(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [isLogPinnedToBottom, logsForSelectedAgent.length, selectedAgentId, stickLogToBottom]);

  if (isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: bgColor }]}>
        <Text style={{ color: subTextColor }}>Loading board...</Text>
      </View>
    );
  }

  if (errorMessage) {
    return (
      <View style={[styles.center, { backgroundColor: bgColor }]}>
        <Text style={{ color: errorColor }}>{errorMessage}</Text>
      </View>
    );
  }

  const renderColumns = () => (
    <ScrollView
      horizontal={isWide}
      contentContainerStyle={isWide ? styles.columnsRow : styles.columnsStack}
    >
      {STATUS_COLUMNS.map((statusColumn) => (
        <Column
          key={statusColumn.key}
          title={statusColumn.title}
          epics={epicsByStatus[statusColumn.key]}
          itemsByEpicId={itemsByEpicId}
          selectedEpicId={selectedEpicId}
          onEpicPress={openEpicDetail}
        />
      ))}
    </ScrollView>
  );

  const renderBoardArea = () => {
    if (epics.length === 0) {
      return (
        <View style={styles.center}>
          <Text style={{ color: subTextColor }}>No epics found.</Text>
        </View>
      );
    }
    return renderColumns();
  };

  const renderInlineItemDetail = (item: CodefleetItem) => (
    <View style={[styles.inlineDetailBody, { borderTopColor: borderColor }]}>
      <Text style={[styles.inlineDetailMeta, { color: subTextColor }]}>Updated: {formatDate(item.updatedAt)}</Text>
      {getStatusTimeline(item.statusChangeHistory).length > 0 ? (
        <View style={styles.notesSection}>
          <Text style={[styles.notesSectionTitle, { color: textColor, borderBottomColor: borderColor }]}>
            Status Timeline
          </Text>
          {getStatusTimeline(item.statusChangeHistory).map((entry) => (
            <Text key={`${item.id}-timeline-${entry.status}`} style={[styles.sectionItem, { color: subTextColor }]}>
              {`${entry.status}: ${formatStatusTimestamp(entry.at) ?? '-'}`}
            </Text>
          ))}
          {formatExecutionDuration(item.statusChangeHistory) ? (
            <Text style={[styles.sectionItemStrong, { color: subTextColor }]}>
              {`runtime: ${formatExecutionDuration(item.statusChangeHistory)}`}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.notesSection}>
        <Text style={[styles.notesSectionTitle, { color: textColor, borderBottomColor: borderColor }]}>
          Notes
        </Text>
        {item.notes.length > 0 ? (
          item.notes.map((note, index) => (
            <View key={note.id ?? `${item.id}-detail-note-${index}`} style={[styles.noteSectionItem, { borderColor }]}>
              <Text style={[styles.noteContent, { color: textColor }]}>{note.content}</Text>
              {formatNoteDate(note.createdAt) ? (
                <Text style={[styles.noteMeta, { color: subTextColor }]}>{formatNoteDate(note.createdAt)}</Text>
              ) : null}
            </View>
          ))
        ) : (
          <Text style={[styles.sectionItem, { color: subTextColor }]}>No notes</Text>
        )}
      </View>
    </View>
  );

  const renderDetailPane = () => {
    if (!isPaneVisible) return null;

    return (
      <View style={styles.overlay}>
        <Pressable style={styles.scrimHitArea} onPress={closeEpicDetail}>
          <Animated.View
            style={[
              styles.scrim,
              {
                opacity: paneProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 0.24] }),
              },
            ]}
          />
        </Pressable>
        <Animated.View
          style={[
            styles.pane,
            {
              width: paneWidth,
              borderLeftColor: borderColor,
              backgroundColor: sidebarBg,
              opacity: paneProgress,
              transform: [{ translateX: paneTranslateX }],
            },
          ]}
        >
          <View style={[styles.paneHeader, { borderBottomColor: borderColor }]}> 
            <Text style={[styles.paneHeaderTitle, { color: textColor }]}>Epic Detail</Text>
            <Pressable onPress={closeEpicDetail} hitSlop={8}>
              <Ionicons name="close" size={18} color={subTextColor} />
            </Pressable>
          </View>
          {selectedEpic ? (
            <ScrollView contentContainerStyle={styles.paneBody}>
              <Text style={[styles.paneTitle, { color: textColor }]}>{selectedEpic.title}</Text>
              <Text style={[styles.metaLine, { color: subTextColor }]}>ID: {selectedEpic.id}</Text>
              <Text style={[styles.metaLine, { color: subTextColor }]}>Kind: {selectedEpic.kind ?? '-'}</Text>
              <Text style={[styles.metaLine, { color: subTextColor }]}>
                Development Scopes: {formatDevelopmentScopes(selectedEpic.developmentScopes)}
              </Text>
              <Text style={[styles.metaLine, { color: subTextColor }]}>Status: {selectedEpic.status ?? '-'}</Text>
              <Text style={[styles.metaLine, { color: subTextColor }]}>
                Visibility: {formatEpicVisibility(selectedEpic)}
              </Text>
              <Text style={[styles.metaLine, { color: subTextColor }]}>
                Acceptance Tests: {formatIdList(selectedEpic.acceptanceTestIds)}
              </Text>

              {getStatusTimeline(selectedEpic.statusChangeHistory).length > 0 ? (
                <View style={styles.notesSection}>
                  <Text style={[styles.notesSectionTitle, { color: textColor, borderBottomColor: borderColor }]}>
                    Status Timeline
                  </Text>
                  {getStatusTimeline(selectedEpic.statusChangeHistory).map((entry) => (
                    <Text
                      key={`${selectedEpic.id}-timeline-${entry.status}`}
                      style={[styles.sectionItem, { color: subTextColor }]}
                    >
                      {`${entry.status}: ${formatStatusTimestamp(entry.at) ?? '-'}`}
                    </Text>
                  ))}
                  {formatExecutionDuration(selectedEpic.statusChangeHistory) ? (
                    <Text style={[styles.sectionItemStrong, { color: subTextColor }]}>
                      {`runtime: ${formatExecutionDuration(selectedEpic.statusChangeHistory)}`}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              <View style={styles.notesSection}>
                <Text style={[styles.notesSectionTitle, { color: textColor, borderBottomColor: borderColor }]}>
                  Notes
                </Text>
                {selectedEpic.notes.length > 0 ? (
                  selectedEpic.notes.map((note, index) => (
                    <View
                      key={note.id ?? `${selectedEpic.id}-note-${index}`}
                      style={[styles.noteSectionItem, { borderColor }]}
                    >
                      <Text style={[styles.noteContent, { color: textColor }]}>{note.content}</Text>
                      {formatNoteDate(note.createdAt) ? (
                        <Text style={[styles.noteMeta, { color: subTextColor }]}>
                          {formatNoteDate(note.createdAt)}
                        </Text>
                      ) : null}
                    </View>
                  ))
                ) : (
                  <Text style={[styles.sectionItem, { color: subTextColor }]}>No notes</Text>
                )}
              </View>

              <View style={styles.notesSection}>
                <Text style={[styles.notesSectionTitle, { color: textColor, borderBottomColor: borderColor }]}>
                  Items
                </Text>
                {detailItems.length > 0 ? (
                  detailItems.map((item) => {
                    return (
                      <View key={item.id} style={[styles.childItem, { borderColor, backgroundColor: 'transparent' }]}>
                        <Pressable
                          style={styles.childItemSummary}
                          onPress={() => setSelectedItemId((previous) => (previous === item.id ? null : item.id))}
                        >
                          <View style={styles.childItemIdRow}>
                            <View style={styles.childItemIdLeft}>
                              {isInProgressStatus(item.status) ? (
                                <ActivityIndicator
                                  size="small"
                                  color={subTextColor}
                                  style={styles.childItemStatusSpinner}
                                />
                              ) : null}
                              <Text style={[styles.childItemId, { color: subTextColor }]} numberOfLines={1}>
                                {item.id}
                              </Text>
                            </View>
                            <Ionicons
                              name={selectedItemId === item.id ? 'chevron-up' : 'chevron-down'}
                              size={18}
                              color={subTextColor}
                            />
                          </View>
                          <Text style={[styles.childItemTitle, { color: textColor }]} numberOfLines={2}>
                            {item.title}
                          </Text>
                          <View style={styles.childItemMetaRow}>
                            <Text style={[styles.childItemMeta, { color: subTextColor }]} numberOfLines={1}>
                              {item.status ?? '-'}
                            </Text>
                            <Text style={[styles.childItemMeta, { color: subTextColor }]} numberOfLines={1}>
                              {item.kind ?? '-'}
                            </Text>
                          </View>
                        </Pressable>
                        {selectedItemId === item.id ? renderInlineItemDetail(item) : null}
                      </View>
                    );
                  })
                ) : (
                  <Text style={[styles.sectionItem, { color: subTextColor }]}>No child items</Text>
                )}
              </View>
            </ScrollView>
          ) : (
            <View style={styles.paneEmpty}>
              <Text style={{ color: subTextColor }}>Select an epic to show details.</Text>
            </View>
          )}
        </Animated.View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}> 
      <View style={styles.boardArea}>{renderBoardArea()}</View>
      {isDashboardMounted ? (
        <Animated.View
          style={[
            styles.statusPanelOverlay,
            {
              transform: [
                {
                  translateY: dashboardSlide.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, dashboardHeight + 24],
                  }),
                },
              ],
            },
          ]}
        >
          <View
            style={[
              styles.statusPanel,
              { borderTopColor: borderColor, backgroundColor: sidebarBg, height: dashboardHeight },
            ]}
          >
            <View
              style={[
                styles.statusPanelHeader,
                { backgroundColor: bgColor, borderBottomColor: borderColor },
              ]}
            >
              <View style={styles.statusPanelHeaderLabels}>
                <View style={[styles.statusPanelHeaderAgentLabel, { borderRightColor: borderColor }]}>
                  <Text style={[styles.statusPanelHeaderLabelText, { color: subTextColor }]}>Agents</Text>
                </View>
                <View style={styles.statusPanelHeaderLogLabel}>
                  <Text style={[styles.statusPanelHeaderLabelText, { color: subTextColor }]}>Logs</Text>
                </View>
              </View>
              <Pressable
                onPress={onCloseDashboard}
                hitSlop={8}
                style={styles.statusPanelCloseButton}
                disabled={!onCloseDashboard}
              >
                <Ionicons name="close" size={16} color={subTextColor} />
              </Pressable>
            </View>
            <View style={[styles.consoleContent, { borderColor }]}>
              <View style={[styles.consoleAgentPane, { borderRightColor: borderColor }]}> 
                <ScrollView contentContainerStyle={styles.consoleAgentList}>
                  {consoleErrorMessage ? (
                    <Text style={[styles.consoleErrorText, { color: errorColor }]} numberOfLines={2}>
                      {consoleErrorMessage}
                    </Text>
                  ) : null}
                  {consoleAgents.map((agent) => {
                    const isSelected = selectedAgent?.agentId === agent.agentId;
                    return (
                      <Pressable
                        key={agent.agentId}
                        onPress={() =>
                          setSelectedAgentId((prev) => (prev === agent.agentId ? null : agent.agentId))
                        }
                        style={[
                          styles.agentRow,
                          {
                            backgroundColor: isSelected ? selectedRowBg : 'transparent',
                          },
                        ]}
                      >
                        <View style={styles.agentRowSingleLine}>
                          <View style={styles.agentSummaryWrap}>
                            {agent.busy ? (
                              <ActivityIndicator
                                size="small"
                                color={subTextColor}
                                style={styles.agentSpinner}
                              />
                            ) : (
                              <View style={styles.agentSpinnerPlaceholder} />
                            )}
                            <Text
                              style={[styles.agentSummaryText, { color: textColor }]}
                              numberOfLines={1}
                            >
                              <Text style={styles.agentIdText}>{agent.agentId}</Text>
                              {agent.currentTask ? (
                                <Text style={[styles.agentTaskText, { color: subTextColor }]}>
                                  {` - ${agent.currentTask}`}
                                </Text>
                              ) : null}
                            </Text>
                          </View>
                          {agent.status.toLowerCase() === 'running' ? null : (
                            <Text style={[styles.agentStatusRight, { color: subTextColor }]}>
                              {agent.status}
                            </Text>
                          )}
                        </View>
                      </Pressable>
                    );
                  })}
                  {consoleAgents.length === 0 ? (
                    <Text style={[styles.consoleLogLine, { color: subTextColor }]}>
                      Waiting for agent activity...
                    </Text>
                  ) : null}
                </ScrollView>
              </View>
              <View style={styles.consoleLogPane}>
                <ScrollView
                  ref={logScrollRef}
                  onScroll={handleLogScroll}
                  onContentSizeChange={handleLogContentSizeChange}
                  scrollEventThrottle={16}
                  contentContainerStyle={styles.consoleLogList}
                >
                  {logsForSelectedAgent.map((log) => (
                    <View key={log.id} style={styles.consoleLogRow}>
                      <Text style={[styles.consoleLogLine, { color: subTextColor }]}>{log.line}</Text>
                    </View>
                  ))}
                  {logsForSelectedAgent.length === 0 ? (
                    <Text style={[styles.consoleLogLine, { color: subTextColor }]}>No logs.</Text>
                  ) : null}
                </ScrollView>
              </View>
            </View>
          </View>
        </Animated.View>
      ) : null}
      {renderDetailPane()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  boardArea: {
    flex: 1,
  },
  columnsRow: {
    gap: 12,
    padding: 12,
    paddingBottom: 16,
  },
  columnsStack: {
    padding: 12,
    gap: 12,
    paddingBottom: 16,
  },
  statusPanelOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 4,
  },
  statusPanel: {
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 14,
    gap: 0,
  },
  statusPanelHeader: {
    marginTop: -12,
    marginHorizontal: -12,
    marginBottom: 0,
    paddingTop: 3,
    paddingBottom: 3,
    paddingHorizontal: 0,
    flexDirection: 'row',
    alignItems: 'stretch',
    position: 'relative',
    gap: 8,
  },
  statusPanelHeaderLabels: {
    flex: 1,
    flexDirection: 'row',
  },
  statusPanelHeaderAgentLabel: {
    width: '34%',
    maxWidth: 460,
    borderRightWidth: 1,
    paddingHorizontal: 10,
    paddingTop: CONSOLE_HEADER_TOP_PADDING,
    paddingBottom: CONSOLE_HEADER_TOP_PADDING,
  },
  statusPanelHeaderLogLabel: {
    flex: 1,
    paddingHorizontal: 10,
    paddingTop: CONSOLE_HEADER_TOP_PADDING,
    paddingBottom: CONSOLE_HEADER_TOP_PADDING,
  },
  statusPanelHeaderLabelText: {
    fontSize: 13,
    fontWeight: '600',
  },
  statusPanelCloseButton: {
    position: 'absolute',
    right: 12,
    top: 3,
    width: 20,
    height: 20,
    paddingTop: CONSOLE_HEADER_TOP_PADDING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  consoleContent: {
    flex: 1,
    borderBottomWidth: 1,
    marginHorizontal: -12,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  consoleAgentPane: {
    width: '34%',
    maxWidth: 460,
    borderRightWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  consoleLogPane: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  consoleAgentList: {
    gap: 0,
    paddingBottom: 6,
  },
  consoleErrorText: {
    fontSize: 12,
    marginBottom: 6,
  },
  agentRow: {
    paddingHorizontal: 8,
    paddingVertical: 9,
  },
  agentRowSingleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  agentSummaryWrap: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  agentSpinner: {
    width: 14,
    height: 14,
    opacity: 0.45,
    transform: [{ scale: 0.72 }],
  },
  agentSpinnerPlaceholder: {
    width: 14,
    height: 14,
  },
  agentSummaryText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
  },
  agentIdText: {
    fontWeight: '600',
  },
  agentTaskText: {
    fontWeight: '400',
  },
  agentStatusRight: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'right',
  },
  consoleLogList: {
    gap: 6,
    paddingBottom: 8,
  },
  consoleLogRow: {
    paddingVertical: 2,
  },
  consoleLogLine: {
    fontSize: 12,
    lineHeight: 15,
    fontFamily: 'monospace',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    zIndex: 5,
  },
  scrimHitArea: {
    flex: 1,
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  pane: {
    height: '100%',
    borderLeftWidth: 1,
  },
  paneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  paneHeaderTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  paneBody: {
    padding: 16,
    gap: 10,
    paddingBottom: 28,
  },
  paneTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  metaLine: {
    fontSize: 12,
  },
  sectionBox: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 6,
    marginTop: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  notesSection: {
    gap: 10,
    marginTop: 8,
  },
  notesSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    paddingBottom: 6,
    borderBottomWidth: 1,
  },
  noteSectionItem: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 4,
  },
  noteContent: {
    fontSize: 13,
    lineHeight: 18,
  },
  noteMeta: {
    fontSize: 11,
    textAlign: 'right',
    alignSelf: 'stretch',
  },
  sectionItem: {
    fontSize: 13,
    lineHeight: 18,
  },
  sectionItemStrong: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  childItem: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  childItemSummary: {
    gap: 4,
  },
  childItemIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  childItemIdLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  childItemStatusSpinner: {
    transform: [{ scale: 0.56 }],
  },
  childItemId: {
    fontSize: 11,
  },
  childItemTitle: {
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
  childItemMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  childItemMeta: {
    fontSize: 11,
    textTransform: 'lowercase',
  },
  paneEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  inlineDetailBody: {
    paddingTop: 12,
    gap: 8,
  },
  inlineDetailMeta: {
    fontSize: 12,
  },
});
