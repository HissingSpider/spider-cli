import path from 'node:path';
import type { PermissionMode, Settings } from '../config.ts';
import { persistAllowRule, providerFor } from '../config.ts';
import { createAnthropicProvider } from '../providers/anthropic.ts';
import { createOpenAIProvider } from '../providers/openai.ts';
import type {
  AssistantResult,
  ImageAttachment,
  Provider,
  ToolCall,
  ToolSpec,
  Turn,
} from '../providers/types.ts';
import { TOOLS, type ToolImpl } from '../tools/index.ts';
import { createSearchTool } from '../tools/search.ts';
import { CostTracker } from '../cost.ts';
import { CheckpointStore } from '../checkpoint.ts';
import { decide } from './permissions.ts';
import { buildSystemPrompt } from './prompt.ts';
import { compactTurns, estimateTokens } from './compact.ts';
import { createTaskTool } from './subagent.ts';
import { createExitPlanModeTool, type PlanAnswer } from './plan.ts';
import { runHooks, toolPayload } from './hooks.ts';
import { classifyCommand } from './risk.ts';
import { isAbortError } from '../errors.ts';

const DEFAULT_MAX_ITERATIONS = 25;
/** How deep the task tree may go. Two levels is enough to fan out and report. */
const MAX_DEPTH = 2;

/** Thrown when the user interrupts a turn; not an error worth a red banner. */
export class InterruptedError extends Error {
  constructor() {
    super('Interrupted');
    this.name = 'InterruptedError';
  }
}

export type PermissionAnswer = 'allow' | 'allow-always' | 'deny';

export type AgentEvents = {
  onDelta: (text: string) => void;
  onAssistantEnd: () => void;
  onToolStart: (call: ToolCall, preview: string) => void;
  onToolEnd: (call: ToolCall, output: string, isError: boolean) => void;
  /** Output arriving while a tool is still running, for a live tail. */
  onToolProgress?: (chunk: string) => void;
  onNotice: (text: string) => void;
  /** Streamed reasoning summary, when the model produces one. */
  onReasoning?: (text: string) => void;
  requestPermission: (call: ToolCall, rule: string, preview: string) => Promise<PermissionAnswer>;
  /** Plan mode only: show the finished plan and ask whether to start work.
   *  Absent in headless runs and inside subagents, where nobody can answer. */
  requestPlanApproval?: (plan: string) => Promise<PlanAnswer>;
};

export type AgentOptions = {
  /** Extra tools, e.g. those discovered from MCP servers. */
  extraTools?: Record<string, ToolImpl>;
  /** Subagents cannot spawn their own subagents. */
  allowSubagents?: boolean;
  /** How deep in the delegation tree this agent is. */
  depth?: number;
  /** Subagents share the parent's cost tracker so /cost covers the whole tree. */
  costTracker?: CostTracker;
};

export class Agent {
  turns: Turn[] = [];
  cost: CostTracker;
  checkpoints = new CheckpointStore();
  mode: PermissionMode;
  model: string;
  tools: Record<string, ToolImpl>;

  /** Nesting depth: 0 is the session agent. */
  readonly depth: number = 0;

  /** Extra system-prompt text, set when a named subagent definition is used. */
  extraSystemPrompt: string | null = null;

  /** Input tokens billed on the last request — the trigger for auto-compaction. */
  lastInputTokens = 0;

  /**
   * Raised when a compaction attempt finds nothing safe to drop, so the next
   * few rounds do not retry (and re-announce) the same no-op every turn.
   */
  private compactFloor = 0;

  /** Transcript length at the last successful compaction, to stop back-to-back runs. */
  private turnsAtLastCompact = -Infinity;

  /** Kept so the tool map can be rebuilt when a server's listing changes. */
  allowSubagents = true;

  private openai: Provider;
  private anthropic: Provider;

  constructor(
    readonly cwd: string,
    readonly settings: Settings,
    private projectInstructions: string | null,
    baseUrl: string,
    apiKey: string,
    opts: AgentOptions = {},
  ) {
    this.mode = settings.permissionMode;
    this.model = settings.model;
    this.cost = opts.costTracker ?? new CostTracker();
    this.openai = createOpenAIProvider(baseUrl, apiKey);
    this.anthropic = createAnthropicProvider(baseUrl, apiKey);

    (this as { depth: number }).depth = opts.depth ?? 0;
    // Delegation is bounded: a tree that can nest without limit turns one
    // request into an unbounded number of them.
    this.allowSubagents = opts.allowSubagents !== false && this.depth < MAX_DEPTH;
    this.tools = {};
    this.setExtraTools(opts.extraTools ?? {});
  }

