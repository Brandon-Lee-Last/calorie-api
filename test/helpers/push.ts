import type { PushMessage, PushOutcome, PushSender } from '../../src/modules/reminders/push';

/** Keeps every notification in memory. Set `outcome` to make the next sends fail the way FCM would. */
export class MemoryPush implements PushSender {
  configured = true;
  sent: PushMessage[] = [];
  outcome: PushOutcome | ((m: PushMessage) => PushOutcome) = 'sent';

  async send(message: PushMessage): Promise<PushOutcome> {
    const outcome = typeof this.outcome === 'function' ? this.outcome(message) : this.outcome;
    if (outcome === 'sent') this.sent.push(message);
    return outcome;
  }
}
