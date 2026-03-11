import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import type {
  CodefleetClient,
  DocumentActor,
  DocumentFileResult,
  DocumentTreeNode as RemoteDocumentTreeNode,
  DocumentWatchEvent,
} from '../../mcp/client';
import { useCodefleetColors } from '../../theme/useCodefleetColors';
import { DocumentEditorPane } from './DocumentEditorPane';
import { DocumentExplorerPane } from './DocumentExplorerPane';
import type { DocumentTreeNode } from './documentTypes';

const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1120;
const MOBILE_PANES = ['explorer', 'editor'] as const;
const SAVE_DEBOUNCE_MS = 700;

type MobilePane = (typeof MOBILE_PANES)[number];

function flattenTree(nodes: DocumentTreeNode[]): DocumentTreeNode[] {
  return nodes.flatMap((node) => [node, ...(node.children ? flattenTree(node.children) : [])]);
}

function mapTree(nodes: RemoteDocumentTreeNode[]): DocumentTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? mapTree(node.children) : undefined,
  }));
}

function collectInitiallyCollapsedFolderIds(
  nodes: DocumentTreeNode[],
  depth: number = 0,
  collapsed: Set<string> = new Set(),
): Set<string> {
  for (const node of nodes) {
    if (node.kind !== 'folder') {
      continue;
    }
    if (depth >= 2) {
      collapsed.add(node.id);
    }
    if (node.children) {
      collectInitiallyCollapsedFolderIds(node.children, depth + 1, collapsed);
    }
  }
  return collapsed;
}

