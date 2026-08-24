import type { ToolImpl } from '../tools/index.ts';
import type { PermissionMode } from '../config.ts';
import type { Agent, AgentEvents } from './loop.ts';

/** What the user chose when shown a finished plan. */
export type PlanAnswer = 'default' | 'acceptEdits' | 'auto' | 'reject';

/**
 * The `exit_plan_mode` tool — the missing half of plan mode.
 *
 * Without it, plan mode is a dead end: the agent investigates, presents a plan,
 * and the user has to type `/mode default` and ask the same question again to
 * act on it. Here the plan is presented as an approval, and approving flips the
 * permission mode and lets the same turn carry straight on into the work.
 *
 * Rejecting leaves the mode alone, so the user can redirect and keep planning.
 */
export function createExitPlanModeTool(agent: Agent): ToolImpl {
  return {
    spec: {
      name: 'exit_plan_mode',
      description: [
        'Call this when you have finished investigating and have a concrete plan ready.',
        'It shows the plan to the user and asks whether to start executing it.',
        'Only call it when the remaining work involves making changes — if the question was',
        'purely a question, just answer it. Do not call it to ask a clarifying question.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description:
              'The plan, in markdown. Concise and concrete — the steps you intend to take.',
          },
        },
        required: ['plan'],
        additionalProperties: false,
      },
    },

    async run(input, _cwd, events?: AgentEvents) {
      if (agent.mode !== 'plan') {
        return { output: 'Not in plan mode — no need to exit it.', isError: true };
      }
      const plan = String(input.plan ?? '').trim();
      if (!plan) return { output: 'exit_plan_mode needs a plan.', isError: true };

      if (!events?.requestPlanApproval) {
        // Headless, or a subagent: nobody is there to approve.
        return {
          output: 'No one is available to approve a plan in this context. Stay in plan mode.',
          isError: true,
        };
      }

      const answer = await events.requestPlanApproval(plan);
      if (answer === 'reject') {
        return {
          output:
            'The user did not approve the plan. Stay in plan mode and ask what they would change.',
          isError: true,
        };
      }

      agent.mode = answer as PermissionMode;
      events.onNotice('Plan approved — permission mode is now ' + answer + '.');
      return {
        output:
          'Plan approved. You are now in ' +
          answer +
          ' mode and may make changes. ' +
          'Carry out the plan without asking again whether to begin.',
        isError: false,
      };
    },
  };
}
