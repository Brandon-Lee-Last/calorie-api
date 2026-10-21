import { badRequest, notFound, validationFailed } from '../../core/errors';
import type { Clock } from '../../core/time';
import { isTimeZone } from '../../core/time';
import {
  ageOn,
  recommendGoals,
  type GoalInputs,
  type GoalRecommendation,
  type Goals,
} from '../../lib/nutrition';
import type { AuthRepo } from '../auth/auth.repo';
import type { ProfileRow, ProfileUpdate, UsersRepo } from './users.repo';

export const MIN_AGE = 13;
export const MAX_AGE = 110;

export type ProfileView = {
  timezone: string;
  locale: string;
  units: 'metric' | 'imperial';
  sex: ProfileRow['sex'];
  birthYear: number | null;
  heightCm: number | null;
  weightKg: number | null;
  activityLevel: ProfileRow['activity_level'];
  goal: ProfileRow['goal'];
  goalRateKgPerWeek: number;
  targetWeightKg: number | null;
  onboardedAt: number | null;
  goals: Goals & { custom: boolean };
};

export type ProfilePatch = Partial<{
  timezone: string;
  locale: string;
  units: 'metric' | 'imperial';
  sex: ProfileRow['sex'];
  birthYear: number | null;
  heightCm: number | null;
  weightKg: number | null;
  activityLevel: ProfileRow['activity_level'];
  goal: ProfileRow['goal'];
  goalRateKgPerWeek: number;
  targetWeightKg: number | null;
  onboarded: boolean;
}>;

export function toProfileView(p: ProfileRow): ProfileView {
  return {
    timezone: p.timezone,
    locale: p.locale,
    units: p.units,
    sex: p.sex,
    birthYear: p.birth_year,
    heightCm: p.height_cm,
    weightKg: p.weight_kg,
    activityLevel: p.activity_level,
    goal: p.goal,
    goalRateKgPerWeek: p.goal_rate_kg_per_week,
    targetWeightKg: p.target_weight_kg,
    onboardedAt: p.onboarded_at,
    goals: {
      calories: p.calorie_goal,
      proteinG: p.protein_goal_g,
      carbG: p.carb_goal_g,
      fatG: p.fat_goal_g,
      custom: p.goals_are_custom === 1,
    },
  };
}

/** The inputs the calculator needs, or the names of the profile fields still missing. */
export function goalInputs(p: ProfileRow): { inputs: GoalInputs } | { missing: string[] } {
  const missing: string[] = [];
  if (p.birth_year === null) missing.push('birthYear');
  if (p.height_cm === null) missing.push('heightCm');
  if (p.weight_kg === null) missing.push('weightKg');
  if (p.activity_level === null) missing.push('activityLevel');
  if (missing.length) return { missing };
  return {
    inputs: {
      sex: p.sex,
      birthYear: p.birth_year!,
      heightCm: p.height_cm!,
      weightKg: p.weight_kg!,
      activityLevel: p.activity_level!,
      goal: p.goal,
      rateKgPerWeek: p.goal_rate_kg_per_week,
    },
  };
}

export class UsersService {
  constructor(
    private repo: UsersRepo,
    private authRepo: AuthRepo,
    private clock: Clock,
    /** Called after the person's timezone changed, so anything scheduled in local time can be worked out again. */
    private onTimezoneChange: (userId: string) => Promise<void> = async () => {},
  ) {}

  async getMe(userId: string) {
    const user = await this.authRepo.findUser(userId);
    const profile = await this.repo.getProfile(userId);
    if (!user || !profile) throw notFound('Account');
    const identities = await this.authRepo.listIdentities(userId);
    return {
      id: user.id,
      createdAt: user.created_at,
      displayName: user.display_name,
      email: user.email,
      isAnonymous: identities.length === 0,
      providers: identities.map((i) => i.provider),
      profile: toProfileView(profile),
    };
  }

  async updateDisplayName(userId: string, displayName: string | null) {
    await this.repo.updateUser(userId, displayName, this.clock.now());
    return this.getMe(userId);
  }

  async getProfile(userId: string): Promise<ProfileView> {
    const p = await this.repo.getProfile(userId);
    if (!p) throw notFound('Profile');
    return toProfileView(p);
  }

