import { useSyncExternalStore } from 'react';
import type {
  AgentConfig,
  AgentControlKey,
  AgentStatus,
  ApprovalDecision,
  Batch,
  ProjectBinding,
  Task,
  TaskStatus,
  TaskWithStatus,
} from '../../shared/types';
import { hasBatchCompleted, parseBatchCompleted } from '../lib/batchParser';

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
  clearCompletedTasks: () => Promise<void>;
  clearEmptySelectionMessage: () => void;
  getRunningBatch: () => Batch | undefined;
  getQueuedBatches: () => Batch[];
}

function getIncompleteCount(tasks: Task[]): number {
  return tasks.filter((task) => !task.completed).length;
}

function getCompletionStatus(task: Task, fallback: TaskStatus): TaskStatus {
  return task.completed ? 'done' : fallback;
}

function getLastLineMarkerIndex(log: string, marker: string): number {
  const markerPattern = new RegExp(`(^|\\n)${marker}(\\r?\\n|$)`, 'g');
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
  // Both completion markers count; only count BATCH_COMPLETED if it's been handled (not prompt text)
  const allDoneIndexFromAll = getLastLineMarkerIndex(log, 'ALL_TASKS_COMPLETED');
  const batchIndex = getLastLineMarkerIndex(log, 'BATCH_COMPLETED');
  const allDoneIndex = batchIndex > handledBatchCompletedIndex
    ? Math.max(allDoneIndexFromAll, batchIndex)
    : allDoneIndexFromAll;
  const approvalIndex = getLastLineMarkerIndex(log, 'WAIT_APPROVAL');
  const approvedIndex = log.lastIndexOf('继续执行');
  const rejectedIndex = log.lastIndexOf('取消本步骤并重新规划');
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
};

