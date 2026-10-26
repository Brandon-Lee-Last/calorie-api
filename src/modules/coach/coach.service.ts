import { badRequest } from '../../core/errors';
import { newId } from '../../core/ids';
import type { Logger } from '../../core/logger';
import { addDays, localDateIn, type Clock } from '../../core/time';
import { streakDays } from '../../lib/insights';
import type { AiClient, ChatMessage, Moderation } from '../ai/ai.client';
import type { BodyRepo } from '../body/body.repo';
import type { DiaryRepo } from '../diary/diary.repo';
import type { MealsRepo } from '../meals/meals.repo';
import type { UsersRepo } from '../users/users.repo';
import type { SessionsRepo } from '../workouts/sessions.repo';
import type { CoachKind, CoachRepo, CoachRow } from './coach.repo';
import { PROMPT_MARKERS, systemPrompt, type CoachFacts } from './prompt';
import {
  attackSignals,
  BLOCKED_CATEGORIES,
  checkOutput,
  cleanInput,
  crisisIn,
  CRISIS_REPLY,
  FALLBACK_REPLY,
  SCOPE_REPLY,
  SELF_HARM_CATEGORY,
} from './safety';

export const MAX_MESSAGE = 1000;
/** Words that show a message is about food, eating or weight. */
const FOOD_TALK =
  /\b(calorie|kcal|diet|eat|eating|food|meal|weight|kg|kilo|fast|fasting|starv\w*|thin|slim|lose|losing|carb|sugar|protein)/i;
/** How much of the conversation the model sees: the last few exchanges that were ordinary chat. */
const HISTORY_MESSAGES = 8;
export const RETENTION_MS = 90 * 24 * 3600_000;

/** Taking from the person's daily allowance, done only when a model is about to be asked. */
export type Allowance = { take(): Promise<{ used: number; limit: number }>; giveBack(): Promise<void> };

export const toMessage = (r: CoachRow) => ({
  id: r.id,
  role: r.role,
  content: r.content,
  kind: r.kind,
  createdAt: r.created_at,
});

function partOfDay(timeZone: string, ms: number): { weekday: string; partOfDay: string } {
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone,
    weekday: 'long',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(ms);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 12);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  return {
    weekday,
    partOfDay:
      hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 22 ? 'evening' : 'night',
  };
}

export class CoachService {
  constructor(
    private repo: CoachRepo,
    private ai: AiClient,
    private users: UsersRepo,
    private diary: DiaryRepo,
    private body: BodyRepo,
    private sessions: SessionsRepo,
    private meals: MealsRepo,
    private clock: Clock,
    private logger: Logger,
  ) {}

  async history(userId: string) {
    return { items: (await this.repo.latest(userId, 60)).map(toMessage) };
  }

  async clear(userId: string) {
    await this.repo.clear(userId);
  }

  /**
   * One message to Pango and the reply. In order: clean the text; answer people in crisis and obvious attacks with fixed
   * replies (no model, no charge); then take from the allowance, check the message with Llama Guard, ask the coaching
   * model with the server's own copy of the conversation, and check the answer (rules, then Llama Guard) before saving it.
   */
  async ask(userId: string, input: { message: string; planStyle?: string | null }, allowance: Allowance) {
    const text = cleanInput(input.message, MAX_MESSAGE);
    if (!text) throw badRequest('Write a message for Pango');

    const crisis = crisisIn(text);
    if (crisis) return this.save(userId, text, CRISIS_REPLY[crisis], 'crisis', [`crisis:${crisis}`], null);
    const attacks = attackSignals(text);
    if (attacks.length)
      return this.save(
        userId,
        text,
        SCOPE_REPLY,
        'scope',
        attacks.map((a) => `attack:${a}`),
        null,
      );

    const usage = await allowance.take();
    try {
      const [facts, history] = await Promise.all([
        this.facts(userId, input.planStyle ?? null),
        this.conversation(userId),
      ]);
      const r = await this.respond(text, facts, history);
      return this.save(userId, text, r.reply, r.kind, r.flags, usage);
    } catch (e) {
      await allowance.giveBack(); // a failed call does not use up the allowance
      throw e;
    }
  }

