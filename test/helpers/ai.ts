import { upstreamFailed } from '../../src/core/errors';
import type { AiClient } from '../../src/modules/ai/ai.client';

/** A stand-in for the language model: returns what it is told to, remembers what it was asked. */
export class FakeAi implements AiClient {
  jsonCalls: { system: string; user: string; schema: Record<string, unknown> }[] = [];
  textCalls: { system: string; user: string }[] = [];
  jsonAnswer: unknown = { items: [] };
  textAnswer = 'You had a steady week.';
  fail = false;

  async json(args: { system: string; user: string; schema: Record<string, unknown> }) {
    this.jsonCalls.push(args);
    if (this.fail) throw upstreamFailed('Workers AI');
    return typeof this.jsonAnswer === 'function' ? (this.jsonAnswer as () => unknown)() : this.jsonAnswer;
  }

  async text(args: { system: string; user: string }) {
    this.textCalls.push(args);
    if (this.fail) throw upstreamFailed('Workers AI');
    return this.textAnswer;
  }
}

export const toastItem = {
  name: 'Toast with peanut butter',
  quantityText: '2 slices',
  quantityG: 90,
  calories: 330,
  proteinG: 12,
  carbG: 36,
  fatG: 15,
  confidence: 'medium',
}; // fmt: skip
