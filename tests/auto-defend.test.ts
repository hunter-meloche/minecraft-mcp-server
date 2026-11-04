import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'events';
import { defendTick, gearTick, installAutoDefend, noteHurt, reflexTarget, rememberRegistry, setAutoDefend, shieldTick, takeAlerts } from '../src/auto-defend.js';
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

test('shieldTick faces a skeleton that shot the idle bot and holds the shield up, then lowers it', async (t) => {
  const skeleton = mob('skeleton', 12);
  const { bot, asBot } = arena({ mobs: [skeleton], items: [] });
  bot.inventory.slots[45] = item('shield');
  Object.assign(bot.pathfinder, { isMoving: () => false });
  t.is(await shieldTick(asBot, 10_000), null); // nobody shot us
  noteHurt(asBot, asBot.entity, skeleton as never);
  t.is(await shieldTick(asBot), 'up');
  t.true(bot.activateItem.calledOnceWith(true));
  t.is(await shieldTick(asBot), null); // stays up, keeps facing it
  Object.assign(bot.pathfinder, { isMoving: () => true }); // a tool starts walking: lower it
  t.is(await shieldTick(asBot), 'down');
  t.false(bot.usingHeldItem);
});

test('the melee reflex lowers the guard shield to swing', async (t) => {
  const zombie = mob('zombie', 2);
  const skeleton = mob('skeleton', 12);
  const { bot, asBot } = arena({ mobs: [skeleton], items: [item('stone_sword')], damage: 1 });
  bot.inventory.slots[45] = item('shield');
  Object.assign(bot.pathfinder, { isMoving: () => false });
  noteHurt(asBot, asBot.entity, skeleton as never);
  t.is(await shieldTick(asBot), 'up');
  (asBot.entities as Record<number, unknown>)[zombie.id] = zombie; // a zombie walks up
  t.is(await defendTick(asBot, Date.now() + 10_000), 'zombie');
  t.true(bot.deactivateItem.called);
});

test('the shield guard also blocks melee between swings, and leaves the ready swing to the reflex', async (t) => {
  const zombie = mob('zombie', 2);
  const { bot, asBot } = arena({ mobs: [zombie], items: [item('stone_sword')], damage: 1 });
  bot.inventory.slots[45] = item('shield');
  Object.assign(bot.pathfinder, { isMoving: () => false });
  t.is(await shieldTick(asBot, 10_000), null); // swing ready: no shield, the reflex hits
  t.is(await defendTick(asBot, 10_000), 'zombie');
  t.is(await shieldTick(asBot), 'up'); // right after the swing: block until the next one
  t.is(await defendTick(asBot), null); // still cooling down
  t.true(bot.usingHeldItem);
});

test('hurts are named by damage type from the registry: lava, fall, arrows from a skeleton', async (t) => {
  const skeleton = mob('skeleton', 9);
  const { bot, asBot } = arena({ mobs: [skeleton], health: 12 });
  const client = new EventEmitter();
  Object.assign(bot, { _client: client });
  rememberRegistry(asBot, { id: 'minecraft:damage_type', entries: ['arrow', 'fall', 'lava', 'mob_attack'].map(k => ({ key: `minecraft:${k}` })) });
  installAutoDefend(asBot);
  client.emit('damage_event', { entityId: 1, sourceTypeId: 2, sourceCauseId: 0 });
  client.emit('damage_event', { entityId: 1, sourceTypeId: 1, sourceCauseId: 0 });
  client.emit('damage_event', { entityId: 1, sourceTypeId: 0, sourceCauseId: skeleton.id + 1 });
  bot.emit('entityHurt', asBot.entity, undefined); // mineflayer's own event for the same hurt: not counted twice
  client.emit('damage_event', { entityId: 77, sourceTypeId: 2, sourceCauseId: 0 }); // someone else
  bot.emit('end');
  t.regex(takeAlerts(asBot) ?? '', /^Took damage 3x \(lava x1, fall x1, arrow from skeleton x1\); health 12\/20/);
});