  /**
   * Replace the MCP-supplied half of the tool map. Servers announce
   * `tools/list_changed` at any time, so this cannot be a one-shot at
   * construction — but the built-ins and the composite tools must survive it.
   */
  setExtraTools(extra: Record<string, ToolImpl>): void {
    this.tools = { ...TOOLS, web_search: createSearchTool(this.settings.search), ...extra };
    if (this.allowSubagents) {
      this.tools.task = createTaskTool(this);
      this.tools.exit_plan_mode = createExitPlanModeTool(this);
    }
  }

  private provider(): Provider {
    return providerFor(this.model) === 'anthropic' ? this.anthropic : this.openai;
  }

  private specs(): ToolSpec[] {
    return Object.entries(this.tools)
      .filter(([name]) => name !== 'exit_plan_mode' || this.mode === 'plan')
      .map(([, t]) => t.spec);
  }

  setModel(model: string): void {
    providerFor(model); // throws on an unknown model before we commit to it
    this.model = model;
  }

  /**
   * A single completion with no tools and no transcript. Used to answer MCP
   * sampling requests, where a server asks the host to run an inference for it.
   * Billed to the same cost tracker — the user pays for it either way, so it
   * had better show up in /cost.
   */
  async complete(prompt: string, system: string, maxTokens = 1024): Promise<string> {
    const result = await this.provider().send({
      model: this.model,
      system,
      turns: [{ role: 'user', text: prompt }],
      tools: [],
      maxTokens,
      onDelta: () => {},
    });
    this.cost.add(this.model, result.usage);
    return result.text;
  }

  /** Spawn a child agent that shares this one's tools, model, and cost tracker. */
  fork(): Agent {
    const child = new Agent(this.cwd, this.settings, this.projectInstructions, '', '', {
      depth: this.depth + 1,
      costTracker: this.cost,
    });
    // Reuse the parent's already-constructed providers rather than rebuilding
    // them from credentials the child was not given.
    child.openai = this.openai;
    child.anthropic = this.anthropic;
    child.model = this.model;
    child.mode = this.mode;
    child.tools = Object.fromEntries(
      Object.entries(this.tools).filter(
        ([name]) => name !== 'exit_plan_mode' && (name !== 'task' || child.allowSubagents),
      ),
    );
    if (child.allowSubagents && !child.tools.task) child.tools.task = createTaskTool(child);
    return child;
  }

  contextTokens(): number {
    return this.lastInputTokens || estimateTokens(this.turns);
  }

  /** Summarize the older part of the transcript and drop it. */
  async compact(events: AgentEvents): Promise<void> {
    const before = this.turns.length;
    const { turns, compacted, droppedTurns } = await compactTurns(
      this.turns,
      this.settings.keepRecentTurns,
      async (older, instruction) => {
        const result = await this.provider().send({
          model: this.model,
          system: 'You are compacting a coding session transcript.',
          turns: [...older, { role: 'user', text: instruction }],
          tools: [],
          maxTokens: 2048,
          onDelta: () => {},
        });
        this.cost.add(this.model, result.usage);
        return result.text;
      },
    );

    if (!compacted) {
      // Nothing safe to drop yet — back off so this does not fire every round.
      this.compactFloor = Math.floor(Math.max(this.lastInputTokens, 1) * 1.5);
      events.onNotice('Nothing safe to compact yet — continuing.');
      return;
    }
    this.turns = turns;
    this.lastInputTokens = 0;
    this.compactFloor = 0;
    this.turnsAtLastCompact = turns.length;
    events.onNotice('Compacted ' + droppedTurns + ' of ' + before + ' turns into a summary.');
  }

  /**
   * Every tool call an assistant turn made must have a matching tool turn, or
   * the next request references a tool_use id that is not in the transcript and
   * is rejected. An interrupt can land between the two, so stub the gap.
   */
  settleInterruptedCalls(): void {
    const answered = new Set(
      this.turns.filter((t) => t.role === 'tool').map((t) => (t as { callId: string }).callId),
    );
    for (const turn of this.turns) {
      if (turn.role !== 'assistant') continue;
      for (const call of turn.toolCalls) {
        if (!answered.has(call.id)) {
          this.turns.push({
            role: 'tool',
            callId: call.id,
            name: call.name,
            output: '[Interrupted by user before this ran]',
            isError: true,
          });
          answered.add(call.id);
        }
      }
    }
  }

