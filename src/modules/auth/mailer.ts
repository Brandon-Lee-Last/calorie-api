import { notConfigured, upstreamFailed } from '../../core/errors';
import type { Logger } from '../../core/logger';

export type Email = { to: string; subject: string; text: string };

/** Sends one transactional email. The API only sends sign-in codes, so there is nothing fancier than plain text. */
export interface Mailer {
  send(email: Email): Promise<void>;
}

/** Sends through Resend (https://resend.com). The sending domain must be verified there. */
export class ResendMailer implements Mailer {
  constructor(
    private apiKey: string,
    private from: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  async send(email: Email): Promise<void> {
    let res: Response;
    try {
      res = await this.fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [email.to], subject: email.subject, text: email.text }),
      });
    } catch {
      throw upstreamFailed('The email service');
    }
    if (!res.ok) throw upstreamFailed('The email service');
  }
}

/** Local and stage: writes the email to the log instead of sending it, so sign-in can be tried without a mail account. */
export class LogMailer implements Mailer {
  constructor(private logger: Logger) {}
  async send(email: Email): Promise<void> {
    this.logger.info('email (not sent, no mail service configured)', { ...email });
  }
}

/** Production without a mail service: refuse loudly rather than pretend a code was sent. */
export const unconfiguredMailer: Mailer = {
  send: async () => {
    throw notConfigured('Email');
  },
};
