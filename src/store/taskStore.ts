import { useSyncExternalStore } from 'react';
import type {
  AgentConfig,
  AgentControlKey,
  AgentStatus,
  ApprovalDecision,
  Batch,
  BatchRuntimeState,
  ProjectBinding,
  Task,
  TaskStatus,
  TaskWithStatus,
} from '../../shared/types';
import { batchSentinel } from '../../shared/types';
import { parseTaskCompletedIndices } from '../lib/batchParser';

export interface TaskStore {
  filePath: string | null;
  projectBinding: ProjectBinding | null;
  agentConfig: AgentConfig;
  tasks: TaskWithStatus[];
  collapsed: boolean;
  isExecuting: boolean;
  currentRunId: string | null;
  snapshotTasks: Task[];
  currentTaskIndex: number;
  showSettings: boolean;
  lastDelete: { lineNumber: number; lineContent: string } | null;
  agentStatus: AgentStatus;
  agentLog: string;
  agentError: string | null;
  agentStallMessage: string | null;
  lastLogChangeTimestamp: number;

  // Batch queue state
  selectedLineNumbers: Set<number>;
  batches: Batch[];
  queuedLineNumbers: Set<number>;
  runningBatchId: string | null;
  nextBatchNumber: number;
  emptySelectionMessage: string | null;

  setFilePath: (path: string) => void;
  loadAgentConfig: () => Promise<void>;
  setAgentConfig: (config: AgentConfig) => Promise<void>;
  loadProjectBinding: () => Promise<void>;
  ensureAgentSession: () => Promise<void>;
  restartAgent: () => Promise<void>;
  setTasks: (tasks: Task[]) => void;
  toggleTask: (lineNumber: number) => Promise<void>;
  addTask: (title: string) => Promise<void>;
  editTaskTitle: (lineNumber: number, newTitle: string) => Promise<void>;
  deleteTask: (lineNumber: number) => Promise<void>;
  undoDeleteTask: () => Promise<void>;
  dismissUndo: () => void;
  refreshTasks: () => Promise<void>;
  refreshAgentLog: () => Promise<void>;
  sendApproval: (decision: ApprovalDecision) => Promise<void>;
  sendAgentMessage: (message: string) => Promise<boolean>;
  sendAgentKey: (key: AgentControlKey) => Promise<boolean>;
  setCollapsed: (collapsed: boolean) => void;

  // Execution
  executeTask: (task: Task) => Promise<void>;
  executeAll: () => Promise<void>;

  // Legacy task controls kept for the existing UI surface.
  cancelPendingTask: (task: Task) => void;
  pauseCurrentTask: () => Promise<void>;
  resumePausedTask: (task: Task) => Promise<void>;
  stopCurrentTask: () => Promise<void>;
  stopRun: () => Promise<void>;

  setShowSettings: (show: boolean) => void;
  getIncompleteTasks: () => Task[];
  getRunningTasks: () => TaskWithStatus[];
  areAllDone: () => boolean;

  // Batch queue actions
  toggleSelection: (lineNumber: number) => void;
  clearSelection: () => void;
  createBatch: () => Promise<void>;
  stopCurrentBatch: () => Promise<void>;
  cancelQueuedBatch: (batchId: string) => void;
  cancelQueuedTask: (lineNumber: number) => void;
  clearCompletedTasks: () => Promise<void>;
  clearEmptySelectionMessage: () => void;
  getRunningBatch: () => Batch | undefined;
  getQueuedBatches: () => Batch[];

  // Batch runtime persistence
  persistBatchRuntime: () => void;
  restoreBatchRuntime: () => Promise<void>;
}

function getIncompleteCount(tasks: Task[]): number {
  return tasks.filter((task) => !task.completed).length;
}

function getCompletionStatus(task: Task, fallback: TaskStatus): TaskStatus {
  return task.completed ? 'done' : fallback;
}

function getLastLineMarkerIndex(log: string, marker: string): number {
  const markerPattern = new RegExp(`(^|\\n)[ \\t]*${marker}[ \\t]*(\\r?\\n|$)`, 'g');
  let lastIndex = -1;
  let match = markerPattern.exec(log);

  while (match) {
    lastIndex = match.index;
    match = markerPattern.exec(log);
  }

  return lastIndex;
}

function getStatusFromLog(
  log: string,
  isExecuting: boolean,
  fallback: AgentStatus,
  handledApprovalMarkerIndex: number,
  handledBatchCompletedIndex: number
): AgentStatus {
  // Strip ANSI SGR sequences so markers are detectable even when the
  // tmux pane contains color codes (tmux capture-pane -e).
  const cleanLog = log.replace(/\x1b\[[0-9;:]*m/g, '');
  // Both completion markers count; only count DONE N if it's been handled (not prompt text).
  const allDoneIndexFromAll = getLastLineMarkerIndex(cleanLog, 'ALL_TASKS_COMPLETED');
  // Use the DONE \d+ regex (not lastIndexOf) so the template's "DONE N" (letter N, not
  // a digit) doesn't cause a false match in non-batch mode.
  const doneRegex = /^[ \t]*DONE (\d+)[ \t]*$/gm;
  let batchIndex = -1;
  let m: RegExpExecArray | null;
  while ((m = doneRegex.exec(cleanLog)) !== null) {
    batchIndex = m.index;
  }
  const allDoneIndex = batchIndex > handledBatchCompletedIndex
    ? Math.max(allDoneIndexFromAll, batchIndex)
    : allDoneIndexFromAll;
  const approvalIndex = getLastLineMarkerIndex(cleanLog, 'WAIT_APPROVAL');
  const approvedIndex = cleanLog.lastIndexOf('继续执行');
  const rejectedIndex = cleanLog.lastIndexOf('取消本步骤并重新规划');
  const responseIndex = Math.max(approvedIndex, rejectedIndex);

  if (allDoneIndex >= 0 && allDoneIndex > approvalIndex) {
    return 'idle';
  }

  if (
    approvalIndex >= 0 &&
    approvalIndex > allDoneIndex &&
    approvalIndex > responseIndex &&
    approvalIndex > handledApprovalMarkerIndex
  ) {
    return 'waitingApproval';
  }

  if (isExecuting) {
    return 'running';
  }

  return fallback === 'error' ? 'error' : 'idle';
}

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  provider: 'codex',
  customCommand: '',
  showTerminalControls: true,
  skipPermissions: false,
};

