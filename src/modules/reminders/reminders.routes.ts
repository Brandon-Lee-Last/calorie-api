import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json, jsonBody } from '../../core/openapi';
import { requireAdmin } from '../../middleware/admin';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import {
  deviceBodySchema,
  kindParam,
  reminderInputSchema,
  reminderListSchema,
  reminderSchema,
  runReportSchema,
  testResultSchema,
  unregisterBodySchema,
} from './reminders.schemas';

export const remindersRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;
const hourly = (name: string, limit: number) => rateLimit({ name, limit, windowSeconds: 3600, by: 'user' });

remindersRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/devices',
    tags: ['Reminders'],
    summary: 'Register this phone for notifications',
    ...secured,
    middleware: [requireAuth, hourly('devices', 60)] as const,
    description:
      'Send the Firebase registration token at every launch (it changes now and then). A token belongs to one account at a time; registering it again moves it. Each account keeps its 10 newest phones.',
    request: { body: jsonBody(deviceBodySchema) },
    responses: { 204: { description: 'Registered' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').reminders.registerDevice(uid(c), c.req.valid('json'));
    return c.body(null, 204);
  },
);

remindersRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/devices/unregister',
    tags: ['Reminders'],
    summary: 'Stop sending notifications to this phone (call when signing out)',
    ...secured,
    middleware: [requireAuth, hourly('devices', 60)] as const,
    request: { body: jsonBody(unregisterBodySchema) },
    responses: {
      204: { description: 'Unregistered (also returned if it was not registered)' },
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').reminders.unregisterDevice(uid(c), c.req.valid('json').token);
    return c.body(null, 204);
  },
);

remindersRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/reminders',
    tags: ['Reminders'],
    summary: 'Your reminders',
    ...secured,
    middleware: [requireAuth] as const,
    responses: { 200: json(reminderListSchema, 'One row per kind that has been set up'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').reminders.list(uid(c)), 200),
);

remindersRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/reminders/{kind}',
    tags: ['Reminders'],
    summary: 'Set up or change a reminder',
    ...secured,
    middleware: [requireAuth, hourly('reminders', 120)] as const,
    description:
      'Times are the person’s local time, in the timezone of their profile. If the timezone changes, `PATCH /me/profile` reschedules automatically. A reminder that is more than 90 minutes late is skipped rather than sent.',
    request: { params: kindParam, body: jsonBody(reminderInputSchema) },
    responses: { 200: json(reminderSchema, 'The reminder'), ...authErrors },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').reminders.put(uid(c), c.req.valid('param').kind, c.req.valid('json')), 200),
);

remindersRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/reminders/{kind}',
    tags: ['Reminders'],
    summary: 'Remove a reminder',
    ...secured,
    middleware: [requireAuth] as const,
    request: { params: kindParam },
    responses: { 204: { description: 'Removed (also returned if there was none)' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').reminders.remove(uid(c), c.req.valid('param').kind);
    return c.body(null, 204);
  },
);

remindersRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/reminders/test',
    tags: ['Reminders'],
    summary: 'Send a test notification to my phones',
    ...secured,
    middleware: [requireAuth, hourly('reminders-test', 5)] as const,
    responses: {
      200: json(testResultSchema, 'How many phones it was sent to'),
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').reminders.sendTest(uid(c)), 200),
);

remindersRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/admin/reminders/run',
    tags: ['Admin'],
    summary: 'Send the reminders that are due now',
    security: [{ adminKey: [] }],
    middleware: requireAdmin,
    description:
      'The same job the five-minute schedule runs. Safe to call at any time: a reminder is only ever sent once.',
    responses: { 200: json(runReportSchema, 'What happened'), 401: commonErrors[400] },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').reminders.run(), 200),
);
