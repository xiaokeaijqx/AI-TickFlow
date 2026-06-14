import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentConfig,
  AgentControlKey,
  ApprovalDecision,
  BatchExecutionResult,
  ElectronAPI,
  Task,
} from '../shared/types';

const electronAPI: ElectronAPI = {
  selectTaskFile: () => ipcRenderer.invoke('select-task-file'),
  readTaskFile: (filePath: string) => ipcRenderer.invoke('read-task-file', filePath),
  writeTaskStatus: (filePath: string, lineNumber: number, completed: boolean) =>
    ipcRenderer.invoke('write-task-status', filePath, lineNumber, completed),
  editTaskTitle: (filePath: string, lineNumber: number, newTitle: string) =>
    ipcRenderer.invoke('edit-task-title', filePath, lineNumber, newTitle),
  appendTask: (filePath: string, title: string) => ipcRenderer.invoke('append-task', filePath, title),
  deleteTask: (filePath: string, lineNumber: number) => ipcRenderer.invoke('delete-task', filePath, lineNumber),
  undoDeleteTask: (filePath: string, lineNumber: number, lineContent: string) =>
    ipcRenderer.invoke('undo-delete-task', filePath, lineNumber, lineContent),
  onFileChanged: (callback: (tasks: Task[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tasks: Task[]) => callback(tasks);
    ipcRenderer.on('file-changed', handler);
    return () => ipcRenderer.removeListener('file-changed', handler);
  },
  getProjectBinding: (filePath: string) => ipcRenderer.invoke('get-project-binding', filePath),
  getAgentConfig: () => ipcRenderer.invoke('get-agent-config'),
  setAgentConfig: (config: AgentConfig) => ipcRenderer.invoke('set-agent-config', config),
  ensureAgentSession: (filePath: string) => ipcRenderer.invoke('ensure-agent-session', filePath),
  executeWithAI: (filePath: string, task?: Task) => ipcRenderer.invoke('execute-with-ai', filePath, task),
  captureAgentLog: (filePath: string) => ipcRenderer.invoke('capture-agent-log', filePath),
  sendAgentApproval: (filePath: string, decision: ApprovalDecision) =>
    ipcRenderer.invoke('send-agent-approval', filePath, decision),
  sendAgentMessage: (filePath: string, message: string) => ipcRenderer.invoke('send-agent-message', filePath, message),
  sendAgentKey: (filePath: string, key: AgentControlKey) => ipcRenderer.invoke('send-agent-key', filePath, key),
  stopAgent: (filePath: string) => ipcRenderer.invoke('stop-agent', filePath),
  executeBatchPrompt: (filePath: string, batchNumber: number, batchTasks: Task[]) =>
    ipcRenderer.invoke('execute-batch-prompt', filePath, batchNumber, batchTasks),
  clearCompletedTasks: (filePath: string) =>
    ipcRenderer.invoke('clear-completed-tasks', filePath),
  notifyComplete: () => ipcRenderer.invoke('notify-complete'),
  getDefaultFilePath: () => ipcRenderer.invoke('get-default-file-path'),
  setDefaultFilePath: (filePath: string) => ipcRenderer.invoke('set-default-file-path', filePath),
  getShortcut: () => ipcRenderer.invoke('get-shortcut'),
  setShortcut: (shortcut: string) => ipcRenderer.invoke('set-shortcut', shortcut),
  refreshTasks: (filePath: string) => ipcRenderer.invoke('refresh-tasks', filePath),
  setWindowCollapsed: (collapsed: boolean) => ipcRenderer.invoke('set-window-collapsed', collapsed),
  onToggleWindow: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('toggle-window', handler);
    return () => ipcRenderer.removeListener('toggle-window', handler);
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
