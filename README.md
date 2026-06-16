# TickFlow

> **Your AI agents. One floating command deck.**
> Write tasks in Markdown. Watch AI knock them out. Checkboxes tick themselves.

TickFlow is a always-on-top macOS widget that turns a plain `task.md` into a live mission control for your AI coding agents. Drop in your tasks, hit execute, and TickFlow drives **Claude, Codex, or any CLI agent** through them inside a real terminal session — checking off boxes in real time while you do literally anything else.

No copy-paste. No babysitting. No context-switching. Just a tiny glass panel hovering over your work, quietly getting things done.

---

## ✨ Why TickFlow

**It runs your agents for you — for real.**
TickFlow spins up a live `tmux` session, launches your agent, pastes the prompt, and streams the terminal back into a built-in log viewer. You watch progress; you don't drive it.

**One project per window. Run them all at once.**
Ship feature A with Claude in one window while Codex grinds through refactors in another — each window bound to its own `task.md`, its own agent, its own permissions. Open a new project with **⌘N** and let them race.

**Markdown is the source of truth.**
Your tasks live in a file you own. TickFlow watches it (500 ms polling, editor-proof), and edits flow both ways — tick a box in the UI or in your editor, and the other side updates instantly.

**Queue it and walk away.**
Batch your tasks, queue the batches, and TickFlow auto-advances through them — pinging you with a sound the moment **each queue** finishes. Come back to a stack of done work, not a stalled prompt.

**It never silently dies on you.**
A per-agent stall watchdog notices when an agent goes quiet and nudges you — without ever killing the session behind your back.

---

## 🚀 How It Works

1. **Pick a `task.md`** — or open several, one per window
2. TickFlow parses every `- [ ]` line into a live checklist
3. **Select tasks → Execute** — they're batched and dispatched to your agent
4. TickFlow launches the agent in a `tmux` session and **pastes the prompt automatically**
5. The agent works, reports `DONE N` per task, and TickFlow ticks the boxes
6. 🔔 Sound + notification fire **as each queue completes** — queue them up and forget about it

The agent reports progress through lightweight markers — no fragile screen-scraping:

| Marker | Meaning |
|---|---|
| `DONE N` | Task N in the current batch is finished → TickFlow checks it off |
| `WAIT_APPROVAL` | Agent needs your go-ahead → you get a notification + approve/reject |
| `ALL_TASKS_COMPLETED` | Everything's done |

A per-batch sentinel anchors marker parsing so it stays correct even as the terminal scrollback slides — battle-tested against offset drift.

---

## 🎛 Features

- **🪟 Multi-window projects** — one window per `task.md`, each with its own agent + config; open new ones with **⌘N** or from Settings
- **🤖 Bring your own agent** — **Claude**, **Codex**, or any **custom command**, configurable *per project*
- **🔓 Per-project permissions** — flip on Claude's `--dangerously-skip-permissions` for unattended batch runs, window by window
- **🛰 Live terminal panel** — full agent log streamed into the widget, with optional key-control passthrough
- **📋 Batch queue** — select → batch → queue; batches auto-advance with **per-queue completion alerts**
- **🔁 Bidirectional Markdown sync** — UI ↔ `task.md`, both directions, in real time
- **👀 Editor-proof file watching** — 500 ms mtime polling, reliable where `fs.watch` isn't
- **🧭 7-state task model** — TODO · RUNNING · DONE · FAILED · PAUSED · STOPPED · QUEUED
- **🐶 Stall watchdog** — per-agent idle detection that warns instead of killing
- **🪄 Collapsed mode** — shrink to a 136×86 pill showing live progress, with a completion flourish
- **↩️ Undo delete** — 6-second restore toast for any deleted task
- **🔔 Custom alerts** — pick any macOS system sound for completion + approval
- **⌨️ Global hotkey** — summon/dismiss every window at once (default **⌘⇧T**)
- **♻️ One-click restarts** — restart the agent (after switching models/configs) or the whole app from Settings

---

## 🏗 Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Electron Main Process                       │
│                                                                │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐  │
│   │ Window        │   │ Per-file      │   │ Per-session      │  │
│   │ Registry      │   │ Watchers      │   │ Stall Watchdogs  │  │
│   │ (1 per proj)  │   │ (500ms poll)  │   │ (idle detection) │  │
│   └──────┬───────┘   └──────┬───────┘   └────────┬─────────┘  │
│          │                  │                     │            │
│   ┌──────┴──────────────────┴─────────────────────┴────────┐  │
│   │            tmux agent sessions (per project)            │  │
│   │      claude / codex / custom  ←  paste prompt  →  log   │  │
│   └─────────────────────────────────────────────────────────┘  │
│                            │                                    │
│                  task.md files (disk, source of truth)         │
└─────────────────────────────┬──────────────────────────────────┘
                              │ IPC (contextBridge, per-window)
┌─────────────────────────────┴──────────────────────────────────┐
│                       Renderer (React 18)                       │
│   App.tsx · TaskList · AgentPanel · SettingsPanel · taskStore   │
│       each window = its own process, store, and bound file      │
└──────────────────────────────────────────────────────────────┘
```

Every window is its own renderer process bound to one file via a synchronous startup handshake — so two projects never step on each other's state, agents, or watchers.

---

## 🧰 Tech Stack

- **Electron 31** — frameless, transparent, always-on-top glass window
- **React 18** — `useSyncExternalStore` over a mutable-closure store (zero state-lib bloat)
- **TypeScript 5** — strict mode, end to end
- **TailwindCSS 3.4** — utility-first with custom `tick` design tokens
- **tmux** — real terminal sessions for genuine agent execution
- **Vite 5** — renderer bundling; `tsc` for the main process

---

## 📁 Project Structure

```
src/
├── main.tsx                 # React entry
├── App.tsx                  # Root layout, resize, per-window init
├── index.css                # Global styles, animations, scrollbar
├── store/
│   └── taskStore.ts         # Central mutable-closure store
├── components/
│   ├── AgentPanel.tsx       # Live terminal log viewer + controls
│   ├── TaskList.tsx         # Task list (normal / batch / execution modes)
│   ├── TaskItem.tsx         # Single task row (checkbox, status, actions)
│   ├── CollapsedView.tsx    # Compact minimized widget
│   ├── SettingsPanel.tsx    # Project / Agent / General / App settings
│   ├── AddTaskInput.tsx     # Inline "+ Add task" input
│   └── UndoToast.tsx        # Deletion undo notification
└── lib/
    ├── ansi.ts              # ANSI escape code parser
    └── batchParser.ts       # DONE / approval marker parser

electron/
├── main.ts                  # Windows, IPC, tmux agents, watchers, watchdogs
└── preload.ts               # contextBridge API (per-window)

shared/
└── types.ts                 # Shared TypeScript interfaces
```

---

## 🛠 Development

```bash
npm install
npm run electron:dev     # Vite dev server + Electron
npm run typecheck        # TypeScript check (renderer)
npm run electron:build   # Production .app + .dmg
```

**Requirements:** macOS · Node.js ≥ 18 · `tmux` · your agent CLI (`claude` / `codex` / …) on `PATH`

---

## 📦 macOS Packaging

Builds `dist/mac-arm64/TickFlow.app` and a `.dmg`. The app is unsigned — **right-click → Open** to clear Gatekeeper on first launch.

---

<p align="center"><em>Stop pasting prompts. Start shipping queues.</em></p>
```