  /**
   * Partial update. When the body stats change and the goals were not set by hand, the goals are recalculated.
   * Nothing is written if any value is invalid.
   */
  async patchProfile(userId: string, patch: ProfilePatch): Promise<ProfileView> {
    const current = await this.repo.getProfile(userId);
    if (!current) throw notFound('Profile');
    const now = this.clock.now();
    const problems: { path: string; message: string }[] = [];

    if (patch.timezone !== undefined && !isTimeZone(patch.timezone))
      problems.push({ path: 'timezone', message: 'Not a known IANA timezone' });
    if (patch.birthYear !== undefined && patch.birthYear !== null) {
      const age = ageOn(patch.birthYear, now);
      if (age < MIN_AGE)
        problems.push({ path: 'birthYear', message: `You must be at least ${MIN_AGE} to use the app` });
      else if (age > MAX_AGE)
        problems.push({ path: 'birthYear', message: 'That birth year is not plausible' });
    }
    if (problems.length) throw validationFailed(problems);

    const update: ProfileUpdate = {};
    const map: [keyof ProfilePatch, keyof ProfileUpdate][] = [
      ['timezone', 'timezone'],
      ['locale', 'locale'],
      ['units', 'units'],
      ['sex', 'sex'],
      ['birthYear', 'birth_year'],
      ['heightCm', 'height_cm'],
      ['weightKg', 'weight_kg'],
      ['activityLevel', 'activity_level'],
      ['goal', 'goal'],
      ['goalRateKgPerWeek', 'goal_rate_kg_per_week'],
      ['targetWeightKg', 'target_weight_kg'],
    ]; // fmt: skip
    for (const [from, to] of map)
      if (patch[from] !== undefined) (update as Record<string, unknown>)[to] = patch[from];
    if (patch.onboarded !== undefined)
      update.onboarded_at = patch.onboarded ? (current.onboarded_at ?? now) : null;

    const next: ProfileRow = { ...current, ...update } as ProfileRow;
    if (next.goals_are_custom === 0 && affectsGoals(patch)) {
      const calc = goalInputs(next);
      if ('inputs' in calc) Object.assign(update, goalColumns(recommendGoals(calc.inputs, now)));
    }
    await this.repo.updateProfile(userId, update, now);
    if (patch.timezone !== undefined && patch.timezone !== current.timezone)
      await this.onTimezoneChange(userId);
    return this.getProfile(userId);
  }

  async setGoals(userId: string, goals: Goals): Promise<ProfileView> {
    await this.repo.updateProfile(
      userId,
      {
        calorie_goal: goals.calories,
        protein_goal_g: goals.proteinG,
        carb_goal_g: goals.carbG,
        fat_goal_g: goals.fatG,
        goals_are_custom: 1,
      },
      this.clock.now(),
    );
    return this.getProfile(userId);
  }

  async recommendation(userId: string): Promise<GoalRecommendation> {
    const p = await this.repo.getProfile(userId);
    if (!p) throw notFound('Profile');
    const calc = goalInputs(p);
    if ('missing' in calc)
      throw badRequest('Add these to your profile first: ' + calc.missing.join(', '), {
        missing: calc.missing,
        reason: 'profile_incomplete',
      });
    return recommendGoals(calc.inputs, this.clock.now());
  }

  async applyRecommendation(userId: string): Promise<ProfileView> {
    const rec = await this.recommendation(userId);
    await this.repo.updateProfile(userId, { ...goalColumns(rec), goals_are_custom: 0 }, this.clock.now());
    return this.getProfile(userId);
  }

  /** Called when a weight is logged: keeps the profile's current weight in step, and the goals with it. */
  async setCurrentWeight(userId: string, weightKg: number): Promise<void> {
    await this.patchProfile(userId, { weightKg });
  }
}

const GOAL_FIELDS: (keyof ProfilePatch)[] = [
  'sex',
  'birthYear',
  'heightCm',
  'weightKg',
  'activityLevel',
  'goal',
  'goalRateKgPerWeek',
];
const affectsGoals = (p: ProfilePatch) => GOAL_FIELDS.some((k) => p[k] !== undefined);

function goalColumns(g: Goals): ProfileUpdate {
  return { calorie_goal: g.calories, protein_goal_g: g.proteinG, carb_goal_g: g.carbG, fat_goal_g: g.fatG };
}
