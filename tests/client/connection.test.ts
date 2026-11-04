import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { ClientConnection } from '../../src/client/client-connection.js';
import { BridgeClient } from '../../src/client/bridge-client.js';
import { fakeBridge } from '../helpers/fake-bridge.js';
import type { LaunchOptions, LaunchPlan } from '../../src/client/launcher.js';

const fakeProcess = () => Object.assign(new EventEmitter(), { pid: 4242, exitCode: null as number | null, kill: sinon.spy() }) as unknown as ChildProcess;

function connection(port: number, token = 'secret') {
  const proc = fakeProcess();
  const chat: [string, string][] = [];
  const logs: string[] = [];
  const opts: LaunchOptions = { minecraftDir: '/mc', gameDir: '/g', username: 'ClaudeBot', server: 'localhost:25565', bridgePort: port, offline: true };
  const c = new ClientConnection(opts, { onLog: (_l, m) => logs.push(m), onChatMessage: (u, m) => chat.push([u, m]) }, {
    prepare: () => ({ token, java: 'java', args: [], cwd: '/g', tokenFile: '/g/t' }) as LaunchPlan,
    launch: sinon.spy(() => proc),
    bridge: new BridgeClient(),
    connectTimeoutMs: 3000,
    retryDelayMs: 20
  });
  return { c, proc, chat, logs };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 20));
};

test('launches, connects, reports "starting" meanwhile, then connected', async (t) => {
  const fake = await fakeBridge();
  const { c } = connection(fake.port);
  const first = await c.checkConnectionAndReconnect(); // starts it
  t.false(first.connected);
  t.regex(first.message!, /starting/);
  await until(() => c.isConnected());
  t.deepEqual(await c.checkConnectionAndReconnect(), { connected: true });
  c.cleanup();
  fake.server.close();
});

test('bridge events become alerts and player chat', async (t) => {
  const fake = await fakeBridge();
  const { c, chat } = connection(fake.port);
  c.start();
  await until(() => c.isConnected());
  fake.push({ type: 'hurt', cause: 'lava', health: 12 });
  fake.push({ type: 'chat', text: '<Hunter> hi bot' });
  fake.push({ type: 'chat', text: '<ClaudeBot> my own line' });
  await new Promise(r => setTimeout(r, 50));
  t.is(c.alerts.take(), 'Took damage 1x (lava x1); health 12/20');
  t.deepEqual(chat, [['Hunter', 'hi bot']]);
  c.cleanup();
  fake.server.close();
});

test('when the game exits, the next check starts it again', async (t) => {
  const fake = await fakeBridge();
  const { c, proc, logs } = connection(fake.port);
  c.start();
  await until(() => c.isConnected());
  (proc as unknown as { exitCode: number }).exitCode = 1;
  proc.emit('exit', 1);
  t.is(c.getState(), 'disconnected');
  t.true(logs.some(l => /Game client exited/.test(l)));
  const check = await c.checkConnectionAndReconnect();
  t.false(check.connected);
  t.is(c.getState(), 'launching');
  c.cleanup();
  fake.server.close();
});