const createStore = () => {
  let hasNotifiedCompletion = false;
  let handledApprovalMarkerIndex = -1;
  let handledBatchCompletedIndex = -1;

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
      state = {
        ...state,
        filePath: path,
        projectBinding: null,
        agentStatus: 'idle',
        agentLog: '',
        agentError: null,
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
        config.customCommand.trim() !== state.agentConfig.customCommand.trim();
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

    setTasks: (tasks: Task[]) => {
      const previousIncompleteCount = getIncompleteCount(state.tasks);
      const nextTasks = mergeTasks(tasks);
      const nextIncompleteCount = getIncompleteCount(nextTasks);
      const didCompleteAll = previousIncompleteCount > 0 && nextIncompleteCount === 0 && nextTasks.length > 0;

      if (nextIncompleteCount > 0) {
        hasNotifiedCompletion = false;
      }

      state = {
        ...state,
        tasks: nextTasks,
        isExecuting: didCompleteAll ? false : state.isExecuting,
        currentRunId: didCompleteAll ? null : state.currentRunId,
        snapshotTasks: didCompleteAll ? [] : state.snapshotTasks,
        currentTaskIndex: didCompleteAll ? -1 : state.currentTaskIndex,
        agentStatus: didCompleteAll ? 'idle' : state.agentStatus,
      };
      notify();

      if (didCompleteAll && !hasNotifiedCompletion) {
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
      await window.electronAPI.writeTaskStatus(filePath, lineNumber, newCompleted);

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

      // If task is queued, remove from its batch
      if (task.status === 'queued') {
        state = {
          ...state,
          batches: state.batches.filter((batch) => {
            if (batch.tasks.some((t) => t.lineNumber === lineNumber)) {
              // Remove this task from the batch
              batch.tasks = batch.tasks.filter((t) => t.lineNumber !== lineNumber);
              // If batch becomes empty, filter it out entirely
              if (batch.tasks.length === 0) {
                return false;
              }
            }
            return true;
          }),
          queuedLineNumbers: (() => {
            const next = new Set(state.queuedLineNumbers);
            next.delete(lineNumber);
            return next;
          })(),
          selectedLineNumbers: (() => {
            const next = new Set(state.selectedLineNumbers);
            next.delete(lineNumber);
            return next;
          })(),
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
      const filePath = state.filePath;
      if (!filePath) return;

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
      const nextStatus = getStatusFromLog(
        newLog,
        state.isExecuting,
        state.agentStatus,
        handledApprovalMarkerIndex,
        handledBatchCompletedIndex
      );
      const isFinished = nextStatus === 'idle' && state.isExecuting;

      // Check for BATCH_COMPLETED — only process new occurrences
      const batchCompletedIndex = newLog.lastIndexOf('BATCH_COMPLETED');
      let batchCompletedHandled = false;
      if (
        state.isExecuting &&
        batchCompletedIndex > handledBatchCompletedIndex &&
        state.runningBatchId
      ) {
        const completedTitles = parseBatchCompleted(newLog);
        const runningBatch = state.batches.find((b) => b.id === state.runningBatchId);

        if (runningBatch && completedTitles.length > 0) {
          // For each parsed title, find matching task in running batch and write status
          const writePromises: Promise<void>[] = [];
          runningBatch.tasks.forEach((batchTask) => {
            const matched = completedTitles.some(
              (title) => title.toLowerCase().trim() === batchTask.title.toLowerCase().trim()
            );
            if (matched) {
              writePromises.push(window.electronAPI.writeTaskStatus(filePath, batchTask.lineNumber, true));
            }
          });

          // Only advance if at least one task was actually matched
          if (writePromises.length > 0) {
            batchCompletedHandled = true;
            handledBatchCompletedIndex = batchCompletedIndex;

            runningBatch.status = 'completed' as Batch['status'];
            state = { ...state };

            await Promise.all(writePromises);
            advanceQueue();
            notify();
            return;
          }
        }
      }

      if (batchCompletedHandled) {
        state = { ...state, agentLog: newLog };
      } else {
        // When agent goes idle while executing in batch mode, clean up stale batch state
        const isBatchMode = state.runningBatchId && state.batches.length > 0;
        const needsBatchCleanup = isFinished && isBatchMode;

        state = {
          ...state,
          projectBinding: result.binding,
          agentLog: newLog,
          agentStatus: nextStatus,
          agentError: null,
          isExecuting: isFinished ? false : state.isExecuting,
          currentRunId: isFinished ? null : state.currentRunId,
          snapshotTasks: isFinished ? [] : state.snapshotTasks,
          currentTaskIndex: isFinished ? -1 : state.currentTaskIndex,
          // Clean up batch state when agent goes idle mid-batch (safety net)
          ...(needsBatchCleanup ? {
            runningBatchId: null,
            batches: [],
            queuedLineNumbers: new Set<number>(),
          } : {}),
        };
      }
      notify();
    },

    sendApproval: async (decision: ApprovalDecision) => {
      const filePath = state.filePath;
      if (!filePath) return;

      const result = await window.electronAPI.sendAgentApproval(filePath, decision);
      if (result.success) {
        handledApprovalMarkerIndex = getLastLineMarkerIndex(state.agentLog, 'WAIT_APPROVAL');
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
    },

    sendAgentKey: async (key: AgentControlKey) => {
      const filePath = state.filePath;
      if (!filePath) return false;

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
    },

    setCollapsed: (collapsed: boolean) => {
      if (collapsed) {
        state = { ...state, collapsed };
        notify();
        void window.electronAPI.setWindowCollapsed(true);
        return;
      }

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
        currentRunId: runId,
        snapshotTasks: [task],
        currentTaskIndex: 0,
        tasks: state.tasks.map((item) =>
          item.lineNumber === task.lineNumber ? { ...item, status: 'running' } : item
        ),
      };
      notify();

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
      }
    },

    stopCurrentBatch: async () => {
      const filePath = state.filePath;
      if (!filePath) return;

      await window.electronAPI.stopAgent(filePath);

      // Mark running batch tasks as stopped
      const runningBatch = state.batches.find((b) => b.id === state.runningBatchId);
      const runningLineNumbers = new Set(runningBatch ? runningBatch.tasks.map((t) => t.lineNumber) : []);
      runningLineNumbers.forEach((n) => state.queuedLineNumbers.delete(n));

      state = {
        ...state,
        tasks: state.tasks.map((task) =>
          runningLineNumbers.has(task.lineNumber) && !task.completed
            ? { ...task, status: 'stopped' as TaskStatus }
            : task
        ),
        batches: state.batches.filter((b) => b.id !== state.runningBatchId),
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
    handledBatchCompletedIndex = -1;
    const result = await window.electronAPI.executeBatchPrompt(
      filePath,
      batch.batchNumber,
      batch.tasks
    );

    if (!result.success) {
      state = {
        ...state,
        projectBinding: result.binding,
        agentStatus: 'error',
        agentError: result.error ?? 'Failed to execute batch prompt',
      };
      notify();
    }
  }

  function advanceQueue(): void {
    // Mark running batch as done and remove completed/stopped batches
    const runningLineNumbers = state.batches
      .filter((b) => b.id === state.runningBatchId)
      .flatMap((b) => b.tasks.map((t) => t.lineNumber));

    runningLineNumbers.forEach((n) => state.queuedLineNumbers.delete(n));

    // Filter out completed/stopped batches
    const remainingBatches = state.batches.filter((b) => b.id !== state.runningBatchId);

    // Find next queued batch
    const nextBatch = remainingBatches.find((b) => b.status === 'queued');

    if (nextBatch) {
      // Promote it to running
      nextBatch.status = 'running';
      const nextLineNumbers = new Set(nextBatch.tasks.map((t) => t.lineNumber));

      state = {
        ...state,
        runningBatchId: nextBatch.id,
        snapshotTasks: nextBatch.tasks.map((t) => ({ ...t })),
        tasks: state.tasks.map((task) =>
          nextLineNumbers.has(task.lineNumber) && !task.completed
            ? { ...task, status: 'running' as TaskStatus }
            : task
        ),
        batches: remainingBatches,
        isExecuting: true,
        agentStatus: 'running',
      };
      notify();

      void sendBatchPrompt(nextBatch);
    } else {
      // All done
      state = {
        ...state,
        runningBatchId: null,
        snapshotTasks: [],
        batches: [],
        queuedLineNumbers: new Set(),
        isExecuting: false,
        agentStatus: 'idle',
      };
      notify();
    }
  }

  function mergeTasks(tasks: Task[]): TaskWithStatus[] {
    const runningBatch = state.batches.find((b) => b.id === state.runningBatchId);
    const runningLineNumbers = new Set(runningBatch ? runningBatch.tasks.map((t) => t.lineNumber) : []);

    return tasks.map((task) => {
      const existing = state.tasks.find((item) => item.lineNumber === task.lineNumber);

      // If lineNumber is in running batch, status = 'running'
      if (runningLineNumbers.has(task.lineNumber)) {
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
