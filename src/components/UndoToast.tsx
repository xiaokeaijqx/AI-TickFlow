import { useEffect } from 'react';
import { useTaskStore } from '../store/taskStore';

export default function UndoToast() {
  const store = useTaskStore();

  useEffect(() => {
    if (!store.lastDelete) return;
    const timer = setTimeout(() => {
      store.dismissUndo();
    }, 6000);
    return () => clearTimeout(timer);
  }, [store.lastDelete]);

  if (!store.lastDelete) return null;

  return (
    <div className="fixed bottom-12 left-1/2 z-50 -translate-x-1/2 animate-in">
      <div className="flex items-center gap-3 rounded-md border border-black/10 bg-white px-3 py-2 shadow-lg shadow-black/10">
        <span className="text-tick-text-dim text-xs">Task deleted</span>
        <button
          onClick={() => store.undoDeleteTask()}
          className="rounded px-1 py-0.5 text-xs font-medium text-tick-accent transition-colors hover:bg-tick-accent/10 hover:text-tick-accent-strong"
        >
          Undo
        </button>
        <button
          onClick={() => store.dismissUndo()}
          aria-label="Dismiss undo notification"
          className="grid h-5 w-5 place-items-center rounded text-xs text-tick-text-dim transition-colors hover:bg-black/[0.06] hover:text-tick-accent"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
