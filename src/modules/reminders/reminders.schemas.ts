import { z } from '../../core/openapi';
import { REMINDER_KINDS, TIME_RE } from '../../lib/reminders';
import { timestampSchema } from '../../core/schemas';

export const reminderKindSchema = z.enum(REMINDER_KINDS);
export const kindParam = z.object({ kind: reminderKindSchema });

export const deviceBodySchema = z
  .object({
    token: z.string().min(20).max(4096).describe('The Firebase Cloud Messaging registration token'),
    appVersion: z.string().trim().max(32).nullable().optional(),
    locale: z.string().trim().max(16).nullable().optional(),
  })
  .openapi('DeviceRegistration');

export const unregisterBodySchema = z
  .object({ token: z.string().min(20).max(4096) })
  .openapi('DeviceUnregistration');

export const reminderInputSchema = z
  .object({
    enabled: z.boolean(),
    time: z.string().regex(TIME_RE, 'Use 24 hour time like 07:30').describe('Local time of day, 24 hour'),
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .default([1, 2, 3, 4, 5, 6, 7])
      .describe('1 is Monday, 7 is Sunday'),
  })
  .openapi('ReminderInput');

export const reminderSchema = z
  .object({
    kind: reminderKindSchema,
    enabled: z.boolean(),
    time: z.string(),
    days: z.array(z.number().int()),
    nextDueAt: timestampSchema.nullable().describe('When it will next fire, if enabled'),
    lastSentAt: timestampSchema.nullable(),
  })
  .openapi('Reminder');

export const reminderListSchema = z.object({ items: z.array(reminderSchema) }).openapi('ReminderList');

export const testResultSchema = z
  .object({ devices: z.number().int(), delivered: z.number().int() })
  .openapi('PushTestResult');

export const runReportSchema = z
  .object({
    configured: z.boolean(),
    due: z.number().int(),
    sent: z.number().int(),
    skipped: z.number().int(),
    late: z.number().int(),
    retried: z.number().int(),
    invalidTokens: z.number().int(),
  })
  .openapi('ReminderRunReport');
