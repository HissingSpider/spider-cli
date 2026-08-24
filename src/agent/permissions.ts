import path from 'node:path';
import { hostOf } from '../tools/web.ts';
import { expandHome } from '../config.ts';
import type { PermissionMode, Settings } from '../config.ts';
import type { ToolCall } from '../providers/types.ts';
import { classifyCommand, splitCommand } from './risk.ts';
import { editDiff } from './preview.ts';

export type Decision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  /** `rules` are persisted on "don't ask again"; `rule` is their display form. */
  | { kind: 'ask'; rule: string; rules: string[]; preview: string };

/** Built-in tools that only observe. */
const READ_ONLY = new Set(['read_file', 'glob', 'grep', 'list_dir']);
const EDITS = new Set(['write_file', 'edit_file']);

/**
 * MCP tools whose server advertised `annotations.readOnlyHint`. Registered at
 * connect time so the permission engine can tell a server that reports from one
 * that acts, instead of treating every mcp__ tool as equally dangerous.
 */
const readOnlyMcpTools = new Set<string>();

export function registerReadOnlyTools(names: Iterable<string>): void {
  for (const n of names) readOnlyMcpTools.add(n);
}

/** Test seam. */
export function clearReadOnlyTools(): void {
  readOnlyMcpTools.clear();
}

/**
 * Directories treated as in-workspace besides the cwd. `--add-dir` exists so a
 * monorepo sibling or a scratch directory can be worked in without every read
 * prompting — it widens the boundary deliberately rather than by accident.
 */
const extraRoots: string[] = [];

export function addWorkspaceRoot(dir: string): void {
  const resolved = path.resolve(expandHome(dir));
  if (!extraRoots.includes(resolved)) extraRoots.push(resolved);
}

export function clearWorkspaceRoots(): void {
  extraRoots.length = 0;
}

export function workspaceRoots(): string[] {
  return [...extraRoots];
}

/**
 * Resolve the path a call targets and report it if it falls outside the
 * workspace. Reads are otherwise unprompted, which is fine inside a project
 * and emphatically not fine outside it — an unscoped read_file will happily
 * open ~/Library/Application Support and print credentials to the terminal.
 */
