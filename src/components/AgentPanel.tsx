import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentControlKey, AgentProvider, AgentStatus } from '../../shared/types';
import { compactAnsiLog, parseAnsiSgr } from '../lib/ansi';
import { useTaskStore } from '../store/taskStore';

// Direct singleton for stall state that the main process pushes into
// (avoids requiring the store to import electron IPC types)
let globalStallMessage: string | null = null;
let globalStallListeners = new Set<() => void>();

export function getGlobalStallMessage(): string | null {
  return globalStallMessage;
}

export function subscribeGlobalStall(listener: () => void): () => void {
  globalStallListeners.add(listener);
  return () => {
    globalStallListeners.delete(listener);
  };
}

export function clearGlobalStallMessage(): void {
  globalStallMessage = null;
  globalStallListeners.forEach((fn) => fn());
}

// Initialize the stall listener from main process
if (typeof window !== 'undefined' && window.electronAPI?.onAgentIdleWarning) {
  window.electronAPI.onAgentIdleWarning((message: string) => {
    globalStallMessage = message;
    globalStallListeners.forEach((fn) => fn());
  });
}

const statusLabel: Record<AgentStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  waitingApproval: 'Waiting Approval',
  error: 'Error',
};

const statusClass: Record<AgentStatus, string> = {
  idle: 'bg-emerald-400',
  running: 'bg-blue-400',
  waitingApproval: 'bg-yellow-400',
  error: 'bg-red-400',
};

const providerLabel: Record<AgentProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  'cmux-codex': 'CMUX Codex',
  'cmux-claude': 'CMUX Claude',
  custom: 'Custom',
};

const keyboardControlKeys: Record<string, AgentControlKey> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  ' ': 'Space',
  Spacebar: 'Space',
};

const controlButtons: Array<{ key: AgentControlKey; label: string; title: string }> = [
  { key: 'Up', label: '↑', title: 'Up' },
  { key: 'Down', label: '↓', title: 'Down' },
  { key: 'Left', label: '←', title: 'Left' },
  { key: 'Right', label: '→', title: 'Right' },
  { key: 'Enter', label: '↵', title: 'Enter' },
  { key: 'Escape', label: 'Esc', title: 'Escape' },
  { key: 'Tab', label: 'Tab', title: 'Tab' },
  { key: 'Space', label: 'Space', title: 'Space' },
];

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

function PanelToggleButton({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      title={collapsed ? 'Expand agent panel' : 'Collapse agent panel'}
      aria-label={collapsed ? 'Expand agent panel' : 'Collapse agent panel'}
      className="grid h-5 w-10 place-items-center rounded text-[10px] leading-none text-[#5F6876] transition-colors hover:bg-[#EAEAED] hover:text-[#20242C]"
    >
      {collapsed ? '⌃' : '⌄'}
    </button>
  );
}

function AnsiLog({ text }: { text: string }) {
  const segments = useMemo(() => parseAnsiSgr(text), [text]);

  return (
    <>
      {segments.map((segment, index) => (
        <span key={`${index}-${segment.text.length}`} style={segment.style}>
          {segment.text}
        </span>
      ))}
    </>
  );
}

function useStallMessage(): string | null {
  const [stallMessage, setStallMessage] = useState<string | null>(globalStallMessage);

  useEffect(() => {
    const unsubscribe = subscribeGlobalStall(() => {
      setStallMessage(getGlobalStallMessage());
    });
    return unsubscribe;
  }, []);

  return stallMessage;
}

