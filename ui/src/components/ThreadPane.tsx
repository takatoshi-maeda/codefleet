import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type {
  CodefleetClient,
  ConversationGetResult,
  ConversationSummary,
  JsonRpcNotification,
} from '../mcp/client';
import { useCodefleetColors } from '../theme/useCodefleetColors';

type Props = {
  client: CodefleetClient;
  title?: string;
  agentId?: string;
};

type ContentPart = { type: 'text'; text: string } | { type: 'image'; url: string };

type TimelineItem =
  | {
      id: string;
      kind: 'reasoning';
      text: string;
      status: 'running' | 'completed';
    }
  | {
      id: string;
      kind: 'tool-call';
      summary: string;
      status: 'running' | 'completed' | 'failed';
      argumentLines?: string[];
    }
  | {
      id: string;
      kind: 'text';
      text: string;
      startedAt?: number;
      updatedAt?: number;
      completedAt?: number;
      durationSeconds?: number;
    };

type AgentEntry = {
  kind: 'agent-response';
  status: 'running' | 'succeeded' | 'failed';
  timeline: TimelineItem[];
  responseText?: string;
  errorMessage?: string;
};

type ThreadMessage = {
  id: string;
  role: 'user' | 'agent' | 'system';
  author: string;
  timestamp: string;
  content: string;
  contentParts?: ContentPart[];
  status?: 'running' | 'completed' | 'failed';
  statusLine?: string;
  entry?: AgentEntry;
};

type ExtendedConversationTurn = ConversationGetResult['turns'][number] & {
  timeline?: TimelineItem[] | null;
  userContent?: string | Array<{ type: string; text?: string; source?: { type: string; url?: string } }>;
  agentName?: string | null;
};

type ExtendedConversation = ConversationGetResult & {
  turns: ExtendedConversationTurn[];
  inProgress?: (NonNullable<ConversationGetResult['inProgress']> & {
    timeline?: TimelineItem[] | null;
    userContent?: string | Array<{ type: string; text?: string; source?: { type: string; url?: string } }>;
    agentName?: string | null;
  }) | null;
};

type StreamDraft = {
  userMessage: ThreadMessage;
  agentMessage: ThreadMessage;
  startedAt: string;
};

const POLL_INTERVAL_MS = 2000;
const INITIAL_VISIBLE_TIMELINE = 3;

function messageId(prefix: string): string {
  return `${prefix}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function formatShortTimestamp(isoString?: string | null): string {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (Number.isNaN(d.valueOf())) return '';
  const mo = d.getMonth() + 1;
  const da = d.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${mo}月${da}日 ${h}:${m}`;
}

function formatDuration(seconds: number): string {
  const n = Math.max(0, Math.floor(seconds));
  const s = n % 60;
  const totalM = Math.floor(n / 60);
  const m = totalM % 60;
  const h = Math.floor(totalM / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function parseUserContentParts(value: ExtendedConversationTurn['userContent']): ContentPart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part): ContentPart[] => {
    if (part?.type === 'text' && typeof part.text === 'string') {
      return [{ type: 'text', text: part.text }];
    }
    if (part?.type === 'image' && part.source?.type === 'url' && typeof part.source.url === 'string') {
      return [{ type: 'image', url: part.source.url }];
    }
    return [];
  });
  return parts.length > 0 ? parts : undefined;
}

function getAgentMessageContent(entry: AgentEntry): string {
  if (entry.responseText?.trim()) return entry.responseText.trim();
  for (let i = entry.timeline.length - 1; i >= 0; i -= 1) {
    const item = entry.timeline[i];
    if (item.kind === 'text' && item.text.trim()) return item.text.trim();
  }
  return entry.errorMessage?.trim() || '';
}

function timelineItemKey(item: TimelineItem): string {
  if (item.kind === 'reasoning') return `reasoning:${item.text}`;
  if (item.kind === 'tool-call') {
    return `tool:${item.summary}:${item.argumentLines?.join('\n') ?? ''}`;
  }
  return `text:${item.text}`;
}

function mergeTimeline(remote: TimelineItem[], local: TimelineItem[]): TimelineItem[] {
  if (remote.length === 0) return [...local];
  if (local.length === 0) return [...remote];

  const merged: TimelineItem[] = [...remote];
  const seen = new Set(merged.map(timelineItemKey));
  for (const item of local) {
    const key = timelineItemKey(item);
    if (seen.has(key)) continue;
    merged.push(item);
    seen.add(key);
  }
  return merged;
}

