/**
 * Terminal escape sequences the shell integration relies on.
 *
 * These are the small courtesies that make a long-running CLI feel native: the
 * tab says what is happening, a finished turn makes a noise if you have looked
 * away. All of them are no-ops when stdout is not a terminal, because writing
 * escape codes into a redirected log is just corruption.
 */

const isTTY = () => process.stdout.isTTY === true;

/** Notify: the terminal bell, plus OSC 9 for terminals that show a banner. */
export function bell(message?: string): void {
  if (!isTTY()) return;
  process.stdout.write('\x07');
  if (message) process.stdout.write('\x1b]9;' + message + '\x07');
}

/** Set the window/tab title. */
export function setTitle(text: string): void {
  if (!isTTY()) return;
  process.stdout.write('\x1b]0;' + text + '\x07');
}

/**
 * An OSC 8 hyperlink. Terminals that support it make the text clickable;
 * the rest show the text unchanged, which is why the fallback is free.
 */
export function link(text: string, url: string): string {
  if (!isTTY()) return text;
  return '\x1b]8;;' + url + '\x1b\\' + text + '\x1b]8;;\x1b\\';
}
