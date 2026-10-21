import { z } from '../../core/openapi';
import { timestampSchema } from '../../core/schemas';

const statusSchema = z.enum([
  'active',
  'trialing',
  'in_grace',
  'on_hold',
  'paused',
  'canceled',
  'expired',
  'refunded',
]);

export const entitlementSchema = z
  .object({
    plan: z.enum(['free', 'pro']),
    status: z
      .union([statusSchema, z.literal('none')])
      .describe('The state of the best subscription, or of the latest one when access has ended'),
    expiresAt: timestampSchema.nullable().describe('When Pro access ends if nothing renews'),
    willRenew: z.boolean(),
    inGrace: z.boolean().describe('The payment failed and the store is retrying; Pro still works'),
    isTrial: z.boolean(),
    limits: z.object({
      scansPerDay: z.number(),
      aiTextPerDay: z.number(),
      mealPhotos: z.number(),
      recipes: z.number(),
      progressPhotos: z.number(),
    }),
    features: z.object({
      workouts: z.enum(['free', 'all']),
      insights: z.enum(['basic', 'full']),
      export: z.boolean(),
    }),
    usage: z.object({ date: z.string(), scans: z.number().int(), aiText: z.number().int() }),
  })
  .openapi('Entitlement');

export const subscriptionSchema = z
  .object({
    id: z.string(),
    provider: z.enum(['mock', 'google_play']),
    productId: z.string(),
    status: statusSchema,
    autoRenew: z.boolean(),
    startedAt: timestampSchema,
    currentPeriodEnd: timestampSchema,
    graceUntil: timestampSchema.nullable(),
    canceledAt: timestampSchema.nullable(),
    environment: z.enum(['sandbox', 'production']),
  })
  .openapi('Subscription');

export const productSchema = z
  .object({
    id: z.string(),
    plan: z.literal('pro'),
    period: z.string().describe('ISO 8601 duration'),
    trialDays: z.number().int(),
  })
  .openapi('Product');

export const subscriptionStateSchema = z
  .object({
    subscription: subscriptionSchema.nullable(),
    entitlement: entitlementSchema,
    products: z.array(productSchema),
  })
  .openapi('SubscriptionState');

export const verifyBodySchema = z
  .object({
    productId: z.string().min(1).max(100).openapi({ example: 'pro_monthly' }),
    purchaseToken: z.string().min(10).max(4096).openapi({ example: 'mock_pro_monthly_active' }),
  })
  .openapi('VerifyPurchaseRequest');

export const simulateBodySchema = z
  .object({
    scenario: z.enum(['subscribe', 'renew', 'cancel', 'expire', 'grace', 'hold', 'refund']),
    productId: z.enum(['pro_monthly', 'pro_yearly']).optional(),
  })
  .openapi('SimulateRequest');
