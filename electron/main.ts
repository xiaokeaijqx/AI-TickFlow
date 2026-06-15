import { app, BrowserWindow, globalShortcut, ipcMain, dialog, Notification } from 'electron';
import type { OpenDialogOptions } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type { Rectangle } from 'electron';
import type {
  AgentConfig,
  AgentControlKey,
  AgentExecutionResult,
  AgentLogResult,
  AgentProvider,
  AgentSessionResult,
  ApprovalDecision,
  BatchExecutionResult,
  ProjectBinding,
  Task,
  TaskFileInfo,
} from '../shared/types';

const execFileAsync = promisify(execFile);
const EXPANDED_MIN_SIZE: [number, number] = [240, 300];
const EXPANDED_MAX_SIZE: [number, number] = [600, 800];
const COLLAPSED_SIZE = { width: 136, height: 86 };

// Store for persistent settings (simple JSON file)
const settingsPath = path.join(app.getPath('userData'), 'tickflow-settings.json');

type AppSettings = {
  filePath: string;
  shortcut: string;
  agentConfig: AgentConfig;
  notificationSound: string;
};

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  provider: 'codex',
  customCommand: '',
  showTerminalControls: true,
};

function normalizeAgentConfig(value: unknown): AgentConfig {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_AGENT_CONFIG;
  }

  const maybeConfig = value as Partial<AgentConfig>;
  const provider = maybeConfig.provider;
  const allowedProviders: AgentProvider[] = ['codex', 'claude', 'cmux-codex', 'cmux-claude', 'custom'];

  return {
    provider: provider && allowedProviders.includes(provider) ? provider : DEFAULT_AGENT_CONFIG.provider,
    customCommand: typeof maybeConfig.customCommand === 'string' ? maybeConfig.customCommand : '',
    showTerminalControls: typeof maybeConfig.showTerminalControls === 'boolean'
      ? maybeConfig.showTerminalControls
      : DEFAULT_AGENT_CONFIG.showTerminalControls,
  };
}

function loadSettings(): AppSettings {
  const defaults: AppSettings = {
    filePath: '',
    shortcut: 'Cmd+Shift+T',
    agentConfig: DEFAULT_AGENT_CONFIG,
    notificationSound: 'Glass.aiff',
  };

  try {
    if (fs.existsSync(settingsPath)) {
      const rawSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Partial<AppSettings>;
      return {
        filePath: typeof rawSettings.filePath === 'string' ? rawSettings.filePath : defaults.filePath,
        shortcut: typeof rawSettings.shortcut === 'string' ? rawSettings.shortcut : defaults.shortcut,
        agentConfig: normalizeAgentConfig(rawSettings.agentConfig),
        notificationSound: typeof rawSettings.notificationSound === 'string' ? rawSettings.notificationSound : defaults.notificationSound,
      };
    }
  } catch (error) {
    console.error('Failed to load settings:', getCommandErrorMessage(error));
  }
  return defaults;
}

function saveSettings(settings: Partial<AppSettings>) {
  const current = loadSettings();
  const merged: AppSettings = {
    ...current,
    ...settings,
    agentConfig: settings.agentConfig ? normalizeAgentConfig(settings.agentConfig) : current.agentConfig,
  };
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
}

let mainWindow: BrowserWindow | null = null;
let expandedWindowBounds: Rectangle | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 320,
    height: 520,
    minWidth: EXPANDED_MIN_SIZE[0],
    minHeight: EXPANDED_MIN_SIZE[1],
    maxWidth: EXPANDED_MAX_SIZE[0],
    maxHeight: EXPANDED_MAX_SIZE[1],
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    hasShadow: true,
    titleBarStyle: 'hidden' as const,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // In dev mode, load from Vite dev server
  if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'floating');

  // Prevent title from showing
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
}

