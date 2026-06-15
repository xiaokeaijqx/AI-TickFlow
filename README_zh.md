# TickFlow

> macOS 桌面悬浮任务管理工具。用 Markdown 写任务，AI 执行，checkbox 自动同步。

TickFlow 是一个极简的始终置顶悬浮窗，读取本地 `task.md` 文件，将 checkbox 渲染为任务清单，并投递给 AI（Claude CLI）执行。AI 工作时 checkbox 实时同步更新。

## 工作流程

1. 点击 **Choose File** 选择一个 `task.md` 文件
2. TickFlow 将所有 `- [ ]` checkbox 解析为待办任务
3. 点击 **Execute** 将任务投递给 Claude CLI
4. 执行指令和任务列表被**复制到剪贴板** — 粘贴到终端即可
5. Claude 逐个完成任务并更新 `task.md` 中的 checkbox 为 `[x]`
6. TickFlow 监听文件变化并即时刷新界面

## 架构

```
┌──────────────────────────────────────────────────────┐
│                  Electron 主进程                       │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │  文件监听     │  │   IPC 通信层  │  │  全局快捷键  │  │
│  │ (500ms轮询)  │  │  (invoke +   │  │ (Cmd+Shift │  │
│  │              │  │   on 回调)    │  │  +T)       │  │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  │
│         │                 │                 │         │
│  ┌──────┴─────────────────┴─────────────────┴──────┐  │
│  │                  task.md（磁盘）                   │  │
│  │    - [x] 已完成任务                               │  │
│  │    - [ ] 待办任务                                 │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────┬────────────────────────────┘
                          │ IPC (contextBridge)
┌─────────────────────────┴────────────────────────────┐
│                    渲染进程 (React 18)                  │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │  App.tsx  │  │AgentPanel│  │    TaskList.tsx    │  │
│  │ (布局,     │  │(终端日志  │  │  (checkbox 列表,   │  │
│  │  窗口缩放) │  │ 查看器)   │  │   批次选择)        │  │
│  └─────┬─────┘  └────┬─────┘  └─────────┬─────────┘  │
│        └──────────────┴────────┬────────┘             │
│                                │                      │
│                      ┌─────────┴──────────┐           │
│                      │   taskStore.ts      │           │
│                      │ (useSyncExternal    │           │
│                      │  Store + 闭包模式)   │           │
│                      └────────────────────┘           │
└──────────────────────────────────────────────────────┘
```

## AI 执行模型

**剪贴板投送模式。** TickFlow 不会后台启动 Claude 进程，而是将执行指令复制到系统剪贴板。用户手动粘贴到已运行 Claude CLI 的终端中。这样既能保持用户掌控感，也避免了 macOS 对后台进程的权限限制。

Claude CLI 直接读取 `task.md`、完成未勾选任务并写入 `[x]`。TickFlow 通过 mtime 轮询检测文件变化并刷新 UI。

### 批次协议

任务被分组为批次执行。提示词中包含：

| 标记 | 含义 |
|---|---|
| `WAIT_APPROVAL` | AI 需要用户确认才能继续 |
| `BATCH_COMPLETED` | 当前批次全部完成；后跟已完成任务列表 |

TickFlow 解析 `BATCH_COMPLETED` 输出来跟踪任务完成情况，并自动推进到下一批次。

## 功能

- **悬浮窗口** — 始终置顶，无边框，毛玻璃质感（320×420，可拖拽缩放）
- **Markdown 双向同步** — UI checkbox 与 `task.md` 实时互相同步
- **文件监听** — 500ms mtime 轮询，检测外部文件变更
- **批次队列** — 选择任务 → 创建批次 → 执行；排队的批次自动推进
- **六状态任务模型** — 待办、执行中、已完成、失败、暂停、停止
- **收起模式** — 最小化为紧凑小组件，显示运行中/剩余任务数；全部完成时有弹跳动效
- **撤销删除** — 6 秒 Toast 提示，一键恢复误删任务
- **完成通知** — 全部任务完成时发出系统通知 + 铃声
- **快捷键** — 可自定义的全局快捷键（默认 `Cmd+Shift+T`）
- **设置面板** — 配置文件路径、快捷键、AI agent 类型

## 技术栈

- **Electron 31** — 无边框窗口 + 自定义标题栏
- **React 18** — `useSyncExternalStore` 驱动渲染（无外部状态库）
- **TypeScript 5** — 严格模式
- **TailwindCSS 3.4** — 原子化 CSS + 自定义 tick 色板
- **Vite 5** — 渲染进程打包；主进程用 `tsc` 编译

## 文件结构

```
src/
├── main.tsx                 # React 入口
├── App.tsx                  # 根布局、窗口缩放、轮询逻辑
├── index.css                # 全局样式、动画、滚动条
├── store/
│   └── taskStore.ts         # 中央闭包 Store
├── components/
│   ├── AgentPanel.tsx       # 终端日志查看器 + 控制按钮
│   ├── TaskList.tsx         # 任务列表（普通/批次/执行三种模式）
│   ├── TaskItem.tsx         # 单条任务行（checkbox、状态、操作按钮）
│   ├── CollapsedView.tsx    # 紧凑的收起小组件
│   ├── SettingsPanel.tsx    # agent 配置 + 快捷键设置
│   ├── AddTaskInput.tsx     # 行内 "+ 新建任务" 输入框
│   └── UndoToast.tsx        # 删除撤销通知
└── lib/
    ├── ansi.ts              # ANSI 转义码解析器
    └── batchParser.ts       # BATCH_COMPLETED 标记解析器

electron/
├── main.ts                  # 主进程：窗口管理、IPC、文件操作、快捷键
└── preload.ts               # contextBridge API

shared/
└── types.ts                 # 共享 TypeScript 类型定义
```

## 开发

```bash
npm install              # 安装依赖
npm run electron:dev     # 启动开发服务器 + Electron
npm run typecheck        # TypeScript 类型检查
npm run electron:build   # 构建生产包 .app + .dmg
```

**环境要求：** Node.js ≥ 18，macOS

## macOS 打包

构建输出 `dist/mac-arm64/TickFlow.app` 和 `.dmg`。App 未签名 — 首次启动需右键 → 打开以绕过 Gatekeeper。
