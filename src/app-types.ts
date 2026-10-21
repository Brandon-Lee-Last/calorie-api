import type { Bindings } from './env';
import type { Container } from './container';
import type { Logger } from './core/logger';

export type AuthContext = { userId: string; sessionId: string };

export type Vars = {
  requestId: string;
  logger: Logger;
  deps: Container;
  auth?: AuthContext;
  /** Who is calling the admin API: their Cloudflare Access email, or `api-key`. */
  adminActor?: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Vars };