export default function AgentPanel({
  height,
  collapsed,
  onToggleCollapse,
}: {
  height: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const store = useTaskStore();
  const stallMessage = useStallMessage();
  const [message, setMessage] = useState('');

  // Clear stall message when agent starts running or becomes idle
  useEffect(() => {
    if (store.agentStatus === 'running' || store.agentStatus === 'idle') {
      clearGlobalStallMessage();
    }
  }, [store.agentStatus]);
  const [isSending, setIsSending] = useState(false);
  const logViewportRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const wasCollapsedRef = useRef(collapsed);
  const sessionName = store.projectBinding?.tmuxSession ?? 'agent';
  const currentProvider = store.projectBinding?.agentProvider ?? store.agentConfig.provider;
  const showTerminalControls = store.agentConfig.showTerminalControls;
  const log = store.agentLog.trimEnd();
  const compactLog = useMemo(() => compactAnsiLog(log), [log]);
  const terminalText = compactLog || 'No agent output yet.';

  const scrollLogToBottom = useCallback(() => {
    const viewport = logViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, []);

  const updateStickToBottom = useCallback(() => {
    const viewport = logViewportRef.current;
    if (!viewport) return;

    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom <= 32;
  }, []);

  const handleSend = async () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || isSending) return;

    try {
      setIsSending(true);
      const sent = await store.sendAgentMessage(trimmedMessage);
      if (sent) {
        setMessage('');
      }
    } finally {
      setIsSending(false);
    }
  };

  const sendControlKey = (key: AgentControlKey) => {
    void store.sendAgentKey(key);
  };

  useEffect(() => {
    // Only capture keyboard when terminal is visible and controls are enabled.
    // When collapsed, these keys belong to normal UI interactions (Escape for
    // modals, Space for checkboxes, Arrow keys for scrolling, etc.).
    if (collapsed || !showTerminalControls) return;

    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      const controlKey = keyboardControlKeys[event.key];
      if (!controlKey) {
        return;
      }

      event.preventDefault();
      void store.sendAgentKey(controlKey);
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, [store, collapsed, showTerminalControls]);

  useEffect(() => {
    if (collapsed) {
      wasCollapsedRef.current = true;
      return;
    }

    const shouldScroll = wasCollapsedRef.current || shouldStickToBottomRef.current;
    wasCollapsedRef.current = false;

    if (!shouldScroll) {
      return;
    }

    const frame = window.requestAnimationFrame(scrollLogToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [collapsed, height, scrollLogToBottom, terminalText]);

  if (collapsed) {
    return (
      <section className="no-drag shrink-0 px-1.5 pb-1 pt-0">
        <div
          role="button"
          tabIndex={0}
          onClick={onToggleCollapse}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onToggleCollapse();
            }
          }}
          className="group flex cursor-pointer items-center justify-between gap-1.5 rounded-md border border-[#DDE1E8] bg-white px-2 py-0.5 outline-none transition-colors hover:bg-[#EAEAED] focus:bg-[#EAEAED]"
        >
          <div className="min-w-0 flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${statusClass[store.agentStatus]}`} />
            <span className="text-[12px] font-semibold leading-4 text-[#20242C] transition-colors group-hover:text-[#111827]">
              {statusLabel[store.agentStatus]}
            </span>
            <span className="text-[10px] leading-4 text-[#5F6876] transition-colors group-hover:text-[#3B414C]">
              {providerLabel[currentProvider]}
            </span>
            <span className="truncate text-[10px] leading-4 text-[#5F6876] transition-colors group-hover:text-[#3B414C]">
              {sessionName}
            </span>
          </div>
          <PanelToggleButton collapsed={collapsed} onToggle={onToggleCollapse} />
        </div>
      </section>
    );
  }

  return (
    <section
      className="no-drag flex shrink-0 flex-col overflow-hidden px-1.5 pb-1 pt-0"
      style={{ height }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleCollapse}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleCollapse();
          }
        }}
        className="group flex shrink-0 cursor-pointer items-center justify-between gap-1.5 rounded-t-md border border-b-0 border-[#DDE1E8] bg-white px-2 py-0.5 outline-none transition-colors hover:bg-[#EAEAED] focus:bg-[#EAEAED]"
      >
        <div className="min-w-0 flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${statusClass[store.agentStatus]} ${store.agentStatus === 'running' ? 'animate-pulse' : ''}`} />
          <span className="text-[12px] font-semibold leading-4 text-[#20242C] transition-colors group-hover:text-[#111827]">
            {statusLabel[store.agentStatus]}
          </span>
          <span className="text-[10px] leading-4 text-[#5F6876] transition-colors group-hover:text-[#3B414C]">
            {providerLabel[currentProvider]}
          </span>
          <span className="truncate text-[10px] leading-4 text-[#5F6876] transition-colors group-hover:text-[#3B414C]">
            {sessionName}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {store.agentStatus === 'waitingApproval' && (
            <>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  void store.sendApproval('approve');
                }}
                className="rounded-md bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/20"
              >
                Approve
              </button>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  void store.sendApproval('reject');
                }}
                className="rounded-md bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-700 transition-colors hover:bg-red-500/20"
              >
                Reject
              </button>
            </>
          )}
          <PanelToggleButton collapsed={collapsed} onToggle={onToggleCollapse} />
        </div>
      </div>

      {store.agentError && (
        <div className="shrink-0 border-x border-red-500/20 bg-red-500/5 px-2.5 py-1 text-[11px] text-red-600">
          {store.agentError}
        </div>
      )}

      {!store.agentError && stallMessage && (
        <div className="shrink-0 border-x border-yellow-500/20 bg-yellow-500/5 px-2.5 py-1.5">
          <div className="flex items-start gap-1.5">
            <p className="flex-1 text-[11px] text-yellow-600">{stallMessage}</p>
            <button
              onClick={async () => {
                clearGlobalStallMessage();
                await window.electronAPI.resetStallTimer();
              }}
              title="Dismiss"
              aria-label="Dismiss"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-yellow-700 hover:bg-yellow-500/20 transition-colors"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div
        ref={logViewportRef}
        role="log"
        aria-label="Agent terminal output"
        onScroll={updateStickToBottom}
        className="scrollable terminal-log min-h-0 flex-1 overflow-y-auto overflow-x-hidden border-x border-t border-[#101114] bg-[#101114] p-2 font-mono text-[11px] leading-none text-[#E9EDF5] whitespace-pre-wrap break-words"
        style={{ scrollbarGutter: 'stable' }}
      >
        <AnsiLog text={terminalText} />
      </div>

      <div className="flex shrink-0 flex-col gap-1 rounded-b-md border-x border-b border-[#101114] bg-[#101114] px-1.5 pb-1 pt-0">
        {showTerminalControls && (
          <div className="grid grid-cols-8 gap-1">
            {controlButtons.map((button) => (
              <button
                key={button.key}
                onClick={() => sendControlKey(button.key)}
                title={button.title}
                aria-label={button.title}
                className="h-5 min-w-0 rounded border border-white/10 bg-white/[0.06] text-[10px] font-medium text-[#AAB2C0] transition-colors hover:border-[#EAEAED] hover:bg-[#EAEAED] hover:text-[#20242C]"
              >
                {button.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-end gap-1.5 rounded bg-white/[0.07] px-2 py-0.5 transition-colors hover:bg-white/[0.1] focus-within:bg-white/[0.12]">
          <span className="select-none pt-0.5 font-mono text-xs leading-4 text-emerald-300">&gt;</span>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return;
              }

              const controlKey = keyboardControlKeys[event.key];
              const shouldSendControlKey =
                !message.trim() &&
                controlKey &&
                !event.shiftKey &&
                !event.altKey &&
                !event.metaKey &&
                !event.ctrlKey;

              if (shouldSendControlKey) {
                event.preventDefault();
                sendControlKey(controlKey);
                return;
              }

              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            rows={1}
            placeholder="Ask agent..."
            aria-label="Ask agent"
            className="min-h-[22px] max-h-14 flex-1 resize-none border border-transparent bg-transparent px-0 py-0.5 font-mono text-xs leading-4 text-[#F8FAFC] outline-none placeholder:text-[#737B89]"
          />
          <button
            onClick={() => void handleSend()}
            disabled={!message.trim() || isSending}
            className="h-[22px] rounded bg-tick-accent/90 px-2.5 text-[11px] font-medium leading-4 text-white transition-colors hover:bg-tick-accent disabled:bg-white/10 disabled:text-[#737B89]"
          >
            Send
          </button>
        </div>
      </div>
    </section>
  );
}
