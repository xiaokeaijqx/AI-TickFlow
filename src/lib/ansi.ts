import type { CSSProperties } from 'react';

export interface AnsiSegment {
  text: string;
  style: CSSProperties;
}

type AnsiState = {
  foreground?: string;
  background?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
};

const DEFAULT_FOREGROUND = '#E9EDF5';
const DEFAULT_BACKGROUND = '#101114';
const DEFAULT_INVERSE_BACKGROUND = '#EAEAED';
const SGR_PATTERN = /\x1b\[([0-9;:]*)m/g;
const SGR_STRIP_PATTERN = /\x1b\[[0-9;:]*m/g;

const ANSI_16_COLORS = [
  '#101114', // Black
  '#EF596F', // Red
  '#7CCF83', // Green
  '#E5C07B', // Yellow
  '#61AFEF', // Blue
  '#C678DD', // Magenta
  '#56B6C2', // Cyan
  '#E9EDF5', // White
] as const;

const ANSI_BRIGHT_COLORS = [
  '#7B8493', // Bright Black (Gray)
  '#FF7B86', // Bright Red
  '#9FEFB3', // Bright Green
  '#F4D98B', // Bright Yellow
  '#82CFFF', // Bright Blue
  '#D7A3FF', // Bright Magenta
  '#7EE7F2', // Bright Cyan
  '#FFFFFF', // Bright White
] as const;

const SEMANTIC_TOKEN_PATTERN =
  /(Bash\([^)]+\)|\/Users\/[^\s)]+|\bVite\b|\bElectron\b|\bDone\b|\btouch\b|\bHMR\b|\bCmd\+R\b|\bWAIT_APPROVAL\b|\bALL_TASKS_COMPLETED\b)/g;

function isPlainState(state: AnsiState): boolean {
  return (
    state.foreground === undefined &&
    state.background === undefined &&
    !state.bold &&
    !state.dim &&
    !state.italic &&
    !state.underline &&
    !state.inverse
  );
}

function getSemanticStyle(token: string): CSSProperties | undefined {
  if (token === 'Vite' || token === 'Done' || token === 'ALL_TASKS_COMPLETED') {
    return { color: '#7CCF83', fontWeight: 600 };
  }

  if (token === 'Electron' || token === 'HMR') {
    return { color: '#61AFEF', fontWeight: 600 };
  }

  if (token.startsWith('Bash(') || token.startsWith('/Users/')) {
    return { color: '#C678DD' };
  }

  if (token === 'touch' || token === 'Cmd+R') {
    return { color: '#E5C07B' };
  }

  if (token === 'WAIT_APPROVAL') {
    return { color: '#F4D98B', fontWeight: 700 };
  }

  if (/^DONE \d+$/.test(token)) {
    return { color: '#7CCF83', fontWeight: 700 };
  }

  return undefined;
}

function pushTextSegments(segments: AnsiSegment[], text: string, state: AnsiState): void {
  const baseStyle = toStyle(state);
  if (!isPlainState(state)) {
    segments.push({ text, style: baseStyle });
    return;
  }

  let lastIndex = 0;
  SEMANTIC_TOKEN_PATTERN.lastIndex = 0;
  let match = SEMANTIC_TOKEN_PATTERN.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), style: baseStyle });
    }

    const token = match[0];
    segments.push({
      text: token,
      style: getSemanticStyle(token) ?? baseStyle,
    });

    lastIndex = match.index + token.length;
    match = SEMANTIC_TOKEN_PATTERN.exec(text);
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), style: baseStyle });
  }
}

function createInitialState(): AnsiState {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function resetState(state: AnsiState): void {
  state.foreground = undefined;
  state.background = undefined;
  state.bold = false;
  state.dim = false;
  state.italic = false;
  state.underline = false;
  state.inverse = false;
}

function getAnsi256Color(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    return undefined;
  }

  if (index < 16) {
    return index < 8 ? ANSI_16_COLORS[index] : ANSI_BRIGHT_COLORS[index - 8];
  }

  if (index >= 232) {
    const channel = 8 + (index - 232) * 10;
    return `rgb(${channel}, ${channel}, ${channel})`;
  }

  const colorIndex = index - 16;
  const red = Math.floor(colorIndex / 36);
  const green = Math.floor((colorIndex % 36) / 6);
  const blue = colorIndex % 6;
  const toChannel = (value: number) => (value === 0 ? 0 : 55 + value * 40);

  return `rgb(${toChannel(red)}, ${toChannel(green)}, ${toChannel(blue)})`;
}

function getRgbColor(red: number, green: number, blue: number): string | undefined {
  const channels = [red, green, blue];
  if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    return undefined;
  }

  return `rgb(${red}, ${green}, ${blue})`;
}