/**
 * Validate a persisted BatchRuntimeState before applying it on restore.
 * Returns false on any malformed field so the caller can bail to clean state
 * instead of crashing the renderer or writing to wrong task lines. Also rejects
 * a `runningBatchId` that does not exist among `batches[].id` (stale/forged
 * reference would otherwise drive writes against a missing batch).
 */
function isValidBatchRuntime(runtime: unknown): runtime is BatchRuntimeState {
  if (typeof runtime !== 'object' || runtime === null) return false;
  const r = runtime as Record<string, unknown>;

  // batches: array of { id: string, batchNumber: number, tasks: array }
  if (!Array.isArray(r.batches)) return false;
  for (const batch of r.batches) {
    if (typeof batch !== 'object' || batch === null) return false;
    const b = batch as Record<string, unknown>;
    if (typeof b.id !== 'string') return false;
    if (typeof b.batchNumber !== 'number') return false;
    if (!Array.isArray(b.tasks)) return false;
  }

  // runningBatchId: null or a string that exists among batch ids
  if (r.runningBatchId !== null) {
    if (typeof r.runningBatchId !== 'string') return false;
    const exists = (r.batches as Array<Record<string, unknown>>).some(
      (b) => b.id === r.runningBatchId
    );
    if (!exists) return false;
  }

  // Array fields with the expected element types.
  if (!Array.isArray(r.queuedLineNumbers) || !r.queuedLineNumbers.every(Number.isFinite)) {
    return false;
  }
  if (
    !Array.isArray(r.completedTaskIndices) ||
    !r.completedTaskIndices.every((n) => Number.isInteger(n))
  ) {
    return false;
  }
  if (!Array.isArray(r.snapshotTasks)) return false;

  // isExecuting must be a boolean.
  if (typeof r.isExecuting !== 'boolean') return false;

  // Numeric fields are coerced/defaulted by the caller, so they need not be
  // present here — only the structural fields above must be valid.
  return true;
}

