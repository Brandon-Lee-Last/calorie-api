import { subscriptionRequired } from '../../core/errors';
import { addDays, localDateIn, type Clock } from '../../core/time';
import {
  fillDays,
  highlights,
  streakDays,
  summarizeWeek,
  weightChange,
  type DayTotals,
} from '../../lib/insights';
import { isAppError } from '../../core/errors';
import type { AiService } from '../ai/ai.service';
import type { BodyRepo } from '../body/body.repo';
import type { DiaryRepo } from '../diary/diary.repo';
import type { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { UsersRepo } from '../users/users.repo';
import type { SessionsRepo } from '../workouts/sessions.repo';

export class InsightsService {
  constructor(
    private diary: DiaryRepo,
    private body: BodyRepo,
    private sessions: SessionsRepo,
    private users: UsersRepo,
    private subscriptions: SubscriptionsService,
    private ai: AiService,
    private clock: Clock,
  ) {}

  private async context(userId: string) {
    const profile = await this.users.getProfile(userId);
    const tz = profile?.timezone ?? 'UTC';
    return {
      today: localDateIn(tz, this.clock.now()),
      goals: {
        calories: profile?.calorie_goal ?? 2000,
        proteinG: profile?.protein_goal_g ?? 125,
        carbG: profile?.carb_goal_g ?? 225,
        fatG: profile?.fat_goal_g ?? 67,
      }, // fmt: skip
    };
  }

  private async totalsFor(userId: string, from: string, to: string): Promise<DayTotals[]> {
    const [days, water] = await Promise.all([
      this.diary.daySummary(userId, from, to),
      this.diary.waterByDay(userId, from, to),
    ]);
    const waterBy = new Map(water.map((w) => [w.local_date, w.ml]));
    const out: DayTotals[] = days.map((d) => ({
      localDate: d.local_date,
      entries: d.entries,
      calories: Math.round(d.calories * 10) / 10,
      proteinG: Math.round(d.protein_g * 10) / 10,
      carbG: Math.round(d.carb_g * 10) / 10,
      fatG: Math.round(d.fat_g * 10) / 10,
      waterMl: waterBy.get(d.local_date) ?? 0,
    })); // fmt: skip
    const have = new Set(days.map((d) => d.local_date));
    for (const [localDate, ml] of waterBy)
      if (!have.has(localDate))
        out.push({ localDate, entries: 0, calories: 0, proteinG: 0, carbG: 0, fatG: 0, waterMl: ml });
    return out.sort((a, b) => a.localDate.localeCompare(b.localDate));
  }

  async overview(userId: string) {
    const { today, goals } = await this.context(userId);
    const history = await this.totalsFor(userId, addDays(today, -365), today);
    const logged = new Set(history.filter((d) => d.entries > 0).map((d) => d.localDate));
    const now = history.find((d) => d.localDate === today);
    return {
      date: today,
      streakDays: streakDays(logged, today),
      loggedToday: logged.has(today),
      today: {
        calories: now?.calories ?? 0,
        proteinG: now?.proteinG ?? 0,
        carbG: now?.carbG ?? 0,
        fatG: now?.fatG ?? 0,
        waterMl: now?.waterMl ?? 0,
        entries: now?.entries ?? 0,
      },
      goals,
    }; // fmt: skip
  }

  async weekly(userId: string, opts: { end?: string; narrative: boolean }) {
    const { today, goals } = await this.context(userId);
    const to = opts.end ?? today;
    const from = addDays(to, -6);
    const pro = (await this.subscriptions.entitlement(userId)).plan === 'pro';
    if (opts.narrative && !pro) throw subscriptionRequired('Written weekly summaries');

    const history = await this.totalsFor(userId, addDays(to, -364), to);
    const days = fillDays(
      from,
      to,
      history.filter((d) => d.localDate >= from),
    );
    const previous = fillDays(
      addDays(from, -7),
      addDays(from, -1),
      history.filter((d) => d.localDate >= addDays(from, -7) && d.localDate < from),
    );
    const summary = summarizeWeek(days, goals.calories);
    const streak = streakDays(new Set(history.filter((d) => d.entries > 0).map((d) => d.localDate)), to);

    let weight = null;
    let training: { sessions: number; minutes: number } | null = null;
    let previousWeek = null;
    if (pro) {
      weight = weightChange(
        (await this.body.listWeight(userId, from, to)).map((w) => ({
          localDate: w.local_date,
          loggedAt: w.logged_at,
          weightKg: w.weight_kg,
        })),
      );
      const finished = (await this.sessions.list(userId, from, to)).filter((s) => s.finished_at !== null);
      training = {
        sessions: finished.length,
        minutes: finished.reduce((m, s) => m + Math.round((s.finished_at! - s.started_at) / 60_000), 0),
      };
      const p = summarizeWeek(previous, goals.calories);
      previousWeek = { daysLogged: p.daysLogged, avgCalories: p.avgCalories };
    } else {
      Object.assign(summary, { avgProteinG: null, avgCarbG: null, avgFatG: null, avgWaterMl: null });
    }

    const lines = highlights({
      summary: pro ? summary : { ...summary, avgWaterMl: null },
      streak,
      weight,
      trainingSessions: training?.sessions ?? 0,
    });
    let narrative: string | null = null;
    if (opts.narrative)
      narrative = await this.narrate(userId, {
        range: { from, to },
        summary,
        streakDays: streak,
        weight,
        training,
        previousWeek,
      });

    return {
      range: { from, to },
      plan: pro ? ('pro' as const) : ('free' as const),
      days: days.map(roundDay),
      summary,
      streakDays: streak,
      weight,
      training,
      previousWeek,
      highlights: pro ? lines : lines.slice(0, 2),
      narrative,
    }; // fmt: skip
  }

  /** The written summary is a nicety: if the AI service is down, the numbers still come back and the allowance is returned. */
  private async narrate(userId: string, facts: Record<string, unknown>): Promise<string | null> {
    await this.subscriptions.consume(userId, 'ai_text');
    try {
      return await this.ai.weeklyNarrative(facts);
    } catch (e) {
      await this.subscriptions.refund(userId, 'ai_text');
      if (isAppError(e) && (e.code === 'upstream_failed' || e.code === 'not_configured')) return null;
      throw e;
    }
  }
}

const roundDay = (d: DayTotals) => ({
  ...d,
  calories: Math.round(d.calories),
  proteinG: Math.round(d.proteinG),
  carbG: Math.round(d.carbG),
  fatG: Math.round(d.fatG),
});