export function escapesWorkspace(call: ToolCall, cwd: string): string | null {
  const raw = call.input.path ?? call.input.pattern;
  if (typeof raw !== 'string' || raw === '') return null;
  const resolved = path.resolve(cwd, expandHome(raw));
  for (const root of [cwd, ...extraRoots]) {
    const rel = path.relative(root, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return null;
  }
  return resolved;
}

/**
 * Does this call only look at things? Used by plan mode, which permits
 * observation and forbids everything else. Note that "observing" is a weaker
 * claim than "safe to run unprompted" — web_fetch observes, but it observes
 * across the network, so it still asks. See `needsNoApproval`.
 */
export function isObserving(call: ToolCall): boolean {
  if (READ_ONLY.has(call.name)) return true;
  if (call.name === 'web_fetch') return true;
  if (call.name === 'task') return true; // the child is judged call by call
  // Writing down a plan changes nothing outside the session.
  if (call.name === 'todo_write' || call.name === 'exit_plan_mode') return true;
  // Listing and reading MCP resources are reads by definition.
  if (call.name === 'list_mcp_resources' || call.name === 'read_mcp_resource') return true;
  if (call.name === 'bash') return classifyCommand(String(call.input.command ?? '')) === 'read';
  if (call.name.startsWith('mcp__')) return readOnlyMcpTools.has(call.name);
  return false;
}

/** Does this call run without ever prompting? Stricter than `isObserving`. */
function needsNoApproval(call: ToolCall): boolean {
  if (call.name === 'web_fetch') return false; // network egress always asks
  if (call.name === 'task') return false;
  return isObserving(call);
}

/** The part of a call a permission rule is written against. */
export function subjectOf(call: ToolCall): string {
  if (call.name === 'bash') return String(call.input.command ?? '');
  // Web rules are per-domain: approving a host should not depend on the path.
  if (call.name === 'web_fetch') return hostOf(String(call.input.url ?? ''));
  return String(call.input.path ?? call.input.pattern ?? '');
}

function parseRule(rule: string): { tool: string; arg?: string } | null {
  // The tool name may itself be a prefix pattern, so one rule can trust a whole
  // MCP server: `mcp__deerdawn__*`.
  const m = /^([a-z_][a-z0-9_]*\*?)(?:\((.*)\))?$/i.exec(rule.trim());
  if (!m) return null;
  return { tool: m[1], arg: m[2] };
}

/** Does a rule's tool field name this call's tool? Supports a trailing `*`. */
function toolMatches(ruleTool: string, callName: string): boolean {
  return ruleTool.endsWith('*')
    ? callName.startsWith(ruleTool.slice(0, -1))
    : ruleTool === callName;
}

/** Does `arg` — possibly a `*` or `:*` prefix pattern — cover `subject`? */
function argCovers(arg: string, subject: string): boolean {
  if (arg.endsWith(':*')) {
    const prefix = arg.slice(0, -2);
    // Anchor on a word boundary so `bash(git s:*)` cannot cover `git switch`.
    return subject === prefix || subject.startsWith(prefix + ' ');
  }
  if (arg.endsWith('*')) return subject.startsWith(arg.slice(0, -1));
  return subject === arg;
}

/** Does a rule cover one already-split bash segment? */
function ruleCoversSegment(rule: string, segment: string): boolean {
  const parsed = parseRule(rule);
  if (!parsed || !toolMatches(parsed.tool, 'bash')) return false;
  if (!parsed.arg) return true;
  return argCovers(parsed.arg, segment.trim());
}

/**
 * Rules look like `bash(git status:*)` or `write_file(src/**)`, matching the
 * Claude Code rule syntax. A trailing `:*` or `*` makes it a prefix match.
 *
 * For bash, a rule only covers a call when it covers EVERY segment of it.
 * Matching the raw command string instead is how `bash(git status:*)` came to
 * approve `git status && rm -rf ~` on the strength of its first two words.
 */
export function matchesRule(rule: string, call: ToolCall): boolean {
  const parsed = parseRule(rule);
  if (!parsed || !toolMatches(parsed.tool, call.name)) return false;
  if (!parsed.arg) return true;

  if (call.name === 'bash') {
    const segments = splitCommand(subjectOf(call));
    return segments.length > 0 && segments.every((s) => argCovers(parsed.arg!, s.trim()));
  }
  return argCovers(parsed.arg, subjectOf(call));
}

/**
 * Is the call covered by the allow list? Every bash segment must be covered by
 * some rule, but they need not all be covered by the *same* rule — so
 * `git status && npm test` passes given both narrow rules.
 */
export function allowedByRules(call: ToolCall, rules: string[]): boolean {
  if (call.name === 'bash') {
    const segments = splitCommand(subjectOf(call));
    if (!segments.length) return false;
    return segments.every((seg) => rules.some((r) => ruleCoversSegment(r, seg)));
  }
  return rules.some((r) => matchesRule(r, call));
}

/** Any single segment matching a deny rule denies the whole command. */
export function deniedByRules(call: ToolCall, rules: string[]): string | null {
  if (call.name === 'bash') {
    const segments = splitCommand(subjectOf(call));
    for (const rule of rules) {
      for (const seg of segments) {
        if (ruleCoversSegment(rule, seg)) return rule;
      }
    }
    return null;
  }
  for (const rule of rules) {
    if (matchesRule(rule, call)) return rule;
  }
  return null;
}

function previewOf(call: ToolCall, cwd: string): string {
  const subject = subjectOf(call);
  if (call.name === 'bash') return `$ ${subject}`;
  // Show the whole URL, not just the host, so a redirect target or odd path is visible.
  if (call.name === 'web_fetch') return `fetch ${String(call.input.url ?? '')}`;
  if (EDITS.has(call.name)) {
    // Approving a change you cannot see is not consent. Show the diff.
    const diff = editDiff(call, cwd);
    const header = `${call.name} → ${subject}`;
    return diff ? header + '\n' + diff.join('\n') : header;
  }
  return `${call.name}(${subject})`;
}

/** Remember the verb, not the exact invocation: `git status -sb` → `bash(git status:*)`. */
function bashRuleFor(segment: string): string {
  const words = segment.trim().split(/\s+/).slice(0, 2).join(' ');
  return `bash(${words}:*)`;
}

/**
 * Rules narrow enough to be worth remembering for the rest of the session.
 * A compound command yields one rule per segment rather than a single rule
 * that would quietly cover far more than the user just looked at.
 */
export function suggestedRules(call: ToolCall): string[] {
  if (call.name === 'web_fetch') return [`web_fetch(${subjectOf(call)})`];
  if (call.name === 'bash') {
    const segments = splitCommand(subjectOf(call));
    return [...new Set(segments.map(bashRuleFor))];
  }
  return [`${call.name}(${subjectOf(call)})`];
}

/** Back-compat single-rule form, kept for callers that display just one. */
export function suggestedRule(call: ToolCall): string {
  return suggestedRules(call).join(' + ');
}

export function decide(
  call: ToolCall,
  settings: Settings,
  mode: PermissionMode,
  cwd: string,
): Decision {
  const denied = deniedByRules(call, settings.deny);
  if (denied) return { kind: 'deny', reason: `blocked by deny rule ${denied}` };

  if (mode === 'bypassPermissions') return { kind: 'allow' };

  // Plan mode permits observation and nothing else. This is a per-call
  // judgement, not a list of four tool names — a read-only MCP tool and
  // `git log` are both fine here, and both used to be refused.
  if (mode === 'plan' && !isObserving(call)) {
    return {
      kind: 'deny',
      reason: 'plan mode is read-only — present the plan instead of making changes',
    };
  }

  const outside = escapesWorkspace(call, cwd);
  const ask = (): Decision => {
    const rules = suggestedRules(call);
    return { kind: 'ask', rule: rules.join(' + '), rules, preview: previewOf(call, cwd) };
  };

  // Leaving the workspace always asks, even for an otherwise-free read.
  if (outside) {
    if (allowedByRules(call, settings.allow)) return { kind: 'allow' };
    const rule = `${call.name}(${outside})`;
    return {
      kind: 'ask',
      rule,
      rules: [rule],
      preview: `${call.name} OUTSIDE the workspace → ${outside}`,
    };
  }

  if (needsNoApproval(call)) return { kind: 'allow' };
  if ((mode === 'acceptEdits' || mode === 'auto') && EDITS.has(call.name)) return { kind: 'allow' };

  // `auto` additionally runs ordinary mutating commands unprompted. Anything
  // destructive or unrecognized still stops for a human.
  if (mode === 'auto' && call.name === 'bash') {
    const risk = classifyCommand(subjectOf(call));
    if (risk === 'read' || risk === 'write') return { kind: 'allow' };
  }

  if (allowedByRules(call, settings.allow)) return { kind: 'allow' };

  return ask();
}