function setWindowCollapsed(collapsed: boolean): void {
  if (!mainWindow) return;

  if (collapsed) {
    const bounds = mainWindow.getBounds();
    expandedWindowBounds = bounds;
    mainWindow.setMinimumSize(COLLAPSED_SIZE.width, COLLAPSED_SIZE.height);
    mainWindow.setBounds({
      x: bounds.x + bounds.width - COLLAPSED_SIZE.width,
      y: bounds.y,
      width: COLLAPSED_SIZE.width,
      height: COLLAPSED_SIZE.height,
    });
    return;
  }

  mainWindow.setMinimumSize(...EXPANDED_MIN_SIZE);
  mainWindow.setMaximumSize(...EXPANDED_MAX_SIZE);

  if (expandedWindowBounds) {
    mainWindow.setBounds(expandedWindowBounds);
    expandedWindowBounds = null;
    return;
  }

  mainWindow.setSize(320, 420);
}

function registerShortcut(shortcut: string) {
  globalShortcut.unregisterAll();

  const registered = globalShortcut.register(shortcut, () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  if (!registered) {
    console.error(`Failed to register shortcut: ${shortcut}`);
  }
}

// ─── Markdown Parser ────────────────────────────────────────────

function parseTasks(markdown: string): Task[] {
  const lines = markdown.split('\n');
  const tasks: Task[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^[\s]*- \[([ x])\] (.+)$/);
    if (match) {
      tasks.push({
        id: `task-${i}`,
        title: match[2].trim(),
        completed: match[1] === 'x',
        lineNumber: i,
      });
    }
  }

  return tasks;
}

function readTasks(filePath: string): TaskFileInfo {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, tasks: [] };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return { path: filePath, tasks: parseTasks(content) };
}

function toggleTaskStatus(filePath: string, lineNumber: number, completed: boolean): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  if (lineNumber < 0 || lineNumber >= lines.length) return;

  const line = lines[lineNumber];
  const newStatus = completed ? 'x' : ' ';
  const newLine = line.replace(/- \[[ x]\]/, `- [${newStatus}]`);

  if (newLine === line) return; // No change

  lines[lineNumber] = newLine;
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

function appendTaskToFile(filePath: string, title: string): Task | null {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# Tasks\n\n`, 'utf-8');
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const newLineNumber = lines.length;

  // Append new task
  const newContent = content.trimEnd() + `\n- [ ] ${title}\n`;
  fs.writeFileSync(filePath, newContent, 'utf-8');

  return {
    id: `task-${newLineNumber}`,
    title,
    completed: false,
    lineNumber: newLineNumber,
  };
}

// ─── Codex Agent via tmux ─────────────────────────────────────

const TMUX_BIN_CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', 'tmux'];
const CMUX_CLI_PATH = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const LOG_CAPTURE_LINES = 2000;
const TMUX_MAX_BUFFER = 1024 * 1024 * 4;
const PASTE_BUFFER_DELAY_MS = 300;

const APPROVAL_RESPONSES: Record<ApprovalDecision, string> = {
  approve: '继续执行',
  reject: '取消本步骤并重新规划',
};

const AGENT_CONTROL_KEYS: Record<AgentControlKey, string> = {
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Space: 'Space',
};

const SHELL_COMMANDS = new Set(['bash', 'fish', 'login', 'sh', 'zsh']);

