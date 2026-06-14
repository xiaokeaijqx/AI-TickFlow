import { useTaskStore } from '../store/taskStore';

interface Props {
  onExpand: () => void;
}

export default function CollapsedView({ onExpand }: Props) {
  const store = useTaskStore();
  const remaining = store.tasks.filter((t) => !t.completed).length;

  return (
    <div
      className="tick-glass drag-region flex h-full w-full cursor-pointer items-center justify-center transition-all hover:shadow-[0_18px_38px_rgba(32,38,50,0.14)]"
      onClick={onExpand}
    >
      <div className="no-drag rounded-lg border border-transparent px-4 py-3 text-center transition-colors hover:border-[#DDE1E8] hover:bg-[#EAEAED]">
        <span className="text-3xl font-bold text-tick-text transition-colors">{remaining}</span>
        <p className="text-tick-text-dim text-xs mt-1">remaining</p>
      </div>
    </div>
  );
}
