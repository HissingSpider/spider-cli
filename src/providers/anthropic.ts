import { postSSE } from './http.ts';
import type { AssistantResult, Provider, StreamOpts, ToolCall, Turn } from './types.ts';
import { SpiderAIError } from './types.ts';
import { asNumber, asRecord, asString } from '../errors.ts';

/**
 * Only Haiku 4.5 is entitled on a SpiderAI student key, and only under its full
 * dated ID — the `claude-haiku-4-5` alias and every Sonnet/Opus ID are rejected
 * with "Sub-product ... is not allowed to be used for the ai resource".
 */
export const ANTHROPIC_MODELS = ['claude-haiku-4-5-20251001'];

type Block = Record<string, unknown>;

function toMessages(turns: Turn[]): unknown[] {
  const msgs: { role: string; content: Block[] }[] = [];
  const push = (role: string, block: Block) => {
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content.push(block);
    else msgs.push({ role, content: [block] });
  };

  for (const t of turns) {
    if (t.role === 'user') {
      push('user', { type: 'text', text: t.text });
      for (const img of t.images ?? []) {
        push('user', {
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.data },
        });
      }
    } else if (t.role === 'assistant') {
      if (t.text.trim()) push('assistant', { type: 'text', text: t.text });
      for (const c of t.toolCalls) {
        push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.input });
      }
    } else {
      // tool_result blocks belong to a user-role message, and consecutive
      // results must be merged into one message or the API rejects them.
      push('user', {
        type: 'tool_result',
        tool_use_id: t.callId,
        content: t.output,
        is_error: t.isError,
      });
    }
  }
  return msgs;
}

export function createAnthropicProvider(baseUrl: string, apiKey: string): Provider {
  return {
    id: 'anthropic',
    models: ANTHROPIC_MODELS,
    async send(opts: StreamOpts): Promise<AssistantResult> {
      const body: Record<string, unknown> = {
        model: opts.model,
        // The system prompt and tool list are identical on every round of a
        // turn, and they are the bulk of the input. Marking the end of the
        // system block as a cache breakpoint means later rounds re-read it from
        // cache instead of paying for it again.
        system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
        messages: toMessages(opts.turns),
        max_tokens: opts.maxTokens,
      };
      if (opts.tools.length) {
        body.tools = opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
      }

      let text = '';
      const toolCalls: ToolCall[] = [];
      const usage = { input: 0, output: 0 };
      let stopReason = 'end_turn';

      // tool_use arguments arrive as a stream of partial JSON fragments keyed by block index.
      const partial = new Map<number, { id: string; name: string; json: string }>();

      const stream = postSSE(
        `${baseUrl}/messages`,
        { Authorization: `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01' },
        body,
        opts.signal,
      );

      for await (const { data } of stream) {
        switch (data?.type) {
          case 'message_start': {
            // Cached input is billed differently but is still input the
            // request carried; counting only the uncached part would make
            // /context under-report and auto-compaction fire late.
            const billed = asRecord(asRecord(data.message)?.usage);
            usage.input =
              (asNumber(billed?.input_tokens) ?? 0) +
              (asNumber(billed?.cache_read_input_tokens) ?? 0) +
              (asNumber(billed?.cache_creation_input_tokens) ?? 0);
            break;
          }
          case 'content_block_start': {
            const block = asRecord(data.content_block);
            const index = asNumber(data.index);
            if (block?.type === 'tool_use' && index !== undefined) {
              partial.set(index, {
                id: String(block.id ?? ''),
                name: String(block.name ?? ''),
                json: '',
              });
            }
            break;
          }
          case 'content_block_delta': {
            const delta = asRecord(data.delta);
            const index = asNumber(data.index);
            if (delta?.type === 'text_delta') {
              const chunk = asString(delta.text) ?? '';
              text += chunk;
              opts.onDelta(chunk);
            } else if (delta?.type === 'input_json_delta' && index !== undefined) {
              const pending = partial.get(index);
              if (pending) pending.json += asString(delta.partial_json) ?? '';
            }
            break;
          }
          case 'content_block_stop': {
            const index = asNumber(data.index);
            const pending = index === undefined ? undefined : partial.get(index);
            if (pending && index !== undefined) {
              let input: Record<string, unknown> = {};
              try {
                input = pending.json ? JSON.parse(pending.json) : {};
              } catch {
                /* malformed arguments surface as an empty input */
              }
              toolCalls.push({ id: pending.id, name: pending.name, input });
              partial.delete(index);
            }
            break;
          }
          case 'message_delta':
            usage.output = asNumber(asRecord(data.usage)?.output_tokens) ?? usage.output;
            stopReason = asString(asRecord(data.delta)?.stop_reason) ?? stopReason;
            break;
          case 'error':
            throw new SpiderAIError(asString(asRecord(data.error)?.message) ?? 'Stream error');
        }
      }

      return { text, toolCalls, usage, stopReason };
    },
  };
}