function createActorId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `browser-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

type Props = {
  client: CodefleetClient;
};

export function DocumentWorkspace({ client }: Props) {
  const colors = useCodefleetColors();
  const { width } = useWindowDimensions();
  const isMobile = width < MOBILE_BREAKPOINT;
  const isTablet = width >= MOBILE_BREAKPOINT && width < TABLET_BREAKPOINT;
  const actorRef = useRef<DocumentActor>({ type: 'user', id: createActorId() });
  const [tree, setTree] = useState<DocumentTreeNode[]>([]);
  const [selectedTreeNodeId, setSelectedTreeNodeId] = useState<string | null>(null);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => new Set());
  const [draftByFileId, setDraftByFileId] = useState<Record<string, string>>({});
  const [versionByFileId, setVersionByFileId] = useState<Record<string, string>>({});
  const [fileDetailsByFileId, setFileDetailsByFileId] = useState<Record<string, DocumentFileResult>>({});
  const [dirtyByFileId, setDirtyByFileId] = useState<Record<string, boolean>>({});
  const [loadedByFileId, setLoadedByFileId] = useState<Record<string, boolean>>({});
  const [savingByFileId, setSavingByFileId] = useState<Record<string, boolean>>({});
  const [conflictedByFileId, setConflictedByFileId] = useState<Record<string, boolean>>({});
  const [mobilePane, setMobilePane] = useState<MobilePane>('editor');
  const [isLoadingTree, setIsLoadingTree] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const dirtyByFileIdRef = useRef<Record<string, boolean>>({});
  const hasAppliedInitialFolderCollapseRef = useRef(false);

  const allNodes = useMemo(() => flattenTree(tree), [tree]);
  const fileNodes = useMemo(
    () => allNodes.filter((node): node is DocumentTreeNode => node.kind === 'file'),
    [allNodes],
  );
  const nodeById = useMemo(
    () => new Map(allNodes.map((node) => [node.id, node])),
    [allNodes],
  );
  const openTabs = useMemo(
    () =>
      openTabIds
        .map((id) => nodeById.get(id))
        .filter((node): node is DocumentTreeNode => node?.kind === 'file'),
    [nodeById, openTabIds],
  );

  const activeFile = activeTabId ? nodeById.get(activeTabId) ?? null : null;
  const activeFileDraft = activeFile?.kind === 'file' ? draftByFileId[activeFile.id] ?? '' : '';
  const activeFileDetails = activeFile?.kind === 'file' ? fileDetailsByFileId[activeFile.id] ?? null : null;
  const activeFileAssetUrl =
    activeFile?.kind === 'file' &&
    (activeFile.language === 'image' ||
      activeFile.language === 'video' ||
      activeFile.language === 'pdf' ||
      activeFile.language === 'binary')
      ? client.getDocumentAssetUrl(activeFile.id)
      : null;

  const refreshTree = useCallback(async () => {
    const payload = await client.listDocumentsTree();
    const nextTree = mapTree(payload.root);
    setTree(nextTree);
    if (!hasAppliedInitialFolderCollapseRef.current) {
      setCollapsedFolderIds(collectInitiallyCollapsedFolderIds(nextTree));
      hasAppliedInitialFolderCollapseRef.current = true;
    }
    setOpenTabIds((previous) => previous.filter((id) => payload.root.some((node) => flattenTree([node]).some((item) => item.id === id))));
  }, [client]);

  const loadFile = useCallback(
    async (fileId: string, options?: { preserveDraft?: boolean }) => {
      const payload = await client.getDocumentFile(fileId);
      setFileDetailsByFileId((previous) => ({ ...previous, [fileId]: payload }));
      setVersionByFileId((previous) => ({ ...previous, [fileId]: payload.version }));
      setLoadedByFileId((previous) => ({ ...previous, [fileId]: true }));
      setConflictedByFileId((previous) => ({ ...previous, [fileId]: false }));
      if (!options?.preserveDraft) {
        setDraftByFileId((previous) => ({ ...previous, [fileId]: payload.content ?? '' }));
        setDirtyByFileId((previous) => ({ ...previous, [fileId]: false }));
      }
    },
    [client],
  );

  const saveFile = useCallback(
    async (fileId: string) => {
      try {
        setSavingByFileId((previous) => ({ ...previous, [fileId]: true }));
        const payload = await client.saveDocumentFile({
          path: fileId,
          content: draftByFileId[fileId] ?? '',
          baseVersion: versionByFileId[fileId] ?? null,
          actor: actorRef.current,
        });
        setFileDetailsByFileId((previous) => ({ ...previous, [fileId]: payload }));
        setDraftByFileId((previous) => ({ ...previous, [fileId]: payload.content ?? '' }));
        setVersionByFileId((previous) => ({ ...previous, [fileId]: payload.version }));
        setDirtyByFileId((previous) => ({ ...previous, [fileId]: false }));
        setConflictedByFileId((previous) => ({ ...previous, [fileId]: false }));
        setErrorMessage(null);
      } catch (error) {
        setConflictedByFileId((previous) => ({ ...previous, [fileId]: true }));
        setErrorMessage(error instanceof Error ? error.message : 'Failed to save document.');
      } finally {
        setSavingByFileId((previous) => ({ ...previous, [fileId]: false }));
      }
    },
    [client, draftByFileId, versionByFileId],
  );

  useEffect(() => {
    dirtyByFileIdRef.current = dirtyByFileId;
  }, [dirtyByFileId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        setIsLoadingTree(true);
        await refreshTree();
        if (cancelled) return;
        setErrorMessage(null);
      } catch (error) {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load documents.');
      } finally {
        if (!cancelled) {
          setIsLoadingTree(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshTree]);

  useEffect(() => {
    if (selectedTreeNodeId || fileNodes.length === 0) return;
    const firstFileId = fileNodes[0]?.id ?? null;
    setSelectedTreeNodeId(firstFileId);
    setActiveTabId(firstFileId);
    setOpenTabIds(firstFileId ? [firstFileId] : []);
  }, [fileNodes, selectedTreeNodeId]);

  useEffect(() => {
    const activeFileId = activeFile?.kind === "file" ? activeFile.id : null;
    if (!activeFileId) return;
    if (loadedByFileId[activeFileId]) return;
    void loadFile(activeFileId).catch((error) => {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load document.');
    });
  }, [activeFile, loadFile, loadedByFileId]);

  useEffect(() => {
    const fileId = activeFile?.kind === 'file' ? activeFile.id : null;
    if (!fileId) return;
    if (!dirtyByFileId[fileId]) return;
    if (!loadedByFileId[fileId]) return;
    if (conflictedByFileId[fileId]) return;
    if (activeFileDetails?.isBinary) return;

    const timer = setTimeout(() => {
      void saveFile(fileId);
    }, SAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [
    activeFile,
    conflictedByFileId,
    dirtyByFileId,
    loadedByFileId,
    saveFile,
    versionByFileId,
    activeFileDetails,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.key.toLowerCase() !== 's') {
        return;
      }
      event.preventDefault();

      const fileId = activeFile?.kind === 'file' ? activeFile.id : null;
      if (!fileId) return;
      if (!loadedByFileId[fileId]) return;
      if (conflictedByFileId[fileId]) return;
      if (activeFileDetails?.isBinary) return;
      void saveFile(fileId);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeFile, activeFileDetails, conflictedByFileId, loadedByFileId, saveFile]);

  useEffect(() => {
    const abort = new AbortController();
    const handleEvent = (event: DocumentWatchEvent) => {
      if (event.type === 'document.snapshot') {
        setTree(mapTree(event.payload.root));
        return;
      }
      if (event.type === 'document.changed') {
        const updatedBySelf = event.payload.updatedBy?.id === actorRef.current.id;
        void refreshTree().catch(() => undefined);
        if (updatedBySelf) {
          return;
        }
        if (dirtyByFileIdRef.current[event.payload.path]) {
          setConflictedByFileId((previous) => ({ ...previous, [event.payload.path]: true }));
          return;
        }
        void loadFile(event.payload.path).catch(() => undefined);
        return;
      }
      if (event.type === 'document.deleted') {
        void refreshTree().catch(() => undefined);
        setDraftByFileId((previous) => {
          const next = { ...previous };
          delete next[event.payload.path];
          return next;
        });
        setVersionByFileId((previous) => {
          const next = { ...previous };
          delete next[event.payload.path];
          return next;
        });
        setFileDetailsByFileId((previous) => {
          const next = { ...previous };
          delete next[event.payload.path];
          return next;
        });
        setLoadedByFileId((previous) => {
          const next = { ...previous };
          delete next[event.payload.path];
          return next;
        });
        setDirtyByFileId((previous) => {
          const next = { ...previous };
          delete next[event.payload.path];
          return next;
        });
        setOpenTabIds((previous) => previous.filter((id) => id !== event.payload.path));
        setActiveTabId((previous) => (previous === event.payload.path ? null : previous));
        setSelectedTreeNodeId((previous) => (previous === event.payload.path ? null : previous));
        return;
      }
      if (event.type === 'document.error') {
        setErrorMessage(event.payload.message ?? 'Document watch failed.');
      }
    };

    void client.watchDocuments({
      signal: abort.signal,
      onEvent: handleEvent,
    }).catch((error) => {
      if (abort.signal.aborted) return;
      setErrorMessage(error instanceof Error ? error.message : 'Failed to watch documents.');
    });

    return () => abort.abort();
  }, [client, loadFile, refreshTree]);

  const ensureTabOpen = useCallback((node: DocumentTreeNode) => {
    if (node.kind !== 'file') return;
    setOpenTabIds((previous) => (previous.includes(node.id) ? previous : [...previous, node.id]));
    setActiveTabId(node.id);
  }, []);

  const handleSelectTreeNode = useCallback(
    (node: DocumentTreeNode) => {
      setSelectedTreeNodeId(node.id);
      if (node.kind === 'file') {
        ensureTabOpen(node);
        setMobilePane('editor');
      }
    },
    [ensureTabOpen],
  );

  const handleToggleFolder = useCallback((node: DocumentTreeNode) => {
    if (node.kind !== 'folder') return;
    setCollapsedFolderIds((previous) => {
      const next = new Set(previous);
      if (next.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      return next;
    });
  }, []);

  const handleSelectTab = useCallback((tabId: string) => {
    if (activeTabId && dirtyByFileId[activeTabId] && loadedByFileId[activeTabId] && !conflictedByFileId[activeTabId]) {
      void saveFile(activeTabId);
    }
    setActiveTabId(tabId);
    setSelectedTreeNodeId(tabId);
    setMobilePane('editor');
  }, [activeTabId, conflictedByFileId, dirtyByFileId, loadedByFileId, saveFile]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      if (activeTabId && dirtyByFileId[activeTabId] && loadedByFileId[activeTabId] && !conflictedByFileId[activeTabId]) {
        void saveFile(activeTabId);
      }
      setOpenTabIds((previous) => {
        const next = previous.filter((tab) => tab !== tabId);
        if (activeTabId === tabId) {
          const fallback = next[next.length - 1] ?? null;
          setActiveTabId(fallback);
          setSelectedTreeNodeId(fallback);
        }
        return next;
      });
    },
    [activeTabId, conflictedByFileId, dirtyByFileId, loadedByFileId, saveFile],
  );

  const handleChangeDraft = useCallback(
    (next: string) => {
      if (!activeFile || activeFile.kind !== 'file') return;
      setDraftByFileId((previous) => ({ ...previous, [activeFile.id]: next }));
      setDirtyByFileId((previous) => ({ ...previous, [activeFile.id]: true }));
    },
    [activeFile],
  );

  const dirtyTabIds = useMemo(() => {
    const next = new Set<string>();
    for (const [fileId, isDirty] of Object.entries(dirtyByFileId)) {
      if (isDirty || savingByFileId[fileId]) {
        next.add(fileId);
      }
    }
    return next;
  }, [dirtyByFileId, savingByFileId]);

  const explorerPane = (
    <DocumentExplorerPane
      tree={tree}
      selectedTreeNodeId={selectedTreeNodeId}
      collapsedFolderIds={collapsedFolderIds}
      onSelectTreeNode={handleSelectTreeNode}
      onToggleFolder={handleToggleFolder}
    />
  );

  const editorPane = (
    <DocumentEditorPane
      openTabs={openTabs}
      activeTabId={activeTabId}
      activeFile={activeFile?.kind === 'file' ? activeFile : null}
      draft={activeFileDraft}
      assetUrl={activeFileAssetUrl}
      dirtyTabIds={dirtyTabIds}
      onSelectTab={handleSelectTab}
      onCloseTab={handleCloseTab}
      onChangeDraft={handleChangeDraft}
    />
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {errorMessage ? (
        <View
          style={[
            styles.banner,
            { backgroundColor: colors.surface, borderBottomColor: colors.surfaceBorder },
          ]}
        >
          <Text style={[styles.bannerText, { color: colors.text }]} numberOfLines={2}>
            {errorMessage}
          </Text>
        </View>
      ) : null}
      {isLoadingTree ? (
        <View style={styles.loadingState}>
          <Text style={[styles.loadingText, { color: colors.mutedText }]}>Loading documents...</Text>
        </View>
      ) : isMobile ? (
        <View style={styles.mobileLayout}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.mobileTabRow}
          >
            {MOBILE_PANES.map((pane) => {
              const isActive = mobilePane === pane;
              const label =
                pane === 'explorer' ? 'Explorer' : pane === 'editor' ? 'Editor' : 'Front Desk';
              return (
                <Pressable
                  key={pane}
                  onPress={() => setMobilePane(pane)}
                  style={[
                    styles.mobileTabButton,
                    {
                      backgroundColor: isActive ? colors.tint : colors.surface,
                      borderColor: isActive ? colors.tint : colors.surfaceBorder,
                    },
                  ]}
                >
                  <Text style={[styles.mobileTabText, { color: isActive ? colors.background : colors.text }]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.mobilePane}>
            {mobilePane === 'explorer'
              ? explorerPane
              : editorPane}
          </View>
        </View>
      ) : (
        <View style={styles.desktopRow}>
          <View style={[styles.explorerColumn, isTablet ? styles.explorerColumnTablet : styles.explorerColumnDesktop]}>
            {explorerPane}
          </View>
          <View style={styles.editorColumn}>{editorPane}</View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 0,
  },
  banner: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  bannerText: {
    fontSize: 12,
    fontWeight: '600',
  },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: 14,
    fontWeight: '600',
  },
  desktopRow: {
    flex: 1,
    flexDirection: 'row',
  },
  explorerColumn: {
    minWidth: 220,
  },
  explorerColumnTablet: {
    width: 240,
  },
  explorerColumnDesktop: {
    width: 280,
  },
  editorColumn: {
    flex: 1,
  },
  mobileLayout: {
    flex: 1,
  },
  mobileTabRow: {
    gap: 0,
  },
  mobileTabButton: {
    minHeight: 38,
    paddingHorizontal: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mobileTabText: {
    fontSize: 13,
    fontWeight: '700',
  },
  mobilePane: {
    flex: 1,
  },
});
