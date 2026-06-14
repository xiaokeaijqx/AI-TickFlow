# Build AI Todo Agent Mac App

## Goal

Build a macOS floating Todo application that binds one project to one `task.md` file and drives a long-lived Codex CLI agent through `tmux`.

The user adds todos in the app. The app writes them to the project's `task.md`. When the user clicks Execute, the app sends a prompt into the project's tmux session where Codex CLI is running. Codex reads `task.md`, completes unchecked tasks, updates each task to `- [x]`, and streams logs back through tmux capture. The app watches `task.md`, syncs state automatically, and notifies the user when all tasks are complete.

## Core Architecture

Do not control Terminal.app directly.

Use:

```text
App
  -> tmux Session
    -> Codex CLI
```

Reasons:

- tmux keeps the Codex session alive.
- The app can send messages to Codex without stealing focus.
- The app can read recent output with `tmux capture-pane`.
- The workflow does not depend on a visible Terminal window.

## Project Model

```json
{
  "projectName": "demo",
  "projectPath": "/Users/xxx/workspace/demo",
  "taskFile": "/Users/xxx/workspace/demo/task.md",
  "tmuxSession": "demo-agent"
}
```

For the MVP, project binding can be derived from the selected `task.md`:

- `projectPath` = directory containing `task.md`
- `projectName` = directory basename
- `tmuxSession` = sanitized `<projectName>-agent`

## task.md Format

```md
# Tasks

- [ ] Refactor LoginService

- [ ] Fix user login bug

- [x] Completed task
```

Only unchecked lines matching `- [ ]` are executable tasks.

## Agent Startup

On first project startup:

```bash
tmux new-session -d -s demo-agent
tmux send-keys -t demo-agent "cd /Users/xxx/workspace/demo" Enter
tmux send-keys -t demo-agent "codex" Enter
```

The session is long-lived. If the session already exists, reuse it.

## Execute Tasks

When the user clicks Execute:

1. Read `task.md`.
2. Extract all unchecked `- [ ]` tasks.
3. Generate the execution prompt.
4. Send the prompt to Codex in tmux:

```bash
tmux send-keys -t demo-agent "<PROMPT>" Enter
```

## Prompt Template

```text
读取当前项目中的 task.md。

执行所有未完成任务（即所有 "- [ ]" 项）。

要求：

1. 按顺序执行
2. 每完成一个任务立即更新 task.md
3. 将对应任务改为 "- [x]"
4. 输出详细执行日志
5. 如果需要用户确认，请先输出单独一行 WAIT_APPROVAL，然后输出确认内容
6. 所有任务完成后，请输出单独一行 ALL_TASKS_COMPLETED
```

## Log Collection

Poll recent tmux output every second:

```bash
tmux capture-pane -t demo-agent -p -S -200
```

The app displays the captured output in a real-time log area.

## Agent Status

The UI shows one of:

- Idle
- Running
- Waiting Approval
- Error

Rules:

- Running after the app sends an execution prompt.
- Waiting Approval when logs contain a standalone `WAIT_APPROVAL` line.
- Idle when logs contain a standalone `ALL_TASKS_COMPLETED` line, no unchecked tasks remain, or no run is active.
- Error when tmux/codex startup or command execution fails.

## Approval

When logs contain:

```text
WAIT_APPROVAL
```

The app enters Waiting Approval and shows approve/reject controls.

Approve sends:

```bash
tmux send-keys -t demo-agent "继续执行" Enter
```

Reject sends:

```bash
tmux send-keys -t demo-agent "取消本步骤并重新规划" Enter
```

After either action, the status returns to Running.

## task.md Sync

The app watches `task.md`.

When Codex changes:

```md
- [ ] Refactor LoginService
```

to:

```md
- [x] Refactor LoginService
```

the app refreshes automatically.

## Completion

When unchecked `- [ ]` task count becomes zero:

- Show a system notification.
- Play a sound.
- Display "All tasks completed" in the app.

## MVP Requirements

- [x] Floating macOS window.
- [x] Bind/select a `task.md`.
- [x] Parse and display markdown checkbox tasks.
- [x] Add todo in app and append to `task.md`.
- [x] Watch `task.md` and sync external changes.
- [x] Derive project model from selected `task.md`.
- [x] Create/reuse a project tmux session.
- [x] Start Codex CLI inside the tmux session.
- [x] Execute all unchecked tasks by sending the prompt to tmux.
- [x] Display recent tmux/Codex logs and refresh them every second.
- [x] Detect `WAIT_APPROVAL` and expose Approve/Reject controls.
- [x] Send approval/rejection responses into tmux.
- [x] Detect `ALL_TASKS_COMPLETED` and return to Idle.
- [x] Notify and play a sound when all tasks complete.

## Out of Scope

- Multi-agent routing.
- Cloud sync.
- Database persistence.
- Workflow orchestration.
- MCP integration.
- Direct control of Terminal.app.
