# TickFlow MVP V1 PRD

## Product Name

TickFlow

## Slogan

Markdown Native Task Widget

Write tasks in task.md.
Manage them from a floating desktop widget.

------

# Product Goal

提供一个常驻桌面的悬浮任务窗口。

任务来源于 Markdown 文件task.md

用户无需打开软件管理任务。

只维护：

```markdown
- [ ] Fix login bug
- [ ] Update README
- [ ] Review PR
```

应用自动同步显示。

修改任意一侧。

另一侧实时更新。

------

# MVP Scope

仅实现：

- 打开 task.md
- 解析 Markdown Checkbox
- 悬浮窗显示任务
- 勾选完成
- 自动回写 Markdown
- 文件变更监听
- 收起/展开
- 永远置顶

不实现：

- AI
- Agent
- Claude
- OpenAI
- 登录系统
- 云同步
- 多用户
- 数据库

------

# User Flow

## First Launch

用户启动应用。

显示：

```text
Select task.md
```

选择：

```text
~/Documents/task.md
```

应用记录路径。

后续自动加载。

------

# Markdown Format

支持：

```markdown
# Today

- [ ] Fix login bug
- [ ] Update README
- [ ] Review PR
```

完成状态：

```markdown
- [x] Update README
```

------

# Parsing Rules

识别：

```markdown
- [ ]
- [x]
```

提取：

```ts
interface Task {
  id: string
  title: string
  completed: boolean
  lineNumber: number
}
```

------

# Main Window

尺寸：

```text
320 × 420
```

风格：

- 极简
- 毛玻璃
- 圆角
- 阴影

布局：

```text
╭─────────────────╮
│ Today           │
├─────────────────┤
│ □ Fix login bug │
│ □ Update README │
│ □ Review PR     │
│                 │
╰─────────────────╯
```

------

# Task Item

未完成：

```text
□ Fix login bug
```

完成：

```text
✓ Fix login bug
```

样式：

- 灰色
- 删除线

------

# Checkbox Behavior

点击：

```text
□ Fix login bug
```

变成：

```text
✓ Fix login bug
```

同时更新：

```markdown
- [ ] Fix login bug
```

为：

```markdown
- [x] Fix login bug
```

立即保存。

------

# Reverse Sync

如果用户直接修改：

```markdown
- [ ] Review PR
```

改成：

```markdown
- [x] Review PR
```

应用自动刷新。

无需重启。

------

# File Watcher

监听：

```text
task.md
```

事件：

- modify
- rename
- delete

触发：

```text
重新解析
重新渲染
```

------

# Collapse Mode

点击收起按钮：

```text
╭─────╮
│  3  │
╰─────╯
```

数字表示：

```text
未完成任务数量
```

点击恢复。

------

# Always On Top

窗口始终位于最前层。

支持：

```text
Visible Across All Spaces
```

------

# Empty State

无任务：

```text
No Tasks
```

------

# Completion State

全部完成：

```text
🎉 All Tasks Done
```

播放提示音。

------

# Settings

V1仅包含：

## Task File

显示：

```text
~/Documents/task.md
```

支持重新选择。

------

# Technical Stack

Electron

React

TypeScript

TailwindCSS

Zustand

chokidar

remark

------

# Architecture

task.md
↓
Markdown Parser
↓
Task Store
↓
React UI

Task Toggle
↓
Markdown Writer
↓
task.md

File Watcher
↓
Parser
↓
UI Refresh

------

# Success Metrics

用户可以：

1. 打开 task.md
2. 看到任务列表
3. 点击完成任务
4. 自动更新 Markdown
5. 修改 Markdown 自动刷新 UI

整个过程无需数据库。

无需登录。

无需云服务。

task.md 是唯一数据源。

------

# Future V2

增加：

Execute Button

```text
[ Execute ]
```

执行：

```markdown
- [ ] @claude Review PR
- [ ] @shell Clean Downloads
```

调用 Agent。

完成后自动：

```markdown
- [x] Review PR
```

更新状态。

V2 开始接入 AI。



---

新增：

---



Execute Model

## Design Goal

TickFlow 不是传统 Todo App。

TickFlow 的核心目标是：

让用户把任务写进 task.md，然后交给 AI 执行。

