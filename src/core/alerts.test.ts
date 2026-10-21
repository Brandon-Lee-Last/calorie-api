import { describe, expect, it } from 'vitest';
import { silentLogger } from './logger';
import { MemoryRateLimiter } from './rate-limiter';
import { FakeClock } from './time';
import { WebhookAlerter, noAlerts } from './alerts';

function setup(response: () => Response | Error = () => new Response('ok')) {
  const clock = new FakeClock(0);
  const sent: Array<{ url: string; body: any }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(init.body as string) });
    const r = response();
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  const alerter = new WebhookAlerter(
    'https://hooks.example/x',
    'stage',
    new MemoryRateLimiter(clock),
    silentLogger,
    fetcher,
  );
  return { clock, sent, alerter };
}

describe('WebhookAlerter', () => {
  it('posts one message that works for Slack and Discord', async () => {
    const { sent, alerter } = setup();
    await alerter.notify({ key: 'a', title: 'Something broke', detail: 'details here' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://hooks.example/x');
    expect(sent[0]!.body.text).toBe('[stage] Something broke\ndetails here');
    expect(sent[0]!.body.content).toBe(sent[0]!.body.text);
  });
  it('sends the same problem once per five minutes, but different problems separately', async () => {
    const { clock, sent, alerter } = setup();
    await alerter.notify({ key: 'a', title: 'A' });
    await alerter.notify({ key: 'a', title: 'A' });
    await alerter.notify({ key: 'b', title: 'B' });
    expect(sent).toHaveLength(2);
    clock.advance(301_000);
    await alerter.notify({ key: 'a', title: 'A' });
    expect(sent).toHaveLength(3);
  });
  it('stops at 30 messages an hour however many problems there are', async () => {
    const { sent, alerter } = setup();
    for (let i = 0; i < 50; i++) await alerter.notify({ key: `k${i}`, title: 'x' });
    expect(sent).toHaveLength(30);
  });
  it('truncates long details', async () => {
    const { sent, alerter } = setup();
    await alerter.notify({ key: 'a', title: 'T', detail: 'x'.repeat(5000) });
    expect(sent[0]!.body.text.length).toBeLessThan(600);
  });
  it('never throws, whatever the webhook does', async () => {
    await expect(
      setup(() => new Response('no', { status: 500 })).alerter.notify({ key: 'a', title: 'T' }),
    ).resolves.toBeUndefined();
    await expect(
      setup(() => new Error('offline')).alerter.notify({ key: 'a', title: 'T' }),
    ).resolves.toBeUndefined();
    await expect(noAlerts.notify({ key: 'a', title: 'T' })).resolves.toBeUndefined();
  });
});
