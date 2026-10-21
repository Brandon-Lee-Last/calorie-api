import { createApp } from './app';
import { Container } from './container';
import type { Bindings } from './env';

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    const d = new Container(env);
    ctx.waitUntil(
      d.maintenance.run().catch(async (e: unknown) => {
        d.logger.error('maintenance failed', { message: String(e) });
        await d.alerts.notify({
          key: 'maintenance-failed',
          title: 'The nightly maintenance run failed',
          detail: String(e).slice(0, 300),
        });
        throw e;
      }),
    );
  },
} satisfies ExportedHandler<Bindings>;
