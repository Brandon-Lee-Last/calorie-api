import { notConfigured, upstreamFailed } from '../../core/errors';

/** The two things the API asks of a language model. Real calls go to Workers AI; tests use a fake. */
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
  ) {}

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
