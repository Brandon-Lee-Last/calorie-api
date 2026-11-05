import { z } from '../../core/openapi';

export const rewardsSchema = z
  .object({
    points: z.number().int().describe('Pango Points to spend'),
    monthCost: z.number().int().describe('Points for a month of Plus'),
    monthDays: z.number().int(),
    inviteCode: z.string().describe('This person’s code to share with friends'),
    codeEntry: z.object({
      open: z
        .boolean()
        .describe('Whether a code can still be entered (the first weeks of an account, one of each kind)'),
      until: z.number().int(),
      usedInvite: z.boolean(),
      partner: z
        .object({ name: z.string() })
        .nullable()
        .describe('The gym or partner this person joined through'),
    }),
    invites: z.object({ joined: z.number().int(), rewarded: z.number().int() }),
    plusFromPointsUntil: z
      .number()
      .int()
      .nullable()
      .describe('When Plus bought with points ends, if it is running'),
    rules: z.object({
      food: z.number().int(),
      foodWithBarcode: z.number().int(),
      foodsPerDay: z.number().int(),
      invitedFriend: z.number().int(),
      joinedWithInvite: z.number().int(),
      referralDays: z.number().int(),
    }),
    history: z.array(z.object({ amount: z.number().int(), reason: z.string(), at: z.number().int() })),
  })
  .openapi('Rewards');

export const codeInputSchema = z
  .object({ code: z.string().trim().min(3).max(24) })
  .openapi('RewardCodeInput');
export const codeResultSchema = z
  .object({
    kind: z.enum(['invite', 'partner']),
    name: z.string().nullable().describe('The partner’s name, for a partner code'),
    points: z
      .number()
      .int()
      .describe('Points it gives (an invite’s come once the person has logged on a few days)'),
  })
  .openapi('RewardCodeResult');
export const redeemResultSchema = z
  .object({ plusUntil: z.number().int(), points: z.number().int() })
  .openapi('RewardRedeemResult');

export const partnerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    code: z.string(),
    sharePct: z.number(),
    months: z
      .number()
      .int()
      .describe('Months after joining that members earn the partner a share; 0 is for as long as they pay'),
    welcomePoints: z.number().int(),
    contact: z.string().nullable(),
    active: z.boolean(),
    createdAt: z.number().int(),
    members: z.number().int(),
    plusMembers: z.number().int(),
    earnedCents: z.number().int(),
    owedCents: z.number().int().describe('Earned, not refunded, not yet paid out'),
  })
  .openapi('Partner');
export const partnerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    code: z.string().trim().min(3).max(24),
    sharePct: z.number().min(0).max(100).optional(),
    months: z.number().int().min(0).max(120).optional(),
    welcomePoints: z.number().int().min(0).max(5000).optional(),
    contact: z.string().trim().max(200).nullable().optional(),
  })
  .openapi('PartnerInput');
export const partnerPatchSchema = partnerInputSchema
  .omit({ code: true })
  .partial()
  .extend({ active: z.boolean().optional() })
  .openapi('PartnerPatch');
export const partnerReportSchema = z
  .object({
    partner: z.object({ id: z.string(), name: z.string(), code: z.string(), sharePct: z.number() }),
    month: z.string(),
    joined: z.number().int(),
    payments: z.array(
      z.object({
        at: z.number().int(),
        productId: z.string(),
        grossCents: z.number().int(),
        earningCents: z.number().int(),
        refunded: z.boolean(),
        paid: z.boolean(),
      }),
    ),
    totalEarningCents: z.number().int(),
    unpaidCents: z.number().int(),
  })
  .openapi('PartnerReport');