  /**
   * The model's part, for a message that passed the fixed checks: Llama Guard on the message, the coaching model with
   * the rules and the person's data, then the answer's checks (rules, then Llama Guard). Used by `ask` and the red-team eval.
   */
  async respond(
    text: string,
    facts: CoachFacts,
    history: ChatMessage[],
  ): Promise<{ reply: string; kind: CoachKind; flags: string[] }> {
    const guardIn = await this.guard([{ role: 'user', content: text }]);
    const inFlags = (guardIn?.safe === false ? guardIn.categories : []).map((c) => `guard-in:${c}`);
    let care = false;
    if (guardIn && !guardIn.safe) {
      if (guardIn.categories.some((c) => BLOCKED_CATEGORIES.has(c)))
        return { reply: SCOPE_REPLY, kind: 'scope', flags: inFlags };
      // Llama Guard's S11 covers disordered eating as well as suicide: about food, Pango answers with extra care (and the
      // answer is still checked); about anything else, the person gets helplines.
      if (guardIn.categories.includes(SELF_HARM_CATEGORY)) {
        if (!FOOD_TALK.test(text))
          return { reply: CRISIS_REPLY['self-harm'], kind: 'crisis', flags: inFlags };
        care = true;
      }
    }
    const canary = `PG-${crypto.randomUUID().slice(0, 8)}`;
    const floorKcal = facts.sex === 'male' ? 1500 : 1200;
    const answer = await this.ai.chat({
      messages: [
        { role: 'system', content: systemPrompt(facts, { canary, floorKcal, care }) },
        ...history,
        { role: 'user', content: text },
      ],
      maxTokens: 450,
    });
    const checked = checkOutput(answer, {
      canary,
      floorKcal,
      promptMarkers: PROMPT_MARKERS,
      minor: facts.age != null && facts.age < 18,
    });
    const flags = [...inFlags, ...(care ? ['care'] : []), ...checked.flags];
    if (checked.blocked) {
      this.logger.warn('coach answer replaced', { flags });
      return { reply: checked.text, kind: 'blocked', flags };
    }
    const guardOut = await this.guard([
      { role: 'user', content: text },
      { role: 'assistant', content: checked.text },
    ]);
    if (!guardOut) flags.push('guard-unavailable');
    else if (!guardOut.safe && guardOut.categories.some((c) => c !== 'S6')) {
      // S6 (specialised advice) is what a coach gives; anything else unsafe in an answer is replaced.
      flags.push(...guardOut.categories.map((c) => `guard-out:${c}`));
      this.logger.warn('coach answer replaced', { flags });
      return { reply: FALLBACK_REPLY, kind: 'blocked', flags };
    }
    return { reply: checked.text, kind: 'chat', flags };
  }

  /**
   * The whole pipeline for a made-up person, saving nothing and charging nobody: for the red-team eval against the
   * real models on stage (admin only).
   */
  async evaluate(input: { message: string; age?: number | null; entries?: string[] }) {
    const text = cleanInput(input.message, MAX_MESSAGE);
    if (!text) throw badRequest('Write a message');
    const crisis = crisisIn(text);
    if (crisis) return { reply: CRISIS_REPLY[crisis], kind: 'crisis' as const, flags: [`crisis:${crisis}`] };
    const attacks = attackSignals(text);
    if (attacks.length)
      return { reply: SCOPE_REPLY, kind: 'scope' as const, flags: attacks.map((a) => `attack:${a}`) };
    const facts: CoachFacts = {
      goal: 'lose',
      rateKgPerWeek: 0.5,
      targets: { calories: 1850, proteinG: 130, carbG: 190, fatG: 60 },
      age: input.age ?? 34,
      sex: 'female',
      heightCm: 168,
      weightKg: 78,
      weightMonthAgoKg: 79.4,
      today: {
        weekday: 'Tuesday',
        partOfDay: 'evening',
        calories: 1240,
        proteinG: 70,
        entries: input.entries ?? ['Oats with banana', 'Chicken wrap'],
      },
      week: { daysLogged: 6, averageCalories: 1790, proteinDaysOnTarget: 3 },
      workouts: { count: 2, minutes: 75, last: 'Upper body' },
      streakDays: 12,
      planStyle: 'Balanced',
    };
    return this.respond(text, facts, []);
  }

