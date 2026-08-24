/**
 * Colour, respecting what the terminal can actually do.
 *
 * Hardcoded colour names assume a 256-colour dark terminal. Anything else —
 * a light background, a 16-colour console, a piped log, NO_COLOR — gets output
 * ranging from ugly to unreadable. The palette is chosen once, here.
 */

export type Theme = {
  name: 'dark' | 'light' | 'mono';
  user: string | undefined;
  assistant: string | undefined;
  notice: string;
  error: string;
  success: string;
  warning: string;
  accent: string;
  dim: boolean;
  /** Code highlighting. */
  keyword: string | undefined;
  stringLit: string | undefined;
  number: string | undefined;
  comment: string | undefined;
  /** Diffs. */
  added: string | undefined;
  removed: string | undefined;
};

const DARK: Theme = {
  name: 'dark',
  user: 'blue',
  assistant: undefined,
  notice: 'cyan',
  error: 'red',
  success: 'green',
  warning: 'yellow',
  accent: 'magenta',
  dim: true,
  keyword: 'magenta',
  stringLit: 'green',
  number: 'yellow',
  comment: 'gray',
  added: 'green',
  removed: 'red',
};

const LIGHT: Theme = {
  ...DARK,
  name: 'light',
  // On a light background the bright variants wash out; the plain ANSI ones
  // have enough contrast.
  user: 'blue',
  notice: 'cyan',
  comment: 'gray',
  keyword: 'magenta',
};

/** No colour at all: NO_COLOR, a dumb terminal, or a pipe. */
const MONO: Theme = {
  name: 'mono',
  user: undefined,
  assistant: undefined,
  notice: undefined as unknown as string,
  error: undefined as unknown as string,
  success: undefined as unknown as string,
  warning: undefined as unknown as string,
  accent: undefined as unknown as string,
  dim: false,
  keyword: undefined,
  stringLit: undefined,
  number: undefined,
  comment: undefined,
  added: undefined,
  removed: undefined,
};

export function detectTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  // https://no-color.org — any non-empty value disables colour.
  if (env.NO_COLOR) return MONO;
  if (env.TERM === 'dumb') return MONO;

  const explicit = (env.SPIDER_THEME ?? '').toLowerCase();
  if (explicit === 'light') return LIGHT;
  if (explicit === 'dark') return DARK;
  if (explicit === 'mono' || explicit === 'none') return MONO;

  // Terminals that report their background do so through COLORFGBG as fg;bg,
  // where a high bg number means a light background.
  const fgbg = env.COLORFGBG;
  if (fgbg) {
    const bg = Number(fgbg.split(';').pop());
    if (Number.isFinite(bg) && bg >= 7) return LIGHT;
  }

  return DARK;
}

let active: Theme = detectTheme();

export function theme(): Theme {
  return active;
}

export function setTheme(name: 'dark' | 'light' | 'mono'): Theme {
  active = name === 'light' ? LIGHT : name === 'mono' ? MONO : DARK;
  return active;
}

/** Terminal width, with a floor so a tiny window does not produce nonsense. */
export function width(): number {
  return Math.max(40, process.stdout.columns || 80);
}