type CommandError = NodeJS.ErrnoException & {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

function isCommandError(error: unknown): error is CommandError {
  return typeof error === 'object' && error !== null;
}

function isAgentControlKey(value: unknown): value is AgentControlKey {
  return typeof value === 'string' && value in AGENT_CONTROL_KEYS;
}

function getCommandErrorMessage(error: unknown): string {
  if (isCommandError(error)) {
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    const stdout = error.stdout ? String(error.stdout).trim() : '';
    return stderr || stdout || error.message || 'Command failed';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Command failed';
}

// ─── Retry helpers ─────────────────────────────────────────────────

const TMUX_RETRY_MAX = 3;
const TMUX_RETRY_DELAYS = [500, 1000, 2000];

const TRANSIENT_TMUX_ERRORS = [
  'no server running',
  'lost server',
  'connection refused',
  'no sessions',
  'connect',
];

function isTransientTmuxError(error: unknown): boolean {
  const message = getCommandErrorMessage(error).toLowerCase();
  return TRANSIENT_TMUX_ERRORS.some((pattern) => message.includes(pattern));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = TMUX_RETRY_MAX,
  delays: number[] = TMUX_RETRY_DELAYS,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Only retry on transient errors
      if (attempt < maxRetries && isTransientTmuxError(error)) {
        const delay = delays[attempt] ?? delays[delays.length - 1];
        console.warn(
          `tmux transient error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`,
          getCommandErrorMessage(error),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

async function runTmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
  let lastError: unknown = null;

  for (const tmuxBin of TMUX_BIN_CANDIDATES) {
    try {
      const result = await withRetry(async () => {
        const execResult = await execFileAsync(tmuxBin, args, { maxBuffer: TMUX_MAX_BUFFER });
        return execResult;
      });
      return {
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    } catch (error) {
      if (isCommandError(error) && error.code === 'ENOENT') {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('tmux was not found');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function getShellPathPrefix(): string {
  const userLocalBin = path.join(app.getPath('home'), '.local/bin').replace(/(["\\])/g, '\\$1');
  return `export PATH="/opt/homebrew/bin:/usr/local/bin:${userLocalBin}:$PATH";`;
}

const UNSAFE_SHELL_PATTERNS = /[;&|`$<>\\]/;

function validateCustomCommand(command: string): string | null {
  if (!command) return 'Custom command is empty';
  if (UNSAFE_SHELL_PATTERNS.test(command)) {
    return `Custom command contains unsafe shell metacharacters: ${command}`;
  }
  return null;
}

function getAgentStartCommand(config: AgentConfig): string {
  const shellPathPrefix = getShellPathPrefix();

  switch (config.provider) {
    case 'codex':
      return `${shellPathPrefix} codex`;
    case 'claude':
      return `${shellPathPrefix} claude`;
    case 'cmux-codex':
      return `${shellPathPrefix} ${shellQuote(CMUX_CLI_PATH)} codex-teams`;
    case 'cmux-claude':
      return `${shellPathPrefix} ${shellQuote(CMUX_CLI_PATH)} claude-teams`;
    case 'custom':
      return config.customCommand.trim();
    default: {
      const _exhaustive: never = config.provider;
      return _exhaustive;
    }
  }
}

function getAgentProviderLabel(provider: AgentProvider): string {
  return provider.replace(/[^A-Za-z0-9_-]+/g, '-');
}

function getProjectBinding(filePath: string): ProjectBinding {
  const agentConfig = loadSettings().agentConfig;
  const taskFile = path.resolve(filePath);
  const projectPath = path.dirname(taskFile);
  const projectName = path.basename(projectPath) || 'project';
  const sessionBase = `${projectName}-${getAgentProviderLabel(agentConfig.provider)}-agent`
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return {
    projectName,
    projectPath,
    taskFile,
    tmuxSession: sessionBase || 'tickflow-agent',
    agentProvider: agentConfig.provider,
  };
}

async function hasTmuxSession(sessionName: string): Promise<boolean> {
  try {
    await runTmux(['has-session', '-t', sessionName]);
    return true;
  } catch {
    // Session probably doesn't exist — that's OK
    return false;
  }
}

async function getPaneValue(sessionName: string, format: string): Promise<string> {
  const result = await runTmux(['display-message', '-p', '-t', sessionName, format]);
  return result.stdout.trim();
}

async function sendLiteralLine(sessionName: string, text: string): Promise<void> {
  await runTmux(['send-keys', '-t', sessionName, '-l', text]);
  await runTmux(['send-keys', '-t', sessionName, 'Enter']);
}

async function pastePrompt(sessionName: string, prompt: string): Promise<void> {
  await runTmux(['set-buffer', prompt]);
  await runTmux(['paste-buffer', '-t', sessionName]);
  await new Promise((resolve) => setTimeout(resolve, PASTE_BUFFER_DELAY_MS));
  await runTmux(['send-keys', '-t', sessionName, 'Enter']);
}

// ─── Stall Watchdog ─────────────────────────────────────────────────

const STALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STALL_CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds

let stallWatchdogInterval: NodeJS.Timeout | null = null;
let lastLogChangeTime = 0;
let lastLogContent = '';
let idleWarningEmitted = false;

function startStallWatchdog(sessionName: string): void {
  stopStallWatchdog();
  lastLogChangeTime = Date.now();
  lastLogContent = '';
  idleWarningEmitted = false;

  stallWatchdogInterval = setInterval(async () => {
    try {
      const result = await runTmux([
        'capture-pane',
        '-e',
        '-t',
        sessionName,
        '-p',
        '-S',
        `-${LOG_CAPTURE_LINES}`,
      ]);

      const currentContent = result.stdout;

      if (currentContent !== lastLogContent) {
        // Content changed — agent is making progress
        lastLogContent = currentContent;
        lastLogChangeTime = Date.now();
        idleWarningEmitted = false;
        return;
      }

      // No change since last check
      const stalledDuration = Date.now() - lastLogChangeTime;
      if (stalledDuration >= STALL_TIMEOUT_MS && !idleWarningEmitted) {
        // Agent idle — warn user but do NOT auto-kill
        idleWarningEmitted = true;

        const message = `Agent idle (no output for ${Math.round(stalledDuration / 1000)}s). Continue or stop?`;
        console.warn(message);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent-idle-warning', message);
        }
      }
    } catch (error) {
      console.error('Stall watchdog check failed:', getCommandErrorMessage(error));
    }
  }, STALL_CHECK_INTERVAL_MS);
}

function stopStallWatchdog(): void {
  if (stallWatchdogInterval) {
    clearInterval(stallWatchdogInterval);
    stallWatchdogInterval = null;
  }
  lastLogContent = '';
  lastLogChangeTime = 0;
}

function resetStallTimer(): void {
  lastLogChangeTime = Date.now();
}

function buildBatchExecutionPrompt(
  binding: ProjectBinding,
  batchNumber: number,
  batchTasks: Task[]
): string {
  const taskLines = batchTasks
    .map((task, index) => `[${index + 1}] ${task.title}`)
    .join('\n');

  return `${taskLines}

完成某个任务后输出：DONE N
需确认时输出：WAIT_APPROVAL
不要直接修改 task.md，通过上述标记报告完成状态。
项目路径：${binding.projectPath}`;
}

function buildExecutionPrompt(binding: ProjectBinding, uncheckedTasks: Task[], focusedTask?: Task): string {
  const taskLines = uncheckedTasks
    .map((task, index) => `[${index + 1}] ${task.title}`)
    .join('\n');
  const focusLine = focusedTask && focusedTask.lineNumber >= 0
    ? `优先: ${focusedTask.title}\n`
    : '';

  return `${focusLine}${taskLines || '无'}

完成某个任务后输出：DONE N
需确认时输出：WAIT_APPROVAL
全部完成后输出：ALL_TASKS_COMPLETED
不要直接修改 task.md，通过上述标记报告完成状态。
项目路径：${binding.projectPath}`;
}

async function ensureAgentSession(filePath: string): Promise<AgentSessionResult> {
  const binding = getProjectBinding(filePath);
  const agentConfig = loadSettings().agentConfig;
  const startCommand = getAgentStartCommand(agentConfig);

  try {
    if (!fs.existsSync(binding.projectPath)) {
      return {
        success: false,
        binding,
        started: false,
        error: `Project path does not exist: ${binding.projectPath}`,
      };
    }

    if (!startCommand) {
      return {
        success: false,
        binding,
        started: false,
        error: 'Agent command is empty',
      };
    }

    if (agentConfig.provider === 'custom') {
      const validationError = validateCustomCommand(startCommand);
      if (validationError) {
        return {
          success: false,
          binding,
          started: false,
          error: validationError,
        };
      }
    }

    let started = false;
    const sessionExists = await hasTmuxSession(binding.tmuxSession);

    if (!sessionExists) {
      await runTmux(['new-session', '-d', '-s', binding.tmuxSession, '-c', binding.projectPath]);
      started = true;
    }

    const currentCommand = (await getPaneValue(binding.tmuxSession, '#{pane_current_command}')).toLowerCase();

    if (SHELL_COMMANDS.has(currentCommand)) {
      const currentPath = await getPaneValue(binding.tmuxSession, '#{pane_current_path}');
      if (currentPath !== binding.projectPath) {
        await sendLiteralLine(binding.tmuxSession, `cd ${shellQuote(binding.projectPath)}`);
      }
      await sendLiteralLine(binding.tmuxSession, startCommand);
      started = true;
    }

    return { success: true, binding, started };
  } catch (error) {
    return {
      success: false,
      binding,
      started: false,
      error: getCommandErrorMessage(error),
    };
  }
}

async function executeAgentTasks(filePath: string, focusedTask?: Task): Promise<AgentExecutionResult> {
  const sessionResult = await ensureAgentSession(filePath);

  if (!sessionResult.success) {
    return {
      success: false,
      binding: sessionResult.binding,
      uncheckedCount: 0,
      sentAt: Date.now(),
      error: sessionResult.error,
    };
  }

  try {
    const uncheckedTasks = readTasks(filePath).tasks.filter((task) => !task.completed);

    if (uncheckedTasks.length === 0) {
      return {
        success: true,
        binding: sessionResult.binding,
        uncheckedCount: 0,
        sentAt: Date.now(),
      };
    }

    const prompt = buildExecutionPrompt(sessionResult.binding, uncheckedTasks, focusedTask);
    await pastePrompt(sessionResult.binding.tmuxSession, prompt);

    startStallWatchdog(sessionResult.binding.tmuxSession);

    return {
      success: true,
      binding: sessionResult.binding,
      uncheckedCount: uncheckedTasks.length,
      sentAt: Date.now(),
    };
  } catch (error) {
    return {
      success: false,
      binding: sessionResult.binding,
      uncheckedCount: 0,
      sentAt: Date.now(),
      error: getCommandErrorMessage(error),
    };
  }
}

async function executeBatchPrompt(
  filePath: string,
  batchNumber: number,
  batchTasks: Task[]
): Promise<BatchExecutionResult> {
  const sessionResult = await ensureAgentSession(filePath);
  if (!sessionResult.success) {
    return {
      success: false,
      binding: sessionResult.binding,
      batchId: '',
      batchNumber,
      taskCount: 0,
      sentAt: Date.now(),
      error: sessionResult.error,
    };
  }
  try {
    if (batchTasks.length === 0) {
      return {
        success: true,
        binding: sessionResult.binding,
        batchId: '',
        batchNumber,
        taskCount: 0,
        sentAt: Date.now(),
      };
    }
    const prompt = buildBatchExecutionPrompt(sessionResult.binding, batchNumber, batchTasks);
    await pastePrompt(sessionResult.binding.tmuxSession, prompt);

    startStallWatchdog(sessionResult.binding.tmuxSession);

    return {
      success: true,
      binding: sessionResult.binding,
      batchId: `batch_${batchNumber}`,
      batchNumber,
      taskCount: batchTasks.length,
      sentAt: Date.now(),
    };
  } catch (error) {
    return {
      success: false,
      binding: sessionResult.binding,
      batchId: '',
      batchNumber,
      taskCount: 0,
      sentAt: Date.now(),
      error: getCommandErrorMessage(error),
    };
  }
}

async function captureAgentLog(filePath: string): Promise<AgentLogResult> {
  const binding = getProjectBinding(filePath);

  try {
    const sessionExists = await hasTmuxSession(binding.tmuxSession);
    if (!sessionExists) {
      return {
        success: true,
        binding,
        log: '',
      };
    }

    const result = await runTmux([
      'capture-pane',
      '-e',
      '-t',
      binding.tmuxSession,
      '-p',
      '-S',
      `-${LOG_CAPTURE_LINES}`,
    ]);

    // If log has changed, reset the stall timer
    if (result.stdout !== lastLogContent) {
      resetStallTimer();
    }

    return {
      success: true,
      binding,
      log: result.stdout,
    };
  } catch (error) {
    return {
      success: false,
      binding,
      log: '',
      error: getCommandErrorMessage(error),
    };
  }
}

async function sendAgentApproval(filePath: string, decision: ApprovalDecision): Promise<AgentExecutionResult> {
  const sessionResult = await ensureAgentSession(filePath);
  const response = APPROVAL_RESPONSES[decision];

  if (!sessionResult.success) {
    return {
      success: false,
      binding: sessionResult.binding,
      uncheckedCount: 0,
      sentAt: Date.now(),
      error: sessionResult.error,
    };
  }

  try {
    await sendLiteralLine(sessionResult.binding.tmuxSession, response);
    return {
      success: true,
      binding: sessionResult.binding,
      uncheckedCount: readTasks(filePath).tasks.filter((task) => !task.completed).length,
      sentAt: Date.now(),
    };
  } catch (error) {
    return {
      success: false,
      binding: sessionResult.binding,
      uncheckedCount: 0,
      sentAt: Date.now(),
      error: getCommandErrorMessage(error),
    };
  }
}

async function sendAgentMessage(filePath: string, message: string): Promise<AgentExecutionResult> {
  const sessionResult = await ensureAgentSession(filePath);
  const trimmedMessage = message.trim();

  if (!sessionResult.success) {
    return {
      success: false,
      binding: sessionResult.binding,
      uncheckedCount: 0,
      sentAt: Date.now(),
      error: sessionResult.error,
    };
  }

  if (!trimmedMessage) {
    return {
      success: false,
      binding: sessionResult.binding,
      uncheckedCount: readTasks(filePath).tasks.filter((task) => !task.completed).length,
      sentAt: Date.now(),
      error: 'Message is empty',
    };
  }

  try {
    await pastePrompt(sessionResult.binding.tmuxSession, trimmedMessage);
    return {
      success: true,
      binding: sessionResult.binding,
      uncheckedCount: readTasks(filePath).tasks.filter((task) => !task.completed).length,
      sentAt: Date.now(),
    };
  } catch (error) {
    return {
      success: false,
      binding: sessionResult.binding,
      uncheckedCount: 0,
      sentAt: Date.now(),
      error: getCommandErrorMessage(error),
    };
  }
}

async function sendAgentKey(filePath: string, key: unknown): Promise<AgentExecutionResult> {
  const sessionResult = await ensureAgentSession(filePath);

  if (!sessionResult.success) {
    return {
      success: false,
      binding: sessionResult.binding,
      uncheckedCount: 0,
      sentAt: Date.now(),
      error: sessionResult.error,
    };
  }

  if (!isAgentControlKey(key)) {
    return {
      success: false,
      binding: sessionResult.binding,
      uncheckedCount: readTasks(filePath).tasks.filter((task) => !task.completed).length,
      sentAt: Date.now(),
      error: 'Unsupported control key',
    };
  }

  try {
    await runTmux(['send-keys', '-t', sessionResult.binding.tmuxSession, AGENT_CONTROL_KEYS[key]]);
    return {
      success: true,
      binding: sessionResult.binding,
      uncheckedCount: readTasks(filePath).tasks.filter((task) => !task.completed).length,
      sentAt: Date.now(),
    };
  } catch (error) {
    return {
      success: false,
      binding: sessionResult.binding,
      uncheckedCount: 0,
      sentAt: Date.now(),
      error: getCommandErrorMessage(error),
    };
  }
}

async function stopAgent(filePath: string): Promise<AgentExecutionResult> {
  const binding = getProjectBinding(filePath);

  try {
    stopStallWatchdog();

    const sessionExists = await hasTmuxSession(binding.tmuxSession);
    if (sessionExists) {
      await runTmux(['send-keys', '-t', binding.tmuxSession, 'C-c']);
    }

    return {
      success: true,
      binding,
      uncheckedCount: readTasks(filePath).tasks.filter((task) => !task.completed).length,
      sentAt: Date.now(),
    };
  } catch (error) {
    return {
      success: false,
      binding,
      uncheckedCount: 0,
      sentAt: Date.now(),
      error: getCommandErrorMessage(error),
    };
  }
}

function clearCompletedFromFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const filtered = lines.filter((line) => !/^[\s]*- \[x\] .+/.test(line));
  fs.writeFileSync(filePath, filtered.join('\n'), 'utf-8');
}

function deleteTaskFromFile(filePath: string, lineNumber: number): string | null {
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  if (lineNumber < 0 || lineNumber >= lines.length) return null;

  const deletedLine = lines[lineNumber];
  lines.splice(lineNumber, 1);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return deletedLine;
}

function undoDeleteTask(filePath: string, lineNumber: number, lineContent: string): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Re-insert at original position (or end if position no longer valid)
  const insertAt = Math.min(lineNumber, lines.length);
  lines.splice(insertAt, 0, lineContent);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

function editTaskTitle(filePath: string, lineNumber: number, newTitle: string): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  if (lineNumber < 0 || lineNumber >= lines.length) return;

  const line = lines[lineNumber];
  const updated = line.replace(/^(\s*-\s*\[[ x]\]\s*).+$/, `$1${newTitle}`);

  if (updated === line) return; // No change

  lines[lineNumber] = updated;
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

// ─── File Watcher (polling) ───────────────────────────────────

let watchInterval: NodeJS.Timeout | null = null;
let lastMtime: number = 0;

function watchFile(filePath: string) {
  if (watchInterval) {
    clearInterval(watchInterval);
  }

  if (!fs.existsSync(filePath)) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, `# Tasks\n\n`, 'utf-8');
  }

  lastMtime = fs.statSync(filePath).mtimeMs;

  // Poll every 500ms for file changes.
  // We use polling (setInterval) instead of fs.watch because macOS
  // fs.watch has known reliability issues with certain editors and
  // file systems — it can miss events, produce duplicate events, or
  // stop firing after rapid writes. Polling with mtime comparison
  // is more predictable for this use case.
  watchInterval = setInterval(() => {
    try {
      if (!fs.existsSync(filePath)) return;
      const mtime = fs.statSync(filePath).mtimeMs;
      if (mtime !== lastMtime) {
        lastMtime = mtime;
        const result = readTasks(filePath);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('file-changed', result.tasks);
        }
      }
    } catch (error) {
      console.error('File watcher error:', error);
    }
  }, 500);
}

// ─── IPC Handlers ────────────────────────────────────────────────

function setupIPC() {
  ipcMain.handle('select-task-file', async () => {
    const dialogOptions: OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      defaultPath: app.getPath('documents'),
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    saveSettings({ filePath });
    watchFile(filePath);
    return filePath;
  });

  ipcMain.handle('read-task-file', (_event, filePath: string) => {
    return readTasks(filePath);
  });

  ipcMain.handle('write-task-status', (_event, filePath: string, lineNumber: number, completed: boolean) => {
    toggleTaskStatus(filePath, lineNumber, completed);
  });

  ipcMain.handle('append-task', (_event, filePath: string, title: string) => {
    return appendTaskToFile(filePath, title);
  });

  ipcMain.handle('get-project-binding', (_event, filePath: string) => {
    return getProjectBinding(filePath);
  });

  ipcMain.handle('get-agent-config', () => {
    return loadSettings().agentConfig;
  });

  ipcMain.handle('set-agent-config', (_event, config: AgentConfig) => {
    const agentConfig = normalizeAgentConfig(config);
    saveSettings({ agentConfig });
    return agentConfig;
  });

  ipcMain.handle('ensure-agent-session', async (_event, filePath: string) => {
    return await ensureAgentSession(filePath);
  });

  ipcMain.handle('execute-with-ai', async (_event, filePath: string, task?: Task) => {
    return await executeAgentTasks(filePath, task);
  });

  ipcMain.handle('capture-agent-log', async (_event, filePath: string) => {
    return await captureAgentLog(filePath);
  });

  ipcMain.handle('send-agent-approval', async (_event, filePath: string, decision: ApprovalDecision) => {
    return await sendAgentApproval(filePath, decision);
  });

  ipcMain.handle('send-agent-message', async (_event, filePath: string, message: string) => {
    return await sendAgentMessage(filePath, message);
  });

  ipcMain.handle('send-agent-key', async (_event, filePath: string, key: AgentControlKey) => {
    return await sendAgentKey(filePath, key);
  });

  ipcMain.handle('stop-agent', async (_event, filePath: string) => {
    return await stopAgent(filePath);
  });

  ipcMain.handle('execute-batch-prompt', async (_event, filePath: string, batchNumber: number, batchTasks: Task[]) => {
    return await executeBatchPrompt(filePath, batchNumber, batchTasks);
  });

  ipcMain.handle('clear-completed-tasks', async (_event, filePath: string) => {
    clearCompletedFromFile(filePath);
  });

  ipcMain.handle('delete-task', (_event, filePath: string, lineNumber: number) => {
    return deleteTaskFromFile(filePath, lineNumber);
  });

  ipcMain.handle('undo-delete-task', (_event, filePath: string, lineNumber: number, lineContent: string) => {
    undoDeleteTask(filePath, lineNumber, lineContent);
  });

  ipcMain.handle('edit-task-title', (_event, filePath: string, lineNumber: number, newTitle: string) => {
    editTaskTitle(filePath, lineNumber, newTitle);
  });

  ipcMain.handle('get-default-file-path', () => {
    return loadSettings().filePath;
  });

  ipcMain.handle('set-default-file-path', (_event, filePath: string) => {
    saveSettings({ filePath });
    watchFile(filePath);
  });

  ipcMain.handle('get-shortcut', () => {
    return loadSettings().shortcut;
  });

  ipcMain.handle('set-shortcut', (_event, shortcut: string) => {
    saveSettings({ shortcut });
    registerShortcut(shortcut);
  });

  ipcMain.handle('refresh-tasks', (_event, filePath: string) => {
    return readTasks(filePath);
  });

  ipcMain.handle('set-window-collapsed', (_event, collapsed: boolean) => {
    setWindowCollapsed(collapsed);
  });

  ipcMain.handle('reset-stall-timer', () => {
    resetStallTimer();
    idleWarningEmitted = false;
  });

  ipcMain.handle('stop-stall-watchdog', () => {
    stopStallWatchdog();
  });

  ipcMain.handle('stop-idle-agent', async (_event, filePath: string) => {
    const binding = getProjectBinding(filePath);
    try {
      stopStallWatchdog();
      const sessionExists = await hasTmuxSession(binding.tmuxSession);
      if (sessionExists) {
        await runTmux(['send-keys', '-t', binding.tmuxSession, 'C-c']);
      }
      // Also send notification so user knows agent was stopped
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('agent-idle-warning', 'Agent stopped by user.');
      }
    } catch (error) {
      console.error('Failed to stop idle agent:', getCommandErrorMessage(error));
    }
  });

  ipcMain.handle('notify-complete', () => {
    const notification = new Notification({
      title: 'TickFlow',
      body: '🎉 All Tasks Done!',
      silent: false,
    });
    notification.show();

    const settings = loadSettings();
    const soundPath = path.join('/System/Library/Sounds', settings.notificationSound);
    exec(`afplay "${soundPath}"`, (error) => {
      if (error) {
        // Fallback to Glass if preferred sound fails
        exec('afplay /System/Library/Sounds/Glass.aiff', () => {});
      }
    });
  });

  ipcMain.handle('get-system-sounds', () => {
    try {
      return fs.readdirSync('/System/Library/Sounds')
        .filter((f) => f.endsWith('.aiff'))
        .sort();
    } catch {
      return ['Glass.aiff', 'Pop.aiff'];
    }
  });

  ipcMain.handle('get-notification-sound', () => {
    return loadSettings().notificationSound;
  });

  ipcMain.handle('set-notification-sound', (_event, sound: string) => {
    saveSettings({ notificationSound: sound });
  });

  ipcMain.handle('restart-app', () => {
    app.relaunch();
    app.quit();
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────

app.whenReady().then(() => {
  setupIPC();
  createWindow();

  const settings = loadSettings();
  registerShortcut(settings.shortcut);
  if (settings.filePath) {
    watchFile(settings.filePath);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (watchInterval) clearInterval(watchInterval);
});
