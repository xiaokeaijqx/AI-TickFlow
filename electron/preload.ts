import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentConfig,
  AgentControlKey,
  ApprovalDecision,
  BatchExecutionResult,
  BatchRuntimeState,
  ElectronAPI,
  Task,
} from '../shared/types';

// ─── IPC Timeout Wrapper ──────────────────────────────────────────────

const IPC_TIMEOUT_MS = 15_000; // 15 second default timeout

function invokeWithTimeout<T>(channel: string, timeoutMs: number, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`IPC timeout: ${channel} did not respond within ${timeoutMs}ms`));
    }, timeoutMs);

    ipcRenderer
      .invoke(channel, ...args)
      .then((result: T) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

// This window's bound task file, passed synchronously via additionalArguments
// (--tickflow-file=...) when the window was created. Empty string = unbound.
function readWindowFilePath(): string {
  const arg = process.argv.find((a) => a.startsWith('--tickflow-file='));
  return arg ? arg.slice('--tickflow-file='.length) : '';
}

const electronAPI: ElectronAPI = {
  getWindowFilePath: () => readWindowFilePath(),
  openProjectWindow: () => invokeWithTimeout<string | null>('open-project-window', 10_000),
  selectTaskFile: () => invokeWithTimeout<string | null>('select-task-file', 10_000),
  readTaskFile: (filePath: string) => invokeWithTimeout('read-task-file', 10_000, filePath),
  writeTaskStatus: (filePath: string, lineNumber: number, completed: boolean, expectedTitle?: string) =>
    invokeWithTimeout<void>('write-task-status', 10_000, filePath, lineNumber, completed, expectedTitle),
  editTaskTitle: (filePath: string, lineNumber: number, newTitle: string) =>
    invokeWithTimeout<void>('edit-task-title', 10_000, filePath, lineNumber, newTitle),
  appendTask: (filePath: string, title: string) => invokeWithTimeout('append-task', 10_000, filePath, title),
  deleteTask: (filePath: string, lineNumber: number) => invokeWithTimeout('delete-task', 10_000, filePath, lineNumber),
  undoDeleteTask: (filePath: string, lineNumber: number, lineContent: string) =>
    invokeWithTimeout<void>('undo-delete-task', 10_000, filePath, lineNumber, lineContent),
  onFileChanged: (callback: (tasks: Task[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tasks: Task[]) => callback(tasks);
    ipcRenderer.on('file-changed', handler);
    return () => ipcRenderer.removeListener('file-changed', handler);
  },
  getProjectBinding: (filePath: string) => invokeWithTimeout('get-project-binding', 10_000, filePath),
  getAgentConfig: (filePath: string) => invokeWithTimeout('get-agent-config', 10_000, filePath),
  setAgentConfig: (filePath: string, config: AgentConfig) =>
    invokeWithTimeout('set-agent-config', 10_000, filePath, config),
  ensureAgentSession: (filePath: string) => invokeWithTimeout('ensure-agent-session', 30_000, filePath),
  restartAgent: (filePath: string) => invokeWithTimeout('restart-agent', 30_000, filePath),
  executeWithAI: (filePath: string, task?: Task) => invokeWithTimeout('execute-with-ai', 30_000, filePath, task),
  captureAgentLog: (filePath: string) => invokeWithTimeout('capture-agent-log', 15_000, filePath),
  sendAgentApproval: (filePath: string, decision: ApprovalDecision) =>
    invokeWithTimeout('send-agent-approval', 10_000, filePath, decision),
  sendAgentMessage: (filePath: string, message: string) => invokeWithTimeout('send-agent-message', 10_000, filePath, message),
  sendAgentKey: (filePath: string, key: AgentControlKey) => invokeWithTimeout('send-agent-key', 10_000, filePath, key),
  stopAgent: (filePath: string) => invokeWithTimeout('stop-agent', 10_000, filePath),
  executeBatchPrompt: (filePath: string, batchNumber: number, batchTasks: Task[], batchId: string) =>
    invokeWithTimeout('execute-batch-prompt', 30_000, filePath, batchNumber, batchTasks, batchId),
  clearCompletedTasks: (filePath: string) =>
    invokeWithTimeout<void>('clear-completed-tasks', 10_000, filePath),
  notifyComplete: () => invokeWithTimeout<void>('notify-complete', 10_000),
  notifyApproval: () => invokeWithTimeout<void>('notify-approval', 5_000),
  getSystemSounds: () => invokeWithTimeout<string[]>('get-system-sounds', 5_000),
  setNotificationSound: (sound: string) => invokeWithTimeout<void>('set-notification-sound', 5_000, sound),
  getNotificationSound: () => invokeWithTimeout<string>('get-notification-sound', 5_000),
  restartApp: () => invokeWithTimeout<void>('restart-app', 5_000),
  getDefaultFilePath: () => invokeWithTimeout<string>('get-default-file-path', 10_000),
  setDefaultFilePath: (filePath: string) => invokeWithTimeout<void>('set-default-file-path', 10_000, filePath),
  getShortcut: () => invokeWithTimeout<string>('get-shortcut', 10_000),
  setShortcut: (shortcut: string) => invokeWithTimeout<void>('set-shortcut', 10_000, shortcut),
  refreshTasks: (filePath: string) => invokeWithTimeout('refresh-tasks', 10_000, filePath),
  setWindowCollapsed: (collapsed: boolean) => invokeWithTimeout<void>('set-window-collapsed', 10_000, collapsed),
  onToggleWindow: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('toggle-window', handler);
    return () => ipcRenderer.removeListener('toggle-window', handler);
  },
  onAgentIdleWarning: (callback: (payload: { message: string; filePath: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { message: string; filePath: string }) =>
      callback(payload);
    ipcRenderer.on('agent-idle-warning', handler);
    return () => ipcRenderer.removeListener('agent-idle-warning', handler);
  },
  resetStallTimer: (filePath: string) => invokeWithTimeout<void>('reset-stall-timer', 10_000, filePath),
  stopStallWatchdog: (filePath: string) => invokeWithTimeout<void>('stop-stall-watchdog', 10_000, filePath),
  stopIdleAgent: (filePath: string) => invokeWithTimeout<void>('stop-idle-agent', 10_000, filePath),
  getBatchRuntime: (filePath: string) => invokeWithTimeout('get-batch-runtime', 10_000, filePath),
  setBatchRuntime: (filePath: string, state: BatchRuntimeState) =>
    invokeWithTimeout<void>('set-batch-runtime', 10_000, filePath, state),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
