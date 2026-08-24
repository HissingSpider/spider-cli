export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };

/** An image attached to a user turn, already base64-encoded. */
export type ImageAttachment = { mimeType: string; data: string; name: string };

export type Turn =
  | { role: 'user'; text: string; images?: ImageAttachment[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; output: string; isError: boolean };

export type Usage = { input: number; output: number };

export type AssistantResult = {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: string;
};

export type StreamOpts = {
  model: string;
  system: string;
  turns: Turn[];
  tools: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  /** Reasoning summary text, where the provider emits it. */
  onReasoning?: (text: string) => void;
};

export interface Provider {
  id: 'openai' | 'anthropic';
  models: string[];
  send(opts: StreamOpts): Promise<AssistantResult>;
}

/**
 * SpiderAI returns gateway errors as HTTP 200 with an error object in the body,
 * so a plain `res.ok` check reports success on a failed call. Every response
 * body has to be inspected directly.
 */
export class SpiderAIError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'SpiderAIError';
  }
}

export function throwIfErrorBody(body: any): void {
  if (body && typeof body === 'object' && body.error) {
    const e = body.error;
    const msg = typeof e === 'string' ? e : (e.message ?? JSON.stringify(e));
    throw new SpiderAIError(msg, typeof e === 'object' ? e.code : undefined);
  }
  if (body && typeof body === 'object' && typeof body.detail === 'string') {
    throw new SpiderAIError(body.detail);
  }
}
