import type { Email, Mailer } from '../../src/modules/auth/mailer';

/** Keeps every email in memory so a test can read the code that would have been sent. */
export class MemoryMailer implements Mailer {
  sent: Email[] = [];
  fail = false;

  async send(email: Email): Promise<void> {
    if (this.fail) throw new Error('mail service down');
    this.sent.push(email);
  }

  /** The most recent six digit code sent to this address. */
  codeFor(to: string): string {
    const mail = [...this.sent].reverse().find((m) => m.to === to);
    const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
    if (!code) throw new Error(`no code was sent to ${to}`);
    return code;
  }
}
