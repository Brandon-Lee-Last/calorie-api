import { createApp } from './app';
import { Container } from './container';
import type { Bindings } from './env';

const app = createApp();
/** Matches the nightly entry in wrangler.jsonc; every other schedule is the reminder job. */
const NIGHTLY_CRON = '17 3 * * *';

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    const d = new Container(env);
    if (controller.cron !== NIGHTLY_CRON) {
      // Every few minutes: send the reminders that have come due.
      ctx.waitUntil(
        d.reminders.run().catch(async (e: unknown) => {
          d.logger.error('reminders failed', { message: String(e) });
          await d.alerts.notify({
            key: 'reminders-failed',
            title: 'The reminder job failed',
            detail: String(e).slice(0, 300),
          });
        }),
      );
      return;
    }
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
