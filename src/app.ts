import { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './app-types';
import { Container, type Overrides } from './container';
import { payloadTooLarge, validationFailed } from './core/errors';
import { accessLog } from './middleware/access-log';
import { onError, onNotFound, zodDetails } from './middleware/error-handler';
import { requestId } from './middleware/request-id';
import { authRoutes } from './modules/auth/auth.routes';
import { usersRoutes } from './modules/users/users.routes';
import { bodyRoutes } from './modules/body/body.routes';
import { diaryRoutes } from './modules/diary/diary.routes';
import { foodsRoutes } from './modules/foods/foods.routes';
import { scansRoutes } from './modules/scans/scans.routes';
import { syncRoutes } from './modules/sync/sync.routes';
import { subscriptionsRoutes } from './modules/subscriptions/subscriptions.routes';
import { mediaRoutes } from './modules/media/media.routes';
import { workoutsRoutes } from './modules/workouts/workouts.routes';
import { sessionsRoutes } from './modules/workouts/sessions.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { accountRoutes } from './modules/account/account.routes';
import { aiRoutes } from './modules/ai/ai.routes';
import { insightsRoutes } from './modules/insights/insights.routes';
import { healthRoutes } from './modules/health/health.routes';

export const API_PREFIX = '/v1';
const JSON_BODY_LIMIT = 1024 * 1024;

/** JSON is capped at 1 MB; image uploads and admin media uploads get more room. */
export function bodyLimitFor(pathname: string): number {
  if (/^\/v1\/admin\/media\//.test(pathname)) return 100 * 1024 * 1024;
  if (/\/photo$/.test(pathname)) return 4 * 1024 * 1024;
  return JSON_BODY_LIMIT;
}

export function createApp(overrides: Overrides = {}) {
  const app = new OpenAPIHono<AppEnv>({
    // Turn a failed request validation into our standard error body.
    defaultHook: (result) => {
      if (!result.success) throw validationFailed(zodDetails(result.error));
    },
  });

  app.use('*', requestId);
  app.use(
    '*',
    createMiddleware<AppEnv>(async (c, next) => {
      const deps = new Container(c.env, overrides, { requestId: c.get('requestId') });
      c.set('deps', deps);
      c.set('logger', deps.logger);
      await next();
    }),
  );
  app.use('*', accessLog);
  app.use('*', secureHeaders());
  app.use(
    '*',
    createMiddleware<AppEnv>(async (c, next) => {
      const origins = c.get('deps').config.CORS_ORIGINS;
      if (origins.length === 0) return next();
      return cors({
        origin: origins,
        allowHeaders: ['authorization', 'content-type', 'x-request-id'],
        maxAge: 600,
      })(c, next);
    }),
  );
  app.use(
    `${API_PREFIX}/*`,
    createMiddleware<AppEnv>(async (c, next) => {
      await next();
      if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
    }),
  );
  app.use(
    `${API_PREFIX}/*`,
    createMiddleware<AppEnv>((c, next) =>
      bodyLimit({
        maxSize: bodyLimitFor(new URL(c.req.url).pathname),
        onError: () => {
          throw payloadTooLarge();
        },
      })(c, next),
    ),
  );

  app.onError(onError);
  app.notFound(onNotFound);

  const v1 = new OpenAPIHono<AppEnv>();
  v1.route('/', healthRoutes);
  v1.route('/', authRoutes);
  v1.route('/', usersRoutes);
  v1.route('/', bodyRoutes);
  v1.route('/', diaryRoutes);
  v1.route('/', foodsRoutes);
  v1.route('/', scansRoutes);
  v1.route('/', syncRoutes);
  v1.route('/', subscriptionsRoutes);
  v1.route('/', mediaRoutes);
  v1.route('/', workoutsRoutes);
  v1.route('/', sessionsRoutes);
  v1.route('/', adminRoutes);
  v1.route('/', accountRoutes);
  v1.route('/', aiRoutes);
  v1.route('/', insightsRoutes);
  app.route(API_PREFIX, v1);

  app.doc(`${API_PREFIX}/openapi.json`, {
    openapi: '3.1.0',
    info: { title: 'Calorie API', version: '0.1.0' },
    servers: [{ url: '/' }],
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'adminKey', {
    type: 'apiKey',
    in: 'header',
    name: 'x-admin-key',
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
