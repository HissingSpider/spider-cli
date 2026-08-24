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

export function throwIfErrorBody(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  const record = body as Record<string, unknown>;

  const error = record.error;
  if (error) {
    // The gateway sends either a bare string or {code, message}.
    if (typeof error === 'string') throw new SpiderAIError(error);
    const details = error as Record<string, unknown>;
    const message = typeof details.message === 'string' ? details.message : JSON.stringify(error);
    const code = typeof details.code === 'number' ? details.code : undefined;
    throw new SpiderAIError(message, code);
  }

  // FastAPI's own rejections (a bad auth header, an unknown route) use `detail`.
  if (typeof record.detail === 'string') throw new SpiderAIError(record.detail);
}