function mergeAgentEntry(remote: AgentEntry | undefined, local: AgentEntry | undefined): AgentEntry | undefined {
  if (!remote) return local ? { ...local, timeline: [...local.timeline] } : undefined;
  if (!local) return remote;

  const responseText = (() => {
    const remoteText = remote.responseText?.trim() ?? '';
    const localText = local.responseText?.trim() ?? '';
    return localText.length > remoteText.length ? local.responseText : remote.responseText;
  })();

  return {
    ...remote,
    status:
      remote.status !== 'running'
        ? remote.status
        : local.status === 'failed'
          ? 'failed'
          : 'running',
    responseText,
    errorMessage: remote.errorMessage ?? local.errorMessage,
    timeline: mergeTimeline(remote.timeline, local.timeline),
  };
}

function completeRunningTimelineItems(timeline: TimelineItem[]): TimelineItem[] {
  return timeline.map((item) => {
    if (item.kind === 'reasoning' && item.status === 'running') {
      return { ...item, status: 'completed' };
    }
    if (item.kind === 'tool-call' && item.status === 'running') {
      return { ...item, status: 'completed' };
    }
    return item;
  });
}

function buildAgentStatusLine(entry: AgentEntry, indicatorSeconds: number): string | undefined {
  if (entry.status !== 'running') return undefined;
  const tool = [...entry.timeline]
    .reverse()
    .find((item): item is Extract<TimelineItem, { kind: 'tool-call' }> => item.kind === 'tool-call' && item.status === 'running');
  if (tool && tool.summary.trim()) {
    return `Tool: ${tool.summary.trim()}${indicatorSeconds > 0 ? ` (${formatDuration(indicatorSeconds)})` : ''}`;
  }
  return `Thinking${indicatorSeconds > 0 ? ` (${formatDuration(indicatorSeconds)})` : ''}`;
}

function toThreadMessages(conversation: ExtendedConversation, fallbackAgentName: string, elapsedSeconds: number): ThreadMessage[] {
  const messages: ThreadMessage[] = [];

  for (const turn of conversation.turns) {
    messages.push({
      id: `${turn.turnId}:user`,
      role: 'user',
      author: 'You',
      timestamp: turn.timestamp,
      content: turn.userMessage,
      contentParts: parseUserContentParts(turn.userContent),
      status: 'completed',
    });

    const agentEntry: AgentEntry = {
      kind: 'agent-response',
      status: turn.status === 'error' ? 'failed' : 'succeeded',
      timeline: turn.timeline ?? [],
      responseText: turn.assistantMessage,
      errorMessage: turn.errorMessage ?? undefined,
    };
    messages.push({
      id: `${turn.turnId}:agent`,
      role: 'agent',
      author: turn.agentName?.trim() || conversation.agentName?.trim() || fallbackAgentName,
      timestamp: turn.timestamp,
      content: getAgentMessageContent(agentEntry),
      status: turn.status === 'error' ? 'failed' : 'completed',
      statusLine: turn.status === 'error' ? turn.errorMessage ?? 'Error' : undefined,
      entry: agentEntry,
    });
  }

  if (conversation.status === 'progress' && conversation.inProgress) {
    const startedAt = conversation.inProgress.startedAt ?? conversation.inProgress.updatedAt ?? new Date().toISOString();
    const userMessage = conversation.inProgress.userMessage?.trim();
    if (userMessage) {
      messages.push({
        id: `${conversation.inProgress.turnId ?? 'progress'}:user`,
        role: 'user',
        author: 'You',
        timestamp: startedAt,
        content: userMessage,
        contentParts: parseUserContentParts(conversation.inProgress.userContent),
        status: 'completed',
      });
    }

    const agentEntry: AgentEntry = {
      kind: 'agent-response',
      status: 'running',
      timeline: conversation.inProgress.timeline ?? [],
      responseText: conversation.inProgress.assistantMessage ?? undefined,
    };
    messages.push({
      id: `${conversation.inProgress.turnId ?? 'progress'}:agent`,
      role: 'agent',
      author: conversation.inProgress.agentName?.trim() || conversation.agentName?.trim() || fallbackAgentName,
      timestamp: startedAt,
      content: getAgentMessageContent(agentEntry),
      status: 'running',
      statusLine: buildAgentStatusLine(agentEntry, elapsedSeconds),
      entry: agentEntry,
    });
  }

  return messages;
}

function jsonArgsToYaml(lines: string[]): string[] {
  const joined = lines.join('');
  try {
    const parsed = JSON.parse(joined);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([key, value]) => {
        const v = typeof value === 'string' ? value : JSON.stringify(value);
        return `${key}: ${v}`;
      });
    }
  } catch {}

  const result: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const v = typeof value === 'string' ? value : JSON.stringify(value);
          result.push(`${key}: ${v}`);
        }
        continue;
      }
    } catch {}
    result.push(line);
  }
  return result;
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function TimelineDot({
  running,
  colors,
}: {
  running: boolean;
  colors: ReturnType<typeof useCodefleetColors>;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!running) {
      setVisible(true);
      return;
    }
    const id = setInterval(() => setVisible((v) => !v), 500);
    return () => clearInterval(id);
  }, [running]);

  return (
    <View
      style={[
        tlStyles.dot,
        {
          backgroundColor: running ? colors.mutedText : '#14b8a6',
          opacity: visible ? 1 : 0.25,
        },
      ]}
    />
  );
}

