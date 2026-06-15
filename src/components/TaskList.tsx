import { useTaskStore } from '../store/taskStore';
import TaskItem from './TaskItem';

export default function TaskList() {
  const store = useTaskStore();

  if (store.tasks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="rounded-md bg-white px-3 py-2 text-sm text-tick-text-dim">
          No tasks yet
        </p>
      </div>
    );
  }

  // Batch queue mode: show batches section + backlog with selection
  if (store.batches.length > 0) {
    const batchTaskLineNumbers = new Set(
      store.batches.flatMap((b) => b.tasks.map((t) => t.lineNumber))
    );
    const backlogTasks = store.tasks.filter(
      (t) => !t.completed && !batchTaskLineNumbers.has(t.lineNumber)
    );
    const completedTasks = store.tasks.filter(
      (t) => t.completed && !batchTaskLineNumbers.has(t.lineNumber)
    );

    return (
      <div className="space-y-1.5">
        {/* Batch queue section */}
        <div>
          <div className="mb-0.5 flex items-center justify-between px-1">
            <p className="text-[10px] font-bold uppercase text-[#5F6876]">Batches</p>
            <span className="text-[10px] font-medium text-[#8B93A1]">{store.batches.length}</span>
          </div>
          <div className="space-y-1">
            {store.batches.map((batch) => (
              <div key={batch.id} className="mb-1 rounded-md border border-[#E3E6EC] bg-white">
                {/* Batch header */}
                <div className="flex items-center justify-between px-2 py-1 border-b border-[#F0F1F4]">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        batch.status === 'running'
                          ? 'bg-amber-500 animate-pulse'
                          : batch.status === 'completed'
                            ? 'bg-emerald-500'
                            : 'bg-gray-400'
                      }`}
                    />
                    <span className="text-[11px] font-semibold text-[#20242C]">
                      Batch #{batch.batchNumber}
                    </span>
                    <span
                      className={`text-[10px] font-medium px-1 rounded ${
                        batch.status === 'running'
                          ? 'bg-amber-100 text-amber-700'
                          : batch.status === 'completed'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {batch.status === 'running' ? 'RUNNING' : batch.status === 'completed' ? 'DONE' : 'QUEUED'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-[#8B93A1]">{batch.tasks.length} tasks</span>
                    {batch.status === 'queued' && (
                      <button
                        onClick={() => store.cancelQueuedBatch(batch.id)}
                        className="text-[11px] text-red-400 hover:text-red-600"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
                {/* Batch tasks */}
                {batch.tasks.map((task) => {
                  const taskWithStatus = store.tasks.find((t) => t.lineNumber === task.lineNumber);
                  if (!taskWithStatus) return null;
                  return (
                    <TaskItem
                      key={task.id}
                      task={taskWithStatus}
                      isBatchMode={true}
                      isSelected={false}
                      onToggleSelect={store.toggleSelection}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Backlog section with selection */}
        {backlogTasks.length > 0 && (
          <div>
            <div className="mb-0.5 flex items-center justify-between px-1">
              <p className="text-[10px] font-bold uppercase text-[#5F6876]">Backlog</p>
              <span className="text-[10px] font-medium text-[#8B93A1]">{backlogTasks.length}</span>
            </div>
            <div className="space-y-0">
              {backlogTasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  isBatchMode={true}
                  isSelected={store.selectedLineNumbers.has(task.lineNumber)}
                  onToggleSelect={store.toggleSelection}
                />
              ))}
            </div>
          </div>
        )}

        {completedTasks.length > 0 && (
          <div>
            <div className="mb-0.5 flex items-center justify-between px-1">
              <p className="text-[10px] font-bold uppercase text-[#5F6876]">Done</p>
              <span className="text-[10px] font-medium text-[#8B93A1]">{completedTasks.length}</span>
            </div>
            <div className="space-y-0">
              {completedTasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  isBatchMode={true}
                  isSelected={false}
                  onToggleSelect={store.toggleSelection}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // During execution (single-task mode): split into Current Run + Backlog
  if (store.isExecuting && store.snapshotTasks.length > 0) {
    const snapshotLineNumbers = new Set(store.snapshotTasks.map((t) => t.lineNumber));
    const runTasks = store.tasks.filter((t) => snapshotLineNumbers.has(t.lineNumber));
    const backlogTasks = store.tasks.filter((t) => !snapshotLineNumbers.has(t.lineNumber) && !t.completed);
    const completedTasks = store.tasks.filter((t) => t.completed && !snapshotLineNumbers.has(t.lineNumber));

    return (
      <div className="space-y-0.5">
        <div>
          <div className="mb-0.5 flex items-center justify-between px-1">
            <p className="text-[10px] font-bold uppercase text-[#5F6876]">Current Run</p>
            <span className="text-[10px] font-medium text-[#8B93A1]">{runTasks.length}</span>
          </div>
          <div className="space-y-0">
            {runTasks.map((task) => (
              <TaskItem key={task.id} task={task} />
            ))}
          </div>
        </div>

        {(backlogTasks.length > 0 || completedTasks.length > 0) && (
          <div>
            <div className="mb-0.5 flex items-center justify-between px-1">
              <p className="text-[10px] font-bold uppercase text-[#5F6876]">Backlog</p>
              <span className="text-[10px] font-medium text-[#8B93A1]">{backlogTasks.length + completedTasks.length}</span>
            </div>
            <div className="space-y-0">
              {backlogTasks.map((task) => (
                <TaskItem key={task.id} task={task} />
              ))}
              {completedTasks.map((task) => (
                <TaskItem key={task.id} task={task} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Normal view: show with checkboxes for selection, incomplete first, then completed
  const incomplete = store.tasks.filter((t) => !t.completed);
  const completed = store.tasks.filter((t) => t.completed);

  return (
    <div className="space-y-0.5">
      {incomplete.length > 0 && (
        <div>
          <div className="mb-0.5 flex items-center justify-between px-1">
            <p className="text-[10px] font-bold uppercase text-[#5F6876]">Backlog</p>
            <span className="text-[10px] font-medium text-[#8B93A1]">{incomplete.length}</span>
          </div>
          <div className="space-y-0">
            {incomplete.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                isSelected={store.selectedLineNumbers.has(task.lineNumber)}
                onToggleSelect={store.toggleSelection}
              />
            ))}
          </div>
        </div>
      )}

      {completed.length > 0 && (
        <div>
          <div className="mb-0.5 flex items-center justify-between px-1">
            <p className="text-[10px] font-bold uppercase text-[#5F6876]">Done</p>
            <span className="text-[10px] font-medium text-[#8B93A1]">{completed.length}</span>
          </div>
          <div className="space-y-0">
            {completed.map((task) => (
              <TaskItem key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
