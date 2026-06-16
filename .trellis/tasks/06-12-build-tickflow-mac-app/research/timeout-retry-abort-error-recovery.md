# Research: Timeout, Retry, Abort, Error Recovery Mechanisms

- **Query**: Search entire codebase for any existing timeout, retry, abort, or error recovery mechanisms
- **Scope**: internal
- **Date**: 2026-06-15

## Summary

**The project has NO timeout, retry, or abort mechanisms on any AI/LLM API calls or network operations.** The architecture does not use HTTP/fetch calls to external services. Instead, AI communication goes through `tmux` CLI commands. There are no timeout guards, no retry logic, no backoff strategies, no circuit breakers, and no AbortController usage anywhere in the application source code. Error handling exists but is limited to try/catch wrapping around synchronous-style `execFile` calls and status propagation.

## Findings

### 1. Timeout Patterns (UI-only, not API)

| File | Line | Pattern | Purpose |
|---|---|---|---|
| `src/components/UndoToast.tsx` | 9 | `setTimeout(() => { store.dismissUndo(); }, 6000)` | Auto-dismiss undo toast after 6 seconds |
| `src/components/UndoToast.tsx` | 12 | `clearTimeout(timer)` | Cleanup on unmount/new undo |
| `src/components/SettingsPanel.tsx` | 59,66,101,125 | `setTimeout(() => setSaved(false), 1500)` | Hide "Saved" indicator after 1.5s |
| `electron/main.ts` | 391 | `setTimeout(resolve, 300)` | 300ms delay between paste-buffer and send-keys (tmux timing) |

**No setTimeout is used for API timeout enforcement.** All instances are UI concerns (auto-dismiss, saved indicator) or a fixed inter-command delay for tmux.

### 2. Promise.race / AbortController

**None found.** A search for `Promise.race`, `AbortController`, and `AbortSignal` across all `.ts` and `.tsx` files returned zero results in application code.

### 3. Retry Logic / Backoff / Circuit Breaker

**None found.** A search for `retry`, `maxRetries`, `backoff`, `exponential`, and `circuit breaker` across all source files returned zero results.

Note: `package-lock.json` references `promise-retry` (v2.0.1) and `retry` (v0.12.0) as transitive dependencies (likely from `npm` or another tool), but these are NOT direct dependencies of the TickFlow project and are not used anywhere in the source code.

The `package.json` itself (`/Users/kiwa/kiwa/AI-TickFlow/package.json`) lists only:
- `chokidar` (file watcher)
- `react` / `react-dom`
- `zustand` (state management)

No retry-related dependencies.

### 4. Polling Intervals

| File | Line | Pattern | Purpose |
|---|---|---|---|
| `electron/main.ts` | 823 | `let watchInterval: NodeJS.Timeout \| null` | File watcher polling |
| `electron/main.ts` | 842-854 | `setInterval(() => { ... }, 500)` | Poll file mtime every 500ms |
| `electron/main.ts` | 827-828 | `clearInterval(watchInterval)` | Clean up previous watcher |
| `electron/main.ts` | 1012 | `clearInterval(watchInterval)` | Cleanup on app quit |
| `src/App.tsx` | 73-77 | `window.setInterval(() => { void store.refreshAgentLog(); }, 1000)` | Poll agent log every 1 second |

The file watcher uses a 500ms polling interval (not `fs.watch`). The agent log is polled every 1 second. Neither interval has error handling for the case where the polling operation itself fails repeatedly — errors inside the interval callbacks are silently caught (empty catch blocks at `electron/main.ts:853` and no catch in `App.tsx:73-74`).

### 5. Error Handling Around AI/LLM Calls

The AI execution path is: **Renderer (store) -> IPC -> Main (tmux execFile)**. There are no HTTP/fetch calls. All AI communication goes through tmux `send-keys` / `paste-buffer` commands.

#### 5a. In `electron/main.ts` (the tmux execution layer)

Every operation follows the same pattern:

```typescript
// Example: pastePrompt (line 388-393)
await runTmux(['set-buffer', prompt]);
await runTmux(['paste-buffer', '-t', sessionName]);
await new Promise((resolve) => setTimeout(resolve, 300));  // fixed delay, not a timeout
await runTmux(['send-keys', '-t', sessionName, 'Enter']);
```

Each public function (`ensureAgentSession`, `executeAgentTasks`, `executeBatchPrompt`, `captureAgentLog`, `sendAgentApproval`, `sendAgentMessage`, `sendAgentKey`, `stopAgent`) wraps its logic in try/catch and returns a result object with `{ success: boolean, error?: string }`.

**Error classes and helpers (lines 270-293):**
- `CommandError` type: `NodeJS.ErrnoException & { stdout?, stderr? }`
- `isCommandError()` type guard (line 275): checks if an error is a `CommandError`
- `getCommandErrorMessage()` (line 283): extracts stderr, stdout, or message from a command error

**`runTmux` function (lines 295-315):**
- Iterates through `TMUX_BIN_CANDIDATES` (`['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', 'tmux']`)
- On `ENOENT` (binary not found), tries the next candidate
- On any other error, throws immediately
- If all candidates fail, throws the last `ENOENT` error
- Uses `maxBuffer: TMUX_MAX_BUFFER` (4 MB) on `execFileAsync` to prevent stdout overflow — this is a Node.js `execFile` option, not a timeout

**`hasTmuxSession` function (lines 369-376):**
- Runs `tmux has-session` and catches any error, returning `false` (treats "no session" as non-error)

#### 5b. In `src/store/taskStore.ts` (the renderer-side orchestration)

