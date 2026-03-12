import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { Board } from './components/Board';
import { RequirementsInterviewWorkspace } from './components/RequirementsInterviewWorkspace';
import { DocumentWorkspace } from './components/document/DocumentWorkspace';
import { ThreadPane } from './components/ThreadPane';
import { useCodefleetBoard } from './hooks/useCodefleetBoard';
import type { CodefleetClient } from './mcp/client';
import { useOptionalStandaloneThemePreference } from './theme/StandaloneThemePreference';
import { useCodefleetColors } from './theme/useCodefleetColors';

const WIDE_BREAKPOINT = 768;
const SCREEN_TABS = ['requirementsInterview', 'document', 'board'] as const;

type ScreenTab = (typeof SCREEN_TABS)[number];

type FleetPeerNode = {
  projectId: string;
  endpoint: string;
};

type EndpointStore = {
  get(): string;
  set(next: string | null): void;
};

export type CodefleetScreenProps = {
  client: CodefleetClient;
  endpointStore: EndpointStore;
  chrome?: {
    renderNavigation?: (args: { orientation: 'vertical' | 'horizontal' }) => ReactNode;
    renderSessionPane?: () => ReactNode;
  };
};

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

export default function CodefleetScreen({
  client,
  endpointStore,
  chrome,
}: CodefleetScreenProps) {
  const { width } = useWindowDimensions();
  const isWide = width >= WIDE_BREAKPOINT;
  const board = useCodefleetBoard(client, true);
  const colors = useCodefleetColors();
  const standaloneTheme = useOptionalStandaloneThemePreference();
  const renderSessionPane = chrome?.renderSessionPane ?? (() => <ThreadPane client={client} agentId="front-desk" />);
  const hasSessionPane = true;
  const [isSessionOpen, setIsSessionOpen] = useState(false);
  const [isDashboardOpen, setIsDashboardOpen] = useState(false);
  const [hasDashboardUserPreference, setHasDashboardUserPreference] = useState(false);
  const [isSessionMounted, setIsSessionMounted] = useState(isSessionOpen);
  const [fleetProjectId, setFleetProjectId] = useState('Codefleet');
  const [fleetPeers, setFleetPeers] = useState<FleetPeerNode[]>([]);
  const [isPeerMenuOpen, setIsPeerMenuOpen] = useState(false);
  const [fleetEndpoint, setFleetEndpoint] = useState(() => normalizeEndpoint(endpointStore.get()));
  const [activeTab, setActiveTab] = useState<ScreenTab>('requirementsInterview');
  const sessionSlide = useRef(new Animated.Value(isSessionOpen ? 0 : 1)).current;
  const previousSessionOpen = useRef(isSessionOpen);

  const refreshFleetStatus = useCallback(
    async (endpoint: string) => {
      const fallbackEndpoint = normalizeEndpoint(endpointStore.get());
      const candidates = [endpoint, fallbackEndpoint].filter(
        (value, index, list) => value.length > 0 && list.indexOf(value) === index,
      );

      try {
        let resolvedEndpoint: string | null = null;
        let payload: Awaited<ReturnType<CodefleetClient['fetchFleetStatus']>> = null;
        for (const candidate of candidates) {
          const status = await client.fetchFleetStatus(candidate);
          if (!status) continue;
          resolvedEndpoint = candidate;
          payload = status;
          break;
        }
        if (!resolvedEndpoint || !payload) {
          throw new Error('Failed to fetch Codefleet status');
        }

        const selfProjectId = payload.nodes?.self?.projectId?.trim();
        const selfEndpoint = normalizeEndpoint(
          payload.nodes?.self?.endpoint ?? resolvedEndpoint,
        );
        const peersRaw = Array.isArray(payload.nodes?.peers) ? payload.nodes?.peers : [];
        const peers = peersRaw
          .map((peer) => {
            const projectId = peer.projectId?.trim() ?? '';
            const peerEndpoint = peer.endpoint?.trim() ?? '';
            if (!projectId || !peerEndpoint) return null;
            return {
              projectId,
              endpoint: normalizeEndpoint(peerEndpoint),
            };
          })
          .filter((peer): peer is FleetPeerNode => peer !== null);

        setFleetProjectId(selfProjectId && selfProjectId.length > 0 ? selfProjectId : 'Codefleet');
        setFleetPeers(peers);
        if (selfEndpoint) {
          setFleetEndpoint(selfEndpoint);
          endpointStore.set(selfEndpoint);
        }
      } catch {
        setFleetProjectId('Codefleet');
        setFleetPeers([]);
      }
    },
    [client, endpointStore],
  );

  useEffect(() => {
    void refreshFleetStatus(fleetEndpoint);
    void board.refreshBoard();
    setIsPeerMenuOpen(false);
    setIsDashboardOpen(false);
    setHasDashboardUserPreference(false);
  }, [board.refreshBoard, fleetEndpoint, refreshFleetStatus]);

  useEffect(() => {
    if (activeTab !== 'board') return;
    void board.refreshBoard();
  }, [activeTab, board.refreshBoard]);

  useEffect(() => {
    if (!isWide || !hasSessionPane) {
      setIsSessionMounted(false);
      sessionSlide.setValue(1);
      previousSessionOpen.current = isSessionOpen;
      return;
    }

    const wasOpen = previousSessionOpen.current;
    previousSessionOpen.current = isSessionOpen;
    if (wasOpen === isSessionOpen) return;

    if (isSessionOpen) {
      setIsSessionMounted(true);
      sessionSlide.setValue(1);
      Animated.timing(sessionSlide, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }).start();
      return;
    }

    Animated.timing(sessionSlide, {
      toValue: 1,
      duration: 160,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) return;
      setIsSessionMounted(false);
    });
  }, [hasSessionPane, isSessionOpen, isWide, sessionSlide]);

  const handlePeerSelect = useCallback(
    (peer: FleetPeerNode) => {
      const nextEndpoint = normalizeEndpoint(peer.endpoint);
      if (!nextEndpoint) return;
      setFleetProjectId(peer.projectId);
      setFleetEndpoint(nextEndpoint);
      endpointStore.set(nextEndpoint);
      setIsPeerMenuOpen(false);
    },
    [endpointStore],
  );

  const canSwitchPeer = fleetPeers.length > 0;
  const isRequirementsInterviewTabActive = activeTab === 'requirementsInterview';
  const isBoardTabActive = activeTab === 'board';
  const navigation = chrome?.renderNavigation?.({
    orientation: isWide ? 'vertical' : 'horizontal',
  });

  const headerTitle = (
    <View style={styles.headerIdentityArea}>
      <View style={styles.headerTitleRow}>
        {standaloneTheme ? (
          <Pressable
            onPress={standaloneTheme.cycleThemePreference}
            hitSlop={8}
            style={styles.headerThemeButton}
          >
            <Ionicons
              name={
                standaloneTheme.themePreference === 'light'
                  ? 'sunny-outline'
                  : standaloneTheme.themePreference === 'dark'
                    ? 'moon-outline'
                    : 'contrast-outline'
              }
              size={20}
              color={colors.tint}
            />
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => {
            if (!canSwitchPeer) return;
            setIsPeerMenuOpen((value) => !value);
          }}
          style={styles.headerTitleTrigger}
          hitSlop={8}
        >
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {fleetProjectId}
          </Text>
          {canSwitchPeer ? (
            <Ionicons
              name={isPeerMenuOpen ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={colors.text}
            />
          ) : null}
        </Pressable>
      </View>
      <View style={styles.headerMenuRow}>
        {SCREEN_TABS.map((tab) => {
          const isActive = activeTab === tab;
          return (
            <Pressable
              key={tab}
              onPress={() => setActiveTab(tab)}
              style={[
                styles.headerMenuButton,
                isActive && { borderBottomColor: colors.tint },
              ]}
              hitSlop={8}
            >
              <Text
                style={[
                  styles.headerMenuText,
                  { color: isActive ? colors.tint : colors.mutedText },
                ]}
              >
                {tab === 'requirementsInterview'
                  ? 'Requirements Interview'
                  : tab === 'document'
                    ? 'Document'
                    : 'Board'}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {isPeerMenuOpen ? (
        <View
          style={[
            styles.peerMenu,
            { backgroundColor: colors.background, borderColor: colors.surfaceBorder },
          ]}
        >
          {fleetPeers.map((peer) => (
            <Pressable
              key={`${peer.projectId}:${peer.endpoint}`}
              onPress={() => handlePeerSelect(peer)}
              style={styles.peerMenuItem}
            >
              <Text style={[styles.peerMenuText, { color: colors.text }]} numberOfLines={1}>
                {peer.projectId}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      {isWide ? (
        <View style={styles.splitContainer}>
          {navigation}
          <View style={styles.mainArea}>
            <View
              style={[
                styles.headerBar,
                {
                  backgroundColor: colors.background,
                  borderBottomColor: colors.surfaceBorder,
                },
              ]}
            >
              {headerTitle}
              <View style={styles.headerActions}>
                {isBoardTabActive ? (
                  <Pressable
                    onPress={() => {
                      setHasDashboardUserPreference(true);
                      setIsDashboardOpen((previous) => !previous);
                    }}
                    hitSlop={8}
                    style={styles.actionButton}
                  >
                    <Ionicons
                      name={isDashboardOpen ? 'code-slash' : 'code-slash-outline'}
                      size={20}
                      color={colors.tint}
                    />
                  </Pressable>
                ) : null}
                {isBoardTabActive && hasSessionPane ? (
                  <Pressable
                    onPress={() => setIsSessionOpen((value) => !value)}
                    hitSlop={8}
                    style={styles.actionButton}
                  >
                    <Ionicons
                      name={isSessionMounted ? 'chatbox' : 'chatbox-outline'}
                      size={20}
                      color={colors.tint}
                    />
                  </Pressable>
                ) : null}
              </View>
            </View>
            <View style={styles.contentRow}>
              <View style={styles.boardContainer}>
                {isRequirementsInterviewTabActive ? (
                  <RequirementsInterviewWorkspace client={client} />
                ) : isBoardTabActive ? (
                  <Board
                    client={client}
                    key={`board:${fleetEndpoint}`}
                    epics={board.epics}
                    itemsByEpicId={board.itemsByEpicId}
                    isLoading={board.isLoading}
                    errorMessage={board.errorMessage}
                    showDashboard={isDashboardOpen}
                    onCloseDashboard={() => {
                      setHasDashboardUserPreference(true);
                      setIsDashboardOpen(false);
                    }}
                    onBacklogChanged={board.refreshBoard}
                    onDashboardActivityChange={(hasActiveAgents) => {
                      if (hasDashboardUserPreference) return;
                      setIsDashboardOpen(hasActiveAgents);
                    }}
                  />
                ) : (
                  <DocumentWorkspace client={client} />
                )}
              </View>
              {isBoardTabActive && isSessionMounted ? (
                <Animated.View
                  style={[
                    styles.sessionContainer,
                    {
                      backgroundColor: colors.surface,
                      borderLeftColor: colors.surfaceBorder,
                    },
                    {
                      transform: [
                        {
                          translateX: sessionSlide.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, 460],
                          }),
                        },
                      ],
                    },
                  ]}
                >
                  {renderSessionPane()}
                </Animated.View>
              ) : null}
            </View>
          </View>
        </View>
      ) : (
        <>
          <View
            style={[
              styles.headerBar,
              {
                backgroundColor: colors.background,
                borderBottomColor: colors.surfaceBorder,
              },
            ]}
          >
            {headerTitle}
            <View style={styles.headerActions}>
              {isBoardTabActive ? (
                <Pressable
                  onPress={() => {
                    setHasDashboardUserPreference(true);
                    setIsDashboardOpen((previous) => !previous);
                  }}
                  hitSlop={8}
                  style={styles.actionButton}
                >
                  <Ionicons
                    name={isDashboardOpen ? 'code-slash' : 'code-slash-outline'}
                    size={20}
                    color={colors.tint}
                  />
                </Pressable>
              ) : null}
            </View>
          </View>
          {navigation}
          {isRequirementsInterviewTabActive ? (
            <RequirementsInterviewWorkspace client={client} />
          ) : isBoardTabActive ? (
            <Board
              client={client}
              key={`board:${fleetEndpoint}`}
              epics={board.epics}
              itemsByEpicId={board.itemsByEpicId}
              isLoading={board.isLoading}
              errorMessage={board.errorMessage}
              showDashboard={isDashboardOpen}
              onCloseDashboard={() => {
                setHasDashboardUserPreference(true);
                setIsDashboardOpen(false);
              }}
              onBacklogChanged={board.refreshBoard}
              onDashboardActivityChange={(hasActiveAgents) => {
                if (hasDashboardUserPreference) return;
                setIsDashboardOpen(hasActiveAgents);
              }}
            />
          ) : (
            <DocumentWorkspace client={client} />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerBar: {
    minHeight: 54,
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    position: 'relative',
    overflow: 'visible',
    zIndex: 50,
    elevation: 50,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  headerIdentityArea: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    maxWidth: '80%',
    overflow: 'visible',
    zIndex: 60,
    elevation: 60,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerTitleTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  headerMenuButton: {
    minHeight: 28,
    paddingBottom: 4,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    justifyContent: 'center',
  },
  headerMenuText: {
    fontSize: 14,
    fontWeight: '600',
  },
  headerThemeButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  splitContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  mainArea: {
    flex: 1,
  },
  contentRow: {
    flex: 1,
    flexDirection: 'row',
  },
  boardContainer: {
    flex: 1,
  },
  documentContainer: {
    flex: 1,
  },
  sessionContainer: {
    width: 460,
    borderLeftWidth: 1,
  },
  peerMenu: {
    position: 'absolute',
    top: 34,
    left: 0,
    minWidth: 240,
    maxWidth: 320,
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden',
  },
  peerMenuItem: {
    minHeight: 40,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  peerMenuText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
