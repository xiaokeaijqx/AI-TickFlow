import { app, BrowserWindow, globalShortcut, ipcMain, dialog, Notification, session } from 'electron';
import type { OpenDialogOptions } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
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
  BatchRuntimeState,
  ProjectBinding,
  Task,
  TaskFileInfo,
} from '../shared/types';
import { batchSentinel } from '../shared/types';

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
  batchRuntime: Record<string, BatchRuntimeState>;
};

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  provider: 'codex',
  customCommand: '',
  showTerminalControls: true,
  skipPermissions: false,
};

function normalizeAgentConfig(value: unknown): AgentConfig {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_AGENT_CONFIG;
  }

  const maybeConfig = value as Partial<AgentConfig>;
  const provider = maybeConfig.provider;
  const allowedProviders: AgentProvider[] = ['codex', 'claude', 'custom'];

  return {
    provider: provider && allowedProviders.includes(provider) ? provider : DEFAULT_AGENT_CONFIG.provider,
    customCommand: typeof maybeConfig.customCommand === 'string' ? maybeConfig.customCommand : '',
    showTerminalControls: typeof maybeConfig.showTerminalControls === 'boolean'
      ? maybeConfig.showTerminalControls
      : DEFAULT_AGENT_CONFIG.showTerminalControls,
    skipPermissions: typeof maybeConfig.skipPermissions === 'boolean'
      ? maybeConfig.skipPermissions
      : DEFAULT_AGENT_CONFIG.skipPermissions,
  };
}

function loadSettings(): AppSettings {
  const defaults: AppSettings = {
    filePath: '',
    shortcut: 'Cmd+Shift+T',
    agentConfig: DEFAULT_AGENT_CONFIG,
    notificationSound: 'Glass.aiff',
    batchRuntime: {},
  };

  try {
    if (fs.existsSync(settingsPath)) {
      const rawSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Partial<AppSettings>;
      return {
        filePath: typeof rawSettings.filePath === 'string' ? rawSettings.filePath : defaults.filePath,
        shortcut: typeof rawSettings.shortcut === 'string' ? rawSettings.shortcut : defaults.shortcut,
        agentConfig: normalizeAgentConfig(rawSettings.agentConfig),
        notificationSound: typeof rawSettings.notificationSound === 'string' ? rawSettings.notificationSound : defaults.notificationSound,
        batchRuntime:
          typeof rawSettings.batchRuntime === 'object' && rawSettings.batchRuntime !== null
            ? rawSettings.batchRuntime
            : defaults.batchRuntime,
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

// Fix #6: Allowlist of RESOLVED file paths the renderer is permitted to touch.
// A path enters this set only when the USER explicitly chose it (file dialog,
// set-default-file-path) or it was a previously user-selected path persisted in
// settings. This blocks a compromised renderer from passing arbitrary paths.
const approvedFilePaths = new Set<string>();

function approveFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  approvedFilePaths.add(resolved);
  return resolved;
}

function assertApprovedFile(filePath: string): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const resolved = path.resolve(filePath);
  if (!approvedFilePaths.has(resolved)) {
    console.warn(`Rejected unapproved file path: ${resolved}`);
    return null;
  }
  return resolved;
}

let mainWindow: BrowserWindow | null = null;
let expandedWindowBounds: Rectangle | null = null;

const DEV_SERVER_URL = 'http://localhost:5173';

function isDevMode(): boolean {
  return process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
}

function buildCspHeader(): string {
  if (isDevMode()) {
    // Relaxed CSP so Vite HMR (ws), eval-based HMR, and inline dev assets work.
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*",
      "style-src 'self' 'unsafe-inline' http://localhost:*",
      "img-src 'self' data:",
      "connect-src 'self' ws://localhost:* http://localhost:*",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }

  // Strict production CSP. 'unsafe-inline' on style-src is required for Tailwind / inline styles.
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

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

  // Fix #4: Set a Content-Security-Policy on every response. Registered once
  // here, before content loads. Header is dev/prod aware so Vite HMR keeps working.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [buildCspHeader()],
      },
    });
  });

  // Fix #5: Harden the renderer against navigation / new-window escapes.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow only the legitimate app URL (dev server in dev, file URL in prod).
    if (isDevMode()) {
      if (!url.startsWith(DEV_SERVER_URL)) {
        event.preventDefault();
      }
    } else if (!url.startsWith('file://')) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // In dev mode, load from Vite dev server
  if (isDevMode()) {
    mainWindow.loadURL(DEV_SERVER_URL);
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

// Fix #9: cap file size before synchronous reads so a pathological
// multi-hundred-MB file cannot freeze the main process. readTasks is the
// central read used by the watcher/poll path, so all callers benefit.
const MAX_TASK_FILE_BYTES = 5 * 1024 * 1024;

function readTasks(filePath: string): TaskFileInfo {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, tasks: [] };
  }
  const size = fs.statSync(filePath).size;
  if (size > MAX_TASK_FILE_BYTES) {
    console.warn(`Task file exceeds ${MAX_TASK_FILE_BYTES} bytes (${size}); skipping read: ${filePath}`);
    return { path: filePath, tasks: [] };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return { path: filePath, tasks: parseTasks(content) };
}