Error handling is status-based, not retry-based:

- `ensureAgentSession` (line 259): On failure, sets `agentStatus: 'error'` and `agentError` to the error message
- `refreshAgentLog` (line 441-583): Uses a `refreshAgentLogInFlight` flag (line 155) to prevent concurrent log refreshes. If the log capture fails, sets `agentStatus: 'error'`. Uses try/finally to clear the flag.
- `sendAgentMessage` (line 603): On failure, sets `agentStatus: 'error'`, sets `agentError`. On success, calls `refreshAgentLog()`.
- `sendAgentKey` (line 624): Same pattern — error status + error message.
- `sendApproval` (line 586): Same pattern.
- `executeTask` (line 658-690): On failure, sets `agentStatus: 'error'` and `agentError`. Does NOT retry.
- `sendBatchPrompt` (line 904-925): On failure, sets `agentStatus: 'error'` and `agentError`. Does NOT retry or queue for retry.

#### 5c. Execution Guard Flags (concurrency prevention, not error recovery)

| File | Line | Flag | Purpose |
|---|---|---|---|
| `src/store/taskStore.ts` | 21, 163 | `isExecuting` | Prevent multiple concurrent executions |
| `src/store/taskStore.ts` | 155 | `refreshAgentLogInFlight` | Prevent concurrent log refresh calls |
| `src/components/AgentPanel.tsx` | 106 | `isSending` | Prevent duplicate message sends |
| `src/components/SettingsPanel.tsx` | 25 | `isSavingAgent` | Prevent duplicate agent config saves |

### 6. Stop/Abort Mechanism

| File | Line | Function | What it does |
|---|---|---|---|
| `electron/main.ts` | 744-768 | `stopAgent()` | Sends `C-c` to the tmux session, returns `AgentExecutionResult` with remaining unchecked tasks |
| `src/store/taskStore.ts` | 824-850 | `stopCurrentBatch()` | Calls `electronAPI.stopAgent()`, marks running tasks as `'stopped'`, calls `advanceQueue()` |
| `src/store/taskStore.ts` | 716-722 | `stopCurrentTask()` / `stopRun()` | Both delegate to `stopCurrentBatch()` |
| `src/store/taskStore.ts` | 697-706 | `cancelPendingTask()` | Removes a task from `snapshotTasks` list (pre-execution cancellation, soft) |

The stop mechanism is entirely manual (user clicks "Stop Batch" / "Stop Run" button). There is no automatic timeout-based abort. There is no forceful process kill — it only sends `C-c` and hopes the tmux process responds.

### 7. Batch Completion Fallback (semi-automatic recovery)

In `src/store/taskStore.ts`, `refreshAgentLog()` (lines 441-583), there is a **fallback auto-advance** mechanism for batch execution:

- **Line 472-502**: Detects `BATCH_COMPLETED` marker in agent log. If parsed titles match batch tasks, marks them complete, advances queue.
- **Lines 511-534**: If `BATCH_COMPLETED` seen but no titles matched, and it's NOT the first occurrence (i.e., not the prompt template), trusts the AI and marks all batch tasks complete.
- **Lines 537-557**: If `BATCH_COMPLETED` was not handled but all batch tasks are already completed in file state (e.g., file watcher completed them), auto-advances.

This is an output-parsing recovery mechanism, NOT a timeout/retry mechanism. It handles the case where the AI completes work but the communication protocol fails to match.

### 8. Configuration Files — Timeout Settings

- `.cursor/hooks.json`: timeout values of 30s, 30s, 5s — these are Cursor IDE hooks, not application code
- `.codex/hooks.json`: timeout of 15s — Codex IDE hooks, not application code
- `.claude/settings.json`: timeout values of 30s, 15s — Claude Code harness, not application code
- `.opencode/lib/session-utils.js`: timeout of 5000ms — OpenCode harness, not application code
- `.opencode/lib/trellis-context.js`: timeout of 10000ms — Trellis harness, not application code

These are ALL development tooling configurations, not part of the TickFlow application.

## Architecture Context

The AI execution flow is:
```
Renderer (React/Zustand store)
  → IPC (contextBridge/ipcRenderer.invoke)
    → Main Process (electron/main.ts)
      → execFile('tmux', ['send-keys', '-t', sessionName, ...])
        → tmux sends keystrokes to CLI agent (codex/claude)
          → Agent runs in tmux pane, output captured via capture-pane
            → File watcher polls task file for checkbox changes
```

This architecture means:
- There is NO HTTP request/response cycle to timeout
- AI "calls" are keystrokes into a tmux pane
- AI "responses" are detected by polling the tmux pane output and file changes
- The only "error" is if `execFile` fails (tmux not running, pane doesn't exist, etc.)

## Caveats / Not Found

1. **No timeout on AI execution**: If the AI agent hangs or runs indefinitely, there is no automatic timeout. The user must manually click "Stop".
2. **No retry on tmux failures**: If `execFile` for tmux commands fails (e.g., tmux crashes), the error is propagated to the UI as status 'error' with no automatic retry.
3. **No exponential backoff**: None exists anywhere in the codebase.
4. **No circuit breaker**: None exists. Repeated failures go straight to error state each time.
5. **No fetch/HTTP calls at all**: The app never makes HTTP requests. All communication is file I/O and tmux commands.
6. **The `promise-retry` in package-lock.json is a transitive dep**: It is NOT used by TickFlow source code.
7. **The `chokidar` dependency** is listed in `package.json` but is not actually used in the source code — the file watcher uses manual `setInterval` polling instead (line 842 of `electron/main.ts`).