因此 Execute 的本质不是勾选任务。

而是：

```text
Task Backlog
    ↓
Execute
    ↓
Execution Snapshot
    ↓
AI Execution
    ↓
Markdown Update
```

------

# Snapshot Execution

用户点击 Execute 时：

系统立即读取当前 task.md。

提取所有未完成任务：

```markdown
- [ ] 修复登录Bug
- [ ] Review PR
- [ ] 更新README
```

生成执行快照：

```json
{
  "runId":"run_001",
  "tasks":[
    "修复登录Bug",
    "Review PR",
    "更新README"
  ]
}
```

快照创建后立即冻结。

后续执行过程始终基于该快照。

不会因为 task.md 被修改而改变。

------

# Why Snapshot

执行期间：

用户可能继续编辑 task.md。

例如：

```markdown
- [ ] 修复登录Bug
- [ ] Review PR
- [ ] 更新README
- [ ] 修复支付Bug
```

新增任务：

```text
修复支付Bug
```

不会进入：

```text
run_001
```

执行队列。

而是进入：

```text
Backlog
```

等待下一次 Execute。

这样可以避免：

- 执行中任务变化
- 状态冲突
- 回写覆盖
- 中途插队

保证执行过程稳定可预测。

------

# AI Task Ordering

用户无需指定任务顺序。

AI 可以根据上下文自动决定执行顺序。

例如：

```markdown
- [ ] 更新README
- [ ] 修复登录Bug
- [ ] Review PR
```

AI 可能判断：

```text
1. 修复登录Bug
2. Review PR
3. 更新README
```

然后按该顺序执行。

排序仅影响执行顺序。

不会修改 Markdown 原始顺序。

------

# Task States

任务存在四种状态。

## TODO

等待执行：

```markdown
- [ ] 修复登录Bug
```

UI：

```text
□ 修复登录Bug
```

------

## RUNNING

当前执行中：

```text
⟳ 修复登录Bug
```

仅在 UI 中显示。

不会写入 Markdown。

------

## DONE

执行完成：

```markdown
- [x] 修复登录Bug
```

UI：

```text
✓ 修复登录Bug
```

------

## FAILED

执行失败：

UI：

```text
⚠ 修复登录Bug
```

Markdown 保持：

```markdown
- [ ] 修复登录Bug
```

用户可再次执行。

------

# Incremental Execution

TickFlow 支持增量执行。

执行期间新增的任务：

```markdown
- [ ] 优化首页UI
- [ ] 修复支付Bug
```

自动进入：

```text
Pending Backlog
```

不会影响当前运行中的任务。

------

# Execution Queue

界面分为两个区域。

## Current Run

当前执行批次：

```text
⟳ 修复登录Bug

□ Review PR

□ 更新README
```

------

## Backlog

新增待执行任务：

```text
□ 修复支付Bug

□ 优化首页UI
```

------

# Execute Again

当前批次结束后：

显示：

```text
2 New Tasks Available
```

用户点击：

```text
Execute Again
```

系统重新生成快照：

```json
{
  "runId":"run_002",
  "tasks":[
    "修复支付Bug",
    "优化首页UI"
  ]
}
```

开始下一轮执行。

------

# Markdown Update Rule

TickFlow 永远不会重写整个文件。

只修改对应任务状态：

```markdown
- [ ] 修复登录Bug
```

变为：

```markdown
- [x] 修复登录Bug
```

不会：

- 调整顺序
- 删除内容
- 修改标题
- 修改格式

task.md 始终由用户控制。

AI 只更新任务完成状态。

------

# User Mental Model

用户应该把 task.md 理解为：

```text
Agent Backlog
```

而不是：

```text
Traditional Todo List
```

工作流程：

写任务
↓
Execute
↓
AI处理当前快照
↓
继续写新任务
↓
下一次 Execute
↓
处理新增内容



----------------

---

# Task Control Model

## Design Principles

TickFlow 的任务分为两类：

```text
Backlog Task
Running Task
```

两类任务允许的操作不同。

原则：

- 用户永远拥有 task.md 控制权
- AI 执行过程可中断
- TickFlow 不负责回滚 AI 已完成的操作
- 删除与停止是两个不同概念

------