// Guarded full-file read shared by the write-path helpers. Returns null when
// the file is missing or exceeds the size cap (Fix #9), so callers no-op
// instead of freezing the main process on a pathological file.
function readFileGuarded(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const size = fs.statSync(filePath).size;
  if (size > MAX_TASK_FILE_BYTES) {
    console.warn(`Task file exceeds ${MAX_TASK_FILE_BYTES} bytes (${size}); skipping read: ${filePath}`);
    return null;
  }
  return fs.readFileSync(filePath, 'utf-8');
}

// Same task-line regex used by parseTasks: captures [ /x] state and title.
const TASK_LINE_REGEX = /^[\s]*- \[([ x])\] (.+)$/;

function toggleTaskStatus(
  filePath: string,
  lineNumber: number,
  completed: boolean,
  expectedTitle?: string
): void {
  // Read fresh so concurrent agent edits to OTHER lines are preserved.
  const content = readFileGuarded(filePath);
  if (content === null) return;
  const lines = content.split('\n');

  const wantedTitle = expectedTitle?.trim();

  // 1. Fast path: lineNumber still points at the expected task line.
  let targetLine = -1;
  if (lineNumber >= 0 && lineNumber < lines.length) {
    const fastMatch = lines[lineNumber].match(TASK_LINE_REGEX);
    if (fastMatch && (wantedTitle === undefined || fastMatch[2].trim() === wantedTitle)) {
      targetLine = lineNumber;
    }
  }

  // 2. Relocate by title: anchor on content, not position.
  if (targetLine === -1 && wantedTitle !== undefined) {
    const candidates: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(TASK_LINE_REGEX);
      if (match && match[2].trim() === wantedTitle) {
        candidates.push(i);
      }
    }
    if (candidates.length === 1) {
      targetLine = candidates[0];
    } else if (candidates.length > 1) {
      // Duplicate titles are real; pick the candidate closest to the
      // original lineNumber (ties resolve to the lowest index).
      targetLine = candidates.reduce((best, idx) => {
        const bestDist = Math.abs(best - lineNumber);
        const idxDist = Math.abs(idx - lineNumber);
        if (idxDist < bestDist) return idx;
        if (idxDist === bestDist) return Math.min(best, idx);
        return best;
      }, candidates[0]);
    }
  }

  // 3. Legacy fallback: no title supplied, use in-range lineNumber as-is.
  if (targetLine === -1 && wantedTitle === undefined && lineNumber >= 0 && lineNumber < lines.length) {
    targetLine = lineNumber;
  }

  if (targetLine === -1) {
    console.warn(
      `toggleTaskStatus: could not locate task line for title "${expectedTitle ?? ''}" (lineNumber ${lineNumber}); skipping`
    );
    return;
  }

  const line = lines[targetLine];
  const newStatus = completed ? 'x' : ' ';
  const newLine = line.replace(/- \[[ x]\]/, `- [${newStatus}]`);

  if (newLine === line) return; // No change

  lines[targetLine] = newLine;
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

function appendTaskToFile(filePath: string, title: string): Task | null {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# Tasks\n\n`, 'utf-8');
  }

  const content = readFileGuarded(filePath);
  if (content === null) return null;
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