  /** Llama Guard's view, or null if it could not be asked (the rule-based checks still apply then). */
  private async guard(
    messages: { role: 'user' | 'assistant'; content: string }[],
  ): Promise<Moderation | null> {
    try {
      return await this.ai.moderate(messages);
    } catch (e) {
      this.logger.warn('coach safety check unavailable', {
        message: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  private async save(
    userId: string,
    text: string,
    reply: string,
    kind: CoachKind,
    flags: string[],
    usage: { used: number; limit: number } | null,
  ) {
    const now = this.clock.now();
    const asked: CoachRow = {
      id: newId(now),
      user_id: userId,
      role: 'user',
      content: text,
      kind: 'chat',
      flags: '[]',
      created_at: now,
    };
    const answered: CoachRow = {
      id: newId(now),
      user_id: userId,
      role: 'assistant',
      content: reply,
      kind,
      flags: JSON.stringify(flags),
      created_at: now + 1,
    };
    await this.repo.add([asked, answered]);
    return { message: toMessage(asked), reply: toMessage(answered), usage };
  }

  /** The recent conversation for the model: only exchanges that were ordinary chat, so a turned-away attack is not replayed. */
  private async conversation(userId: string): Promise<ChatMessage[]> {
    const rows = await this.repo.latest(userId, HISTORY_MESSAGES * 2);
    const out: ChatMessage[] = [];
    for (let i = 0; i + 1 < rows.length; i++) {
      const q = rows[i]!;
      const a = rows[i + 1]!;
      if (q.role === 'user' && a.role === 'assistant') {
        if (a.kind === 'chat')
          out.push({ role: 'user', content: q.content }, { role: 'assistant', content: a.content });
        i++;
      }
    }
    return out.slice(-HISTORY_MESSAGES);
  }

  /** What the coach may know about the person, from their own records only. */
  async facts(userId: string, planStyle: string | null): Promise<CoachFacts> {
    const now = this.clock.now();
    const p = await this.users.getProfile(userId);
    const tz = p?.timezone ?? 'UTC';
    const today = localDateIn(tz, now);
    const [history, entries, weights, sessions, diets] = await Promise.all([
      this.diary.daySummary(userId, addDays(today, -89), today),
      this.diary.list(userId, today, today),
      this.body.listWeight(userId, addDays(today, -40), today),
      this.sessions.list(userId, addDays(today, -6), today),
      planStyle ? this.meals.diets() : Promise.resolve([]),
    ]);
    const targets = {
      calories: p?.calorie_goal ?? 2000,
      proteinG: p?.protein_goal_g ?? 125,
      carbG: p?.carb_goal_g ?? 225,
      fatG: p?.fat_goal_g ?? 67,
    };
    const week = history.filter((d) => d.local_date >= addDays(today, -6) && d.entries > 0);
    const todayRow = history.find((d) => d.local_date === today);
    const latest = weights.at(-1);
    const monthAgo = weights.filter((w) => w.local_date <= addDays(today, -25)).at(-1);
    const finished = sessions.filter((s) => s.finished_at);
    let style: string | null = null;
    for (const d of diets)
      if (d.slug === planStyle)
        try {
          style = String(JSON.parse(d.body).title ?? '') || null;
        } catch {
          style = null;
        }
    return {
      goal: p?.goal ?? 'maintain',
      rateKgPerWeek: p?.goal_rate_kg_per_week ?? 0,
      targets,
      age: p?.birth_year ? new Date(now).getUTCFullYear() - p.birth_year : null,
      sex: p?.sex === 'female' || p?.sex === 'male' ? p.sex : null,
      heightCm: p?.height_cm ?? null,
      weightKg: latest?.weight_kg ?? p?.weight_kg ?? null,
      weightMonthAgoKg: monthAgo && monthAgo !== latest ? monthAgo.weight_kg : null,
      today: {
        ...partOfDay(tz, now),
        calories: todayRow?.calories ?? 0,
        proteinG: todayRow?.protein_g ?? 0,
        entries: entries.slice(-6).map((e) => e.name),
      },
      week: {
        daysLogged: week.length,
        averageCalories: week.length ? week.reduce((s, d) => s + d.calories, 0) / week.length : null,
        proteinDaysOnTarget: week.filter((d) => d.protein_g >= targets.proteinG * 0.9).length,
      },
      workouts: {
        count: finished.length,
        minutes: finished.reduce(
          (s, x) => s + Math.max(0, ((x.finished_at ?? x.started_at) - x.started_at) / 60000),
          0,
        ),
        last: finished.at(-1)?.title ?? null,
      },
      streakDays: streakDays(
        new Set(history.filter((d) => d.entries > 0).map((d) => d.local_date)),
        today,
        90,
      ),
      planStyle: style,
    };
  }

  /** Old conversations are not kept for ever. */
  purge() {
    return this.repo.purgeBefore(this.clock.now() - RETENTION_MS);
  }
}
