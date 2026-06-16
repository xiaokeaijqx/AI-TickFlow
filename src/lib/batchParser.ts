/**
 * Normalize a title for fuzzy comparison:
 * - lowercase
 * - trim whitespace
 * - strip trailing punctuation (. ! ?)
 * - collapse multiple spaces
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ');
}

/** Prefix the AI outputs to signal a task is completed. */
export const TASK_COMPLETED_PATTERN = 'DONE ';

/** Matches "DONE N" on its own line, tolerating leading whitespace/indent. */
const TASK_COMPLETED_REGEX = /^[ \t]*DONE (\d+)[ \t]*$/gm;

/**
 * Parse completed task indices from "DONE N" markers.
 * Returns 0-based array indices, deduplicated.
 *
 * Anchoring: the agent log is captured with `tmux capture-pane -S -2000`, a
 * SLIDING WINDOW of the last 2000 lines. As the agent emits more output, old
 * lines scroll off the top, so the ABSOLUTE character offset of any text
 * decreases over time — a numeric baseline is NOT a stable anchor. Instead we
 * anchor on a unique per-batch `sentinel` string embedded at the top of the
 * batch prompt. We RE-LOCATE it on every poll via `lastIndexOf`, then only
 * collect `DONE N` markers that appear AFTER the sentinel's end. Because the
 * position is recomputed from the current capture every time, it is immune to
 * offset drift.
 *
 * Three-way behavior depending on `sentinel`:
 *   1. `sentinel === null` — caller intentionally wants no anchoring: collect
 *      ALL `DONE N` markers (fromIndex = -1). The caller's
 *      `completedTaskIndices` dedup set is the safety net against re-claiming.
 *   2. `sentinel` is a non-null string but NOT found in the capture (it scrolled
 *      off the top of the 2000-line window on a long batch): claim NOTHING and
 *      return immediately. We must NOT fall through to "claim all" here, because
 *      the capture still contains stale `DONE N` markers from PREVIOUS batches,
 *      and `completedTaskIndices` is reset per batch — so those stale markers
 *      would be mapped onto the current batch's task list and mark the WRONG
 *      tasks done (silent corruption, can even falsely auto-advance). A missed
 *      claim is recoverable: the task stays unchecked and a later poll (with the
 *      sentinel back in-window) will claim it. Claiming the wrong task is not.
 *   3. `sentinel` found — anchor as usual: only markers after the sentinel's end.
 *
 * Strips ANSI escape codes first because terminal capture (tmux capture-pane -e)
 * includes color codes, and TUIs like Claude Code render output with leading
 * indentation — both would break a naive /^DONE \d+$/ match.
 */
export function parseTaskCompletedIndices(
  log: string,
  sentinel: string | null
): { indices: number[]; lastMatchIndex: number } {
  const cleanLog = log.replace(/\x1b\[[0-9;:]*m/g, '');

  // Re-locate the sentinel each call.
  // - null sentinel => no lower bound (claim all).
  // - non-null but not found => claim nothing (avoid claiming stale markers).
  // - found => anchor after the sentinel's end.
  let fromIndex = -1;
  if (sentinel !== null) {
    const sentinelPos = cleanLog.lastIndexOf(sentinel);
    if (sentinelPos === -1) {
      console.warn(
        `parseTaskCompletedIndices: sentinel "${sentinel}" not found in capture ` +
          '(likely scrolled out of the tmux window); claiming no markers this poll.'
      );
      return { indices: [], lastMatchIndex: -1 };
    }
    fromIndex = sentinelPos + sentinel.length;
  }

  const indices: number[] = [];
  let lastMatchIndex = 0;

  const regex = new RegExp(TASK_COMPLETED_REGEX.source, 'gm');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleanLog)) !== null) {
    if (match.index <= fromIndex) continue;

    const num = parseInt(match[1], 10);
    if (num > 0) {
      indices.push(num - 1); // Convert 1-based (prompt) to 0-based (array)
    }
    lastMatchIndex = match.index;
  }

  return {
    indices: [...new Set(indices)],
    lastMatchIndex,
  };
}