# Task States

```text
TODO
 │
 ▼

RUNNING
 │
 ├──► DONE
 │
 ├──► FAILED
 │
 ├──► PAUSED
 │         │
 │         ▼
 │      RUNNING
 │
 └──► STOPPED
```

------

# Delete Logic

## Backlog Task Delete

适用状态：

```text
TODO
```

例如：

```markdown
- [ ] Update README
```

用户点击：

```text
🗑 Delete
```

行为：

- 从 task.md 删除对应行
- 从 UI 删除对应任务
- 不进入 Snapshot

结果：

```markdown
# 删除该任务行
```

------

## Pending Snapshot Task Cancel

适用状态：

```text
Current Run
但尚未开始执行
```

例如：

```text
✓ Fix Login Bug

□ Review PR

□ Update README
```

此时：

```text
Review PR
```

尚未执行。

用户点击：

```text
🗑 Cancel
```

行为：

- 从当前 Snapshot 移除
- 不再执行
- Markdown 保持不变

结果：

```text
✓ Fix Login Bug

□ Update README
```

说明：

任务仍存在于 task.md。

用户未来仍可再次执行。

------

## Running Task

适用状态：

```text
RUNNING
```

例如：

```text
⟳ Fix Login Bug
```

不允许：

```text
🗑 Delete
```

原因：

AI 可能已经：

- 修改文件
- 创建文件
- 删除文件
- 提交代码

删除无法定义回滚行为。

因此禁止删除运行中的任务。

------

# Pause Logic

## Pause

适用状态：

```text
RUNNING
```

用户点击：

```text
⏸ Pause
```

行为：

- 向 Agent 发送暂停请求
- 停止后续任务调度
- 当前任务状态变为：

```text
PAUSED
```

UI：

```text
⏸ Fix Login Bug
```

------

## Resume

适用状态：

```text
PAUSED
```

用户点击：

```text
▶ Resume
```

行为：

- 恢复当前 Snapshot
- 从暂停位置继续执行

状态：

```text
PAUSED
↓
RUNNING
```

------

# Stop Logic

## Stop Current Task

适用状态：

```text
RUNNING
PAUSED
```

用户点击：

```text
⏹ Stop
```

行为：

- 终止当前 Agent
- 不再继续执行该任务
- 状态更新为：

```text
STOPPED
```

------

结果：

```text
⏹ Fix Login Bug
```

------

重要说明：

Stop 仅停止执行。

不会：

- 回滚文件修改
- 恢复代码状态
- 撤销已完成操作

------

# Batch Stop

如果当前存在：

```text
Current Run

⟳ Fix Login Bug

□ Review PR

□ Update README
```

点击：

```text
Stop Run
```

行为：

- 停止当前任务
- 取消剩余任务执行
- 当前 Snapshot 结束

结果：

```text
⏹ Fix Login Bug

⏹ Review PR

⏹ Update README
```

------

# Markdown Update Rules

## Delete

删除 Backlog 任务：

```markdown
- [ ] Update README
```

直接删除对应行。

------

## Pause

Pause 不修改 Markdown。

仅修改运行时状态。

------

## Resume

Resume 不修改 Markdown。

------

## Stop

Stop 不修改 Markdown。

任务仍保持：

```markdown
- [ ] Fix Login Bug
```

用户后续可再次执行。

------

## Done

执行成功：

```markdown
- [ ] Fix Login Bug
```

更新为：

```markdown
- [x] Fix Login Bug
```

------

# UI Specification

## Backlog

```text
□ Fix Login Bug       ▶  🗑
□ Review PR           ▶  🗑
```

允许：

- Execute
- Delete

------

## Running

```text
⟳ Fix Login Bug

⏸ Pause
⏹ Stop
```

允许：

- Pause
- Stop

禁止：

- Delete

------

## Paused

```text
⏸ Fix Login Bug

▶ Resume
⏹ Stop
```

允许：

- Resume
- Stop

------

# Product Rule

```text
Backlog Task
    可删除

Pending Snapshot Task
    可取消

Running Task
    不可删除
    仅支持 Pause / Stop

TickFlow 不负责回滚 AI 已执行操作
```

这是整个任务控制模型的核心规则。

形成持续循环。