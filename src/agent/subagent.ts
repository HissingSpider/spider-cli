import type { ToolImpl } from '../tools/index.ts';
import type { Agent, AgentEvents } from './loop.ts';
import { describe } from './loop.ts';
import { loadAgents, type AgentDefinition } from '../agents.ts';

/**
 * The `task` tool. Delegates a self-contained piece of work to a child agent
 * with its own transcript, so a long search or multi-file survey does not fill
 * the parent's context with intermediate tool output — only the final report
 * comes back.
 *
 * The child inherits the parent's tools minus `task` itself, so a subagent
 * cannot spawn further subagents.
 */
export function createTaskTool(parent: Agent): ToolImpl {
  const defined: AgentDefinition[] = loadAgents(parent.cwd);
  const types = ['general', ...defined.map((d) => d.name)];

  return {
    spec: {
      name: 'task',
      description: [
        'Delegate a self-contained task to a subagent with its own context.',
        'Use it for open-ended searching or multi-file investigation where you only need the conclusion.',
        'The subagent cannot ask the user questions, so the prompt must be complete and specific,',
        'and it returns a single final report — nothing it does mid-task is visible to you.',
        defined.length
          ? 'Available agent types: ' +
            defined.map((d) => d.name + ' (' + d.description + ')').join('; ') + '.'
          : '',
      ].filter(Boolean).join(' '),
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'A 3-5 word label for the task, shown to the user',
          },
          prompt: {
            type: 'string',
            description: 'The full instructions for the subagent, including what to report back',
          },
          agent_type: {
            type: 'string',
            enum: types,
            description: 'Which agent to use. "general" inherits the full toolset.',
          },
        },
        required: ['description', 'prompt'],
        additionalProperties: false,
      },
    },

    async run(input, _cwd, events?: AgentEvents) {
      const wanted = String(input.agent_type ?? 'general');
      const def = defined.find((d) => d.name === wanted);
      if (wanted !== 'general' && !def) {
        return {
          output: 'No agent type "' + wanted + '". Available: ' + types.join(', '),
          isError: true,
        };
      }

      const child = parent.fork();
      const label = String(input.description ?? 'task');

      if (def) {
        // A definition that names its tools is a restriction, not a suggestion:
        // a read-only reviewer that can still call write_file is not read-only.
        if (def.tools) {
          const allowed = new Set(def.tools);
          child.tools = Object.fromEntries(
            Object.entries(child.tools).filter(([name]) => allowed.has(name)),
          );
        }
        child.extraSystemPrompt = def.prompt;
      }

      try {
        await child.run(String(input.prompt ?? ''), {
          // The child's narration is suppressed; only its tool activity is
          // surfaced, indented, so the user can see it is doing something.
          onDelta: () => {},
          onAssistantEnd: () => {},
          onToolStart: (call) => events?.onNotice('  ↳ ' + label + ': ' + describe(call)),
          onToolEnd: () => {},
          onNotice: (t) => events?.onNotice('  ↳ ' + t),
          // Approvals still route to the user — a subagent gets no extra authority.
          requestPermission: events
            ? events.requestPermission
            : async () => 'deny' as const,
        });

        for (let i = child.turns.length - 1; i >= 0; i--) {
          const t = child.turns[i];
          if (t.role === 'assistant' && t.text.trim()) {
            return { output: t.text.trim(), isError: false };
          }
        }
        return { output: 'Subagent finished without producing a report.', isError: true };
      } catch (err: any) {
        return { output: 'Subagent failed: ' + (err?.message ?? String(err)), isError: true };
      }
    },
  };
}
