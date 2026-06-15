import { useState, useRef, useEffect, type MouseEvent, type KeyboardEvent } from 'react';
import type { TaskWithStatus } from '../../shared/types';
import { useTaskStore } from '../store/taskStore';

interface Props {
  task: TaskWithStatus;
  isBatchMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (lineNumber: number) => void;
}

const statusIcon: Record<string, string> = {
  todo: '○',
  running: '⟳',
  done: '✓',
  failed: '⚠',
  paused: '⏸',
  stopped: '⏹',
  queued: '⏳',
};

const statusColor: Record<string, string> = {
  todo: 'text-[#3B414C]',
  running: 'text-[#B7791F]',
  done: 'text-emerald-600',
  failed: 'text-tick-failed',
  paused: 'text-[#A16207]',
  stopped: 'text-red-500',
  queued: 'text-[#A16207]',
};

export default function TaskItem({ task, isBatchMode = false, isSelected = false, onToggleSelect }: Props) {
  const store = useTaskStore();
  const inputRef = useRef<HTMLInputElement>(null);

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(task.title);

  const isRunning = task.status === 'running';
  const isStopped = task.status === 'stopped';
  const isDone = task.status === 'done' || task.completed;
  const isQueued = task.status === 'queued';
  const isPending = task.status === 'todo' && store.isExecuting && store.snapshotTasks.some((t) => t.lineNumber === task.lineNumber);
  const showActiveState = isRunning || isStopped || isQueued;

  const canEdit = task.status === 'todo' && !store.isExecuting;

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Sync edit value when task title changes externally
  useEffect(() => {
    if (!isEditing) {
      setEditValue(task.title);
    }
  }, [task.title, isEditing]);

  const handleToggle = () => {
    if (isRunning || store.isExecuting || isQueued) return;
    store.toggleTask(task.lineNumber);
  };

  const handleExecute = (e: MouseEvent) => {
    e.stopPropagation();
    if (store.isExecuting) return;
    store.executeTask(task);
  };

  const handleDelete = async (e: MouseEvent) => {
    e.stopPropagation();
    if (isRunning) return;
    await store.deleteTask(task.lineNumber);
  };

  const handleCancelQueued = (e: MouseEvent) => {
    e.stopPropagation();
    store.cancelQueuedTask(task.lineNumber);
  };

  const handleCancel = (e: MouseEvent) => {
    e.stopPropagation();
    store.cancelPendingTask(task);
  };

  const handleTitleClick = () => {
    if (!canEdit) return;
    setIsEditing(true);
    setEditValue(task.title);
  };

  const saveEdit = () => {
    const trimmed = editValue.trim();
    setIsEditing(false);
    if (trimmed && trimmed !== task.title) {
      store.editTaskTitle(task.lineNumber, trimmed);
    }
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setEditValue(task.title);
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      saveEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  const rowClassName = isRunning
    ? 'bg-[#FFF8E6]'
    : isStopped
    ? 'bg-red-50'
    : isQueued
    ? 'bg-amber-50/50'
    : isPending
    ? 'bg-[#F5F6F8]'
    : 'bg-white hover:bg-[#EAEAED]';

  return (
    <div
      className={`group flex min-h-7 items-center gap-1.5 rounded-[4px] px-2 py-0.5 transition-colors duration-150 ${rowClassName}`}
    >
      {/* Selection checkbox for todo tasks */}
      {task.status === 'todo' && onToggleSelect && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSelect(task.lineNumber); }}
          className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded text-[14px] transition-colors hover:bg-tick-accent/10"
          aria-label={isSelected ? 'Deselect task' : 'Select task'}
        >
          <span className={isSelected ? 'text-tick-accent' : 'text-tick-muted'}>
            {isSelected ? '☑' : '☐'}
          </span>
        </button>
      )}

      {/* Status icon */}
      <button
        onClick={handleToggle}
        disabled={isRunning || store.isExecuting || isQueued}
        aria-label={isDone ? 'Mark task as todo' : 'Mark task as done'}
        className={`flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded text-[13px] transition-colors ${
          isRunning ? 'animate-spin text-[#B7791F]' : ''
        } ${
          isDone
            ? 'cursor-pointer hover:bg-emerald-500/10'
            : isQueued
            ? ''
            : 'cursor-pointer hover:bg-white/75 hover:text-tick-accent'
        } ${isDone ? 'text-emerald-600' : statusColor[task.status]}`}
      >
        {statusIcon[task.status]}
      </button>

      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleEditKeyDown}
          onBlur={saveEdit}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 bg-transparent text-[13px] font-medium text-[#20242C] outline-none min-w-0 px-0.5 rounded focus:bg-white focus:ring-1 focus:ring-tick-accent/30"
        />
      ) : (
        <span
          onClick={canEdit ? (e) => { e.stopPropagation(); handleTitleClick(); } : undefined}
          className={`flex-1 truncate text-[13px] font-medium leading-5 transition-colors ${
            isDone ? 'line-through text-[#6F7785]' :
            isStopped ? 'line-through text-red-500/60' :
            canEdit ? 'cursor-text text-[#20242C] group-hover:text-[#111827]' :
            'text-[#20242C] group-hover:text-[#111827]'
          } ${isRunning ? 'text-[#B7791F]' : ''}`}
        >
          {task.title}
        </span>
      )}

      <div
        className={`flex w-[48px] flex-shrink-0 items-center justify-end gap-0.5 transition-all duration-150 ${
          showActiveState
            ? 'opacity-100'
            : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
        }`}
      >
          {!isDone && !isRunning && !isPending && !isQueued && !isBatchMode && (
            <button
              onClick={handleExecute}
              disabled={store.isExecuting}
              aria-label="Execute with AI"
              className="grid h-5 w-5 place-items-center rounded bg-tick-action/10 text-[11px] text-tick-action transition-colors hover:bg-tick-action/20 hover:text-tick-action-strong disabled:opacity-40"
              title="Execute with AI"
            >
              ▶
            </button>
          )}

          {isPending && (
            <button
              onClick={handleCancel}
              aria-label="Cancel task from current run"
              className="grid h-5 w-5 place-items-center rounded bg-black/[0.04] text-[11px] text-tick-text-dim transition-colors hover:bg-black/[0.08] hover:text-tick-text"
              title="Cancel (remove from run)"
            >
              ×
            </button>
          )}

          {isQueued && (
            <button
              onClick={handleCancelQueued}
              aria-label="Remove from batch"
              className="grid h-5 w-5 place-items-center rounded bg-amber-500/10 text-[11px] text-amber-600/70 transition-colors hover:bg-amber-500/15 hover:text-amber-700"
              title="Remove from batch (back to todo)"
            >
              ✕
            </button>
          )}

          {!isRunning && !isPending && !isQueued && (
            <button
              onClick={handleDelete}
              aria-label="Delete task"
              className="grid h-5 w-5 place-items-center rounded bg-red-500/10 text-[11px] text-red-500/70 transition-colors hover:bg-red-500/15 hover:text-red-600"
              title="Delete from file"
            >
              ×
            </button>
          )}

          {isRunning && (
            <span className="flex-shrink-0 animate-pulse text-xs font-medium text-tick-running">running</span>
          )}

          {isQueued && (
            <span className="flex-shrink-0 text-xs text-[#A16207]">queued</span>
          )}

          {isStopped && (
            <span className="flex-shrink-0 text-xs text-red-500/60">⏹</span>
          )}
      </div>
    </div>
  );
}