const createStore = () => {
  let hasNotifiedCompletion = false;
  let handledApprovalMarkerIndex = -1;
  // Tracks the last WAIT_APPROVAL marker index we already notified for, so the
  // desktop notification fires exactly once per distinct approval request and
  // not on every 1s poll while approval stays pending.
  let notifiedApprovalIndex = -1;
  let handledBatchCompletedIndex = -1;
  let completedTaskIndices = new Set<number>();
  // Character offset in the agent log captured when a batch is sent. Only DONE
  // markers AFTER this position belong to the current batch — markers before it
  // are stale output from previous batches still in the tmux scrollback.
  let doneParseBaseline = -1;
  let refreshAgentLogInFlight = false;

  let state: TaskStore = {
    filePath: null,
    projectBinding: null,
    agentConfig: DEFAULT_AGENT_CONFIG,
    tasks: [],
    collapsed: false,
    isExecuting: false,
    currentRunId: null,
    snapshotTasks: [],
    currentTaskIndex: -1,
    showSettings: false,
    lastDelete: null,
    agentStatus: 'idle',
    agentLog: '',
    agentError: null,
    agentStallMessage: null,
    lastLogChangeTimestamp: 0,

    // Batch queue state
    selectedLineNumbers: new Set(),
    batches: [],
    queuedLineNumbers: new Set(),
    runningBatchId: null,
    nextBatchNumber: 1,
    emptySelectionMessage: null,

    setFilePath: (path: string) => {
      hasNotifiedCompletion = false;
      handledApprovalMarkerIndex = -1;
      notifiedApprovalIndex = -1;
      state = {
        ...state,
        filePath: path,
        projectBinding: null,
        agentStatus: 'idle',
        agentLog: '',
        agentError: null,
        agentStallMessage: null,
        lastLogChangeTimestamp: 0,
        isExecuting: false,
        currentRunId: null,
        snapshotTasks: [],
        currentTaskIndex: -1,
        selectedLineNumbers: new Set(),
        batches: [],
        queuedLineNumbers: new Set(),
        runningBatchId: null,
        nextBatchNumber: 1,
        emptySelectionMessage: null,
      };
      notify();
    },

    loadAgentConfig: async () => {
      const agentConfig = await window.electronAPI.getAgentConfig();
      state = { ...state, agentConfig };
      notify();
    },

    setAgentConfig: async (config: AgentConfig) => {
      const shouldRestartAgent =
        config.provider !== state.agentConfig.provider ||
        config.customCommand.trim() !== state.agentConfig.customCommand.trim() ||
        config.skipPermissions !== state.agentConfig.skipPermissions;
      const agentConfig = await window.electronAPI.setAgentConfig(config);
      const filePath = state.filePath;
      const projectBinding = filePath
        ? await window.electronAPI.getProjectBinding(filePath)
        : state.projectBinding;

      if (shouldRestartAgent) {
        handledApprovalMarkerIndex = -1;
        state = {
          ...state,
          agentConfig,
          projectBinding,
          agentStatus: 'idle',
          agentLog: '',
          agentError: null,
          agentStallMessage: null,
          lastLogChangeTimestamp: 0,
          isExecuting: false,
          currentRunId: null,
          snapshotTasks: [],
          currentTaskIndex: -1,
          selectedLineNumbers: new Set(),
          batches: [],
          queuedLineNumbers: new Set(),
          runningBatchId: null,
          nextBatchNumber: 1,
        };
      } else {
        state = { ...state, agentConfig, projectBinding };
      }
      notify();

      if (filePath && shouldRestartAgent) {
        void state.ensureAgentSession();
      }
    },

    loadProjectBinding: async () => {
      const filePath = state.filePath;
      if (!filePath) return;

      const binding = await window.electronAPI.getProjectBinding(filePath);
      state = { ...state, projectBinding: binding };
      notify();
    },

    ensureAgentSession: async () => {
      const filePath = state.filePath;
      if (!filePath) return;

      const result = await window.electronAPI.ensureAgentSession(filePath);
      state = {
        ...state,
        projectBinding: result.binding,
        agentStatus: result.success ? (state.isExecuting ? state.agentStatus : 'idle') : 'error',
        agentError: result.success ? null : result.error ?? 'Failed to start agent session',
      };
      notify();
    },

    restartAgent: async () => {
      const filePath = state.filePath;
      if (!filePath) return;

      // Restarting kills the tmux session and spawns a FRESH agent, which
      // abandons whatever the old agent was doing. Mirror the reset done by
      // setAgentConfig's shouldRestartAgent branch so the queue doesn't wedge
      // at "running". Reset module-level dedup vars too.
      hasNotifiedCompletion = false;
      handledApprovalMarkerIndex = -1;
      handledBatchCompletedIndex = -1;
      completedTaskIndices = new Set();
      doneParseBaseline = -1;
      state = {
        ...state,
        agentStatus: 'idle',
        agentLog: '',
        agentError: null,
        agentStallMessage: null,
        lastLogChangeTimestamp: 0,
        isExecuting: false,
        currentRunId: null,
        snapshotTasks: [],
        currentTaskIndex: -1,
        selectedLineNumbers: new Set(),
        batches: [],
        queuedLineNumbers: new Set(),
        runningBatchId: null,
        nextBatchNumber: 1,
      };
      notify();
      // Persist the cleared batch state so a stale persisted batch can't
      // resurrect on next launch.
      persistRuntime();

      const result = await window.electronAPI.restartAgent(filePath);
      state = {
        ...state,
        projectBinding: result.binding,
        agentStatus: result.success ? 'idle' : 'error',
        agentError: result.success ? null : result.error ?? 'Failed to restart agent',
      };
      notify();
    },

    setTasks: (tasks: Task[]) => {
      const previousIncompleteCount = getIncompleteCount(state.tasks);
      const nextTasks = mergeTasks(tasks);
      const nextIncompleteCount = getIncompleteCount(nextTasks);
      const didCompleteAll = previousIncompleteCount > 0 && nextIncompleteCount === 0 && nextTasks.length > 0;

      if (nextIncompleteCount > 0) {
        hasNotifiedCompletion = false;
      }

      // In batch mode, completion is handled by the DONE N
      // detection and fallback in refreshAgentLog → advanceQueue().  Do NOT reset
      // isExecuting here — doing so prevents advanceQueue() from cleaning up
      // the running batch, leaving it stuck as "running" forever.
      const isBatchMode = state.runningBatchId && state.batches.length > 0;
      const effectiveDidCompleteAll = didCompleteAll && !isBatchMode;

      state = {
        ...state,
        tasks: nextTasks,
        isExecuting: effectiveDidCompleteAll ? false : state.isExecuting,
        currentRunId: effectiveDidCompleteAll ? null : state.currentRunId,
        snapshotTasks: effectiveDidCompleteAll ? [] : state.snapshotTasks,
        currentTaskIndex: effectiveDidCompleteAll ? -1 : state.currentTaskIndex,
        agentStatus: effectiveDidCompleteAll ? 'idle' : state.agentStatus,
      };
      notify();

      if (effectiveDidCompleteAll && !hasNotifiedCompletion) {
        hasNotifiedCompletion = true;
        void window.electronAPI.notifyComplete();
      }
    },

    toggleTask: async (lineNumber: number) => {
      const filePath = state.filePath;
      if (!filePath) return;
      const task = state.tasks.find((item) => item.lineNumber === lineNumber);
      if (!task || task.status === 'running' || task.status === 'queued') return;

      const newCompleted = !task.completed;
      await window.electronAPI.writeTaskStatus(filePath, lineNumber, newCompleted, task.title);

      const newTasks: TaskWithStatus[] = state.tasks.map((item) =>
        item.lineNumber === lineNumber
          ? { ...item, completed: newCompleted, status: newCompleted ? 'done' : 'todo' }
          : item
      );

      state = { ...state, tasks: newTasks };
      notify();

      if (newTasks.length > 0 && newTasks.every((item) => item.completed)) {
        hasNotifiedCompletion = true;
        void window.electronAPI.notifyComplete();
      } else {
        hasNotifiedCompletion = false;
      }
    },

    addTask: async (title: string) => {
      const filePath = state.filePath;
      if (!filePath) return;
      const newTask = await window.electronAPI.appendTask(filePath, title);
      if (newTask) {
        hasNotifiedCompletion = false;
        const withStatus: TaskWithStatus = { ...newTask, status: 'todo' };
        state = { ...state, tasks: [...state.tasks, withStatus] };
        notify();
      }
    },

    editTaskTitle: async (lineNumber: number, newTitle: string) => {
      const filePath = state.filePath;
      if (!filePath) return;
      await window.electronAPI.editTaskTitle(filePath, lineNumber, newTitle);
      // Optimistic update: update local state immediately so UI doesn't flash old title
      state = {
        ...state,
        tasks: state.tasks.map((t) =>
          t.lineNumber === lineNumber ? { ...t, title: newTitle } : t
        ),
      };
      notify();
    },

    deleteTask: async (lineNumber: number) => {
      const filePath = state.filePath;
      if (!filePath) return;
      const task = state.tasks.find((item) => item.lineNumber === lineNumber);
      if (!task || task.status === 'running') return;

      // If task is queued, remove from its batch (immutable)
      if (task.status === 'queued') {
        const newBatches: Batch[] = [];
        for (const batch of state.batches) {
          if (batch.tasks.some((t) => t.lineNumber === lineNumber)) {
            const newTasks = batch.tasks.filter((t) => t.lineNumber !== lineNumber);
            if (newTasks.length > 0) {
              newBatches.push({ ...batch, tasks: newTasks });
            }
            // If batch becomes empty, drop it entirely
          } else {
            newBatches.push(batch);
          }
        }

        const newQueuedLineNumbers = new Set(state.queuedLineNumbers);
        newQueuedLineNumbers.delete(lineNumber);
        const newSelectedLineNumbers = new Set(state.selectedLineNumbers);
        newSelectedLineNumbers.delete(lineNumber);

        state = {
          ...state,
          batches: newBatches,
          queuedLineNumbers: newQueuedLineNumbers,
          selectedLineNumbers: newSelectedLineNumbers,
        };

        // If no batches left, reset execution state
        if (state.batches.length === 0) {
          state = {
            ...state,
            isExecuting: false,
            snapshotTasks: [],
            runningBatchId: null,
          };
        }
      }

      const deletedLine = await window.electronAPI.deleteTask(filePath, lineNumber);

      state = {
        ...state,
        lastDelete: deletedLine ? { lineNumber, lineContent: deletedLine } : state.lastDelete,
        tasks: state.tasks.filter((item) => item.lineNumber !== lineNumber),
      };
      notify();
    },

    undoDeleteTask: async () => {
      const filePath = state.filePath;
      const last = state.lastDelete;
      if (!filePath || !last) return;

      await window.electronAPI.undoDeleteTask(filePath, last.lineNumber, last.lineContent);
      const result = await window.electronAPI.readTaskFile(filePath);
      hasNotifiedCompletion = false;
      state = {
        ...state,
        tasks: result.tasks.map((task) => ({ ...task, status: getCompletionStatus(task, 'todo') })),
        lastDelete: null,
      };
      notify();
    },

    dismissUndo: () => {
      state = { ...state, lastDelete: null };
      notify();
    },

    refreshTasks: async () => {
      const filePath = state.filePath;
      if (!filePath) return;
      const result = await window.electronAPI.refreshTasks(filePath);
      state.setTasks(result.tasks);
    },

    refreshAgentLog: async () => {
      // Prevent concurrent calls from interleaving their state updates
      if (refreshAgentLogInFlight) return;
      const filePath = state.filePath;
      if (!filePath) return;

      refreshAgentLogInFlight = true;

      try {
        const result = await window.electronAPI.captureAgentLog(filePath);
        if (!result.success) {
          state = {
            ...state,
            projectBinding: result.binding,
            agentStatus: 'error',
            agentError: result.error ?? 'Failed to read agent log',
          };
          notify();
          return;
        }

        const newLog = result.log;
        const logChanged = newLog !== state.agentLog;
        const lastLogChangeTimestamp = logChanged ? Date.now() : state.lastLogChangeTimestamp;

        const nextStatus = getStatusFromLog(
          newLog,
          state.isExecuting,
          state.agentStatus,
          handledApprovalMarkerIndex,
          handledBatchCompletedIndex
        );
        const isFinished = nextStatus === 'idle' && state.isExecuting;

        // Edge-triggered approval notification: fire exactly once per distinct
        // approval request. The marker index changes for each new WAIT_APPROVAL,
        // so a different index means a new request. This must run regardless of
        // batch mode (a batch can still hit a genuine approval prompt).
        if (nextStatus === 'waitingApproval') {
          const cleanLog = newLog.replace(/\x1b\[[0-9;:]*m/g, '');
          const approvalIndex = getLastLineMarkerIndex(cleanLog, 'WAIT_APPROVAL');
          if (approvalIndex >= 0 && approvalIndex !== notifiedApprovalIndex) {
            notifiedApprovalIndex = approvalIndex;
            void window.electronAPI.notifyApproval();
          }
        }

        // Check for DONE N markers. parseTaskCompletedIndices strips ANSI codes
        // and tolerates leading indentation, so TUI-rendered "  DONE 1" is matched.
        // The /DONE (\d+)/ regex inherently skips the template's "DONE N" (letter N).
        let taskCompletedHandled = false;
        if (state.isExecuting && state.runningBatchId) {
          const runningBatch = state.batches.find((b) => b.id === state.runningBatchId);

          if (runningBatch && runningBatch.tasks.length > 0) {
            // Parse DONE N markers AFTER this batch's sentinel. The sentinel is
            // re-located in the freshly captured log on every poll, so it is
            // immune to sliding-window offset drift (capture-pane -S -2000).
            // runningBatchId IS the batch id, so the sentinel matches what was
            // sent. completedTaskIndices below is the dedup safety net.
            const { indices } = parseTaskCompletedIndices(
              newLog,
              batchSentinel(state.runningBatchId)
            );

            // Filter to indices we haven't processed yet
            const newIndices = indices.filter((i) => !completedTaskIndices.has(i));
            newIndices.forEach((i) => completedTaskIndices.add(i));

            if (newIndices.length > 0) {
              const writePromises: Promise<void>[] = [];

              for (const taskIndex of newIndices) {
                if (taskIndex >= 0 && taskIndex < runningBatch.tasks.length) {
                  const batchTask = runningBatch.tasks[taskIndex];
                  writePromises.push(
                    window.electronAPI.writeTaskStatus(filePath, batchTask.lineNumber, true, batchTask.title)
                  );
                }
              }

              if (writePromises.length > 0) {
                taskCompletedHandled = true;
                state = {
                  ...state,
                  batches: state.batches.map((b) =>
                    b.id === state.runningBatchId
                      ? {
                          ...b,
                          tasks: b.tasks.map((t, i) =>
                            newIndices.includes(i) ? { ...t, completed: true } : t
                          ),
                        }
                      : b
                  ),
                };

                await Promise.all(writePromises);

                // Check if all batch tasks are now done
                const updatedBatch = state.batches.find((b) => b.id === state.runningBatchId);
                if (updatedBatch && updatedBatch.tasks.every((t) => t.completed)) {
                  const refreshed = await window.electronAPI.refreshTasks(filePath);
                  state = {
                    ...state,
                    tasks: mergeTasks(refreshed.tasks),
                    batches: state.batches.map((b) =>
                      b.id === state.runningBatchId ? { ...b, status: 'completed' as const } : b
                    ),
                  };
                  advanceQueue();
                  notify();
                  return;
                }

                const refreshed = await window.electronAPI.refreshTasks(filePath);
                state = { ...state, tasks: mergeTasks(refreshed.tasks) };
                persistRuntime();
                notify();
                return;
              }
            }

            // Fallback: if all batch tasks are already completed in file state, auto-advance
            if (!taskCompletedHandled) {
              const allCompletedInFile = runningBatch.tasks.every((bt) =>
                state.tasks.find((t) => t.lineNumber === bt.lineNumber)?.completed
              );
              if (allCompletedInFile) {
                state = {
                  ...state,
                  batches: state.batches.map((b) =>
                    b.id === state.runningBatchId ? { ...b, status: 'completed' as const } : b
                  ),
                };
                advanceQueue();
                notify();
                return;
              }
            }
          }
        }

        if (taskCompletedHandled) {
          state = { ...state, agentLog: newLog, lastLogChangeTimestamp };
        } else {
          // In batch mode, completion is handled exclusively by the
          // DONE N path above — never auto-clean from status detection
          const isBatchMode = state.runningBatchId && state.batches.length > 0;
          const effectiveIsFinished = isFinished && !isBatchMode;

          // In batch mode we force 'running' to suppress a false
          // ALL_TASKS_COMPLETED auto-finish — BUT a genuine pending
          // WAIT_APPROVAL must still surface (otherwise the batch silently
          // hangs on an approval prompt). So let waitingApproval win over the
          // forced 'running'; only idle (the false-completion case) is masked.
          const effectiveStatus = isBatchMode
            ? nextStatus === 'waitingApproval'
              ? 'waitingApproval'
              : 'running'
            : nextStatus;

          state = {
            ...state,
            projectBinding: result.binding,
            agentLog: newLog,
            agentStatus: effectiveStatus,
            agentError: null,
            lastLogChangeTimestamp,
            isExecuting: effectiveIsFinished ? false : state.isExecuting,
            currentRunId: effectiveIsFinished ? null : state.currentRunId,
            snapshotTasks: effectiveIsFinished ? [] : state.snapshotTasks,
            currentTaskIndex: effectiveIsFinished ? -1 : state.currentTaskIndex,
          };
        }
        notify();
      } catch (error) {
        console.error('refreshAgentLog failed:', error);
        state = {
          ...state,
          agentStatus: 'error',
          agentError: error instanceof Error ? error.message : 'Failed to refresh agent log',
        };
        notify();
      } finally {
        refreshAgentLogInFlight = false;
      }
    },

    sendApproval: async (decision: ApprovalDecision) => {
      const filePath = state.filePath;
      if (!filePath) return;

      const result = await window.electronAPI.sendAgentApproval(filePath, decision);
      if (result.success) {
        handledApprovalMarkerIndex = getLastLineMarkerIndex(state.agentLog, 'WAIT_APPROVAL');
        // Reset so the next distinct WAIT_APPROVAL re-notifies.
        notifiedApprovalIndex = -1;
      }
      state = {
        ...state,
        projectBinding: result.binding,
        agentStatus: result.success ? 'running' : 'error',
        agentError: result.success ? null : result.error ?? 'Failed to send approval',
      };
      notify();
    },

    sendAgentMessage: async (message: string) => {
      const filePath = state.filePath;
      const trimmedMessage = message.trim();
      if (!filePath || !trimmedMessage) return false;

      try {
        const result = await window.electronAPI.sendAgentMessage(filePath, trimmedMessage);
        state = {
          ...state,
          projectBinding: result.binding,
          agentStatus: result.success ? 'running' : 'error',
          agentError: result.success ? null : result.error ?? 'Failed to send message',
        };
        notify();

        if (result.success) {
          void state.refreshAgentLog();
        }

        return result.success;
      } catch (error) {
        console.error('sendAgentMessage failed:', error);
        state = {
          ...state,
          agentStatus: 'error',
          agentError: error instanceof Error ? error.message : 'Failed to send message',
        };
        notify();
        return false;
      }
    },

    sendAgentKey: async (key: AgentControlKey) => {
      const filePath = state.filePath;
      if (!filePath) return false;

      try {
        const result = await window.electronAPI.sendAgentKey(filePath, key);
        state = {
          ...state,
          projectBinding: result.binding,
          agentStatus: result.success ? state.agentStatus : 'error',
          agentError: result.success ? null : result.error ?? 'Failed to send key',
        };
        notify();

        if (result.success) {
          void state.refreshAgentLog();
        }

        return result.success;
      } catch (error) {
        console.error('sendAgentKey failed:', error);
        state = {
          ...state,
          agentStatus: 'error',
          agentError: error instanceof Error ? error.message : 'Failed to send key',
        };
        notify();
        return false;
      }
    },

    setCollapsed: (collapsed: boolean) => {
      // Collapsing updates state immediately so the UI feels responsive
      // (no delay perceptible to the user).
      if (collapsed) {
        state = { ...state, collapsed };
        notify();
        void window.electronAPI.setWindowCollapsed(true);
        return;
      }

      // Expanding waits for the window resize to complete before updating
      // React state. This prevents a layout flash where content briefly
      // renders at the collapsed width before the window actually resizes.
      void window.electronAPI.setWindowCollapsed(false).finally(() => {
        state = { ...state, collapsed };
        notify();
      });
    },

    executeTask: async (task: Task) => {
      const filePath = state.filePath;
      if (!filePath || state.isExecuting || task.completed) return;

      const runId = `run_${Date.now()}`;
      handledApprovalMarkerIndex = -1;
      state = {
        ...state,
        isExecuting: true,
        agentStatus: 'running',
        agentError: null,
        agentStallMessage: null,
        lastLogChangeTimestamp: Date.now(),
        currentRunId: runId,
        snapshotTasks: [task],
        currentTaskIndex: 0,
        tasks: state.tasks.map((item) =>
          item.lineNumber === task.lineNumber ? { ...item, status: 'running' } : item
        ),
      };
      notify();

      try {
        const result = await window.electronAPI.executeWithAI(filePath, task);
        state = {
          ...state,
          projectBinding: result.binding,
          agentStatus: result.success ? (result.uncheckedCount > 0 ? 'running' : 'idle') : 'error',
          agentError: result.success ? null : result.error ?? 'Failed to execute task',
          isExecuting: result.success && result.uncheckedCount > 0,
          currentRunId: result.success && result.uncheckedCount > 0 ? state.currentRunId : null,
          snapshotTasks: result.success && result.uncheckedCount > 0 ? state.snapshotTasks : [],
          currentTaskIndex: result.success && result.uncheckedCount > 0 ? state.currentTaskIndex : -1,
        };
      } catch (error) {
        state = {
          ...state,
          isExecuting: false,
          currentRunId: null,
          snapshotTasks: [],
          currentTaskIndex: -1,
          agentStatus: 'error',
          agentError: error instanceof Error ? error.message : 'Failed to execute task',
        };
      }
      notify();
    },

    executeAll: async () => {
      selectAllIncomplete();
      await state.createBatch();
    },

    cancelPendingTask: (task: Task) => {
      state = {
        ...state,
        snapshotTasks: state.snapshotTasks.filter((item) => item.lineNumber !== task.lineNumber),
        tasks: state.tasks.map((item) =>
          item.lineNumber === task.lineNumber ? { ...item, status: getCompletionStatus(item, 'todo') } : item
        ),
      };
      notify();
    },

    pauseCurrentTask: async () => {
      await state.stopCurrentTask();
    },

    resumePausedTask: async (task: Task) => {
      await state.executeTask(task);
    },

    stopCurrentTask: async () => {
      await state.stopCurrentBatch();
    },

    stopRun: async () => {
      await state.stopCurrentBatch();
    },

    setShowSettings: (show: boolean) => {
      state = { ...state, showSettings: show };
      notify();
    },

    getIncompleteTasks: () => state.tasks.filter((task) => !task.completed),
    getRunningTasks: () => state.tasks.filter((task) => task.status === 'running'),
    areAllDone: () => state.tasks.length > 0 && state.tasks.every((task) => task.completed),

    // ─── Batch Queue Actions ────────────────────────────────────────────

    toggleSelection: (lineNumber: number) => {
      const next = new Set(state.selectedLineNumbers);
      if (next.has(lineNumber)) {
        next.delete(lineNumber);
      } else {
        next.add(lineNumber);
      }
      state = { ...state, selectedLineNumbers: next, emptySelectionMessage: null };
      notify();
    },

    clearSelection: () => {
      state = { ...state, selectedLineNumbers: new Set() };
      notify();
    },

    clearEmptySelectionMessage: () => {
      state = { ...state, emptySelectionMessage: null };
      notify();
    },

    createBatch: async () => {
      const filePath = state.filePath;
      if (!filePath) return;

      // Get eligible tasks: selected AND todo
      const eligibleTasks = state.tasks.filter(
        (task) =>
          state.selectedLineNumbers.has(task.lineNumber) &&
          task.status === 'todo' &&
          !task.completed
      );

      if (eligibleTasks.length === 0) {
        state = { ...state, emptySelectionMessage: 'No tasks selected' };
        notify();
        return;
      }

      const batchNumber = state.nextBatchNumber;
      const batch: Batch = {
        id: `batch_${Date.now()}`,
        batchNumber,
        tasks: eligibleTasks.map((t) => ({ ...t })),
        status: state.batches.length === 0 ? 'running' : 'queued',
        createdAt: Date.now(),
      };

      // Update task statuses to 'queued'
      const lineNumbers = new Set(eligibleTasks.map((t) => t.lineNumber));
      const newQueuedLineNumbers = new Set(state.queuedLineNumbers);
      lineNumbers.forEach((n) => newQueuedLineNumbers.add(n));

      state = {
        ...state,
        tasks: state.tasks.map((task) =>
          lineNumbers.has(task.lineNumber)
            ? { ...task, status: 'queued' as TaskStatus }
            : task
        ),
        selectedLineNumbers: new Set(),
        batches: [...state.batches, batch],
        queuedLineNumbers: newQueuedLineNumbers,
        nextBatchNumber: batchNumber + 1,
      };

      // If this is the first batch, start it immediately
      if (batch.status === 'running') {
        state = {
          ...state,
          runningBatchId: batch.id,
          isExecuting: true,
          agentStatus: 'running',
          agentStallMessage: null,
          lastLogChangeTimestamp: Date.now(),
          snapshotTasks: eligibleTasks.map((t) => ({ ...t })),
          tasks: state.tasks.map((task) =>
            lineNumbers.has(task.lineNumber)
              ? { ...task, status: 'running' as TaskStatus }
              : task
          ),
        };
        notify();

        // Send the prompt
        await sendBatchPrompt(batch);
      } else {
        notify();
        persistRuntime();
      }
    },

    stopCurrentBatch: async () => {
      const filePath = state.filePath;
      if (!filePath) return;

      await window.electronAPI.stopAgent(filePath);

      // Mark running batch tasks as stopped
      const runningBatch = state.batches.find((b) => b.id === state.runningBatchId);
      const runningLineNumbers = new Set(runningBatch ? runningBatch.tasks.map((t) => t.lineNumber) : []);

      const newQueuedLineNumbers = new Set(state.queuedLineNumbers);
      runningLineNumbers.forEach((n) => newQueuedLineNumbers.delete(n));

      state = {
        ...state,
        tasks: state.tasks.map((task) =>
          runningLineNumbers.has(task.lineNumber) && !task.completed
            ? { ...task, status: 'stopped' as TaskStatus }
            : task
        ),
        queuedLineNumbers: newQueuedLineNumbers,
        // Keep the running batch in state.batches so advanceQueue() can
        // find its line numbers and fix task statuses (stopped → todo).
      };

      advanceQueue();
    },

    cancelQueuedBatch: (batchId: string) => {
      const batch = state.batches.find((b) => b.id === batchId);
      if (!batch || batch.status !== 'queued') return;

      // Revert its tasks to 'todo' status
      const batchLineNumbers = new Set(batch.tasks.map((t) => t.lineNumber));
      const newQueuedLineNumbers = new Set(state.queuedLineNumbers);
      batchLineNumbers.forEach((n) => newQueuedLineNumbers.delete(n));

      state = {
        ...state,
        tasks: state.tasks.map((task) =>
          batchLineNumbers.has(task.lineNumber) && !task.completed
            ? { ...task, status: 'todo' as TaskStatus }
            : task
        ),
        batches: state.batches.filter((b) => b.id !== batchId),
        queuedLineNumbers: newQueuedLineNumbers,
      };
      notify();
      persistRuntime();
    },

    cancelQueuedTask: (lineNumber: number) => {
      const task = state.tasks.find((t) => t.lineNumber === lineNumber);
      if (!task || task.status !== 'queued') return;

      // Remove from its batch (immutable)
      const newBatches: Batch[] = [];
      for (const batch of state.batches) {
        if (batch.tasks.some((t) => t.lineNumber === lineNumber)) {
          const newTasks = batch.tasks.filter((t) => t.lineNumber !== lineNumber);
          if (newTasks.length > 0) {
            newBatches.push({ ...batch, tasks: newTasks });
          }
          // If batch becomes empty, drop it entirely
        } else {
          newBatches.push(batch);
        }
      }

      const newQueuedLineNumbers = new Set(state.queuedLineNumbers);
      newQueuedLineNumbers.delete(lineNumber);

      state = {
        ...state,
        // Set task status back to 'todo' (do NOT delete from file)
        tasks: state.tasks.map((t) =>
          t.lineNumber === lineNumber ? { ...t, status: 'todo' as TaskStatus } : t
        ),
        batches: newBatches,
        queuedLineNumbers: newQueuedLineNumbers,
      };

      // If no batches left, reset execution state
      if (newBatches.length === 0) {
        state = {
          ...state,
          isExecuting: false,
          snapshotTasks: [],
          runningBatchId: null,
        };
      }

      notify();
      persistRuntime();
    },

    clearCompletedTasks: async () => {
      const filePath = state.filePath;
      if (!filePath) return;
      await window.electronAPI.clearCompletedTasks(filePath);
      const result = await window.electronAPI.refreshTasks(filePath);
      state.setTasks(result.tasks);
    },

    getRunningBatch: () => {
      return state.batches.find((b) => b.id === state.runningBatchId);
    },

    getQueuedBatches: () => {
      return state.batches.filter((b) => b.status === 'queued');
    },

    persistBatchRuntime: () => {
      persistRuntime();
    },

    restoreBatchRuntime: async () => {
      const filePath = state.filePath;
      if (!filePath) return;

      try {
        const runtime = await window.electronAPI.getBatchRuntime(filePath);
        if (!runtime) return;

        // Validate the persisted shape before trusting it. A corrupt/partial/
        // forged settings file could otherwise crash the renderer (e.g.
        // `new Set(5)`, `.map` on a non-array) or restore a stale batch that
        // writes checkboxes onto the wrong lines. On ANY malformed field, bail
        // without mutating batch state, leaving the clean post-setTasks state.
        if (!isValidBatchRuntime(runtime)) {
          console.warn('restoreBatchRuntime: persisted runtime is malformed; ignoring it.');
          // Clear the bad entry so it can't repeatedly trip restore.
          persistRuntime();
          return;
        }

        // Coerce numeric fields (default if missing/non-finite).
        const toInt = (value: unknown, fallback: number): number =>
          typeof value === 'number' && Number.isFinite(value) ? value : fallback;

        doneParseBaseline = toInt(runtime.doneParseBaseline, -1);
        completedTaskIndices = new Set(runtime.completedTaskIndices);
        handledApprovalMarkerIndex = toInt(runtime.handledApprovalMarkerIndex, -1);
        handledBatchCompletedIndex = toInt(runtime.handledBatchCompletedIndex, -1);

        state = {
          ...state,
          batches: runtime.batches,
          runningBatchId: runtime.runningBatchId,
          queuedLineNumbers: new Set(runtime.queuedLineNumbers),
          nextBatchNumber: toInt(runtime.nextBatchNumber, 1),
          isExecuting: runtime.isExecuting,
          snapshotTasks: runtime.snapshotTasks,
          currentTaskIndex: toInt(runtime.currentTaskIndex, -1),
          currentRunId: runtime.currentRunId,
          agentStatus: runtime.isExecuting ? 'running' : state.agentStatus,
        };
        // Re-merge existing tasks against the restored batch state so task rows
        // reflect running/queued status immediately (setTasks ran before restore
        // with empty batch state, marking everything todo/done).
        state = { ...state, tasks: mergeTasks(state.tasks) };
        notify();
      } catch (error) {
        console.warn('restoreBatchRuntime failed; leaving clean batch state:', error);
      }
    },
  };

  const listeners: Set<() => void> = new Set();

  function selectAllIncomplete(): void {
    const incompleteLineNumbers = state.tasks
      .filter((t) => !t.completed && t.status === 'todo')
      .map((t) => t.lineNumber);

    state = {
      ...state,
      selectedLineNumbers: new Set(incompleteLineNumbers),
    };
  }

  async function sendBatchPrompt(batch: Batch): Promise<void> {
    const filePath = state.filePath;
    if (!filePath) return;

    handledApprovalMarkerIndex = -1;
    notifiedApprovalIndex = -1;
    handledBatchCompletedIndex = -1;
    // doneParseBaseline is deprecated: DONE markers are now anchored on this
    // batch's relative sentinel (batchSentinel(batch.id)) re-located each poll,
    // which is immune to sliding-window offset drift. We still assign the field
    // so the persisted runtime JSON shape is unchanged, but it is never used
    // for filtering.
    doneParseBaseline = 0;
    state = { ...state, agentStallMessage: null, lastLogChangeTimestamp: Date.now() };
    notify();
    try {
      const result = await window.electronAPI.executeBatchPrompt(
        filePath,
        batch.batchNumber,
        batch.tasks,
        batch.id
      );

      if (!result.success) {
        state = {
          ...state,
          projectBinding: result.binding,
          agentStatus: 'error',
          agentError: result.error ?? 'Failed to execute batch prompt',
        };
        notify();
        return;
      }

      // Reset per-batch dedup tracking. The batch sentinel (anchored at parse
      // time) ensures only DONE markers emitted after this batch are claimed.
      completedTaskIndices = new Set();
      persistRuntime();
    } catch (error) {
      console.error('sendBatchPrompt failed:', error);
      state = {
        ...state,
        agentStatus: 'error',
        agentError: error instanceof Error ? error.message : 'Failed to send batch prompt',
        runningBatchId: null,
        isExecuting: false,
      };
      notify();
    }
  }

  function advanceQueue(): void {
    // Mark running batch as done and remove completed/stopped batches
    const runningLineNumbers = state.batches
      .filter((b) => b.id === state.runningBatchId)
      .flatMap((b) => b.tasks.map((t) => t.lineNumber));

    const runningLineNumbersSet = new Set(runningLineNumbers);

    // Build new queuedLineNumbers Set (don't mutate the existing one)
    const newQueuedLineNumbers = new Set(state.queuedLineNumbers);
    runningLineNumbers.forEach((n) => newQueuedLineNumbers.delete(n));

    // Filter out completed/stopped batches (immutable: map to new objects)
    const remainingBatches = state.batches
      .filter((b) => b.id !== state.runningBatchId)
      .map((b) => ({ ...b }));

    // Find next queued batch
    const nextBatch = remainingBatches.find((b) => b.status === 'queued');

    if (nextBatch) {
      const runningBatch = { ...nextBatch };
      // Promote it to running
      runningBatch.status = 'running';
      const runningIndex = remainingBatches.indexOf(nextBatch);
      if (runningIndex !== -1) {
        remainingBatches[runningIndex] = runningBatch;
      }
      const nextLineNumbers = new Set(runningBatch.tasks.map((t) => t.lineNumber));

      state = {
        ...state,
        runningBatchId: runningBatch.id,
        queuedLineNumbers: newQueuedLineNumbers,
        snapshotTasks: runningBatch.tasks.map((t) => ({ ...t })),
        tasks: state.tasks.map((task) => {
          // Promote next batch tasks to running
          if (nextLineNumbers.has(task.lineNumber) && !task.completed) {
            return { ...task, status: 'running' as TaskStatus };
          }
          // Fix completed batch tasks that mergeTasks may have locked as 'running'
          if (runningLineNumbersSet.has(task.lineNumber)) {
            return {
              ...task,
              status: task.completed ? 'done' as TaskStatus : 'todo' as TaskStatus,
            };
          }
          return task;
        }),
        batches: remainingBatches,
        isExecuting: true,
        agentStatus: 'running',
      };
      notify();

      void sendBatchPrompt(runningBatch);
    } else {
      // All done — fix task statuses too (mergeTasks may have locked them as 'running')
      state = {
        ...state,
        runningBatchId: null,
        snapshotTasks: [],
        batches: [],
        queuedLineNumbers: new Set<number>(),
        isExecuting: false,
        agentStatus: 'idle',
        tasks: state.tasks.map((task) =>
          runningLineNumbersSet.has(task.lineNumber) && task.completed
            ? { ...task, status: 'done' as TaskStatus }
            : runningLineNumbersSet.has(task.lineNumber)
              ? { ...task, status: 'todo' as TaskStatus }
              : task
        ),
      };
      notify();

      // Stop the stall watchdog since there are no more batches
      void window.electronAPI.stopStallWatchdog();

      // Persist the cleared runtime so a restart doesn't resurrect a finished batch.
      persistRuntime();

      // Trigger completion notification if all tasks done
      if (state.tasks.length > 0 && state.tasks.every((t) => t.completed)) {
        void window.electronAPI.notifyComplete();
      }
    }
  }

  function mergeTasks(tasks: Task[]): TaskWithStatus[] {
    const runningBatch = state.batches.find((b) => b.id === state.runningBatchId);
    const runningLineNumbers = new Set(runningBatch ? runningBatch.tasks.map((t) => t.lineNumber) : []);

    return tasks.map((task) => {
      const existing = state.tasks.find((item) => item.lineNumber === task.lineNumber);

      // If lineNumber is in running batch, respect file completion state
      if (runningLineNumbers.has(task.lineNumber)) {
        if (task.completed) {
          return { ...task, status: 'done' as TaskStatus };
        }
        return { ...task, status: 'running' as TaskStatus };
      }

      // If lineNumber is in queuedLineNumbers but not running batch, status = 'queued'
      if (state.queuedLineNumbers.has(task.lineNumber) && !runningLineNumbers.has(task.lineNumber)) {
        return { ...task, status: 'queued' as TaskStatus };
      }

      const fallbackStatus: TaskStatus = existing?.status ?? 'todo';
      // Don't carry over transient statuses
      const persistentStatuses: TaskStatus[] = ['todo', 'done', 'failed', 'paused', 'stopped'];
      const effectiveFallback: TaskStatus = persistentStatuses.includes(fallbackStatus)
        ? fallbackStatus
        : 'todo';

      return {
        ...task,
        status: getCompletionStatus(task, effectiveFallback),
      };
    });
  }

  function notify(): void {
    listeners.forEach((listener) => listener());
  }

  function persistRuntime(): void {
    const filePath = state.filePath;
    if (!filePath) return;

    const snapshot: BatchRuntimeState = {
      batches: state.batches,
      runningBatchId: state.runningBatchId,
      queuedLineNumbers: Array.from(state.queuedLineNumbers),
      nextBatchNumber: state.nextBatchNumber,
      isExecuting: state.isExecuting,
      snapshotTasks: state.snapshotTasks,
      currentTaskIndex: state.currentTaskIndex,
      currentRunId: state.currentRunId,
      doneParseBaseline,
      completedTaskIndices: Array.from(completedTaskIndices),
      handledApprovalMarkerIndex,
      handledBatchCompletedIndex,
    };

    void window.electronAPI.setBatchRuntime(filePath, snapshot);
  }

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

const store = createStore();

export function useTaskStore(): TaskStore {
  return useSyncExternalStore(store.subscribe, store.getState);
}

export function getStore(): TaskStore {
  return store.getState();
}