function InlineTimelineItem({
  item,
  colors,
}: {
  item: TimelineItem;
  colors: ReturnType<typeof useCodefleetColors>;
}) {
  if (item.kind === 'reasoning') {
    return (
      <View style={tlStyles.item}>
        <View style={tlStyles.header}>
          <TimelineDot running={item.status === 'running'} colors={colors} />
          <Text style={[tlStyles.label, { color: colors.text }]}>Thinking</Text>
        </View>
      </View>
    );
  }

  if (item.kind === 'tool-call') {
    const yamlLines = item.argumentLines && item.argumentLines.length > 0
      ? jsonArgsToYaml(item.argumentLines)
      : null;
    return (
      <View style={tlStyles.item}>
        <View style={tlStyles.header}>
          <TimelineDot running={item.status === 'running'} colors={colors} />
          <Text style={[tlStyles.label, { color: colors.text }]}>
            ToolCall: {item.summary || 'tool_call'}
          </Text>
        </View>
        {yamlLines ? (
          <View style={tlStyles.args}>
            {yamlLines.map((line, i) => (
              <Text key={i} style={[tlStyles.argLine, { color: colors.mutedText }]} numberOfLines={2}>
                {i === 0 ? '\u2514 ' : '  '}
                {line}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    );
  }

  if (!item.text.trim()) return null;
  return (
    <View style={tlStyles.responseBlock}>
      <View style={[tlStyles.dot, { backgroundColor: colors.tint, marginTop: 6 }]} />
      <Text style={[tlStyles.responseText, { color: colors.text }]}>{item.text.trim()}</Text>
    </View>
  );
}

function AgentInlineTimeline({
  entry,
  liveElapsed,
  colors,
}: {
  entry: AgentEntry;
  liveElapsed: number;
  colors: ReturnType<typeof useCodefleetColors>;
}) {
  const [expanded, setExpanded] = useState(false);
  const timeline = entry.timeline;
  const isRunning = entry.status === 'running';

  if (timeline.length === 0 && !isRunning) return null;

  const hasThinkingOrTool = timeline.some((t) => t.kind === 'reasoning' || t.kind === 'tool-call');
  const hasTimelineText = timeline.some((t) => t.kind === 'text' && t.text.trim().length > 0);
  const hasResponseText = !!entry.responseText?.trim();
  const showSyntheticThinking = isRunning && !hasThinkingOrTool && !hasResponseText;
  const hiddenCount = expanded ? 0 : Math.max(0, timeline.length - INITIAL_VISIBLE_TIMELINE);
  const visibleItems = expanded ? timeline : timeline.slice(hiddenCount);
  const durationText = isRunning
    ? `Working ${formatDuration(liveElapsed)}`
    : undefined;

  return (
    <View style={tlStyles.container}>
      {hiddenCount > 0 ? (
        <Pressable onPress={() => setExpanded(true)} style={tlStyles.showEarlier}>
          <Ionicons name="chevron-down" size={14} color={colors.tint} />
          <Text style={[tlStyles.showEarlierText, { color: colors.tint }]}>
            Show {hiddenCount} earlier
          </Text>
        </Pressable>
      ) : expanded && timeline.length > INITIAL_VISIBLE_TIMELINE ? (
        <Pressable onPress={() => setExpanded(false)} style={tlStyles.showEarlier}>
          <Ionicons name="chevron-up" size={14} color={colors.tint} />
          <Text style={[tlStyles.showEarlierText, { color: colors.tint }]}>Show less</Text>
        </Pressable>
      ) : null}
      {showSyntheticThinking ? (
        <View style={tlStyles.item}>
          <View style={tlStyles.header}>
            <TimelineDot running colors={colors} />
            <Text style={[tlStyles.label, { color: colors.text }]}>Thinking</Text>
          </View>
        </View>
      ) : null}
      {visibleItems.map((item) => (
        <InlineTimelineItem key={item.id} item={item} colors={colors} />
      ))}
      {!hasTimelineText && entry.responseText?.trim() ? (
        <View style={tlStyles.responseBlock}>
          <View style={[tlStyles.dot, { backgroundColor: colors.tint, marginTop: 6 }]} />
          <Text style={[tlStyles.responseText, { color: colors.text }]}>
            {entry.responseText.trim()}
          </Text>
        </View>
      ) : null}
      {durationText ? (
        <View style={tlStyles.durationRow}>
          <Text style={[tlStyles.duration, { color: colors.mutedText }]}>{durationText}</Text>
          <View style={[tlStyles.durationRule, { backgroundColor: colors.mutedText }]} />
        </View>
      ) : null}
    </View>
  );
}

function ThreadMessageView({
  message,
  liveElapsed,
  colors,
}: {
  message: ThreadMessage;
  liveElapsed: number;
  colors: ReturnType<typeof useCodefleetColors>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [viewerImageUrl, setViewerImageUrl] = useState<string | null>(null);

  const handleCopy = useCallback(() => {
    if (!message.content) return;
    void copyToClipboard(message.content);
  }, [message.content]);

  if (message.role === 'system') {
    return (
      <View style={styles.systemContainer}>
        <Text style={[styles.systemText, { color: colors.mutedText }]}>{message.content}</Text>
      </View>
    );
  }

  const isUser = message.role === 'user';
  const avatarColor = isUser ? '#22c55e' : colors.text;
  const hasTimeline = !isUser && message.entry && (message.entry.timeline.length > 0 || message.entry.status === 'running');

  return (
    <>
      <View style={styles.messageContainer}>
        <View style={styles.messageHeader}>
          <View style={styles.authorRow}>
            <View style={[styles.authorAvatar, { backgroundColor: avatarColor }]}>
              {isUser ? <Text style={styles.avatarText}>You</Text> : null}
            </View>
            <Text style={[styles.authorName, { color: colors.text }]}>{message.author}</Text>
            <Text style={[styles.timestamp, { color: colors.mutedText }]}>
              {formatShortTimestamp(message.timestamp)}
            </Text>
          </View>
          <Pressable onPress={() => setCollapsed((c) => !c)} hitSlop={8}>
            <Ionicons
              name={collapsed ? 'chevron-forward' : 'chevron-down'}
              size={18}
              color={colors.mutedText}
            />
          </Pressable>
        </View>
        {!collapsed ? (
          <View style={styles.messageBody}>
            {hasTimeline ? (
              <AgentInlineTimeline entry={message.entry!} liveElapsed={liveElapsed} colors={colors} />
            ) : (
              <>
                {isUser && Array.isArray(message.contentParts) && message.contentParts.length > 0 ? (
                  <View style={styles.imageGroup}>
                    {message.contentParts.map((part, index) => {
                      if (part.type === 'image') {
                        return (
                          <Pressable
                            key={`${message.id}-part-${index}`}
                            onPress={() => setViewerImageUrl(part.url)}
                            hitSlop={4}
                          >
                            <Image
                              source={{ uri: part.url }}
                              style={styles.inlineImage}
                              resizeMode="cover"
                            />
                          </Pressable>
                        );
                      }
                      return (
                        <Pressable key={`${message.id}-part-${index}`} onLongPress={handleCopy}>
                          <Text style={[styles.content, { color: colors.text }]}>{part.text}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : message.content ? (
                  <Pressable onLongPress={handleCopy}>
                    <Text style={[styles.content, { color: colors.text }]}>{message.content}</Text>
                  </Pressable>
                ) : message.statusLine ? (
                  <Text style={[styles.statusLine, { color: colors.mutedText }]}>{message.statusLine}</Text>
                ) : null}
              </>
            )}
            {!isUser && message.content && !hasTimeline ? (
              <Pressable onPress={handleCopy} style={styles.copyButton}>
                <Ionicons name="copy-outline" size={16} color={colors.mutedText} />
              </Pressable>
            ) : null}
            {!hasTimeline && message.statusLine && message.content ? (
              <Text style={[styles.statusLine, { color: colors.mutedText }]}>{message.statusLine}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
      <Modal
        visible={viewerImageUrl !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setViewerImageUrl(null)}
      >
        <Pressable style={styles.viewerBackdrop} onPress={() => setViewerImageUrl(null)}>
          <Pressable style={styles.viewerClose} onPress={() => setViewerImageUrl(null)} hitSlop={8}>
            <Ionicons name="close" size={24} color="#ffffff" />
          </Pressable>
          {viewerImageUrl ? (
            <Image source={{ uri: viewerImageUrl }} style={styles.viewerImage} resizeMode="contain" />
          ) : null}
        </Pressable>
      </Modal>
    </>
  );
}

function ThreadDetail({
  messages,
  elapsedSeconds,
  colors,
}: {
  messages: ThreadMessage[];
  elapsedSeconds: number;
  colors: ReturnType<typeof useCodefleetColors>;
}) {
  const listRef = useRef<FlatList<ThreadMessage>>(null);

  const handleContentSizeChange = useCallback(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages.length]);

  return (
    <View style={styles.threadContainer}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ThreadMessageView message={item} liveElapsed={elapsedSeconds} colors={colors} />
        )}
        contentContainerStyle={styles.threadContent}
        onContentSizeChange={handleContentSizeChange}
      />
    </View>
  );
}

function Composer({
  draft,
  onChangeDraft,
  onSubmit,
  onAbort,
  isSubmitting,
  colors,
}: {
  draft: string;
  onChangeDraft: (value: string) => void;
  onSubmit: () => void;
  onAbort: () => void;
  isSubmitting: boolean;
  colors: ReturnType<typeof useCodefleetColors>;
}) {
  const canSend = draft.trim().length > 0 && !isSubmitting;

  const handleKeyPress = (event: any) => {
    if (Platform.OS !== 'web') return;
    const { key, shiftKey, isComposing } = event.nativeEvent ?? {};
    if (isComposing) return;
    if (key === 'Enter' && !shiftKey) {
      event.preventDefault?.();
      onSubmit();
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <View
        style={[
          styles.composerContainer,
          { backgroundColor: colors.background, borderTopColor: colors.surfaceBorder },
        ]}
      >
        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, { color: colors.text }]}
            underlineColorAndroid="transparent"
            value={draft}
            onChangeText={onChangeDraft}
            onKeyPress={handleKeyPress}
            placeholder="メッセージを入力..."
            placeholderTextColor={`${colors.mutedText}99`}
            multiline
            maxLength={10000}
            editable={!isSubmitting}
            onSubmitEditing={onSubmit}
            blurOnSubmit={false}
          />
          {isSubmitting ? (
            <Pressable style={styles.button} onPress={onAbort}>
              <Ionicons name="stop-circle" size={28} color="#f87171" />
            </Pressable>
          ) : (
            <Pressable
              style={[
                styles.sendButton,
                { backgroundColor: canSend ? colors.tint : `${colors.mutedText}33` },
              ]}
              onPress={onSubmit}
              disabled={!canSend}
            >
              <Ionicons
                name="arrow-up"
                size={20}
                color={canSend ? '#ffffff' : `${colors.mutedText}66`}
              />
            </Pressable>
          )}
        </View>
        <View style={styles.bottomRow}>
          <Pressable style={styles.button} disabled>
            <Ionicons name="attach" size={22} color={`${colors.mutedText}55`} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function applyStreamEvent(current: ThreadMessage, event: JsonRpcNotification): ThreadMessage {
  const params =
    event.params && typeof event.params === 'object'
      ? (event.params as Record<string, unknown>)
      : null;
  const type = typeof params?.type === 'string' ? params.type : '';
  const nextEntry: AgentEntry = current.entry
    ? { ...current.entry, timeline: [...current.entry.timeline] }
    : { kind: 'agent-response', status: 'running', timeline: [] };

  if (type === 'agent.text_delta') {
    const delta = typeof params?.delta === 'string' ? params.delta : '';
    nextEntry.timeline = completeRunningTimelineItems(nextEntry.timeline);
    nextEntry.responseText = `${nextEntry.responseText ?? ''}${delta}`;
  }

  if (type === 'agent.reasoning_summary_delta') {
    const delta = typeof params?.delta === 'string' ? params.delta : '';
    const last = nextEntry.timeline[nextEntry.timeline.length - 1];
    if (last?.kind === 'reasoning' && last.status === 'running') {
      last.text = `${last.text}${delta}`;
    } else {
      nextEntry.timeline.push({
        id: messageId('reasoning'),
        kind: 'reasoning',
        text: delta,
        status: 'running',
      });
    }
  }

  if (type === 'agent.tool_call') {
    const summary = typeof params?.summary === 'string' ? params.summary : 'tool_call';
    const description = typeof params?.description === 'string' ? params.description : '';
    nextEntry.timeline = nextEntry.timeline.map((item) =>
      item.kind === 'reasoning' && item.status === 'running'
        ? { ...item, status: 'completed' }
        : item,
    );
    nextEntry.timeline.push({
      id: typeof params?.toolCallId === 'string' ? params.toolCallId : messageId('tool'),
      kind: 'tool-call',
      summary,
      status: 'running',
      argumentLines: description ? description.split('\n') : undefined,
    });
  }

  if (type === 'agent.text_result') {
    nextEntry.timeline = completeRunningTimelineItems(nextEntry.timeline);
  }

  return {
    ...current,
    content: getAgentMessageContent(nextEntry),
    status: 'running',
    statusLine: buildAgentStatusLine(nextEntry, 0),
    entry: nextEntry,
  };
}

export function ThreadPane({ client, title = 'Feedback Desk', agentId }: Props) {
  const colors = useCodefleetColors();
  const [sessions, setSessions] = useState<ConversationSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('new');
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRunningRemote, setIsRunningRemote] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<string | null>(null);
  const [streamDraft, setStreamDraft] = useState<StreamDraft | null>(null);
  const [runningTick, setRunningTick] = useState(0);
  const turnHistoryRef = useRef<Record<string, AgentEntry>>({});
  const streamDraftRef = useRef<StreamDraft | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const elapsedSeconds = useMemo(() => {
    if (!isRunningRemote || !runStartedAt) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(runStartedAt).getTime()) / 1000));
  }, [isRunningRemote, runStartedAt, runningTick]);

  useEffect(() => {
    if (!isRunningRemote) return;
    const id = setInterval(() => setRunningTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [isRunningRemote]);

  const refreshSessions = useCallback(async () => {
    try {
      const result = await client.listConversations(50, agentId);
      const next = [...result.sessions].sort((a, b) => {
        const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0;
        const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0;
        return bTime - aTime;
      });
      setSessions(next);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load history.');
    }
  }, [agentId, client]);

  const loadConversation = useCallback(async (sessionId: string) => {
    if (!sessionId || sessionId === 'new') {
      const currentDraft = streamDraftRef.current;
      setMessages(currentDraft ? [currentDraft.userMessage, currentDraft.agentMessage] : []);
      setIsRunningRemote(!!currentDraft);
      setRunStartedAt(currentDraft?.startedAt ?? null);
      return;
    }

    setIsLoadingConversation(true);
    try {
      const result = (await client.getConversation(sessionId, agentId)) as ExtendedConversation;
      if (result.inProgress?.turnId && streamDraftRef.current?.agentMessage.entry) {
        turnHistoryRef.current[result.inProgress.turnId] = mergeAgentEntry(
          turnHistoryRef.current[result.inProgress.turnId],
          streamDraftRef.current.agentMessage.entry,
        ) ?? streamDraftRef.current.agentMessage.entry;
      }

      const nextMessages = toThreadMessages(result, title, 0).map((message) => {
        if (message.role !== 'agent') return message;
        const turnId = message.id.split(':')[0];
        const localEntry = turnHistoryRef.current[turnId];
        const mergedEntry = mergeAgentEntry(message.entry, localEntry);
        if (!mergedEntry) return message;
        const mergedStatus: ThreadMessage['status'] =
          mergedEntry.status === 'running'
            ? 'running'
            : mergedEntry.status === 'failed'
              ? 'failed'
              : 'completed';
        return {
          ...message,
          content: getAgentMessageContent(mergedEntry),
          entry: mergedEntry,
          status: mergedStatus,
          statusLine: buildAgentStatusLine(mergedEntry, 0) ?? message.statusLine,
        };
      });

      setMessages(nextMessages);
      setIsRunningRemote(result.status === 'progress');
      setRunStartedAt(result.inProgress?.startedAt ?? null);
      setErrorMessage(null);
      if (result.status !== 'progress') {
        setStreamDraft(null);
        streamDraftRef.current = null;
      }
    } catch (error) {
      setMessages([]);
      setIsRunningRemote(false);
      setRunStartedAt(null);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load conversation.');
    } finally {
      setIsLoadingConversation(false);
    }
  }, [agentId, client, title]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    void loadConversation(selectedSessionId);
    setIsHistoryOpen(false);
  }, [loadConversation, selectedSessionId]);

  useEffect(() => {
    // While a local `agent.run` stream is active, the live SSE payload is the source of truth.
    // Polling `conversations.get` in parallel causes message list churn on follow-up turns.
    if (!isRunningRemote || selectedSessionId === 'new' || streamDraft !== null) return;
    const timer = setInterval(() => {
      void loadConversation(selectedSessionId);
      void refreshSessions();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isRunningRemote, loadConversation, refreshSessions, selectedSessionId, streamDraft]);

  const historyItems = useMemo(
    () => sessions.filter((item) => item.sessionId && item.sessionId !== 'new'),
    [sessions],
  );

  const titleText =
    messages.find((m) => m.role === 'user')?.content?.split('\n')[0] ??
    sessions.find((item) => item.sessionId === selectedSessionId)?.latestUserMessage?.trim() ??
    title;
  const handleCopyAll = useCallback(async () => {
    const allText = messages
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.author}: ${m.content}`)
      .join('\n\n');
    if (!allText) return;
    await copyToClipboard(allText);
  }, [messages]);

  const handleAbort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsSubmitting(false);
    setIsRunningRemote(false);
    setRunStartedAt(null);
    setStreamDraft(null);
    streamDraftRef.current = null;
  }, []);

  const handleSubmit = useCallback(async () => {
    const text = draft.trim();
    if (!text || isSubmitting) return;

    const startedAt = new Date().toISOString();
    const optimisticUser: ThreadMessage = {
      id: messageId('user'),
      role: 'user',
      author: 'You',
      timestamp: startedAt,
      content: text,
      status: 'completed',
    };
    const optimisticAgent: ThreadMessage = {
      id: messageId('agent'),
      role: 'agent',
      author: title,
      timestamp: startedAt,
      content: '',
      status: 'running',
      statusLine: 'Thinking',
      entry: {
        kind: 'agent-response',
        status: 'running',
        timeline: [],
      },
    };

    setDraft('');
    setErrorMessage(null);
    setIsSubmitting(true);
    setIsRunningRemote(true);
    setRunStartedAt(startedAt);
    const nextStreamDraft: StreamDraft = {
      userMessage: optimisticUser,
      agentMessage: optimisticAgent,
      startedAt,
    };
    setStreamDraft(nextStreamDraft);
    streamDraftRef.current = nextStreamDraft;
    setMessages((prev) => [...prev, optimisticUser, optimisticAgent]);

    const abortController = new AbortController();
    abortRef.current = abortController;
    let latestAgentEntry: AgentEntry = optimisticAgent.entry!;

    try {
      const result = await client.runAgent({
        message: text,
        agentId,
        sessionId: selectedSessionId === 'new' ? undefined : selectedSessionId,
        signal: abortController.signal,
        onStreamEvent: (event) => {
          setMessages((previous) => {
            if (previous.length === 0) return previous;
            const next = [...previous];
            const last = next[next.length - 1];
            if (last?.role !== 'agent') return previous;
            const nextMessage = applyStreamEvent(last, event);
            latestAgentEntry = nextMessage.entry ?? latestAgentEntry;
            next[next.length - 1] = nextMessage;
            return next;
          });
          setStreamDraft((current) => {
            if (!current) return current;
            const nextAgentMessage = applyStreamEvent(current.agentMessage, event);
            latestAgentEntry = nextAgentMessage.entry ?? latestAgentEntry;
            const nextDraft = {
              ...current,
              agentMessage: nextAgentMessage,
            };
            streamDraftRef.current = nextDraft;
            return nextDraft;
          });
        },
      });
      abortRef.current = null;
      if (result.turnId) {
        turnHistoryRef.current[result.turnId] = mergeAgentEntry(
          turnHistoryRef.current[result.turnId],
          {
            ...latestAgentEntry,
            status: result.status === 'error' ? 'failed' : 'succeeded',
          },
        ) ?? {
          ...latestAgentEntry,
          status: result.status === 'error' ? 'failed' : 'succeeded',
        };
      }
      const nextSessionId = result.sessionId || selectedSessionId;
      setSelectedSessionId(nextSessionId);
      await Promise.all([loadConversation(nextSessionId), refreshSessions()]);
    } catch (error) {
      abortRef.current = null;
      if (abortController.signal.aborted) {
        setMessages((previous) => previous.filter((item) => item.id !== optimisticAgent.id));
        setStreamDraft(null);
        streamDraftRef.current = null;
        return;
      }
      const message = error instanceof Error ? error.message : 'Failed to send message.';
      setMessages((previous) => {
        if (previous.length === 0) return previous;
        const next = [...previous];
        const last = next[next.length - 1];
        if (last?.role === 'agent') {
          next[next.length - 1] = {
            ...last,
            content: message,
            status: 'failed',
            entry: last.entry ? { ...last.entry, status: 'failed', errorMessage: message } : undefined,
          };
        }
        return next;
      });
      setErrorMessage(message);
      setIsRunningRemote(false);
      setRunStartedAt(null);
      setStreamDraft(null);
      streamDraftRef.current = null;
    } finally {
      setIsSubmitting(false);
    }
  }, [agentId, client, draft, isSubmitting, loadConversation, refreshSessions, selectedSessionId, title]);

  return (
    <View style={[styles.container, { backgroundColor: colors.surface }]}>
      <View style={[styles.header, { borderBottomColor: colors.surfaceBorder }]}>
        {titleText.trim().length > 0 ? (
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {titleText}
          </Text>
        ) : (
          <View style={styles.headerSpacer} />
        )}
        <View style={styles.headerActions}>
          <Pressable onPress={handleCopyAll} hitSlop={8}>
            <Ionicons name="copy-outline" size={20} color={colors.mutedText} />
          </Pressable>
          <Pressable onPress={() => setIsHistoryOpen((v) => !v)} hitSlop={8}>
            <Ionicons
              name={isHistoryOpen ? 'time' : 'time-outline'}
              size={20}
              color={colors.mutedText}
            />
          </Pressable>
        </View>
      </View>

      {isHistoryOpen ? (
        <>
          <Pressable style={styles.historyDismissLayer} onPress={() => setIsHistoryOpen(false)} />
          <View
            style={[
              styles.historyPanel,
              {
                backgroundColor: colors.surface,
                borderColor: colors.surfaceBorder,
              },
            ]}
          >
            <Pressable
              style={[
                styles.historyItem,
                selectedSessionId === 'new' && { backgroundColor: colors.surfaceSelected },
              ]}
              onPress={() => setSelectedSessionId('new')}
            >
              <Ionicons name="create-outline" size={16} color={colors.mutedText} />
              <Text style={[styles.historyItemText, { color: colors.text }]} numberOfLines={1}>
                New Chat
              </Text>
            </Pressable>
            <ScrollView style={styles.historyList} contentContainerStyle={styles.historyListContent}>
              {historyItems.map((item) => {
                const label = item.latestUserMessage?.trim() || item.title?.trim() || item.sessionId;
                const isSelected = selectedSessionId === item.sessionId;
                return (
                  <Pressable
                    key={item.sessionId}
                    style={[styles.historyItem, isSelected && { backgroundColor: colors.surfaceSelected }]}
                    onPress={() => setSelectedSessionId(item.sessionId)}
                  >
                    <Ionicons name="chatbox-ellipses-outline" size={16} color={colors.mutedText} />
                    <Text style={[styles.historyItemText, { color: colors.text }]} numberOfLines={1}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
              {historyItems.length === 0 ? (
                <Text style={[styles.historyEmptyText, { color: colors.mutedText }]}>No history.</Text>
              ) : null}
            </ScrollView>
          </View>
        </>
      ) : null}

      <View style={styles.body}>
        {isLoadingConversation ? (
          <View style={styles.center}>
            <ActivityIndicator size="small" color={colors.mutedText} />
          </View>
        ) : messages.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyText, { color: colors.mutedText }]}>
              {title.trim().length > 0 ? `Start a conversation with ${title}.` : 'Start a conversation.'}
            </Text>
          </View>
        ) : (
          <ThreadDetail messages={messages} elapsedSeconds={elapsedSeconds} colors={colors} />
        )}
      </View>

      {errorMessage ? (
        <View style={[styles.errorBar, { borderTopColor: colors.surfaceBorder }]}>
          <Text style={[styles.errorText, { color: colors.error }]} numberOfLines={2}>
            {errorMessage}
          </Text>
        </View>
      ) : null}

      <Composer
        draft={draft}
        onChangeDraft={setDraft}
        onSubmit={() => void handleSubmit()}
        onAbort={handleAbort}
        isSubmitting={isSubmitting}
        colors={colors}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    flex: 1,
    marginRight: 12,
  },
  headerSpacer: {
    flex: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  historyPanel: {
    position: 'absolute',
    top: 58,
    right: 16,
    width: 320,
    maxHeight: 280,
    borderWidth: 1,
    borderRadius: 10,
    zIndex: 20,
    overflow: 'hidden',
  },
  historyDismissLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
  },
  historyList: {
    maxHeight: 232,
  },
  historyListContent: {
    paddingBottom: 6,
  },
  historyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  historyItemText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
  },
  historyEmptyText: {
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  body: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
  threadContainer: {
    flex: 1,
  },
  threadContent: {
    paddingVertical: 8,
  },
  messageContainer: {
    paddingHorizontal: 24,
    paddingVertical: 8,
  },
  messageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  authorAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 8,
    fontWeight: '700',
    color: '#ffffff',
  },
  authorName: {
    fontSize: 14,
    fontWeight: '700',
  },
  timestamp: {
    fontSize: 12,
  },
  messageBody: {
    paddingLeft: 32,
    paddingTop: 6,
  },
  content: {
    fontSize: 14,
    lineHeight: 22,
  },
  imageGroup: {
    marginBottom: 8,
    gap: 8,
  },
  inlineImage: {
    width: 240,
    maxWidth: '100%',
    height: 160,
    borderRadius: 10,
    backgroundColor: '#00000012',
  },
  viewerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  viewerImage: {
    width: '100%',
    height: '100%',
    maxWidth: 1200,
    maxHeight: 1200,
  },
  viewerClose: {
    position: 'absolute',
    top: 14,
    right: 14,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  statusLine: {
    marginTop: 6,
    fontSize: 13,
    fontStyle: 'italic',
  },
  copyButton: {
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  systemContainer: {
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingVertical: 8,
  },
  systemText: {
    fontSize: 13,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  errorBar: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  errorText: {
    fontSize: 12,
  },
  composerContainer: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    gap: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  input: {
    flex: 1,
    margin: 0,
    borderRadius: 0,
    padding: 0,
    outlineWidth: 0,
    outlineColor: 'transparent',
    fontSize: 14,
    maxHeight: 120,
    minHeight: 56,
  },
  button: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 36,
    height: 36,
  },
  sendButton: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 36,
    height: 36,
    borderRadius: 18,
  },
});

const tlStyles = StyleSheet.create({
  container: {
    gap: 4,
  },
  showEarlier: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
  },
  showEarlierText: {
    fontSize: 13,
    fontWeight: '500',
  },
  item: {
    gap: 2,
    paddingVertical: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
  },
  args: {
    paddingLeft: 16,
    gap: 2,
  },
  argLine: {
    fontSize: 12,
    lineHeight: 18,
  },
  responseBlock: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 2,
  },
  responseText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 22,
  },
  durationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  duration: {
    fontSize: 12,
  },
  durationRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    opacity: 0.35,
  },
});
