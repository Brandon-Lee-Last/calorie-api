import { notConfigured, upstreamFailed } from '../../core/errors';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
/** What the safety model said: unsafe content comes with its hazard categories (Llama Guard's S1 to S14). */
export type Moderation = { safe: boolean; categories: string[] };

/** What the API asks of language models. Real calls go to Workers AI; tests use a fake. */
export interface AiClient {
  /** Ask for JSON that matches `schema`. Returns whatever the model produced; the caller validates it. */
  json(args: {
    system: string;
    user: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<unknown>;
  /** Ask for a short piece of plain text. */
  text(args: { system: string; user: string; maxTokens?: number }): Promise<string>;
  /** A conversation turn from the coaching model (bigger than the one used for text and JSON). */
  chat(args: { messages: ChatMessage[]; maxTokens?: number; temperature?: number }): Promise<string>;
  /** Ask JSON from the coaching model. */
  chatJson(args: {
    messages: ChatMessage[];
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<unknown>;
  /** Classify the last message of a conversation with the safety model. */
  moderate(messages: { role: 'user' | 'assistant'; content: string }[]): Promise<Moderation>;
}

/** Llama Guard answers "safe", or "unsafe" and the categories on the next line; some versions answer JSON. */
export function parseModeration(out: unknown): Moderation {
  if (out && typeof out === 'object' && 'safe' in out) {
    const o = out as { safe: unknown; categories?: unknown };
    return { safe: o.safe === true, categories: Array.isArray(o.categories) ? o.categories.map(String) : [] };
  }
  const text = String(out ?? '')
    .trim()
    .toLowerCase();
  if (text.startsWith('safe')) return { safe: true, categories: [] };
  if (text.startsWith('unsafe'))
    return { safe: false, categories: (text.match(/s\d{1,2}/g) ?? []).map((c) => c.toUpperCase()) };
  throw upstreamFailed('Workers AI', 'The safety check gave an answer we could not read');
}

type AiRunner = { run(model: string, input: Record<string, unknown>): Promise<unknown> };

function extractResponse(result: unknown): unknown {
  if (result && typeof result === 'object' && 'response' in result)
    return (result as { response: unknown }).response;
  return result;
}

/**
 * Cloudflare Workers AI. The model id comes from configuration (`AI_TEXT_MODEL`) so it can change without a code change.
 * Not exercised by the automated tests, which cannot reach the service: check it on stage with a real call.
 */
export class WorkersAiClient implements AiClient {
  constructor(
    private ai: AiRunner | undefined,
    private model: string,
    private coachModel: string = model,
    private guardModel: string = '@cf/meta/llama-guard-3-8b',
  ) {}

  /** One call to Workers AI; anything that goes wrong on its side becomes a 502 the app can explain. */
  private async call(model: string, input: Record<string, unknown>): Promise<unknown> {
    try {
      return extractResponse(await this.runner().run(model, input));
    } catch (e) {
      if (e instanceof Error && e.name === 'AppError') throw e;
      throw upstreamFailed('Workers AI');
    }
  }

  async chat(args: { messages: ChatMessage[]; maxTokens?: number; temperature?: number }): Promise<string> {
    const out = await this.call(this.coachModel, {
      messages: args.messages,
      max_tokens: args.maxTokens ?? 450,
      temperature: args.temperature ?? 0.6,
    });
    if (typeof out !== 'string' || !out.trim())
      throw upstreamFailed('Workers AI', 'The AI service returned no text');
    return out;
  }

  async chatJson(args: {
    messages: ChatMessage[];
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<unknown> {
    const out = await this.call(this.coachModel, {
      messages: args.messages,
      response_format: { type: 'json_schema', json_schema: args.schema },
      max_tokens: args.maxTokens ?? 1200,
      temperature: 0.4,
    });
    if (typeof out !== 'string') return out;
    try {
      return JSON.parse(out);
    } catch {
      throw upstreamFailed('Workers AI', 'The AI service returned something that was not valid JSON');
    }
  }

  async moderate(messages: { role: 'user' | 'assistant'; content: string }[]): Promise<Moderation> {
    return parseModeration(await this.call(this.guardModel, { messages }));
  }

  private runner(): AiRunner {
    if (!this.ai) throw notConfigured('Workers AI');
    return this.ai;
  }

  async json(args: {
    system: string;
    user: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<unknown> {
    let out: unknown;
    try {
      out = extractResponse(
        await this.runner().run(this.model, {
          messages: [
            { role: 'system', content: args.system },
            { role: 'user', content: args.user },
          ],
          response_format: { type: 'json_schema', json_schema: args.schema },
          max_tokens: args.maxTokens ?? 800,
        }),
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'AppError') throw e;
      throw upstreamFailed('Workers AI');
    }
    if (typeof out === 'string') {
      try {
        return JSON.parse(out);
      } catch {
        throw upstreamFailed('Workers AI', 'The AI service returned something that was not valid JSON');
      }
    }
    return out;
  }

  async text(args: { system: string; user: string; maxTokens?: number }): Promise<string> {
    let out: unknown;
    try {
      out = extractResponse(
        await this.runner().run(this.model, {
          messages: [
            { role: 'system', content: args.system },
            { role: 'user', content: args.user },
          ],
          max_tokens: args.maxTokens ?? 300,
        }),
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'AppError') throw e;
      throw upstreamFailed('Workers AI');
    }
    if (typeof out !== 'string' || !out.trim())
      throw upstreamFailed('Workers AI', 'The AI service returned no text');
    return out;
  }
}
