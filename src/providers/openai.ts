import { postSSE } from './http.ts';
import type { AssistantResult, Provider, StreamOpts, ToolCall, Turn } from './types.ts';
import { SpiderAIError } from './types.ts';

/** Models confirmed reachable on a SpiderAI student key. There is no /v1/models to query. */
export const OPENAI_MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'];

function toInput(turns: Turn[]): unknown[] {
  const items: unknown[] = [];
  for (const t of turns) {
    if (t.role === 'user') {
      const content: any[] = [{ type: 'input_text', text: t.text }];
      for (const img of t.images ?? []) {
        content.push({
          type: 'input_image',
          image_url: 'data:' + img.mimeType + ';base64,' + img.data,
        });
      }
      items.push({ role: 'user', content });
    } else if (t.role === 'assistant') {
      if (t.text.trim()) {
        items.push({ role: 'assistant', content: [{ type: 'output_text', text: t.text }] });
      }
      for (const c of t.toolCalls) {
        items.push({
          type: 'function_call',
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.input),
        });
      }
    } else {
      items.push({ type: 'function_call_output', call_id: t.callId, output: t.output });
    }
  }
  return items;
}

export function createOpenAIProvider(baseUrl: string, apiKey: string): Provider {
  return {
    id: 'openai',
    models: OPENAI_MODELS,
    async send(opts: StreamOpts): Promise<AssistantResult> {
      const body: Record<string, unknown> = {
        model: opts.model,
        instructions: opts.system,
        input: toInput(opts.turns),
        max_output_tokens: opts.maxTokens,
      };
      if (opts.tools.length) {
        body.tools = opts.tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }));
      }

      let text = '';
      const toolCalls: ToolCall[] = [];
      let usage = { input: 0, output: 0 };
      let stopReason = 'end_turn';

      const stream = postSSE(
        `${baseUrl}/responses`,
        { Authorization: `Bearer ${apiKey}` },
        body,
        opts.signal,
      );

      for await (const { data } of stream) {
        switch (data?.type) {
          // Reasoning summaries arrive on their own event stream. Showing
          // them is the difference between watching a spinner and seeing what
          // the model is actually considering.
          case 'response.reasoning_summary_text.delta':
            opts.onReasoning?.(String(data.delta ?? ''));
            break;
          case 'response.reasoning_summary_part.done':
            opts.onReasoning?.('\n');
            break;
          case 'response.output_text.delta':
            if (typeof data.delta === 'string') {
              text += data.delta;
              opts.onDelta(data.delta);
            }
            break;
          case 'response.failed':
          case 'error':
            throw new SpiderAIError(
              data.response?.error?.message ?? data.message ?? 'Response failed',
            );
          case 'response.completed':
          case 'response.incomplete': {
            const r = data.response ?? {};
            for (const item of r.output ?? []) {
              if (item.type === 'function_call') {
                let input: Record<string, unknown> = {};
                try {
                  input = JSON.parse(item.arguments || '{}');
                } catch {
                  /* malformed arguments surface as an empty input */
                }
                toolCalls.push({ id: item.call_id, name: item.name, input });
              }
            }
            usage = {
              input: r.usage?.input_tokens ?? 0,
              output: r.usage?.output_tokens ?? 0,
            };
            stopReason = toolCalls.length ? 'tool_use' : (r.status ?? 'completed');
            break;
          }
        }
      }

      return { text, toolCalls, usage, stopReason };
    },
  };
}
