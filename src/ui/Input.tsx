import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.ts';

/**
 * The prompt line.
 *
 * `ink-text-input` owns its cursor and handles one line, which rules out
 * multi-line editing, reverse search and modal keys all at once. This is a
 * replacement that keeps the cursor as ordinary state, so everything that needs
 * to move it can.
 */

export type InputMode = 'insert' | 'normal';

export type InputProps = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  /** Newest last. */
  history: string[];
  /** Vim modal editing, off unless the user asks for it. */
  vim: boolean;
  /** Open $EDITOR on the current buffer. */
  onExternalEditor?: () => void;
  placeholder?: string;
};

/** Split a buffer into rendered lines, with the cursor's row and column. */
function locate(value: string, cursor: number): { lines: string[]; row: number; col: number } {
  const lines = value.split('\n');
  let seen = 0;
  for (let row = 0; row < lines.length; row++) {
    const end = seen + lines[row].length;
    if (cursor <= end) return { lines, row, col: cursor - seen };
    seen = end + 1;
  }
  return { lines, row: lines.length - 1, col: lines[lines.length - 1].length };
}

function offsetOf(lines: string[], row: number, col: number): number {
  let n = 0;
  for (let i = 0; i < row; i++) n += lines[i].length + 1;
  return n + Math.min(col, lines[row]?.length ?? 0);
}

