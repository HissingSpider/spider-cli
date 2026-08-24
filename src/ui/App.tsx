import path from 'node:path';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { InterruptedError, describe } from '../agent/loop.ts';
import type { Agent, PermissionAnswer } from '../agent/loop.ts';
import { allModels } from '../config.ts';
import { expand, loadCommands, type CustomCommand } from '../commands.ts';
import type { PermissionMode } from '../config.ts';
import type { ImageAttachment, ToolCall } from '../providers/types.ts';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { extname, join as joinPath } from 'node:path';
import * as sessions from '../session.ts';
import { formatList } from '../checkpoint.ts';
import type { McpConnection, McpStatus } from '../mcp/client.ts';
import type { PlanAnswer } from '../agent/plan.ts';
import { Markdown } from './markdown.tsx';
import { getTodos, onTodosChanged, type Todo } from '../tools/todo.ts';
import { setNoticeSink } from './notices.ts';
import { setElicitHandler, type ElicitAnswer, type ElicitRequest } from './elicit.ts';
import { detectTheme, setTheme, theme, width } from './theme.ts';
import { bell, setTitle } from './terminal.ts';
import { Input } from './Input.tsx';
import { errorMessage, isAbortError } from '../errors.ts';

// Split so `push` can take an item without an id: Omit<> over a bare union
// collapses to the keys they share, which erases `label` and `output`.
type ItemInput =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; label: string; output: string; full: string; isError: boolean }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string };

type Item = ItemInput & { id: number };

type Pending = {
  call: ToolCall;
  rule: string;
  preview: string;
  resolve: (a: PermissionAnswer) => void;
};

type PendingPlan = { plan: string; resolve: (a: PlanAnswer) => void };

type PendingElicit = { req: ElicitRequest; resolve: (a: ElicitAnswer) => void };

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];

/** What shift+tab walks through. bypassPermissions is deliberately absent —
 *  turning off every guardrail should take more than a stray keystroke. */
const CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan'];

/** The persistent indicator for a mode that is not the ordinary one. */
const BANNER: Partial<Record<PermissionMode, { text: string; color: string }>> = {
  acceptEdits: { text: '\u23f5\u23f5 accept edits on', color: 'green' },
  auto: { text: '\u23f5\u23f5 auto on \u00b7 destructive commands still ask', color: 'yellow' },
  plan: { text: '\u23f8 plan mode on \u00b7 read-only', color: 'cyan' },
  bypassPermissions: { text: '\u26a0 bypassing permissions', color: 'red' },
};

const HELP = `/help          Show this help
/model [name]  Show or switch the active model
/mode [name]   Permission mode: default, acceptEdits, auto, plan, bypassPermissions
               (shift+tab cycles default \u2192 acceptEdits \u2192 auto \u2192 plan)
/clear         Clear the conversation
/compact       Summarize the transcript so far and drop the raw history
/context       Show how much context the conversation is using
/mcp           Show connected MCP servers, their health and their tools
/resources     List resources exposed by connected MCP servers
/prompts       List prompts exposed by connected MCP servers
/cost          Token usage and estimated cost
/permissions   Show the active allow and deny rules
/init          Write a SPIDER.md describing this project
/commands      List custom commands from .spider/commands/
/theme [name]  Colour theme: dark, light, mono
/vim           Toggle vim-style modal editing
/status        Model, mode, session, tools and cost at a glance
/doctor        Check the environment and configuration
/sessions      List saved sessions for this directory
/resume [id]   Reload a session — the most recent, or one by id
/export [file] Write the transcript to markdown (default spider-session.md)
/exit          Quit

!<command>     Run a shell command directly, without asking the model
#<note>        Append a note to SPIDER.md`;

