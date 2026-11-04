import test from 'ava';
import { BridgeClient, type BridgeEvent } from '../../src/client/bridge-client.js';
import { fakeBridge } from '../helpers/fake-bridge.js';

test('connects with the token, calls methods, receives events', async (t) => {
  const fake = await fakeBridge();
  const c = new BridgeClient();
  t.like(await c.connect(fake.port, 'secret'), { bridge: 'claudebridge', username: 'Bot' });
  t.deepEqual(await c.request('echo', { a: 1 }), { a: 1 });
  const events: BridgeEvent[] = [];
  c.on('event', e => events.push(e));
  fake.push({ type: 'hurt', cause: 'arrow' });
  await new Promise(r => setTimeout(r, 50));
  t.deepEqual(events, [{ type: 'hurt', cause: 'arrow' }]);
  c.close();
  fake.server.close();
});

test('a wrong token is refused', async (t) => {
  const fake = await fakeBridge();
  const c = new BridgeClient();
  await t.throwsAsync(c.connect(fake.port, 'wrong'), { message: /launch token/ });
  c.close();
  fake.server.close();
});

test('errors, timeouts and a dropped connection reject pending calls', async (t) => {
  const fake = await fakeBridge();
  const c = new BridgeClient();
  await c.connect(fake.port, 'secret');
  await t.throwsAsync(c.request('nope'), { message: 'unknown method: nope' });
  await t.throwsAsync(c.request('never', {}, { timeoutMs: 100 }), { message: /timed out after 100 ms/ });
  t.is(await c.request('slow', {}, { timeoutMs: 2000 }), 'late');
  const pending = c.request('never', {}, { timeoutMs: 5000 });
  fake.dropAll();
  await t.throwsAsync(pending, { message: 'bridge connection closed' });
  await t.throwsAsync(c.request('echo'), { message: 'bridge not connected' });
  fake.server.close();
});

test('connect fails when nothing listens', async (t) => {
  const c = new BridgeClient();
  await t.throwsAsync(c.connect(1, 'x'));
});
