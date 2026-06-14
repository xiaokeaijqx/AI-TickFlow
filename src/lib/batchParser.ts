export function hasBatchCompleted(log: string): boolean {
  return /BATCH_COMPLETED/.test(log);
}

export function parseBatchCompleted(log: string): string[] {
  const markerIndex = log.lastIndexOf('BATCH_COMPLETED');
  if (markerIndex === -1) return [];

  const afterMarker = log.slice(markerIndex + 'BATCH_COMPLETED'.length);
  const lines = afterMarker.split('\n');
  const titles: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      titles.push(trimmed.slice(2).trim());
    } else if (trimmed === '' || /^\x1b\[/.test(trimmed)) {
      continue; // empty or ANSI-only line
    } else if (titles.length > 0) {
      break; // non-matching content after we started collecting = end of list
    }
  }

  return titles;
}
