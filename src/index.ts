import { createApp } from './app';
import type { Bindings } from './env';

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: Bindings, _ctx: ExecutionContext) {
    // Nightly maintenance is wired in phase 5.
  },
} satisfies ExportedHandler<Bindings>;
