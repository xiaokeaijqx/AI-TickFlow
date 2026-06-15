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

/** Matches "DONE N" on its own line. */
const TASK_COMPLETED_REGEX = /^DONE (\d+)$/gm;

/**
 * Parse completed task indices from "DONE N" markers.
 * Returns 0-based array indices, deduplicated.
 * Only processes markers at positions > fromIndex (to skip prompt template text).
 */
export function parseTaskCompletedIndices(
  log: string,
  fromIndex: number
): { indices: number[]; lastMatchIndex: number } {
  const indices: number[] = [];
  let lastMatchIndex = fromIndex;

  const regex = new RegExp(TASK_COMPLETED_REGEX.source, 'gm');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(log)) !== null) {
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