// Reject shell metacharacters plus newline/CR and other control chars
// (\x00-\x1f) — a newline lets an attacker start a whole new shell command.
// Spaces are intentionally allowed so commands can carry flags/args.
const UNSAFE_SHELL_PATTERNS = /[;&|`$<>\\\n\r\x00-\x1f]/;

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
      return config.skipPermissions
        ? `${shellPathPrefix} claude --dangerously-skip-permissions`
        : `${shellPathPrefix} claude`;
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

const STALL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
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

        const message = `代理已约 ${Math.round(stalledDuration / 60000)} 分钟无新输出（可能已完成未上报或卡住）。如需停止，请点下方 Stop 按钮。`;
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
  batchTasks: Task[],
  batchId: string
): string {
  const taskLines = batchTasks
    .map((task, index) => `[${index + 1}] ${task.title}`)
    .join('\n');

  // Sentinel anchors DONE-marker parsing relative to this batch (see
  // batchSentinel docs). It is echoed back into the capture; the parser
  // re-locates it each poll, so it survives sliding-window offset drift.
  return `${batchSentinel(batchId)}
${taskLines}

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
  batchTasks: Task[],
  batchId: string
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
    const prompt = buildBatchExecutionPrompt(sessionResult.binding, batchNumber, batchTasks, batchId);
    await pastePrompt(sessionResult.binding.tmuxSession, prompt);

    startStallWatchdog(sessionResult.binding.tmuxSession);

    return {
      success: true,
      binding: sessionResult.binding,
      batchId,
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
  const content = readFileGuarded(filePath);
  if (content === null) return;
  const lines = content.split('\n');
  const filtered = lines.filter((line) => !/^[\s]*- \[x\] .+/.test(line));
  fs.writeFileSync(filePath, filtered.join('\n'), 'utf-8');
}

function deleteTaskFromFile(filePath: string, lineNumber: number): string | null {
  const content = readFileGuarded(filePath);
  if (content === null) return null;

  const lines = content.split('\n');

  if (lineNumber < 0 || lineNumber >= lines.length) return null;

  const deletedLine = lines[lineNumber];
  lines.splice(lineNumber, 1);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return deletedLine;
}

function undoDeleteTask(filePath: string, lineNumber: number, lineContent: string): void {
  const content = readFileGuarded(filePath);
  if (content === null) return;
  const lines = content.split('\n');

  // Re-insert at original position (or end if position no longer valid)
  const insertAt = Math.min(lineNumber, lines.length);
  lines.splice(insertAt, 0, lineContent);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

function editTaskTitle(filePath: string, lineNumber: number, newTitle: string): void {
  const content = readFileGuarded(filePath);
  if (content === null) return;
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
    // Dialog result is trusted (the user explicitly chose it) — approve & persist.
    const filePath = approveFilePath(result.filePaths[0]);
    saveSettings({ filePath });
    watchFile(filePath);
    return filePath;
  });

  ipcMain.handle('read-task-file', (_event, filePath: string) => {
    const approved = assertApprovedFile(filePath);
    if (!approved) return { path: filePath, tasks: [] };
    return readTasks(approved);
  });

  ipcMain.handle(
    'write-task-status',
    (_event, filePath: string, lineNumber: number, completed: boolean, expectedTitle?: string) => {
      const approved = assertApprovedFile(filePath);
      if (!approved) return;
      toggleTaskStatus(approved, lineNumber, completed, expectedTitle);
    }
  );

  ipcMain.handle('append-task', (_event, filePath: string, title: string) => {
    const approved = assertApprovedFile(filePath);
    if (!approved) return null;
    return appendTaskToFile(approved, title);
  });

  ipcMain.handle('get-project-binding', (_event, filePath: string) => {
    const approved = assertApprovedFile(filePath);
    if (!approved) return null;
    return getProjectBinding(approved);
  });

  ipcMain.handle('get-agent-config', () => {
    return loadSettings().agentConfig;
  });

  ipcMain.handle('set-agent-config', (_event, config: AgentConfig) => {
    const agentConfig = normalizeAgentConfig(config);
    // Fix #7: never persist an unsafe custom command. Reject the change and
    // return the current (unchanged) config so the renderer reflects reality.
    if (agentConfig.provider === 'custom') {
      const validationError = validateCustomCommand(agentConfig.customCommand.trim());
      if (validationError) {
        console.warn(`Rejected unsafe custom command: ${validationError}`);
        return loadSettings().agentConfig;
      }
    }
    saveSettings({ agentConfig });
    return agentConfig;
  });

  ipcMain.handle('ensure-agent-session', async (_event, filePath: string) => {
    return await ensureAgentSession(filePath);
  });

  ipcMain.handle('restart-agent', async (_event, filePath: string) => {
    const binding = getProjectBinding(filePath);
    try {
      stopStallWatchdog();
      if (await hasTmuxSession(binding.tmuxSession)) {
        await runTmux(['kill-session', '-t', binding.tmuxSession]);
      }
    } catch (error) {
      console.error('Failed to kill agent session on restart:', getCommandErrorMessage(error));
    }
    // Recreate a fresh session running the (possibly newly-configured) agent.
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

  ipcMain.handle('execute-batch-prompt', async (_event, filePath: string, batchNumber: number, batchTasks: Task[], batchId: string) => {
    return await executeBatchPrompt(filePath, batchNumber, batchTasks, batchId);
  });

  ipcMain.handle('clear-completed-tasks', async (_event, filePath: string) => {
    const approved = assertApprovedFile(filePath);
    if (!approved) return;
    clearCompletedFromFile(approved);
  });

  ipcMain.handle('delete-task', (_event, filePath: string, lineNumber: number) => {
    const approved = assertApprovedFile(filePath);
    if (!approved) return null;
    return deleteTaskFromFile(approved, lineNumber);
  });

  ipcMain.handle('undo-delete-task', (_event, filePath: string, lineNumber: number, lineContent: string) => {
    const approved = assertApprovedFile(filePath);
    if (!approved) return;
    undoDeleteTask(approved, lineNumber, lineContent);
  });

  ipcMain.handle('edit-task-title', (_event, filePath: string, lineNumber: number, newTitle: string) => {
    const approved = assertApprovedFile(filePath);
    if (!approved) return;
    editTaskTitle(approved, lineNumber, newTitle);
  });

  ipcMain.handle('get-default-file-path', () => {
    return loadSettings().filePath;
  });

  ipcMain.handle('set-default-file-path', (_event, filePath: string) => {
    // Renderer only calls this with the user-selected default path — approve it (Fix #6).
    const approved = approveFilePath(filePath);
    saveSettings({ filePath: approved });
    watchFile(approved);
  });

  ipcMain.handle('get-shortcut', () => {
    return loadSettings().shortcut;
  });

  ipcMain.handle('set-shortcut', (_event, shortcut: string) => {
    saveSettings({ shortcut });
    registerShortcut(shortcut);
  });

  ipcMain.handle('get-batch-runtime', (_event, filePath: string) => {
    const key = path.resolve(filePath);
    return loadSettings().batchRuntime[key] ?? null;
  });

  ipcMain.handle('set-batch-runtime', (_event, filePath: string, runtime: BatchRuntimeState) => {
    const key = path.resolve(filePath);
    const current = loadSettings();
    saveSettings({ batchRuntime: { ...current.batchRuntime, [key]: runtime } });
  });

  ipcMain.handle('refresh-tasks', (_event, filePath: string) => {
    const approved = assertApprovedFile(filePath);
    if (!approved) return { path: filePath, tasks: [] };
    return readTasks(approved);
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
    // Use execFile (no shell) so any metacharacters in the sound name are inert.
    execFile('afplay', [soundPath], (error) => {
      if (error) {
        // Fallback to Glass if preferred sound fails
        execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});
      }
    });
  });

  ipcMain.handle('notify-approval', () => {
    const notification = new Notification({
      title: 'TickFlow',
      body: '需要审批才能继续 / Approval needed',
      silent: false,
    });
    notification.show();

    const settings = loadSettings();
    const soundPath = path.join('/System/Library/Sounds', settings.notificationSound);
    // Use execFile (no shell) so any metacharacters in the sound name are inert.
    execFile('afplay', [soundPath], (error) => {
      if (error) {
        // Fallback to Glass if preferred sound fails
        execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});
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
    // Reject renderer-controlled values that could carry shell metacharacters or
    // path traversal. Must be a bare ".aiff" filename and, when the system sound
    // directory can be enumerated, an actual member of it. Invalid input is a
    // no-op (keeps the previously persisted sound) — never persist arbitrary
    // strings, which would flow into the afplay call.
    if (typeof sound !== 'string' || !/^[A-Za-z0-9 ._-]+\.aiff$/.test(sound)) {
      return;
    }
    try {
      const available = fs.readdirSync('/System/Library/Sounds').filter((f) => f.endsWith('.aiff'));
      if (!available.includes(sound)) {
        return;
      }
    } catch {
      // If enumeration fails, fall back to the regex check above (already passed).
    }
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
    // The persisted path was user-selected previously — approve it (Fix #6).
    approveFilePath(settings.filePath);
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