export function Input({
  value,
  onChange,
  onSubmit,
  history,
  vim,
  onExternalEditor,
  placeholder,
}: InputProps): React.ReactElement {
  const [cursor, setCursor] = useState(value.length);
  const [mode, setMode] = useState<InputMode>('insert');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [histIdx, setHistIdx] = useState(-1);

  const clamp = useCallback((n: number, max: number) => Math.max(0, Math.min(n, max)), []);

  const set = useCallback(
    (next: string, at?: number) => {
      onChange(next);
      setCursor(clamp(at ?? next.length, next.length));
    },
    [clamp, onChange],
  );

  /** Most recent history entry containing the query. */
  const searchHit = useMemo(() => {
    if (!query) return null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].includes(query)) return history[i];
    }
    return null;
  }, [history, query]);

  useInput((input, key) => {
    // --- reverse search ------------------------------------------------
    if (searching) {
      if (key.escape || (key.ctrl && input === 'c')) {
        setSearching(false);
        setQuery('');
        return;
      }
      if (key.return) {
        setSearching(false);
        if (searchHit) set(searchHit);
        setQuery('');
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) setQuery((q) => q + input);
      return;
    }

    if (key.ctrl && input === 'r') {
      setSearching(true);
      setQuery('');
      return;
    }

    if (key.ctrl && input === 'x') {
      onExternalEditor?.();
      return;
    }

    // --- vim normal mode -----------------------------------------------
    if (vim && mode === 'normal') {
      const { lines, row, col } = locate(value, cursor);
      switch (input) {
        case 'i':
          setMode('insert');
          return;
        case 'a':
          setMode('insert');
          setCursor(clamp(cursor + 1, value.length));
          return;
        case 'A':
          setMode('insert');
          setCursor(offsetOf(lines, row, lines[row].length));
          return;
        case 'I':
          setMode('insert');
          setCursor(offsetOf(lines, row, 0));
          return;
        case 'h':
          setCursor(clamp(cursor - 1, value.length));
          return;
        case 'l':
          setCursor(clamp(cursor + 1, value.length));
          return;
        case 'j':
          if (row < lines.length - 1) setCursor(offsetOf(lines, row + 1, col));
          return;
        case 'k':
          if (row > 0) setCursor(offsetOf(lines, row - 1, col));
          return;
        case '0':
          setCursor(offsetOf(lines, row, 0));
          return;
        case '$':
          setCursor(offsetOf(lines, row, lines[row].length));
          return;
        case 'w': {
          const next = value.slice(cursor).search(/\s\S/);
          setCursor(next === -1 ? value.length : cursor + next + 1);
          return;
        }
        case 'b': {
          const before = value.slice(0, cursor).trimEnd();
          const at = before.lastIndexOf(' ');
          setCursor(at === -1 ? 0 : at + 1);
          return;
        }
        case 'x':
          set(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
          return;
        case 'D':
          set(value.slice(0, cursor), cursor);
          return;
        case 'C':
          set(value.slice(0, cursor), cursor);
          setMode('insert');
          return;
      }
      if (key.return) {
        onSubmit(value);
        setCursor(0);
        setMode('insert');
      }
      return;
    }

    if (vim && key.escape) {
      setMode('normal');
      setCursor(clamp(cursor - 1, value.length));
      return;
    }

    // --- history --------------------------------------------------------
    if (key.upArrow) {
      const { row } = locate(value, cursor);
      // Inside a multi-line buffer the arrows move the cursor; history is only
      // reachable from the first line, which is what a shell does.
      if (row > 0) {
        const { lines, col } = locate(value, cursor);
        setCursor(offsetOf(lines, row - 1, col));
        return;
      }
      if (!history.length) return;
      const idx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      set(history[idx]);
      return;
    }
    if (key.downArrow) {
      const { lines, row, col } = locate(value, cursor);
      if (row < lines.length - 1) {
        setCursor(offsetOf(lines, row + 1, col));
        return;
      }
      if (histIdx < 0) return;
      const idx = histIdx + 1;
      if (idx >= history.length) {
        setHistIdx(-1);
        set('');
        return;
      }
      setHistIdx(idx);
      set(history[idx]);
      return;
    }

    // --- editing --------------------------------------------------------
    if (key.leftArrow) return setCursor(clamp(cursor - 1, value.length));
    if (key.rightArrow) return setCursor(clamp(cursor + 1, value.length));
    if (key.ctrl && input === 'a') {
      const { lines, row } = locate(value, cursor);
      return setCursor(offsetOf(lines, row, 0));
    }
    if (key.ctrl && input === 'e') {
      const { lines, row } = locate(value, cursor);
      return setCursor(offsetOf(lines, row, lines[row].length));
    }
    if (key.ctrl && input === 'k') return set(value.slice(0, cursor), cursor);
    if (key.ctrl && input === 'u') return set(value.slice(cursor), 0);
    if (key.ctrl && input === 'w') {
      const before = value.slice(0, cursor).replace(/\S+\s*$/, '');
      return set(before + value.slice(cursor), before.length);
    }

    if (key.backspace || key.delete) {
      if (!cursor) return;
      return set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
    }

    if (key.return) {
      // A trailing backslash, or shift+enter where the terminal reports it,
      // continues onto another line instead of submitting.
      const continued = value.endsWith('\\');
      if (continued) {
        const next = value.slice(0, -1) + '\n';
        return set(next, next.length);
      }
      if (key.meta) {
        const next = value.slice(0, cursor) + '\n' + value.slice(cursor);
        return set(next, cursor + 1);
      }
      setHistIdx(-1);
      onSubmit(value);
      setCursor(0);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      const next = value.slice(0, cursor) + input + value.slice(cursor);
      set(next, cursor + input.length);
    }
  });

  const t = theme();
  const { lines, row, col } = locate(value, cursor);

  if (searching) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={t.accent}>{'(reverse-i-search)`' + query + "': "}</Text>
          <Text>{searchHit ?? ''}</Text>
        </Box>
        <Text dimColor>enter to accept · esc to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const prefix = i === 0 ? '> ' : '  ';
        const isCursorRow = i === row;
        const before = isCursorRow ? line.slice(0, col) : line;
        const at = isCursorRow ? line[col] ?? ' ' : '';
        const after = isCursorRow ? line.slice(col + 1) : '';
        return (
          <Box key={i}>
            <Text color={vim && mode === 'normal' ? t.warning : t.user}>{prefix}</Text>
            <Text>{before}</Text>
            {isCursorRow ? <Text inverse>{at}</Text> : null}
            <Text>{after}</Text>
          </Box>
        );
      })}
      {!value && placeholder ? <Text dimColor>{'  ' + placeholder}</Text> : null}
      {vim ? <Text dimColor>{'  -- ' + mode.toUpperCase() + ' --'}</Text> : null}
    </Box>
  );
}
