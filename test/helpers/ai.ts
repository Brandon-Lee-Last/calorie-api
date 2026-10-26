import { upstreamFailed } from '../../src/core/errors';
import type { AiClient, ChatMessage, Moderation } from '../../src/modules/ai/ai.client';

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

  chatCalls: ChatMessage[][] = [];
  /** The coach's reply: a fixed text, or worked out from the conversation (to play a model that obeys an attack). */
  chatAnswer: string | ((messages: ChatMessage[]) => string) = 'Aim for a palm of protein at each meal.';
  async chat(args: { messages: ChatMessage[] }) {
    this.chatCalls.push(args.messages);
    if (this.fail) throw upstreamFailed('Workers AI');
    return typeof this.chatAnswer === 'function' ? this.chatAnswer(args.messages) : this.chatAnswer;
  }

  chatJsonCalls: { messages: ChatMessage[]; schema: Record<string, unknown> }[] = [];
  chatJsonAnswer: unknown = {};
  async chatJson(args: { messages: ChatMessage[]; schema: Record<string, unknown> }) {
    this.chatJsonCalls.push(args);
    if (this.fail) throw upstreamFailed('Workers AI');
    return typeof this.chatJsonAnswer === 'function'
      ? (this.chatJsonAnswer as (m: ChatMessage[]) => unknown)(args.messages)
      : this.chatJsonAnswer;
  }

  moderateCalls: { role: 'user' | 'assistant'; content: string }[][] = [];
  /** What the safety model says about a conversation (safe unless told otherwise). */
  moderation: (messages: { role: 'user' | 'assistant'; content: string }[]) => Moderation = () => ({
    safe: true,
    categories: [],
  });
  guardFail = false;
  async moderate(messages: { role: 'user' | 'assistant'; content: string }[]) {
    this.moderateCalls.push(messages);
    if (this.guardFail) throw upstreamFailed('Workers AI');
    return this.moderation(messages);
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
