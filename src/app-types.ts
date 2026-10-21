import type { Bindings } from './env';
import type { Container } from './container';
import type { Logger } from './core/logger';

export type AuthContext = { userId: string; sessionId: string };

export type Vars = {
  requestId: string;
  logger: Logger;
  deps: Container;
  auth?: AuthContext;
};

export type AppEnv = { Bindings: Bindings; Variables: Vars };