/** Colour a preview that may contain a unified diff. */
function DiffPreview({ text }: { text: string }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {text.split('\n').map((line, i) => {
        const t = theme();
        const color = line.startsWith('+')
          ? t.added
          : line.startsWith('-')
            ? t.removed
            : line.startsWith('@@')
              ? t.notice
              : undefined;
        return (
          <Text key={i} color={color} dimColor={line.startsWith('@@')}>
            {line || ' '}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * A tool result. Collapsed to a headline and a few lines, because a 200-line
 * grep result scrolling the actual conversation off the screen is how a
 * transcript becomes unreadable. ctrl+o expands them all.
 */
function ToolResult({
  item,
  expanded,
  live,
}: {
  item: Item & { kind: 'tool' };
  expanded: boolean;
  live: boolean;
}): React.ReactElement {
  const allLines = item.full.split('\n');
  const shown = expanded ? allLines : allLines.slice(0, 4);
  const hidden = allLines.length - shown.length;

  return (
    <Box flexDirection="column">
      <Text color={item.isError ? theme().error : theme().success}>
        {(item.isError ? '✗ ' : '● ') + item.label}
      </Text>
      {shown.map((l, i) => (
        <Text key={i} dimColor>
          {'  ' + l}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text dimColor>
          {'  ⎿ ' +
            allLines.length +
            ' lines total · ' +
            hidden +
            ' hidden' +
            (live ? ' (ctrl+o to expand)' : '')}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * How much of the compaction budget the conversation has eaten. `/context`
 * answers this on demand; having it always visible is what stops a compaction
 * from arriving as a surprise mid-task.
 */
function ContextMeter({ agent, tick }: { agent: Agent; tick: number }): React.ReactElement {
  void tick; // re-render alongside the elapsed clock
  const limit = agent.settings.autoCompactAt;
  if (limit <= 0) return <Text dimColor>context: unlimited</Text>;
  const used = agent.contextTokens();
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const filled = Math.round(pct / 10);
  const color = pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : undefined;
  return (
    <Text color={color} dimColor={!color}>
      {'[' + '█'.repeat(filled) + '░'.repeat(10 - filled) + '] ' + pct + '%'}
    </Text>
  );
}

/**
 * Files matching a trailing `@partial`. Attaching a file to a prompt means
 * typing its path exactly; suggesting completions is what makes that bearable
 * in a tree you do not have memorised.
 */
function FileHints({ input, cwd }: { input: string; cwd: string }): React.ReactElement | null {
  const partial = /(?:^|\s)@([^\s]*)$/.exec(input)?.[1] ?? '';
  const matches = React.useMemo(() => {
    const dir = partial.includes('/') ? partial.slice(0, partial.lastIndexOf('/')) : '';
    const leaf = partial.slice(partial.lastIndexOf('/') + 1).toLowerCase();
    try {
      return readdirSync(joinPath(cwd, dir), { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .filter((e) => e.name.toLowerCase().startsWith(leaf))
        .slice(0, 8)
        .map((e) => (dir ? dir + '/' : '') + e.name + (e.isDirectory() ? '/' : ''));
    } catch {
      return [];
    }
  }, [cwd, partial]);

  if (!matches.length) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {matches.map((m, i) => (
        <Text key={i} dimColor>
          {'  @' + m}
        </Text>
      ))}
    </Box>
  );
}

/** Is `query` a subsequence of `name`? `/cmp` finds `/compact`. */
function fuzzy(name: string, query: string): boolean {
  let i = 0;
  for (const ch of name) {
    if (i < query.length && ch === query[i]) i++;
  }
  return i === query.length;
}

/**
 * Commands matching what has been typed, with their argument hints and one-line
 * help. Exact prefixes rank above fuzzy hits so typing `/co` still puts
 * `/compact` before `/cost`... and both above anything merely fuzzy.
 */
function SlashHints({
  prefix,
  commands,
}: {
  prefix: string;
  commands: CustomCommand[];
}): React.ReactElement | null {
  const lines = [
    ...HELP.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/')),
    ...commands.map((c) => '/' + c.name.padEnd(14) + c.description),
  ];
  const nameOf = (l: string) => l.split(/\s+/)[0];
  const exact = lines.filter((l) => nameOf(l).startsWith(prefix));
  const loose = lines.filter((l) => !exact.includes(l) && fuzzy(nameOf(l), prefix));
  const matches = [...exact, ...loose].slice(0, 6);
  if (!matches.length) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {matches.map((m, i) => (
        <Text key={i} dimColor>
          {'  ' + m}
        </Text>
      ))}
    </Box>
  );
}

/** The task list, while there is one and it is not finished. */
function TodoPanel({ todos }: { todos: Todo[] }): React.ReactElement | null {
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  if (done === todos.length) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>{'Tasks  ' + done + '/' + todos.length}</Text>
      {todos.map((t, i) => {
        const mark = t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '▶' : '○';
        const color =
          t.status === 'completed' ? 'green' : t.status === 'in_progress' ? 'cyan' : undefined;
        return (
          <Text
            key={i}
            color={color}
            dimColor={t.status === 'pending'}
            strikethrough={t.status === 'completed'}
            bold={t.status === 'in_progress'}
          >
            {'  ' + mark + ' ' + t.content}
          </Text>
        );
      })}
    </Box>
  );
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Providers reject very large images, and a 20 MB screenshot is never needed. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Resolve `@path` mentions. Text files are inlined; images are attached as
 * image content, because a screenshot pasted into a prompt as base64 text is
 * just noise the model cannot see.
 */
function expandMentions(
  text: string,
  cwd: string,
): { text: string; images: ImageAttachment[]; notes: string[] } {
  const mentions = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)].map((m) => m[1]);
  if (!mentions.length) return { text, images: [], notes: [] };

  const parts: string[] = [text];
  const images: ImageAttachment[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const ref of mentions) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const file = joinPath(cwd, ref);
    const mime = IMAGE_TYPES[extname(ref).toLowerCase()];

    if (mime) {
      try {
        const buf = readFileSync(file);
        if (buf.length > MAX_IMAGE_BYTES) {
          notes.push(ref + ' is ' + Math.round(buf.length / 1e6) + ' MB — too large to attach.');
          continue;
        }
        images.push({ mimeType: mime, data: buf.toString('base64'), name: ref });
        notes.push('Attached ' + ref + ' (' + Math.round(buf.length / 1024) + ' KB)');
      } catch {
        notes.push('Could not read ' + ref);
      }
      continue;
    }

    try {
      const body = readFileSync(file, 'utf8');
      const capped = body.length > 50_000 ? body.slice(0, 50_000) + '\n… [truncated]' : body;
      parts.push('--- ' + ref + ' ---\n' + capped);
    } catch {
      // A mention that is not a file is just text; leave it alone.
    }
  }

  return { text: parts.join('\n\n'), images, notes };
}

/** One transcript entry. `live` entries can still be expanded; scrollback cannot. */
function renderItem(item: Item, expanded: boolean, live: boolean): React.ReactElement {
  const t = theme();
  return (
    <Box key={item.id} flexDirection="column" marginBottom={1}>
      {item.kind === 'user' && <Text color={t.user}>{'> ' + item.text}</Text>}
      {item.kind === 'assistant' && <Markdown text={item.text} />}
      {item.kind === 'notice' && <Text color={t.notice}>{item.text}</Text>}
      {item.kind === 'error' && <Text color={t.error}>{'✗ ' + item.text}</Text>}
      {item.kind === 'tool' && <ToolResult item={item} expanded={expanded} live={live} />}
    </Box>
  );
}

export function App({
  agent,
  cwd,
  sessionId,
  initialTurns,
  mcpStatus = [],
  mcp,
  pendingNotices = [],
}: {
  agent: Agent;
  cwd: string;
  sessionId: string;
  initialTurns: number;
  mcpStatus?: McpStatus[];
  mcp?: McpConnection;
  pendingNotices?: string[];
}) {
  const { exit } = useApp();
  // Two regions. `items` is scrollback: Ink's <Static> writes each entry to the
  // terminal exactly once and never touches it again, which is what keeps long
  // sessions cheap — but also means an entry can never be re-rendered. `live`
  // holds the current turn, so its tool results stay expandable until the next
  // message flushes them into scrollback.
  const [items, setItems] = useState<Item[]>([]);
  const [live, setLive] = useState<Item[]>([]);
  const liveRef = useRef<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState('');
  const [toolLine, setToolLine] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [pendingElicit, setPendingElicit] = useState<PendingElicit | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const lastEscape = useRef(0);
  const [expanded, setExpanded] = useState(false);
  /** Messages typed while the agent was working, run in order once it stops. */
  const queueRef = useRef<string[]>([]);
  const [queued, setQueued] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const historyIdx = useRef(-1);
  const [elapsed, setElapsed] = useState(0);
  const [todos, setTodosState] = useState<Todo[]>(getTodos());
  const [commands] = useState<CustomCommand[]>(() => loadCommands(cwd));
  const [themeName, setThemeName] = useState(() => detectTheme().name);
  const [vim, setVim] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const exitTimer = useRef<NodeJS.Timeout | null>(null);
  const [model, setModel] = useState(agent.model);
  const [mode, setMode] = useState<PermissionMode>(agent.mode);
  const nextId = useRef(0);
  const inputValueRef = useRef('');

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  useEffect(() => onTodosChanged(setTodosState), []);

  // A spinner with no elapsed time gives no sense of whether a turn is
  // progressing or wedged.
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const push = useCallback((item: ItemInput) => {
    const next = { ...item, id: nextId.current++ };
    liveRef.current = [...liveRef.current, next];
    setLive(liveRef.current);
  }, []);

  /** Hand the buffer to $EDITOR, then take back whatever was saved. */
  const openEditor = useCallback(() => {
    const editor = process.env.VISUAL || process.env.EDITOR;
    if (!editor) {
      push({ kind: 'notice', text: 'Set $EDITOR or $VISUAL to use ctrl+x.' });
      return;
    }
    const file = joinPath(tmpdir(), 'spider-prompt-' + process.pid + '.md');
    try {
      writeFileSync(file, inputValueRef.current);
      // Ink owns the terminal; the editor needs it back for the duration.
      spawnSync(editor, [file], { stdio: 'inherit' });
      setInput(readFileSync(file, 'utf8').replace(/\n$/, ''));
    } catch (e) {
      push({ kind: 'error', text: 'Editor failed: ' + errorMessage(e) });
    } finally {
      try {
        unlinkSync(file);
      } catch {
        /* best effort */
      }
    }
  }, [push]);

  /** Retire the finished turn into scrollback. */
  const flush = useCallback(() => {
    if (!liveRef.current.length) return;
    const done = liveRef.current;
    liveRef.current = [];
    setLive([]);
    setItems((prev) => [...prev, ...done]);
    setExpanded(false);
  }, []);

  useEffect(() => {
    for (const t of pendingNotices) push({ kind: 'notice', text: t });
    setNoticeSink((t) => push({ kind: 'notice', text: t }));
    // A server asking the user something needs somewhere to ask.
    setElicitHandler(
      (req) => new Promise<ElicitAnswer>((resolve) => setPendingElicit({ req, resolve })),
    );
    return () => setElicitHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNotices, push]);

  useEffect(() => {
    if (initialTurns > 0) {
      push({ kind: 'notice', text: `Resumed session with ${initialTurns} prior turns.` });
    }
  }, [initialTurns, push]);

  const armExitConfirm = useCallback(() => {
    setConfirmExit(true);
    if (exitTimer.current) clearTimeout(exitTimer.current);
    // The confirmation lapses, so a stray ctrl+c much later is not half an exit.
    exitTimer.current = setTimeout(() => setConfirmExit(false), 2000);
  }, []);

  const interrupt = useCallback(() => {
    abortRef.current?.abort();
    if (pending) {
      // A pending approval is itself a blocked turn; reject it so run() unwinds.
      pending.resolve('deny');
      setPending(null);
    }
    if (pendingPlan) {
      pendingPlan.resolve('reject');
      setPendingPlan(null);
    }
    if (pendingElicit) {
      pendingElicit.resolve({ action: 'decline' });
      setPendingElicit(null);
    }
  }, [pending, pendingElicit, pendingPlan]);

  useInput((input, key) => {
    // shift+tab cycles the permission mode. Checked before anything else so it
    // works mid-turn: raising or lowering authority is exactly the thing you
    // want to do while watching the agent work.
    if (key.tab && key.shift) {
      const next = CYCLE[(CYCLE.indexOf(agent.mode) + 1) % CYCLE.length];
      agent.mode = next;
      setMode(next);
      return;
    }

    if (key.ctrl && input === 'c') {
      if (busy || pending || pendingPlan) {
        interrupt();
        setConfirmExit(false);
        return;
      }
      if (inputValueRef.current.trim()) {
        setInput('');
        setConfirmExit(false);
        return;
      }
      if (confirmExit) {
        exit();
        return;
      }
      armExitConfirm();
      return;
    }

    // ctrl+o expands every collapsed tool result in the transcript.
    if (key.ctrl && input === 'o') {
      setExpanded((e) => !e);
      return;
    }

    if (key.ctrl && input === 'd' && !busy && !pending && !pendingPlan && !inputValueRef.current) {
      exit();
      return;
    }

    if (key.escape && !busy && !pending && !pendingPlan && !pendingElicit) {
      const now = Date.now();
      if (now - lastEscape.current < 600) {
        lastEscape.current = 0;
        push({ kind: 'notice', text: formatList(agent.checkpoints.list(), cwd) });
      } else {
        lastEscape.current = now;
      }
      return;
    }

    if (key.escape && (busy || pending || pendingPlan)) {
      interrupt();
    }
  });

  // Elicitation: a free-text answer, or esc to decline.
  useInput(
    (_input, key) => {
      if (!pendingElicit) return;
      if (key.escape) {
        const { resolve } = pendingElicit;
        setPendingElicit(null);
        resolve({ action: 'decline' });
      }
    },
    { isActive: pendingElicit !== null },
  );

  // Plan approval keybindings.
  useInput(
    (input, key) => {
      if (!pendingPlan) return;
      const answer: PlanAnswer | null =
        input === '1' || key.return
          ? 'acceptEdits'
          : input === '2'
            ? 'default'
            : input === '3' || key.escape
              ? 'reject'
              : null;
      if (!answer) return;
      const { resolve } = pendingPlan;
      setPendingPlan(null);
      if (answer !== 'reject') setMode(answer as PermissionMode);
      resolve(answer);
    },
    { isActive: pendingPlan !== null },
  );

  // Approval prompt keybindings.
  useInput(
    (input, key) => {
      if (!pending) return;
      const answer: PermissionAnswer | null =
        input === '1' || key.return
          ? 'allow'
          : input === '2'
            ? 'allow-always'
            : input === '3' || key.escape
              ? 'deny'
              : null;
      if (!answer) return;
      const { resolve } = pending;
      setPending(null);
      resolve(answer);
    },
    { isActive: pending !== null },
  );

  const runAgent = useCallback(
    async (text: string, images?: ImageAttachment[]) => {
      setBusy(true);
      setConfirmExit(false);
      setTitle('spider — working');
      const controller = new AbortController();
      abortRef.current = controller;
      let buffer = '';
      try {
        await agent.run(
          text,
          {
            onDelta: (d) => {
              buffer += d;
              // Reasoning belongs to the step that produced it; once the answer
              // starts, keeping it on screen just crowds the answer out.
              setReasoning('');
              setStream(buffer);
            },
            onReasoning: (d) => setReasoning((r) => (r + d).slice(-600)),
            onAssistantEnd: () => {
              if (buffer.trim()) push({ kind: 'assistant', text: buffer.trim() });
              buffer = '';
              setStream('');
            },
            onToolStart: (_call, preview) => setToolLine(preview),
            onToolEnd: (_call, output, isError) => {
              setToolLine(null);
              push({
                kind: 'tool',
                label: describe(_call),
                output: output.split('\n').slice(0, 4).join('\n'),
                full: output,
                isError,
              });
            },
            onNotice: (t) => push({ kind: 'notice', text: t }),
            requestPermission: (call, rule, preview) =>
              new Promise<PermissionAnswer>((resolve) =>
                setPending({ call, rule, preview, resolve }),
              ),
            requestPlanApproval: (plan) =>
              new Promise<PlanAnswer>((resolve) => setPendingPlan({ plan, resolve })),
          },
          controller.signal,
          images,
        );
      } catch (err) {
        if (err instanceof InterruptedError || isAbortError(err) || controller.signal.aborted) {
          if (buffer.trim()) push({ kind: 'assistant', text: buffer.trim() });
          push({ kind: 'notice', text: 'Interrupted.' });
        } else {
          push({ kind: 'error', text: errorMessage(err) });
        }
      } finally {
        abortRef.current = null;
        setStream('');
        setToolLine(null);
        setReasoning('');
        setBusy(false);
        // A finished turn is worth a nudge if the user has looked away. Only
        // when nothing is queued, so a batch does not chime repeatedly.
        if (!queueRef.current.length) {
          bell('spider: turn finished');
          setTitle('spider — ready');
        }
        sessions.save({
          id: sessionId,
          cwd,
          model: agent.model,
          updatedAt: '',
          turns: agent.turns,
          mode: agent.mode,
          allow: agent.settings.allow,
        });
      }
    },
    [agent, cwd, push, sessionId],
  );

  useEffect(() => {
    if (busy || pending || pendingPlan || pendingElicit) return;
    const next = queueRef.current.shift();
    if (next === undefined) return;
    setQueued([...queueRef.current]);
    flush();
    push({ kind: 'user', text: next });
    void runAgent(next);
  }, [busy, flush, pending, pendingElicit, pendingPlan, push, runAgent]);

  const onSubmit = useCallback(
    (raw: string) => {
      const text = raw.trim();
      setInput('');
      historyIdx.current = -1;

      if (pendingElicit) {
        const { resolve } = pendingElicit;
        setPendingElicit(null);
        resolve(text ? { action: 'accept', content: { answer: text } } : { action: 'decline' });
        return;
      }

      if (!text) return;
      if (text !== history[history.length - 1]) setHistory((h) => [...h, text]);

      // `!cmd` runs a shell command directly, without a round trip through the
      // model — the thing you want when you already know the command.
      if (text.startsWith('!')) {
        const command = text.slice(1).trim();
        if (!command) return;
        flush();
        push({ kind: 'user', text: text });
        setBusy(true);
        void agent.tools.bash
          .run({ command }, cwd)
          .then((r) => {
            push({
              kind: 'tool',
              label: '$ ' + command,
              output: r.output,
              full: r.output,
              isError: r.isError,
            });
            // The model must know this happened, or its picture of the
            // workspace silently diverges from reality.
            agent.turns.push({
              role: 'user',
              text: '[ran directly] $ ' + command + '\n' + r.output,
            });
          })
          .catch((e: any) => push({ kind: 'error', text: errorMessage(e) }))
          .finally(() => setBusy(false));
        return;
      }

      // `#note` appends to the project's SPIDER.md — a fact worth keeping,
      // captured at the moment you think of it.
      if (text.startsWith('#')) {
        const note = text.slice(1).trim();
        if (!note) return;
        try {
          appendFileSync(cwd + '/SPIDER.md', '\n- ' + note + '\n');
          push({ kind: 'notice', text: 'Added to SPIDER.md: ' + note });
        } catch (e) {
          push({ kind: 'error', text: 'Could not write SPIDER.md: ' + errorMessage(e) });
        }
        return;
      }

      // Typing while the agent works used to be impossible; now it queues and
      // runs in order, so a follow-up thought does not have to wait for a turn.
      if (busy || pending || pendingPlan) {
        queueRef.current.push(text);
        setQueued([...queueRef.current]);
        return;
      }

      flush();

      if (text.startsWith('/')) {
        const [cmd, ...rest] = text.split(/\s+/);
        const arg = rest.join(' ');
        switch (cmd) {
          case '/help':
            push({ kind: 'notice', text: HELP });
            return;
          case '/exit':
          case '/quit':
            exit();
            return;
          case '/clear':
            agent.turns = [];
            setItems([]);
            liveRef.current = [];
            setLive([]);
            push({ kind: 'notice', text: 'Conversation cleared.' });
            return;
          case '/cost':
            push({ kind: 'notice', text: agent.cost.summary() });
            return;
          case '/context': {
            const used = agent.contextTokens();
            const limit = agent.settings.autoCompactAt;
            push({
              kind: 'notice',
              text:
                agent.turns.length +
                ' turns, about ' +
                used.toLocaleString() +
                ' input tokens' +
                (limit > 0
                  ? ' (auto-compacts above ' + limit.toLocaleString() + ')'
                  : ' (auto-compaction disabled)'),
            });
            return;
          }
          case '/mcp': {
            if (!mcpStatus.length) {
              push({
                kind: 'notice',
                text: 'No MCP servers configured. Add mcpServers to .spider/settings.json.',
              });
              return;
            }
            const lines = mcpStatus.map((s) => {
              const mark =
                s.state === 'connected'
                  ? '●'
                  : s.state === 'reconnecting'
                    ? '◐'
                    : s.state === 'disabled'
                      ? '○'
                      : '✗';
              if (s.state === 'disabled') return mark + ' ' + s.name + ' — disabled';
              if (!s.ok) {
                const tail = s.stderr.length
                  ? '\n    stderr: ' + s.stderr.slice(-3).join('\n            ')
                  : '';
                return mark + ' ' + s.name + ' — ' + (s.error ?? 'failed') + tail;
              }
              const bits = [s.toolCount + ' tools'];
              if (s.resourceCount) bits.push(s.resourceCount + ' resources');
              if (s.promptCount) bits.push(s.promptCount + ' prompts');
              if (s.filtered) bits.push(s.filtered + ' filtered out');
              if (s.latencyMs !== undefined) bits.push(s.latencyMs + 'ms');
              return mark + ' ' + s.name + ' — ' + bits.join(' · ');
            });
            const tools = Object.keys(agent.tools).filter((n) => n.startsWith('mcp__'));
            push({
              kind: 'notice',
              text: lines.join('\n') + (tools.length ? '\n\n' + tools.join('\n') : ''),
            });
            return;
          }
          case '/resources': {
            const all = mcp?.resources() ?? [];
            push({
              kind: 'notice',
              text: all.length
                ? all.map((r) => '  ' + r.server + '  ' + r.uri + '  ' + r.name).join('\n')
                : 'No connected MCP server exposes resources.',
            });
            return;
          }
          case '/prompts': {
            const all = mcp?.prompts() ?? [];
            push({
              kind: 'notice',
              text: all.length
                ? all
                    .map(
                      (p) =>
                        '  /mcp__' +
                        p.server +
                        '__' +
                        p.name +
                        p.arguments
                          .map((a) => ' <' + a.name + (a.required ? '' : '?') + '>')
                          .join('') +
                        (p.description ? '\n      ' + p.description : ''),
                    )
                    .join('\n')
                : 'No connected MCP server exposes prompts.',
            });
            return;
          }
          case '/compact':
            setBusy(true);
            void agent
              .compact({
                onDelta: () => {},
                onAssistantEnd: () => {},
                onToolStart: () => {},
                onToolEnd: () => {},
                onNotice: (t) => push({ kind: 'notice', text: t }),
                requestPermission: async () => 'deny',
              })
              .catch((e: any) => push({ kind: 'error', text: errorMessage(e) }))
              .finally(() => setBusy(false));
            return;
          case '/permissions':
            push({
              kind: 'notice',
              text:
                'Mode: ' +
                agent.mode +
                '\nallow: ' +
                (agent.settings.allow.join(', ') || '(none)') +
                '\ndeny:  ' +
                (agent.settings.deny.join(', ') || '(none)'),
            });
            return;
          case '/model':
            if (!arg) {
              push({
                kind: 'notice',
                text: 'Current: ' + agent.model + '\nAvailable: ' + allModels().join(', '),
              });
              return;
            }
            try {
              agent.setModel(arg);
              setModel(arg);
              push({ kind: 'notice', text: 'Model set to ' + arg });
            } catch (e) {
              push({ kind: 'error', text: errorMessage(e) });
            }
            return;
          case '/mode':
            if (!MODES.includes(arg as PermissionMode)) {
              push({
                kind: 'notice',
                text: 'Modes: ' + MODES.join(', ') + '\nCurrent: ' + agent.mode,
              });
              return;
            }
            agent.mode = arg as PermissionMode;
            setMode(arg as PermissionMode);
            push({ kind: 'notice', text: 'Permission mode: ' + arg });
            return;
          case '/sessions': {
            const all = sessions.list(cwd).slice(0, 15);
            push({
              kind: 'notice',
              text: all.length
                ? 'Sessions here (/resume <id> to load one):\n' +
                  all
                    .map(
                      (x) =>
                        '  ' +
                        x.id +
                        '  ' +
                        String(x.turns.length).padStart(3) +
                        ' turns  ' +
                        (x.title ?? '(untitled)'),
                    )
                    .join('\n')
                : 'No saved sessions for this directory.',
            });
            return;
          }
          case '/export': {
            const target = arg || 'spider-session.md';
            try {
              writeFileSync(
                target,
                sessions.toMarkdown({
                  id: sessionId,
                  cwd,
                  model: agent.model,
                  updatedAt: new Date().toISOString(),
                  turns: agent.turns,
                  mode: agent.mode,
                }),
              );
              push({ kind: 'notice', text: 'Wrote the transcript to ' + target });
            } catch (e) {
              push({ kind: 'error', text: 'Could not write ' + target + ': ' + errorMessage(e) });
            }
            return;
          }
          case '/rewind': {
            if (!arg) {
              push({ kind: 'notice', text: formatList(agent.checkpoints.list(), cwd) });
              return;
            }
            const id = Number(arg);
            if (!Number.isInteger(id)) {
              push({ kind: 'error', text: 'Usage: /rewind <number> — see /rewind for the list' });
              return;
            }
            const result = agent.checkpoints.restore(id);
            if (!result) {
              push({ kind: 'error', text: 'No checkpoint ' + id + '. Run /rewind to list them.' });
              return;
            }
            agent.turns = result.turns;
            const parts = ['Rewound to checkpoint ' + id + '.'];
            if (result.restored.length) {
              parts.push(
                'Reverted: ' + result.restored.map((f) => path.relative(cwd, f)).join(', '),
              );
            }
            if (result.removed.length) {
              parts.push('Deleted: ' + result.removed.map((f) => path.relative(cwd, f)).join(', '));
            }
            if (result.failed.length) {
              parts.push(
                'COULD NOT restore: ' + result.failed.map((f) => path.relative(cwd, f)).join(', '),
              );
            }
            if (!result.restored.length && !result.removed.length) {
              parts.push('No file changes to undo.');
            }
            push({ kind: 'notice', text: parts.join('\n') });
            return;
          }
          case '/resume': {
            const prev = arg ? sessions.byId(arg, cwd) : sessions.mostRecent(cwd);
            if (!prev) {
              push({
                kind: 'notice',
                text: arg
                  ? 'No session "' + arg + '" here. /sessions lists them.'
                  : 'No saved session for this directory.',
              });
              return;
            }
            // Resuming an older session must not append this session's turns
            // onto it; the append bookkeeping has to start over.
            sessions.resetAppendState(prev.id);
            agent.turns = prev.turns;
            if (prev.mode) {
              agent.mode = prev.mode;
              setMode(prev.mode);
            }
            for (const rule of prev.allow ?? []) {
              if (!agent.settings.allow.includes(rule)) agent.settings.allow.push(rule);
            }
            push({
              kind: 'notice',
              text:
                `Resumed ${prev.turns.length} turns from ${prev.id}` +
                (prev.mode ? ` in ${prev.mode} mode.` : '.'),
            });
            return;
          }
          case '/init': {
            const file = 'SPIDER.md';
            const prompt =
              'Write a SPIDER.md for this project. Explore the codebase first: read the ' +
              'README, package manifests, config and a representative sample of the source. ' +
              'Then write ' +
              file +
              ' covering how to build, test and run it, the layout, ' +
              'the conventions a newcomer would otherwise get wrong, and anything non-obvious ' +
              'about the architecture. Be concise and concrete — no filler, no restating what ' +
              'the code already makes obvious. If a ' +
              file +
              ' already exists, improve it ' +
              'rather than replacing it wholesale.';
            push({ kind: 'user', text: prompt });
            void runAgent(prompt);
            return;
          }
          case '/vim':
            setVim((v) => {
              push({
                kind: 'notice',
                text: 'Vim keys ' + (!v ? 'on — esc for normal mode' : 'off'),
              });
              return !v;
            });
            return;
          case '/theme': {
            const wanted = arg as 'dark' | 'light' | 'mono';
            if (!['dark', 'light', 'mono'].includes(wanted)) {
              push({
                kind: 'notice',
                text:
                  'Themes: dark, light, mono. Current: ' +
                  themeName +
                  '\nSet SPIDER_THEME, or NO_COLOR=1 for no colour at all.',
              });
              return;
            }
            setTheme(wanted);
            setThemeName(wanted);
            push({ kind: 'notice', text: 'Theme: ' + wanted });
            return;
          }
          case '/status': {
            const mcpLine = mcpStatus.length
              ? mcpStatus.map((x) => x.name + '=' + x.state).join(', ')
              : 'none configured';
            push({
              kind: 'notice',
              text: [
                'model      ' + agent.model,
                'mode       ' + agent.mode,
                'cwd        ' + cwd,
                'session    ' + sessionId,
                'turns      ' + agent.turns.length,
                'tools      ' + Object.keys(agent.tools).length,
                'mcp        ' + mcpLine,
                'theme      ' + themeName + ' (' + width() + ' cols)',
                'cost       $' + agent.cost.estimateUSD().toFixed(4),
              ].join('\n'),
            });
            return;
          }
          case '/doctor': {
            const checks: string[] = [];
            const ok = (label: string, good: boolean, detail: string) =>
              checks.push((good ? '● ' : '✗ ') + label.padEnd(22) + detail);

            ok('node', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node);
            ok(
              'workspace',
              cwd !== homedir(),
              cwd === homedir() ? 'running in $HOME — cd into a project' : cwd,
            );
            ok(
              'project instructions',
              !!agent.settings,
              existsSync(cwd + '/SPIDER.md')
                ? 'SPIDER.md found'
                : 'no SPIDER.md (/init writes one)',
            );
            ok('deny rules', true, agent.settings.deny.length + ' configured');
            ok('allow rules', true, agent.settings.allow.length + ' configured');
            ok(
              'search',
              !!agent.settings.search,
              agent.settings.search ? 'configured' : 'not configured — web_search unavailable',
            );
            ok(
              'hooks',
              true,
              Object.keys(agent.settings.hooks ?? {}).length + ' event(s) with hooks',
            );
            for (const m of mcpStatus) {
              ok('mcp: ' + m.name, m.ok, m.ok ? m.toolCount + ' tools' : (m.error ?? m.state));
            }
            push({ kind: 'notice', text: checks.join('\n') });
            return;
          }
          case '/commands': {
            push({
              kind: 'notice',
              text: commands.length
                ? commands.map((c) => '  /' + c.name.padEnd(16) + c.description).join('\n')
                : 'No custom commands. Add markdown files to .spider/commands/.',
            });
            return;
          }
          default: {
            // A user-defined command from .spider/commands/<name>.md.
            const custom = commands.find((c) => '/' + c.name === cmd);
            if (custom) {
              const text = expand(custom, rest);
              push({ kind: 'user', text });
              void runAgent(text);
              return;
            }

            // MCP prompts are addressable as /mcp__<server>__<prompt>.
            const mcpPrompt = /^\/mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(cmd);
            if (mcpPrompt && mcp) {
              const [, server, name] = mcpPrompt;
              const known = mcp.prompts().find((p) => p.server === server && p.name === name);
              if (known) {
                const values: Record<string, string> = {};
                // Positional: arguments are filled in declaration order.
                rest.forEach((v, i) => {
                  const arg = known.arguments[i];
                  if (arg) values[arg.name] = v;
                });
                setBusy(true);
                void mcp
                  .getPrompt(server, name, values)
                  .then((text) => {
                    push({ kind: 'user', text });
                    return runAgent(text);
                  })
                  .catch((e: any) =>
                    push({ kind: 'error', text: 'Prompt failed: ' + errorMessage(e) }),
                  )
                  .finally(() => setBusy(false));
                return;
              }
            }
            push({ kind: 'error', text: 'Unknown command ' + cmd + ' — try /help' });
            return;
          }
        }
      }

      push({ kind: 'user', text });
      // Snapshot the transcript before this turn so /rewind can drop it whole.
      agent.checkpoints.record(text, agent.turns);
      // `@path` mentions are resolved to real content, so the model gets the
      // file rather than a filename it has to go and read.
      const resolved = expandMentions(text, cwd);
      for (const note of resolved.notes) push({ kind: 'notice', text: note });
      void runAgent(resolved.text, resolved.images);
    },
    [
      agent,
      busy,
      commands,
      cwd,
      exit,
      flush,
      history,
      mcp,
      mcpStatus,
      pending,
      pendingElicit,
      pendingPlan,
      push,
      runAgent,
      themeName,
      sessionId,
    ],
  );

  return (
    <Box flexDirection="column">
      <Static items={items}>{(item) => renderItem(item, false, false)}</Static>

      {live.map((item) => renderItem(item, expanded, true))}

      {reasoning && !stream ? (
        <Box marginBottom={1} flexDirection="column">
          <Text dimColor italic>
            {reasoning
              .split('\n')
              .slice(-4)
              .map((l) => '  ' + l)
              .join('\n')}
          </Text>
        </Box>
      ) : null}

      {stream ? (
        <Box marginBottom={1}>
          <Text>{stream}</Text>
        </Box>
      ) : null}

      {toolLine ? (
        <Box marginBottom={1}>
          <Text color="yellow">
            <Spinner type="dots" /> {' ' + toolLine}
          </Text>
        </Box>
      ) : null}

      <TodoPanel todos={todos} />

      {!pending && !pendingPlan && input.startsWith('/') && !input.includes(' ') ? (
        <SlashHints prefix={input} commands={commands} />
      ) : null}

      {!pending && !pendingPlan && /(^|\s)@[^\s]*$/.test(input) ? (
        <FileHints input={input} cwd={cwd} />
      ) : null}

      {pendingElicit ? (
        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text color="magenta" bold>
            {'"' + pendingElicit.req.server + '" is asking'}
          </Text>
          <Text>{pendingElicit.req.message}</Text>
          <Text dimColor>Type an answer and press enter, or esc to decline.</Text>
        </Box>
      ) : null}

      {pendingPlan ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan" bold>
            Ready to code?
          </Text>
          <Box marginY={1}>
            <Markdown text={pendingPlan.plan} />
          </Box>
          <Box flexDirection="column">
            <Text>[1] Yes, and auto-accept edits (enter)</Text>
            <Text>[2] Yes, but approve each change</Text>
            <Text>[3] No, keep planning (esc)</Text>
          </Box>
        </Box>
      ) : pending ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow" bold>
            Permission required
          </Text>
          <DiffPreview text={pending.preview} />
          <Box marginTop={1} flexDirection="column">
            <Text>[1] Yes (enter)</Text>
            <Text>{"[2] Yes, and don't ask again for " + pending.rule}</Text>
            <Text>[3] No (esc)</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {busy ? (
            <Box>
              <Text color="green">
                <Spinner type="dots" />
              </Text>
              <Text dimColor>
                {' working… (' +
                  elapsed +
                  's · ' +
                  (agent.cost.input + agent.cost.output).toLocaleString() +
                  ' tokens · esc to interrupt)'}
              </Text>
            </Box>
          ) : null}
          <Input
            value={input}
            onChange={setInput}
            onSubmit={onSubmit}
            history={history}
            vim={vim}
            onExternalEditor={openEditor}
            placeholder={busy ? 'type to queue a follow-up…' : undefined}
          />
          {queued.map((q, i) => (
            <Text key={i} dimColor>
              {'  ⏵ queued: ' + (q.length > 60 ? q.slice(0, 60) + '…' : q)}
            </Text>
          ))}
        </Box>
      )}

      {BANNER[mode] ? (
        <Box marginTop={1}>
          <Text color={BANNER[mode]!.color} bold>
            {BANNER[mode]!.text}
          </Text>
          <Text dimColor>{'  (shift+tab to cycle)'}</Text>
        </Box>
      ) : null}

      {!pending && !pendingPlan ? (
        <Box marginTop={1}>
          <Text dimColor>{model + '  ·  ' + mode + '  ·  '}</Text>
          <ContextMeter agent={agent} tick={elapsed} />
          <Text dimColor>{'  ·  $' + agent.cost.estimateUSD().toFixed(4)}</Text>
        </Box>
      ) : null}

      {confirmExit ? (
        <Box>
          <Text color="yellow">Press ctrl+c again to exit.</Text>
        </Box>
      ) : null}
    </Box>
  );
}