  /** Run one user request to completion, including any tool-use rounds. */
  async run(
    userInput: string,
    events: AgentEvents,
    signal?: AbortSignal,
    images?: ImageAttachment[],
  ): Promise<void> {
    const submit = await runHooks(
      'UserPromptSubmit',
      this.settings,
      { prompt: userInput },
      this.cwd,
    );
    for (const n of submit.notices) events.onNotice(n);
    if (submit.blocked) {
      events.onNotice(
        'Blocked by a UserPromptSubmit hook: ' + (submit.reason ?? 'no reason given'),
      );
      return;
    }

    this.turns.push(
      images?.length
        ? { role: 'user', text: userInput, images }
        : { role: 'user', text: userInput },
    );
    // A hook can inject context the model should see, without pretending the
    // user said it.
    if (submit.context) {
      this.turns.push({ role: 'user', text: '[hook context]\n' + submit.context });
    }

    const maxRounds = this.settings.maxTurns ?? DEFAULT_MAX_ITERATIONS;
    for (let i = 0; i < maxRounds; i++) {
      // Requires enough history to be worth summarizing as well as enough
      // tokens — otherwise a two-turn transcript trips the threshold, finds
      // nothing safe to drop, and raises the backoff floor for no reason.
      // Enough history to summarize, and enough new history since the last
      // compaction that we are not re-summarizing the same thing every round.
      const enoughHistory =
        this.turns.length > this.settings.keepRecentTurns + 2 &&
        this.turns.length >= this.turnsAtLastCompact + this.settings.keepRecentTurns + 2;
      if (
        this.settings.autoCompactAt > 0 &&
        enoughHistory &&
        this.lastInputTokens > Math.max(this.settings.autoCompactAt, this.compactFloor)
      ) {
        events.onNotice(
          'Context reached ' + this.lastInputTokens.toLocaleString() + ' tokens — compacting.',
        );
        await this.compact(events);
      }

      let result: AssistantResult;
      try {
        result = await this.provider().send({
          model: this.model,
          system:
            buildSystemPrompt(this.cwd, this.mode, this.projectInstructions, this.specs()) +
            (this.extraSystemPrompt ? '\n\n# Your role\n' + this.extraSystemPrompt : ''),
          turns: this.turns,
          tools: this.specs(),
          maxTokens: this.settings.maxTokens,
          signal,
          onDelta: events.onDelta,
          onReasoning: events.onReasoning,
        });
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
          this.settleInterruptedCalls();
          throw new InterruptedError();
        }
        throw err;
      }

      this.cost.add(this.model, result.usage);
      this.lastInputTokens = result.usage.input;
      this.turns.push({ role: 'assistant', text: result.text, toolCalls: result.toolCalls });
      events.onAssistantEnd();

      if (!result.toolCalls.length) {
        const stop = await runHooks('Stop', this.settings, {}, this.cwd);
        for (const n of stop.notices) events.onNotice(n);
        // A Stop hook that blocks is saying "you are not finished".
        if (stop.blocked) {
          this.turns.push({
            role: 'user',
            text: '[stop hook] ' + (stop.reason ?? 'Keep going.'),
          });
          continue;
        }
        return;
      }

      // Independent reads are run concurrently; anything that can change the
      // world stays sequential, because two writes to one file racing is not a
      // speed-up. Approval prompts are also serialised by construction: a
      // mutating call cannot start until the previous one has been answered.
      const concurrent: ToolCall[] = [];
      const sequential: ToolCall[] = [];
      for (const call of result.toolCalls) {
        (isConcurrencySafe(call) ? concurrent : sequential).push(call);
      }

      if (concurrent.length > 1) {
        await Promise.all(concurrent.map((call) => this.executeCall(call, events)));
      } else {
        for (const call of concurrent) await this.executeCall(call, events);
      }

      for (const call of sequential) {
        if (signal?.aborted) break;
        await this.executeCall(call, events);
      }

      // Checked between rounds so an interrupt lands before another model call.
      if (signal?.aborted) {
        this.settleInterruptedCalls();
        return;
      }
    }

