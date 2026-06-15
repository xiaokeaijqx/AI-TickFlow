// Shared types between main and renderer processes

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  lineNumber: number;
}

export type TaskStatus = 'todo' | 'running' | 'done' | 'failed' | 'paused' | 'stopped' | 'queued';

export type AgentStatus = 'idle' | 'running' | 'waitingApproval' | 'error';

export interface TaskWithStatus extends Task {
  status: TaskStatus;
}

export interface ExecutionSnapshot {
  runId: string;
  tasks: Task[];
  createdAt: number;
}

export interface TaskFileInfo {
  path: string;
  tasks: Task[];
}

export interface ProjectBinding {
  projectName: string;
  projectPath: string;
  taskFile: string;
  tmuxSession: string;
  agentProvider: AgentProvider;
}

export interface AgentSessionResult {
  success: boolean;
  binding: ProjectBinding;
  started: boolean;
  error?: string;
}

export interface AgentExecutionResult {
  success: boolean;
  binding: ProjectBinding;
  uncheckedCount: number;
  sentAt: number;
  error?: string;
}

export interface AgentLogResult {
  success: boolean;
  binding: ProjectBinding;
  log: string;
  error?: string;
}

export type ApprovalDecision = 'approve' | 'reject';

export type AgentProvider = 'codex' | 'claude' | 'cmux-codex' | 'cmux-claude' | 'custom';

export type AgentControlKey = 'Up' | 'Down' | 'Left' | 'Right' | 'Enter' | 'Escape' | 'Tab' | 'Space';

export interface Batch {
  id: string;
  batchNumber: number;
  tasks: Task[];
  status: 'running' | 'queued' | 'completed';
  createdAt: number;
}

export interface BatchExecutionResult {
  success: boolean;
  binding: ProjectBinding;
  batchId: string;
  batchNumber: number;
  taskCount: number;
  sentAt: number;
  error?: string;
}

export interface AgentConfig {
  provider: AgentProvider;
  customCommand: string;
  showTerminalControls: boolean;
}

export interface BatchRuntimeState {
  batches: Batch[];
  runningBatchId: string | null;
  queuedLineNumbers: number[];
  nextBatchNumber: number;
  isExecuting: boolean;
  snapshotTasks: Task[];
  currentTaskIndex: number;
  currentRunId: string | null;
  doneParseBaseline: number;
  completedTaskIndices: number[];
  handledApprovalMarkerIndex: number;
  handledBatchCompletedIndex: number;
}

export interface ElectronAPI {
  selectTaskFile: () => Promise<string | null>;
  readTaskFile: (filePath: string) => Promise<TaskFileInfo>;
  writeTaskStatus: (filePath: string, lineNumber: number, completed: boolean) => Promise<void>;
  editTaskTitle: (filePath: string, lineNumber: number, newTitle: string) => Promise<void>;
  appendTask: (filePath: string, title: string) => Promise<Task | null>;
  deleteTask: (filePath: string, lineNumber: number) => Promise<string | null>;
  undoDeleteTask: (filePath: string, lineNumber: number, lineContent: string) => Promise<void>;
  onFileChanged: (callback: (tasks: Task[]) => void) => () => void;
  getProjectBinding: (filePath: string) => Promise<ProjectBinding>;
  getAgentConfig: () => Promise<AgentConfig>;
  setAgentConfig: (config: AgentConfig) => Promise<AgentConfig>;
  ensureAgentSession: (filePath: string) => Promise<AgentSessionResult>;
  executeWithAI: (filePath: string, task?: Task) => Promise<AgentExecutionResult>;
  captureAgentLog: (filePath: string) => Promise<AgentLogResult>;
  sendAgentApproval: (filePath: string, decision: ApprovalDecision) => Promise<AgentExecutionResult>;
  sendAgentMessage: (filePath: string, message: string) => Promise<AgentExecutionResult>;
  sendAgentKey: (filePath: string, key: AgentControlKey) => Promise<AgentExecutionResult>;
  stopAgent: (filePath: string) => Promise<AgentExecutionResult>;
  executeBatchPrompt: (filePath: string, batchNumber: number, batchTasks: Task[]) => Promise<BatchExecutionResult>;
  clearCompletedTasks: (filePath: string) => Promise<void>;
  notifyComplete: () => Promise<void>;
  getSystemSounds: () => Promise<string[]>;
  setNotificationSound: (sound: string) => Promise<void>;
  getNotificationSound: () => Promise<string>;
  restartApp: () => Promise<void>;
  getDefaultFilePath: () => Promise<string>;
  setDefaultFilePath: (filePath: string) => Promise<void>;
  getShortcut: () => Promise<string>;
  setShortcut: (shortcut: string) => Promise<void>;
  refreshTasks: (filePath: string) => Promise<TaskFileInfo>;
  setWindowCollapsed: (collapsed: boolean) => Promise<void>;
  onToggleWindow: (callback: () => void) => () => void;
  onAgentIdleWarning: (callback: (message: string) => void) => () => void;
  resetStallTimer: () => Promise<void>;
  stopStallWatchdog: () => Promise<void>;
  stopIdleAgent: (filePath: string) => Promise<void>;
  getBatchRuntime: (filePath: string) => Promise<BatchRuntimeState | null>;
  setBatchRuntime: (filePath: string, state: BatchRuntimeState) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
