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
 * Fallback: if the sentinel is not found (it scrolled off the top of the 2000-
 * line window) or is null, we collect ALL `DONE N` markers in the capture. The
 * caller's `completedTaskIndices` dedup set is the safety net against
 * re-claiming a marker — so falling back to "claim all" never double-applies.
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

  // Re-locate the sentinel each call; -1 (not found) or null => no lower bound.
  let fromIndex = -1;
  if (sentinel) {
    const sentinelPos = cleanLog.lastIndexOf(sentinel);
    if (sentinelPos !== -1) {
      fromIndex = sentinelPos + sentinel.length;
    }
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
