import { useCallback, useEffect, useRef, useState } from 'react';
import { useTaskStore } from './store/taskStore';
import TaskList from './components/TaskList';
import AddTaskInput from './components/AddTaskInput';
import CollapsedView from './components/CollapsedView';
import SettingsPanel from './components/SettingsPanel';
import UndoToast from './components/UndoToast';
import AgentPanel from './components/AgentPanel';

export default function App() {
  const store = useTaskStore();
  const [fileSelected, setFileSelected] = useState(false);
  const [agentPanelHeight, setAgentPanelHeight] = useState(280);
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isResizingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      startYRef.current = e.clientY;
      startHeightRef.current = agentPanelHeight;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!isResizingRef.current) return;
        const deltaY = startYRef.current - ev.clientY;
        const newHeight = Math.max(80, Math.min(500, startHeightRef.current + deltaY));
        setAgentPanelHeight(newHeight);
      };

      const handleMouseUp = () => {
        isResizingRef.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [agentPanelHeight],
  );

  useEffect(() => {
    async function init() {
      // This window's bound file comes from the main process (per-window),
      // not the global default — that's what lets each window show its own project.
      const boundPath = window.electronAPI.getWindowFilePath();
      if (boundPath) {
        store.setFilePath(boundPath);
        await store.loadAgentConfig();
        const result = await window.electronAPI.readTaskFile(boundPath);
        store.setTasks(result.tasks);
        await store.loadProjectBinding();
        void store.ensureAgentSession();
        await store.restoreBatchRuntime();
        void store.refreshAgentLog();
        setFileSelected(true);
      }
    }
    init();
  }, []);

  useEffect(() => {
    if (!store.filePath) return;
    const unsubscribe = window.electronAPI.onFileChanged((tasks) => {
      store.setTasks(tasks);
    });
    return unsubscribe;
  }, [store.filePath]);

  useEffect(() => {
    if (!fileSelected || !store.filePath) return;

    void store.refreshAgentLog();
    const interval = window.setInterval(() => {
      void store.refreshAgentLog();
    }, 1000);

    return () => window.clearInterval(interval);
  }, [fileSelected, store.filePath]);

  const incompleteTasks = store.tasks.filter((t) => !t.completed);
  const incompleteCount = incompleteTasks.length;
  const completedCount = store.tasks.filter((t) => t.completed).length;
  const hasTasks = store.tasks.length > 0;
  const projectName = (() => {
    if (!store.filePath) return 'TickFlow';
    const parts = store.filePath.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : store.filePath.replace(/\.[^/.]+$/, '');
  })();
  const showBottomBar = store.isExecuting || incompleteCount > 0 || (incompleteCount === 0 && hasTasks);

  const selectedCount = store.selectedLineNumbers.size;
  const runningBatch = store.getRunningBatch();
  const queuedCount = store.getQueuedBatches().length;

  const handleSelectFile = async () => {
    // selectTaskFile rebinds THIS window to the chosen file (main process).
    const filePath = await window.electronAPI.selectTaskFile();
    if (filePath) {
      store.setFilePath(filePath);
      await store.loadAgentConfig();
      const result = await window.electronAPI.readTaskFile(filePath);
      store.setTasks(result.tasks);
      await store.loadProjectBinding();
      void store.ensureAgentSession();
      await store.restoreBatchRuntime();
      void store.refreshAgentLog();
      setFileSelected(true);
    }
  };

  if (!fileSelected) {
    return (
      <div className="tick-glass w-full h-full flex flex-col items-center justify-center gap-5">
        <div className="text-center no-drag">
          <p className="mb-1.5 text-base font-semibold text-tick-text">TickFlow</p>
          <p className="text-tick-text-dim text-xs">Select task.md to get started</p>
        </div>
        <button
          onClick={handleSelectFile}
          className="rounded-lg bg-tick-accent px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-tick-accent/25 transition-all hover:bg-tick-accent-strong hover:shadow-md hover:shadow-tick-accent/25 active:scale-[0.98]"
        >
          Choose File
        </button>
      </div>
    );
  }

  if (store.collapsed) {
    return <CollapsedView onExpand={() => store.setCollapsed(false)} />;
  }

  if (store.showSettings) {
    return (
      <SettingsPanel
        currentPath={store.filePath || ''}
        onClose={() => store.setShowSettings(false)}
      />
    );
  }

  return (
    <div className="tick-glass w-full h-full flex flex-col overflow-hidden">
      <div className="drag-region relative grid h-9 shrink-0 grid-cols-[80px_1fr_92px] items-center border-b border-[#E7E9EE] bg-white/95 px-2">
        <div aria-hidden="true" />
        <div className="pointer-events-none absolute inset-x-[80px] top-0 flex h-9 items-center justify-center">
          <div className="flex max-w-full items-center justify-center gap-1.5 overflow-hidden rounded-md px-1.5 py-0.5">
            <span className="truncate text-[13px] font-semibold leading-5 text-[#20242C]">{projectName}</span>
            <span className="shrink-0 rounded-md border border-[#DDE0E7] bg-[#F6F7F9] px-1.5 py-0.5 text-[10px] font-medium leading-4 text-[#5F6876]">
              {incompleteCount} open
            </span>
          </div>
        </div>
        <div className="col-start-3 flex items-center justify-end gap-0.5 no-drag">
          <button
            onClick={async () => {
              if (isRefreshing) return;
              setIsRefreshing(true);
              await store.refreshTasks();
              setTimeout(() => setIsRefreshing(false), 600);
            }}
            className="grid h-6 w-6 place-items-center rounded-md text-sm leading-none text-[#5F6876] transition-colors hover:bg-[#EAEAED] hover:text-[#20242C]"
            title="Refresh tasks"
            aria-label="Refresh tasks"
          >
            <span className={isRefreshing ? 'animate-spin-once inline-block' : ''}>↻</span>
          </button>
          <button
            onClick={() => store.setShowSettings(true)}
            className="grid h-7 w-7 place-items-center rounded-md text-base leading-none text-[#5F6876] transition-colors hover:bg-[#EAEAED] hover:text-[#20242C]"
            title="Settings"
            aria-label="Open settings"
          >
            ⚙
          </button>
          <button
            onClick={() => store.setCollapsed(true)}
            className="grid h-6 w-6 place-items-center rounded-md text-sm leading-none text-[#5F6876] transition-colors hover:bg-[#EAEAED] hover:text-[#20242C]"
            title="Minimize TickFlow"
            aria-label="Minimize TickFlow"
          >
            <span className="mb-px block h-0.5 w-2.5 rounded-full bg-current" />
          </button>
        </div>
      </div>

      <div className="no-drag shrink-0 px-2.5 pb-1 pt-1.5">
        <AddTaskInput onAdd={(title) => store.addTask(title)} disabled={store.isExecuting} />
      </div>

      {/* Empty selection banner */}
      {store.emptySelectionMessage && (
        <div className="no-drag mx-2.5 mb-1 flex items-center justify-between rounded-md bg-amber-50 border border-amber-200 px-2.5 py-1.5 text-xs text-amber-800">
          {store.emptySelectionMessage}
          <button
            onClick={() => store.clearEmptySelectionMessage()}
            className="ml-2 text-amber-500 hover:text-amber-700"
          >
            ✕
          </button>
        </div>
      )}

      <div
        className="scrollable no-drag flex-1 overflow-y-auto px-2.5 py-0"
        style={{ scrollbarGutter: 'stable' }}
      >
        <TaskList />
      </div>

      <div
        className="no-drag group relative z-10 shrink-0 py-1"
        style={{ cursor: agentPanelCollapsed ? 'default' : 'row-resize' }}
        onMouseDown={agentPanelCollapsed ? undefined : handleResizeStart}
      >
        <div className="h-px bg-transparent transition-colors group-hover:bg-[#C8CED8]" />
      </div>

      <AgentPanel
        height={agentPanelHeight}
        collapsed={agentPanelCollapsed}
        onToggleCollapse={() => setAgentPanelCollapsed(!agentPanelCollapsed)}
      />

      {showBottomBar && (
        <div className="no-drag space-y-1.5 px-2.5 pb-1.5 pt-1">
          {/* Batch execution UI */}
          {store.isExecuting && store.runningBatchId && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-tick-text-dim">
                <span className="font-medium">
                  Batch #{runningBatch?.batchNumber} RUNNING
                </span>
                <span className="text-tick-text-dim">{queuedCount} queued</span>
              </div>
              <button
                onClick={() => store.stopCurrentBatch()}
                className="w-full rounded-md bg-red-500/10 px-3 py-1 text-xs font-medium text-red-600 transition-all hover:bg-red-500/15 hover:text-red-700 active:scale-[0.98]"
              >
                ⏹ Stop Batch
              </button>
            </div>
          )}

          {/* Single-task execution UI (non-batch mode, e.g. executeTask) */}
          {store.isExecuting && !store.runningBatchId && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-tick-text-dim">
                <span>
                  ⟳ {store.snapshotTasks.length > 0
                    ? `${store.currentTaskIndex + 1}/${store.snapshotTasks.length}`
                    : ''}
                </span>
                <button
                  onClick={() => store.stopRun()}
                  className="rounded-md bg-red-500/10 px-3 py-1 text-xs font-medium text-red-600 transition-all hover:bg-red-500/15 hover:text-red-700 active:scale-[0.98]"
                >
                  ⏹ Stop Run
                </button>
              </div>
            </div>
          )}

          {/* Execute button — always visible when there are incomplete tasks */}
          {incompleteCount > 0 && (
            <button
              onClick={() => store.createBatch()}
              disabled={selectedCount === 0}
              className="w-full rounded-md bg-tick-action py-2 text-[14px] font-semibold leading-5 text-white shadow-sm shadow-tick-action/25 transition-colors hover:bg-tick-action-strong active:bg-tick-action-strong disabled:opacity-40"
            >
              {selectedCount > 0
                ? `Execute ${selectedCount} Task${selectedCount !== 1 ? 's' : ''}`
                : 'Select tasks to execute'}
            </button>
          )}

          {/* All tasks done */}
          {!store.isExecuting && incompleteCount === 0 && hasTasks && (
            <div className="text-center py-1 space-y-1">
              <p className="text-tick-accent text-xs font-medium">All tasks done</p>
              {completedCount > 0 && (
                <button
                  onClick={() => store.clearCompletedTasks()}
                  className="rounded-md bg-gray-100 px-3 py-1 text-xs text-gray-600 hover:bg-gray-200"
                >
                  Clear Completed
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <UndoToast />
    </div>
  );
}
