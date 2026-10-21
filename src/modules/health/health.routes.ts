import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { json, z } from '../../core/openapi';

const liveSchema = z
  .object({ status: z.literal('ok'), environment: z.string(), time: z.number() })
  .openapi('Health');
const readySchema = z
  .object({ status: z.enum(['ok', 'degraded']), checks: z.record(z.string(), z.enum(['ok', 'fail'])) })
  .openapi('Readiness');

export const healthRoutes = new OpenAPIHono<AppEnv>();

healthRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['Health'],
    summary: 'Liveness: the Worker is up',
    responses: { 200: json(liveSchema, 'The API is running') },
  }),
  (c) => {
    const d = c.get('deps');
    return c.json({ status: 'ok' as const, environment: d.config.ENVIRONMENT, time: d.clock.now() }, 200);
  },
);

healthRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/health/ready',
    tags: ['Health'],
    summary: 'Readiness: the database and storage answer',
    responses: { 200: json(readySchema, 'Everything answers'), 503: json(readySchema, 'Something does not') },
  }),
  async (c) => {
    const d = c.get('deps');
    const checks: Record<string, 'ok' | 'fail'> = { database: 'fail', storage: 'fail' };
    try {
      await d.db.prepare('SELECT 1').first();
      checks.database = 'ok';
    } catch (e) {
      d.logger.error('readiness: database failed', { message: String(e) });
    }
    try {
      await d.env.MEDIA.head('__health__');
      checks.storage = 'ok';
    } catch (e) {
      d.logger.error('readiness: storage failed', { message: String(e) });
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return c.json({ status: ok ? ('ok' as const) : ('degraded' as const), checks }, ok ? 200 : 503);
  },
);