    events.onNotice(
      'Stopped after ' +
        maxRounds +
        ' tool rounds. Send another message to continue,' +
        ' or raise maxTurns in settings.',
    );
  }

  private async executeCall(call: ToolCall, events: AgentEvents): Promise<void> {
    const impl = this.tools[call.name];
    if (!impl) {
      this.pushResult(call, 'Unknown tool: ' + call.name, true);
      return;
    }

    const decision = decide(call, this.settings, this.mode, this.cwd);

    if (decision.kind === 'deny') {
      events.onToolEnd(call, decision.reason, true);
      this.pushResult(call, 'Denied: ' + decision.reason, true);
      return;
    }

    if (decision.kind === 'ask') {
      const answer = await events.requestPermission(call, decision.rule, decision.preview);
      if (answer === 'deny') {
        events.onToolEnd(call, 'Rejected by user', true);
        this.pushResult(
          call,
          'The user rejected this action. Stop and ask what they would prefer.',
          true,
        );
        return;
      }
      if (answer === 'allow-always') {
        for (const rule of decision.rules) {
          if (!this.settings.allow.includes(rule)) this.settings.allow.push(rule);
          try {
            persistAllowRule(this.cwd, rule);
          } catch {
            events.onNotice('Could not persist the rule to .spider/settings.json');
          }
        }
      }
    }

    const pre = await runHooks('PreToolUse', this.settings, toolPayload(call), this.cwd);
    for (const n of pre.notices) events.onNotice(n);
    if (pre.blocked) {
      const reason = pre.reason ?? 'blocked by a PreToolUse hook';
      events.onToolEnd(call, reason, true);
      this.pushResult(call, 'Blocked by a hook: ' + reason, true);
      return;
    }

    events.onToolStart(call, describe(call));
    if (call.name === 'write_file' || call.name === 'edit_file') {
      const target = String(call.input.path ?? '');
      if (target) {
        this.checkpoints.backup(path.isAbsolute(target) ? target : path.join(this.cwd, target));
      }
    }
    const result = await impl.run(call.input, this.cwd, events);

    const post = await runHooks(
      'PostToolUse',
      this.settings,
      { ...toolPayload(call), tool_output: result.output, tool_is_error: result.isError },
      this.cwd,
    );
    for (const n of post.notices) events.onNotice(n);

    // A PostToolUse hook cannot un-run the tool, but it can tell the model what
    // it found — a failing test suite, a lint error in the file just written.
    const output =
      post.blocked || post.context
        ? result.output + '\n\n[hook] ' + (post.reason ?? post.context ?? '')
        : result.output;
    const isError = result.isError || post.blocked;

    events.onToolEnd(call, output, isError);
    this.pushResult(call, output, isError);
  }

  private pushResult(call: ToolCall, output: string, isError: boolean): void {
    this.turns.push({ role: 'tool', callId: call.id, name: call.name, output, isError });
  }

  /** Tool labels, for the UI. */
  toolNames(): string[] {
    return Object.keys(this.tools);
  }
}

/**
 * Can this call run alongside its siblings? Only if it observes: a read has no
 * ordering relationship with another read, while two edits absolutely do.
 */
function isConcurrencySafe(call: ToolCall): boolean {
  if (READ_TOOLS.has(call.name)) return true;
  if (call.name === 'bash') return classifyCommand(String(call.input.command ?? '')) === 'read';
  return false;
}

const READ_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
  'list_dir',
  'web_fetch',
  'web_search',
  'list_mcp_resources',
  'read_mcp_resource',
]);

export function describe(call: ToolCall): string {
  // Tools legitimately take no arguments — several MCP tools do — so this must
  // not assume `input` is present.
  const i = (call.input ?? {}) as Record<string, any>;
  switch (call.name) {
    case 'bash':
      return '$ ' + (i.command ?? '');
    case 'read_file':
      return 'read ' + i.path;
    case 'write_file':
      return 'write ' + i.path;
    case 'edit_file':
      return 'edit ' + i.path;
    case 'glob':
      return 'glob ' + i.pattern;
    case 'grep':
      return 'grep ' + i.pattern + (i.glob ? ' in ' + i.glob : '');
    case 'list_dir':
      return 'ls ' + (i.path || '.');
    case 'task':
      return 'subagent: ' + (i.description ?? 'delegated task');
    case 'exit_plan_mode':
      return 'present plan for approval';
    case 'todo_write':
      return 'update todo list';
    default:
      return call.name.startsWith('mcp__')
        ? call.name.replace(/^mcp__/, '').replace('__', ' · ')
        : call.name;
  }
}