function toStyle(state: AnsiState): CSSProperties {
  const foreground = state.foreground ?? DEFAULT_FOREGROUND;
  const background = state.background;
  const inverseBackground = background ? foreground : DEFAULT_INVERSE_BACKGROUND;
  const style: CSSProperties = {
    color: state.inverse ? (background ?? DEFAULT_BACKGROUND) : foreground,
  };

  const backgroundColor = state.inverse ? inverseBackground : background;
  if (backgroundColor) {
    style.backgroundColor = backgroundColor;
  }

  if (state.bold) {
    style.fontWeight = 700;
  }

  if (state.dim) {
    style.opacity = 0.72;
  }

  if (state.italic) {
    style.fontStyle = 'italic';
  }

  if (state.underline) {
    style.textDecoration = 'underline';
  }

  return style;
}

function applySgrCode(codes: number[], startIndex: number, state: AnsiState): number {
  const code = codes[startIndex];

  if (code === 0) {
    resetState(state);
    return startIndex;
  }

  if (code === 1) {
    state.bold = true;
    state.dim = false;
    return startIndex;
  }

  if (code === 2) {
    state.dim = true;
    state.bold = false;
    return startIndex;
  }

  if (code === 3) {
    state.italic = true;
    return startIndex;
  }

  if (code === 4) {
    state.underline = true;
    return startIndex;
  }

  if (code === 7) {
    state.inverse = true;
    return startIndex;
  }

  if (code === 22) {
    state.bold = false;
    state.dim = false;
    return startIndex;
  }

  if (code === 23) {
    state.italic = false;
    return startIndex;
  }

  if (code === 24) {
    state.underline = false;
    return startIndex;
  }

  if (code === 27) {
    state.inverse = false;
    return startIndex;
  }

  if (code === 39) {
    state.foreground = undefined;
    return startIndex;
  }

  if (code === 49) {
    state.background = undefined;
    return startIndex;
  }

  if (code >= 30 && code <= 37) {
    state.foreground = ANSI_16_COLORS[code - 30];
    return startIndex;
  }

  if (code >= 40 && code <= 47) {
    state.background = ANSI_16_COLORS[code - 40];
    return startIndex;
  }

  if (code >= 90 && code <= 97) {
    state.foreground = ANSI_BRIGHT_COLORS[code - 90];
    return startIndex;
  }

  if (code >= 100 && code <= 107) {
    state.background = ANSI_BRIGHT_COLORS[code - 100];
    return startIndex;
  }

  if ((code === 38 || code === 48) && codes[startIndex + 1] === 5) {
    const color = getAnsi256Color(codes[startIndex + 2]);
    if (color) {
      if (code === 38) {
        state.foreground = color;
      } else {
        state.background = color;
      }
    }
    return startIndex + 2;
  }

  if ((code === 38 || code === 48) && codes[startIndex + 1] === 2) {
    const color = getRgbColor(codes[startIndex + 2], codes[startIndex + 3], codes[startIndex + 4]);
    if (color) {
      if (code === 38) {
        state.foreground = color;
      } else {
        state.background = color;
      }
    }
    return startIndex + 4;
  }

  return startIndex;
}

function parseSgrCodes(rawCodes: string): number[] {
  if (rawCodes.trim() === '') {
    return [0];
  }

  return rawCodes
    .split(/[;:]/)
    .map((rawCode) => Number.parseInt(rawCode, 10))
    .filter((code) => Number.isFinite(code));
}

export function stripAnsiSgr(input: string): string {
  return input.replace(SGR_STRIP_PATTERN, '');
}

function isDecorativeRuleLine(line: string): boolean {
  const plainLine = stripAnsiSgr(line).trim();
  return plainLine.length >= 24 && /^[\u2500-\u2501\u2504-\u2505\u2508-\u2509\u2550-]+$/.test(plainLine);
}

export function compactAnsiLog(input: string): string {
  return input
    .split(/\r?\n/)
    .filter((line) => !isDecorativeRuleLine(line))
    .join('\n');
}

export function parseAnsiSgr(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const state = createInitialState();
  const pattern = new RegExp(SGR_PATTERN);
  let lastIndex = 0;
  let match = pattern.exec(input);

  while (match) {
    if (match.index > lastIndex) {
      pushTextSegments(segments, input.slice(lastIndex, match.index), state);
    }

    const codes = parseSgrCodes(match[1] ?? '');
    for (let index = 0; index < codes.length; index += 1) {
      index = applySgrCode(codes, index, state);
    }

    lastIndex = pattern.lastIndex;
    match = pattern.exec(input);
  }

  if (lastIndex < input.length) {
    pushTextSegments(segments, input.slice(lastIndex), state);
  }

  return segments;
}
