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
import { healthRoutes } from './modules/health/health.routes';

export const API_PREFIX = '/v1';
const JSON_BODY_LIMIT = 1024 * 1024;

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
    bodyLimit({
      maxSize: JSON_BODY_LIMIT,
      onError: () => {
        throw payloadTooLarge();
      },
    }),
  );

  app.onError(onError);
  app.notFound(onNotFound);

  const v1 = new OpenAPIHono<AppEnv>();
  v1.route('/', healthRoutes);
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

  return app;
}

export type App = ReturnType<typeof createApp>;
