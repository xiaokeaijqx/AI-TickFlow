# tmux-backed Agent Providers

## Scenario: Long-lived AI Agent in tmux

### 1. Scope / Trigger

- Trigger: The app needs to drive Codex, Claude, CMUX, or a custom local CLI without controlling Terminal.app or stealing focus.
- Scope: Electron main process owns tmux/agent process control; renderer accesses it only through typed preload IPC.
- Do not put Node.js, `child_process`, tmux, or shell access in renderer code.
- Agent provider selection is a persisted app setting surfaced in Settings UI, not a magic command typed into the agent message box.
- Terminal key control visibility is a persisted display setting; toggling it must not restart the tmux session.

### 2. Signatures

Shared IPC-facing types live in `shared/types.ts`:

```typescript
export type AgentProvider = 'codex' | 'claude' | 'cmux-codex' | 'cmux-claude' | 'custom';

export interface AgentConfig {
  provider: AgentProvider;
  customCommand: string;
  showTerminalControls: boolean;
}

export interface ProjectBinding {
  projectName: string;
  projectPath: string;
  taskFile: string;
  tmuxSession: string;
  agentProvider: AgentProvider;
}

export type AgentStatus = 'idle' | 'running' | 'waitingApproval' | 'error';
export type ApprovalDecision = 'approve' | 'reject';
export type AgentControlKey = 'Up' | 'Down' | 'Left' | 'Right' | 'Enter' | 'Escape' | 'Tab' | 'Space';
```

Renderer API surface:

```typescript
getProjectBinding(filePath: string): Promise<ProjectBinding>;
getAgentConfig(): Promise<AgentConfig>;
setAgentConfig(config: AgentConfig): Promise<AgentConfig>;
ensureAgentSession(filePath: string): Promise<AgentSessionResult>;
executeWithAI(filePath: string, task?: Task): Promise<AgentExecutionResult>;
captureAgentLog(filePath: string): Promise<AgentLogResult>;
sendAgentApproval(filePath: string, decision: ApprovalDecision): Promise<AgentExecutionResult>;
sendAgentMessage(filePath: string, message: string): Promise<AgentExecutionResult>;
sendAgentKey(filePath: string, key: AgentControlKey): Promise<AgentExecutionResult>;
stopAgent(filePath: string): Promise<AgentExecutionResult>;
```

### 3. Contracts

- `projectPath` is the directory containing `task.md`.
- `projectName` is the basename of `projectPath`.
- `tmuxSession` is a sanitized `<projectName>-<provider>-agent` string using only letters, digits, `_`, and `-`.
- Built-in provider commands prepend a PATH containing `/opt/homebrew/bin`, `/usr/local/bin`, and `<home>/.local/bin`.
- Provider commands:
  - `codex` -> `codex`
  - `claude` -> `claude`
  - `cmux-codex` -> `'/Applications/cmux.app/Contents/Resources/bin/cmux' codex-teams`
  - `cmux-claude` -> `'/Applications/cmux.app/Contents/Resources/bin/cmux' claude-teams`
  - `custom` -> trimmed `customCommand`
- Empty custom commands must fail with a clear error instead of starting a shell-only session.
- `showTerminalControls` controls only the renderer's on-screen key row. Physical keyboard forwarding remains available even when the row is hidden.
- `ensureAgentSession` creates the session with `tmux new-session -d -s <session> -c <projectPath>` when missing.
- If the tmux pane is currently a shell, send `cd <projectPath>` when needed, then start the selected agent command.
- Multi-line prompts must be sent through tmux buffer/paste, not shell command interpolation.
- After `paste-buffer`, wait briefly before sending `Enter`; agent TUIs can otherwise leave the pasted prompt in the input editor without submitting it.
- User-authored follow-up messages from the app window use the same tmux buffer/paste path as execution prompts.
- TUI navigation keys from the app window use `tmux send-keys` with a fixed `AgentControlKey` whitelist, not text paste.
- When the app message input is empty, arrow keys, Enter, Escape, and Tab can be forwarded to the agent for interactive selectors.
- When the app window is focused and no editable input/select/contenteditable element is active, arrow keys, Enter, Escape, Tab, and Space are forwarded directly to the agent.
- Logs are read with `tmux capture-pane -e -t <session> -p -S -200`; `-e` is required so renderer code can preserve ANSI colors and reverse-video selection highlights from Codex, Claude, and other TUIs.
- The renderer derives approval state only from standalone captured log marker lines: `WAIT_APPROVAL` and `ALL_TASKS_COMPLETED`.
- The prompt may mention marker tokens inline, but must not include those tokens as standalone lines. Otherwise the app can mistake the echoed prompt for Codex output.

### 4. Validation & Error Matrix

| Condition | Expected behavior |
| --- | --- |
| `projectPath` does not exist | Return `success: false` with a clear error. |
| tmux binary is unavailable | Return `success: false`; renderer shows `error`. |
| tmux session is missing during log capture | Return `success: true` with empty log. |
| no unchecked tasks exist | Return `success: true`, `uncheckedCount: 0`, and do not send a prompt. |
| custom agent provider has empty command | Return `success: false` with `Agent command is empty`. |
| approval decision is sent | Send `继续执行` for approve or `取消本步骤并重新规划` for reject. |
| custom agent message is empty | Return `success: false` with `Message is empty`. |
| custom agent message is sent | Paste the message into the existing tmux session and press Enter. |
| control key is unsupported | Return `success: false` with `Unsupported control key`. |
| control key is supported | Send the mapped key with `tmux send-keys -t <session> <key>`. |
| stop requested | Send `C-c` to the tmux session and return the remaining unchecked count. |
| marker token appears inside prompt text or task title | Do not change status unless the marker appears on its own line. |

### 5. Good/Base/Bad Cases

- Good: Select `/repo/task.md`, choose Claude in Settings, create/reuse `repo-claude-agent`, start Claude, paste prompt that asks the agent to output standalone markers, poll logs every second, and let file watching update task state.
- Base: tmux session already exists with the selected provider running; reuse it without restarting.
- Bad: Copy a command to clipboard, activate Terminal.app, run the agent in renderer code, or change providers by typing a command into the agent message box.

### 6. Tests Required

- Typecheck must prove all IPC result payloads match shared types.
- Build must compile renderer, preload, and Electron main process.
- Manual test with installed `tmux` and `codex` should verify:
  - provider selection persists through Settings,
  - session creation/reuse uses provider-specific session names,
  - prompt appears in the tmux pane,
  - log panel updates from `capture-pane -e` and preserves ANSI colors / reverse-video selection state,
  - approval buttons send the expected Chinese response text,
  - app-window message input can send a follow-up question or instruction,
  - app-window empty message input can forward Up/Down/Left/Right/Enter to a TUI selector,
  - app-window global keyboard control forwards selector keys when no text input is focused,
  - standalone `ALL_TASKS_COMPLETED` returns the UI to Idle,
  - `task.md` changes refresh the todo list.

### 7. Wrong vs Correct

#### Wrong

```typescript
// Renderer or main process copies a shell command and asks the user to paste it.
exec(`echo "${command}" | pbcopy`);
```

#### Correct

```typescript
// Main process sends the prompt to a long-lived tmux session.
await runTmux(['set-buffer', prompt]);
await runTmux(['paste-buffer', '-t', binding.tmuxSession]);
await new Promise((resolve) => setTimeout(resolve, 300));
await runTmux(['send-keys', '-t', binding.tmuxSession, 'Enter']);
```
