/**
 * Server-initiated questions.
 *
 * MCP elicitation lets a server ask the user something mid-call. The handler
 * has to be registered before any server connects, which is before the TUI
 * exists — hence a module-level slot the UI fills in on mount, the same shape
 * as `notices.ts`. Until something registers, requests are declined rather than
 * left hanging: a server waiting forever on an answer nobody can give is worse
 * than a clean refusal.
 */
export type ElicitRequest = { server: string; message: string };
export type ElicitAnswer =
  | { action: 'accept'; content: Record<string, unknown> }
  | { action: 'decline' };

let handler: ((req: ElicitRequest) => Promise<ElicitAnswer>) | null = null;

export function setElicitHandler(fn: ((req: ElicitRequest) => Promise<ElicitAnswer>) | null): void {
  handler = fn;
}

export async function elicit(req: ElicitRequest): Promise<ElicitAnswer> {
  if (!handler) return { action: 'decline' };
  return handler(req);
}
