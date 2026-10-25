import type { GoogleServiceAccountAuth } from '../../core/google-auth';
import type { Logger } from '../../core/logger';
import { globalFetch } from '../../core/fetch';

export type PushMessage = { token: string; title: string; body: string; data: Record<string, string> };

/**
 * `sent`: delivered to FCM. `invalid_token`: the phone no longer has the app (stop using this token). `retry`: a problem on
 * the way (FCM or the network), worth trying again soon.
 */
export type PushOutcome = 'sent' | 'invalid_token' | 'retry';

export interface PushSender {
  /** False where nothing can be sent (production without Firebase set up): reminders are then left untouched. */
  readonly configured: boolean;
  send(message: PushMessage): Promise<PushOutcome>;
}

export const unconfiguredSender: PushSender = { configured: false, send: async () => 'retry' };

/** Local and stage: writes the notification to the log instead of sending it. */
export class LogSender implements PushSender {
  readonly configured = true;
  constructor(private logger: Logger) {}
  async send(m: PushMessage): Promise<PushOutcome> {
    this.logger.info('push (not sent, no Firebase configured)', {
      title: m.title,
      body: m.body,
      kind: m.data.kind,
    });
    return 'sent';
  }
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * Firebase Cloud Messaging, HTTP v1 API. Written from Google's documentation and tested against a fake; it has not been run
 * against a live Firebase project.
 */
export class FcmSender implements PushSender {
  constructor(
    private auth: GoogleServiceAccountAuth,
    private projectId: string | undefined,
    private logger: Logger,
    private fetcher: typeof fetch = globalFetch,
  ) {}

  get configured() {
    return this.auth.configured && Boolean(this.projectId);
  }

  async send(m: PushMessage): Promise<PushOutcome> {
    try {
      const access = await this.auth.token(SCOPE);
      const res = await this.fetcher(
        `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: m.token,
              notification: { title: m.title, body: m.body },
              data: m.data,
              android: { priority: 'HIGH', ttl: '3600s', notification: { channel_id: 'reminders' } },
            },
          }),
        },
      );
      if (res.ok) return 'sent';
      const text = await res.text();
      // 404 / UNREGISTERED: the app was uninstalled. 400 INVALID_ARGUMENT: the token is malformed. Neither will ever work.
      if (
        res.status === 404 ||
        /UNREGISTERED/.test(text) ||
        (res.status === 400 && /INVALID_ARGUMENT/.test(text))
      )
        return 'invalid_token';
      this.logger.warn('fcm refused a message', { status: res.status });
      return 'retry';
    } catch (e) {
      this.logger.warn('fcm could not be reached', { message: String(e) });
      return 'retry';
    }
  }
}
