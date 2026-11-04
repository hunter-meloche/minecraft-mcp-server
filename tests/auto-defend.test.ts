import test from 'ava';
import sinon from 'sinon';
import { defendTick, gearTick, noteHurt, reflexTarget, setAutoDefend, takeAlerts } from '../src/auto-defend.js';
import { fighting } from '../src/combat.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import { arena, item, mob } from './helpers/arena.js';

test('the reflex hits a hostile in reach with the best weapon, then waits for the cooldown', async (t) => {
  const zombie = mob('zombie', 2);
  const { bot, asBot } = arena({ mobs: [zombie], items: [item('stone_sword')], damage: 1 });
  t.is(await defendTick(asBot, 10_000), 'zombie');
  t.is(bot.heldItem?.name, 'stone_sword');
  t.is(await defendTick(asBot, Date.now() + 100), null); // within the 650 ms sword cooldown
  t.true(bot.attack.calledOnceWith(zombie));
});

test('the reflex ignores mobs out of reach, animals, and neutral mobs unless they attacked', async (t) => {
  const enderman = mob('enderman', 2);
  const { asBot } = arena({ mobs: [mob('skeleton', 8), mob('cow', 1, { type: 'animal' }), enderman] });
  t.is(reflexTarget(asBot), null);
  noteHurt(asBot, asBot.entity, enderman as never);
  t.is(reflexTarget(asBot)?.name, 'enderman');
});

test('the reflex stays out of the way: off, during attack-entity, while eating, and keeps the tool while digging', async (t) => {
  const { bot, asBot } = arena({ mobs: [mob('zombie', 2)], items: [item('iron_pickaxe'), item('iron_sword')], damage: 1 });
  setAutoDefend(asBot, false);
  t.is(await defendTick(asBot, 10_000), null);
  setAutoDefend(asBot, true);
  fighting.add(asBot);
  t.is(await defendTick(asBot, 10_000), null);
  fighting.delete(asBot);
  bot.usingHeldItem = true;
  t.is(await defendTick(asBot, 10_000), null);
  bot.usingHeldItem = false;
  bot.heldItem = item('iron_pickaxe');
  bot.targetDigBlock = {};
  t.is(await defendTick(asBot, 10_000), 'zombie');
  t.is(bot.heldItem?.name, 'iron_pickaxe');
});

test('takeAlerts summarises damage and reflex hits once', async (t) => {
  const zombie = mob('zombie', 2);
  const { asBot } = arena({ mobs: [zombie, mob('skeleton', 7)], health: 14, damage: 1 });
  noteHurt(asBot, asBot.entity, zombie as never);
  noteHurt(asBot, asBot.entity, zombie as never);
  noteHurt(asBot, { id: 99 } as never, zombie as never); // someone else got hurt: not ours
  await defendTick(asBot, 10_000);
  t.is(takeAlerts(asBot), 'Took damage 2x (zombie x2); health 14/20; auto-defend hit zombie x1; hostiles near: zombie 2m, skeleton 7m');
  t.is(takeAlerts(asBot), null);
});

test('ToolFactory appends alerts to every reply, errors included', async (t) => {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const alerts = sinon.stub().onFirstCall().returns('Took damage 1x (zombie x1)').returns(null);
  const factory = new ToolFactory(server, connection, alerts);
  factory.registerTool('ok', 'd', {}, async () => factory.createResponse('done'));
  factory.registerTool('bad', 'd', {}, async () => { throw new Error('nope'); });
  const run = (name: string) => (server.tool as sinon.SinonStub).getCalls().find(c => c.args[0] === name)!.args[3]({});
  t.deepEqual((await run('ok')).content.map((c: { text: string }) => c.text), ['done', '[!] Took damage 1x (zombie x1)']);
  t.deepEqual((await run('bad')).content.map((c: { text: string }) => c.text), ['Failed: nope']);
});

test('gearTick wears better armor and puts a shield in an empty off-hand, and says so once', async (t) => {
  const { bot, asBot } = arena({ items: [item('iron_boots'), item('leather_boots'), item('shield'), item('stone_sword')] });
  t.deepEqual(await gearTick(asBot), ['iron_boots', 'shield']);
  t.is((bot.inventory.slots[8] as { name: string }).name, 'iron_boots');
  t.is((bot.inventory.slots[45] as { name: string }).name, 'shield');
  t.deepEqual(await gearTick(asBot), []); // nothing better left
  t.is(takeAlerts(asBot), 'put on iron_boots, shield');
});

test('gearTick leaves a torch in the off-hand alone', async (t) => {
  const { bot, asBot } = arena({ items: [item('shield')] });
  bot.inventory.slots[45] = item('torch');
  t.deepEqual(await gearTick(asBot), []);
});
