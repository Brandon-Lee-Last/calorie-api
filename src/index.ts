import { createApp } from './app';
import { Container } from './container';
import type { Bindings } from './env';

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(new Container(env).maintenance.run());
  },
} satisfies ExportedHandler<Bindings>;
