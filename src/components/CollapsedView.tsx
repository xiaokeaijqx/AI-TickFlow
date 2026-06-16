import { useEffect, useState } from 'react';
import { useTaskStore } from '../store/taskStore';

interface Props {
  onExpand: () => void;
}

export default function CollapsedView({ onExpand }: Props) {
  const store = useTaskStore();
  const running = store.getRunningTasks().length;
  const remaining = store.tasks.filter((t) => !t.completed).length;
  const hasTasks = store.tasks.length > 0;
  const [completeKey, setCompleteKey] = useState(0);

  useEffect(() => {
    if (hasTasks && remaining === 0 && running === 0) {
      setCompleteKey((k) => k + 1);
    }
  }, [remaining, running, hasTasks]);

  const allDone = remaining === 0 && hasTasks;

  return (
    <div
      className="tick-glass drag-region flex h-full w-full cursor-pointer items-center justify-center transition-all hover:shadow-[0_18px_38px_rgba(32,38,50,0.14)]"
      onClick={onExpand}
    >
      <div className="no-drag rounded-lg border border-transparent px-3 py-1.5 text-center transition-colors hover:border-[#DDE1E8] hover:bg-[#EAEAED]">
        {allDone ? (
          <span
            key={completeKey}
            className="inline-block text-3xl font-bold text-tick-accent animate-complete-pop"
          >
            ✓
          </span>
        ) : (
          <>
            <span className="text-3xl font-bold text-tick-text transition-colors">
              {running > 0 ? running : remaining}
            </span>
            <p className="text-tick-text-dim mt-1 text-xs">
              {running > 0 ? 'running' : 'remaining'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
