import { execFile } from 'node:child_process';
import type { Settings } from '../config.ts';
import type { ToolCall } from '../providers/types.ts';
import { errorCode } from '../errors.ts';

/**
 * Hooks — shell commands the harness runs at fixed points in a turn.
 *
 * This is the difference between "the agent usually remembers to run the
 * formatter" and "the formatter runs". A hook is executed by the CLI, not
 * requested of the model, so it cannot be forgotten, reasoned away, or skipped
 * because the context got long.
 *
 * Contract, matching the shape Claude Code uses:
 *   - the event payload arrives as JSON on stdin
 *   - exit 0 permits; anything printed on stdout that parses as
 *     `{"decision":"block","reason":...}` blocks, and `{"additionalContext":...}`
 *     is fed back to the model
 *   - exit 2 blocks, with stderr as the reason
 *   - any other non-zero exit is a hook malfunction: reported, not enforced,
 *     because a broken hook must not silently become a deny-all
 */

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop';

export type HookConfig = {
  /** Regex matched against the tool name. Absent means every call. */
  matcher?: string;
  command: string;
  timeoutMs?: number;
};

export type HooksConfig = Partial<Record<HookEvent, HookConfig[]>>;

export type HookOutcome = {
  blocked: boolean;
  /** Why it was blocked, or what a hook wants the model to know. */
  reason?: string;
  /** Text to append to the model's view of what happened. */
  context?: string;
  /** Diagnostics for the user — a hook that failed to run, say. */
  notices: string[];
};

const DEFAULT_TIMEOUT_MS = 30_000;

export type HookPayload = {
  event: HookEvent;
  cwd: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  tool_is_error?: boolean;
  prompt?: string;
};

function matches(hook: HookConfig, toolName: string | undefined): boolean {
  if (!hook.matcher) return true;
  if (!toolName) return false;
  try {
    return new RegExp('^(?:' + hook.matcher + ')$').test(toolName);
  } catch {
    // A malformed matcher matches nothing rather than everything.
    return false;
  }
}

type RunResult = { code: number; stdout: string; stderr: string };

function runOne(hook: HookConfig, payload: HookPayload, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      hook.command,
      {
        cwd,
        shell: true,
        timeout: hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, SPIDER_HOOK_EVENT: payload.event },
      },
      (err, stdout, stderr) => {
        const code = err ? (errorCode(err) ?? 1) : 0;
        resolve({
          code: typeof code === 'number' ? code : 1,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
    // A hook that ignores its stdin is perfectly legitimate — `echo ok` never
    // reads it. The pipe then closes before this write lands, raising EPIPE as
    // an unhandled 'error' event on the socket, which takes the CLI down. The
    // race is timing-dependent: it passed on macOS and failed on Linux CI.
    const stdin = child.stdin;
    if (stdin) {
      stdin.on('error', () => {
        /* the hook did not want the payload; that is not a failure */
      });
      stdin.end(JSON.stringify(payload));
    }
  });
}

/** Parse whatever a hook printed, tolerating plain text. */
function interpret(stdout: string): { block?: boolean; reason?: string; context?: string } {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return {
      block: parsed.decision === 'block',
      reason: parsed.reason,
      context: parsed.additionalContext,
    };
  } catch {
    return {};
  }
}

export async function runHooks(
  event: HookEvent,
  settings: Settings,
  payload: Omit<HookPayload, 'event' | 'cwd'>,
  cwd: string,
): Promise<HookOutcome> {
  const configured = settings.hooks?.[event] ?? [];
  const applicable = configured.filter((h) => matches(h, payload.tool_name));
  const outcome: HookOutcome = { blocked: false, notices: [] };
  if (!applicable.length) return outcome;

  const full: HookPayload = { ...payload, event, cwd };
  const contexts: string[] = [];

  // Sequential on purpose: hooks routinely touch the same files, and a
  // formatter racing a linter over one tree is a bug generator.
  for (const hook of applicable) {
    const { code, stdout, stderr } = await runOne(hook, full, cwd);
    const parsed = interpret(stdout);

    if (parsed.context) contexts.push(parsed.context);

    if (code === 2 || parsed.block) {
      outcome.blocked = true;
      outcome.reason = parsed.reason ?? stderr.trim() ?? 'blocked by hook';
      break;
    }
    if (code !== 0) {
      // A hook that cannot run is a broken hook, not a veto.
      outcome.notices.push(
        'Hook "' + hook.command + '" exited ' + code + (stderr.trim() ? ': ' + stderr.trim() : ''),
      );
    }
  }

  if (contexts.length) outcome.context = contexts.join('\n');
  return outcome;
}

/** The payload shape for a tool call, kept in one place. */
export function toolPayload(call: ToolCall): Pick<HookPayload, 'tool_name' | 'tool_input'> {
  return { tool_name: call.name, tool_input: call.input };
}
