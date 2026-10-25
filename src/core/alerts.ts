import type { Logger } from './logger';
import type { RateLimiter } from './rate-limiter';
import { globalFetch } from './fetch';

export type Alert = {
  /** Same key = same problem: it is sent at most once every five minutes. */
  key: string;
  title: string;
  detail?: string;
};

/** Tells a human that something needs attention. Never throws: a broken alert channel must not break a request. */
export interface Alerter {
  notify(alert: Alert): Promise<void>;
}

export const noAlerts: Alerter = { notify: async () => {} };

const SAME_PROBLEM_SECONDS = 300;
const MOST_PER_HOUR = 30;

/**
 * Posts to a webhook. The body has both `text` (Slack, Mattermost) and `content` (Discord) so the same URL works for either.
 * Alerts carry no user data: just what failed, where, and the request id to look it up in the logs.
 */
export class WebhookAlerter implements Alerter {
  constructor(
    private url: string,
    private environment: string,
    private limiter: RateLimiter,
    private logger: Logger,
    private fetcher: typeof fetch = globalFetch,
  ) {}

  async notify(a: Alert): Promise<void> {
    try {
      if (!(await this.limiter.hit(`alert:${a.key}`, 1, SAME_PROBLEM_SECONDS)).allowed) return;
      if (!(await this.limiter.hit('alert-all', MOST_PER_HOUR, 3600)).allowed) return;
      const text = `[${this.environment}] ${a.title}${a.detail ? `\n${a.detail.slice(0, 500)}` : ''}`;
      const res = await this.fetcher(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, content: text }),
      });
      if (!res.ok) this.logger.warn('alert webhook refused the message', { status: res.status });
    } catch (e) {
      this.logger.warn('alert could not be sent', { message: String(e) });
    }
  }
}
