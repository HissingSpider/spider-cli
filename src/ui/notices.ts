/**
 * Where mid-session notices go.
 *
 * MCP servers reconnect, change their tool lists and log errors long after
 * startup, and those messages have to reach the user. Before the TUI mounts
 * there is nowhere to put them but stderr; afterwards they belong in the
 * transcript. This indirection is a separate module rather than living in
 * `index.tsx` because the UI importing the entrypoint would be a cycle — and
 * `index.tsx` calls `main()` on load, so the cycle would run the CLI twice.
 */
let sink: (text: string) => void = (t) => process.stderr.write(t + '\n');

export function notice(text: string): void {
  sink(text);
}

export function setNoticeSink(fn: (text: string) => void): void {
  sink = fn;
}

export function resetNoticeSink(): void {
  sink = (t) => process.stderr.write(t + '\n');
}
