# TickFlow

> Floating macOS task widget. Write tasks in Markdown, AI executes them, checkboxes sync automatically.

TickFlow is a minimalist always-on-top window that reads a local `task.md` file, displays tasks as a checklist, and dispatches them to an AI agent (Claude CLI). Tasks are checked off in real-time as the AI works.

## How It Works

1. Click **Choose File** to select a `task.md`
2. TickFlow parses all `- [ ]` checkboxes as tasks
3. Click **Execute** to send tasks to Claude CLI
4. The prompt and tasks are **copied to clipboard** — paste them into your terminal
5. Claude works through tasks and updates `task.md` checkboxes to `[x]`
6. TickFlow watches the file and reflects changes instantly in the UI

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                Electron Main Process                  │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ File Watcher │  │   IPC Layer   │  │ Global     │  │
│  │ (500ms poll) │  │  (invoke +    │  │ Shortcut   │  │
│  │              │  │   on callback)│  │ (Cmd+Shift │  │
│  │              │  │               │  │  +T)       │  │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  │
│         │                 │                 │         │
│  ┌──────┴─────────────────┴─────────────────┴──────┐  │
│  │                  task.md (disk)                   │  │
│  │    - [x] done task                               │  │
│  │    - [ ] pending task                            │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────┬────────────────────────────┘
                          │ IPC (contextBridge)
┌─────────────────────────┴────────────────────────────┐
│                  Renderer (React 18)                  │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  App.tsx  │  │AgentPanel│  │    TaskList.tsx    │  │
│  │ (layout,  │  │(terminal │  │  (checkbox list,   │  │
│  │  resize)  │  │ log view)│  │   batch selection) │  │
│  └─────┬─────┘  └────┬─────┘  └─────────┬─────────┘  │
│        └──────────────┴────────┬────────┘             │
│                                │                      │
│                      ┌─────────┴──────────┐           │
│                      │   taskStore.ts      │           │
│                      │ (useSyncExternal    │           │
│                      │  Store + closure)   │           │
│                      └────────────────────┘           │
└──────────────────────────────────────────────────────┘
```

## AI Execution Model

**Clipboard-based dispatch.** Instead of spawning a background Claude process, TickFlow copies the execution prompt to the clipboard. The user pastes it into their terminal where Claude CLI is already running. This keeps the user in control and avoids macOS permission issues with background processes.

Claude CLI reads `task.md` directly, completes unchecked tasks, and writes `[x]` checkboxes. TickFlow detects file changes via mtime polling and updates the UI.

### Batch Protocol

Tasks are grouped into batches for execution. The prompt includes:

| Marker | Meaning |
|---|---|
| `WAIT_APPROVAL` | AI needs user confirmation before proceeding |
| `BATCH_COMPLETED` | All batch tasks finished; followed by completed task list |

TickFlow parses `BATCH_COMPLETED` output to track which tasks were done and auto-advances to the next batch.

## Features

- **Floating window** — Always on top, frameless, glass-morphism design (320×420, resizable)
- **Markdown sync** — Real-time bidirectional sync between UI checkboxes and `task.md`
- **File watching** — 500ms mtime polling detects external file changes
- **Batch queue** — Select tasks → create batch → execute; queued batches auto-advance
- **6-state task model** — TODO, RUNNING, DONE, FAILED, PAUSED, STOPPED
- **Collapsed mode** — Minimize to a compact widget showing running/remaining count; completion animation when all done
- **Undo delete** — 6-second toast with restore button for deleted tasks
- **Completion notification** — System notification + sound when all tasks are done
- **Keyboard shortcuts** — Customizable global shortcut (default `Cmd+Shift+T`)
- **Settings panel** — Configure file path, shortcut, and agent provider

## Tech Stack

- **Electron 31** — Frameless window with custom title bar
- **React 18** — Rendering with `useSyncExternalStore` (no external state library)
- **TypeScript 5** — Strict mode throughout
- **TailwindCSS 3.4** — Utility-first styling with custom tick color tokens
- **Vite 5** — Renderer bundling; `tsc` for main process

## File Structure

```
src/
├── main.tsx                 # React entry
├── App.tsx                  # Root layout, resize, polling
├── index.css                # Global styles, animations, scrollbar
├── store/
│   └── taskStore.ts         # Central mutable-closure store
├── components/
│   ├── AgentPanel.tsx       # Terminal log viewer + controls
│   ├── TaskList.tsx         # Task list (normal/batch/execution modes)
│   ├── TaskItem.tsx         # Single task row (checkbox, status, actions)
│   ├── CollapsedView.tsx    # Compact minimized widget
│   ├── SettingsPanel.tsx    # Agent config + shortcut setup
│   ├── AddTaskInput.tsx     # Inline "+ Add task" input
│   └── UndoToast.tsx        # Deletion undo notification
└── lib/
    ├── ansi.ts              # ANSI escape code parser
    └── batchParser.ts       # BATCH_COMPLETED marker parser

electron/
├── main.ts                  # Main process: window, IPC, file ops, shortcuts
└── preload.ts               # contextBridge API

shared/
└── types.ts                 # Shared TypeScript interfaces
```

## Development

```bash
npm install
npm run electron:dev    # Dev server + Electron
npm run typecheck       # TypeScript check
npm run electron:build  # Production .app + .dmg
```

**Requirements:** Node.js ≥ 18, macOS

## macOS Packaging

Build outputs `dist/mac-arm64/TickFlow.app` and `.dmg`. The app is unsigned — right-click → Open to bypass Gatekeeper on first launch.
