import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';
import { registerSurvivalTools, matchesTarget, bestWeapon, chooseFood } from '../src/tools/survival-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';

function executor (bot: unknown, name: string) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  registerSurvivalTools(new ToolFactory(server, connection), () => bot as mineflayer.Bot);
  return (server.tool as sinon.SinonStub).getCalls().find(c => c.args[0] === name)!.args[3];
}

const item = (name: string, count = 1) => ({ name, count, type: name.length }) as unknown as Item;

test('matchesTarget: hostile covers monsters filed as "mob", names match exactly, players only on request', (t) => {
  t.true(matchesTarget({ type: 'hostile', name: 'zombie' }, 'hostile'));
  t.true(matchesTarget({ type: 'mob', name: 'slime' }, 'hostile'));
  t.false(matchesTarget({ type: 'animal', name: 'cow' }, 'hostile'));
  t.true(matchesTarget({ type: 'animal', name: 'cow' }, 'cow'));
  t.true(matchesTarget({ type: 'animal', name: 'cow' }, 'minecraft:cow'));
  t.false(matchesTarget({ type: 'animal', name: 'mooshroom' }, 'cow'));
  t.true(matchesTarget({ type: 'animal', name: 'cow' }, 'mob'));
  t.false(matchesTarget({ type: 'player', name: 'player' }, 'mob'));
  t.true(matchesTarget({ type: 'player', name: 'player' }, 'player'));
  t.false(matchesTarget({ type: 'other', name: 'item' }, 'item'));
});

test('bestWeapon prefers swords, then axes, then other tools by tier', (t) => {
  t.is(bestWeapon([item('diamond_pickaxe'), item('iron_sword'), item('apple')])!.item.name, 'iron_sword');
  t.is(bestWeapon([item('wooden_pickaxe'), item('stone_axe')])!.item.name, 'stone_axe');
  t.is(bestWeapon([item('stone_pickaxe'), item('iron_pickaxe')])!.cooldownMs, 850);
  t.is(bestWeapon([item('apple'), item('stick')]), null);
});

const FOODS = {
  apple: { foodPoints: 4, saturation: 2.4 },
  cooked_beef: { foodPoints: 8, saturation: 12.8 },
  rotten_flesh: { foodPoints: 4, saturation: 0.8 },
  golden_apple: { foodPoints: 4, saturation: 9.6 }
};

test('chooseFood picks the most filling safe food and skips harmful or precious food', (t) => {
  t.is(chooseFood([item('apple'), item('cooked_beef'), item('rotten_flesh')], FOODS, 8)!.name, 'cooked_beef');
  t.is(chooseFood([item('rotten_flesh'), item('golden_apple')], FOODS, 8), null);
  t.is(chooseFood([item('stick')], FOODS, 8), null);
});

function fightBot (opts: { hitsToKill: number; health?: number; victimAt?: Vec3; pathfinderSwaps?: boolean }) {
  const victim = Object.assign(new EventEmitter(), {
    id: 7, type: 'hostile', name: 'zombie', height: 1.95, isValid: true,
    position: opts.victimAt ?? new Vec3(2, 64, 0)
  });
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: { 7: victim } as Record<number, unknown>,
    health: opts.health ?? 20,
    food: 20,
    heldItem: null as Item | null,
    inventory: { items: () => [item('stone_pickaxe'), item('iron_sword'), item('dirt', 5)] },
    equip: sinon.stub().callsFake(async (i: Item) => { bot.heldItem = i; }),
    // stands in for pathfinder switching to scaffolding while chasing
    lookAt: sinon.stub().callsFake(async () => { if (opts.pathfinderSwaps) bot.heldItem = item('dirt', 5); }),
    attack: sinon.stub().callsFake(() => {
      if (bot.attack.callCount >= opts.hitsToKill) { victim.isValid = false; delete bot.entities[7]; }
    }),
    nearestEntity: (filter: (e: unknown) => boolean) => (filter(victim) ? victim : null),
    pathfinder: { setGoal: sinon.stub(), goto: sinon.stub().resolves() }
  };
  return { bot, victim };
}

test('attack-entity equips the best weapon, hits until the target is gone, then collects drops', async (t) => {
  const { bot } = fightBot({ hitsToKill: 2 });
  const result = await executor(bot, 'attack-entity')({ target: 'zombie' });
  t.regex(result.content[0].text, /Killed zombie with 2 hit\(s\)/);
  t.is(bot.equip.firstCall.args[0].name, 'iron_sword');
  t.true(bot.pathfinder.goto.calledOnce); // walked to the drops
  t.is(bot.pathfinder.setGoal.lastCall.args[0], null);
});

test('attack-entity stops at low health without chasing further', async (t) => {
  const { bot } = fightBot({ hitsToKill: 99, health: 5 });
  const result = await executor(bot, 'attack-entity')({ target: 'hostile' });
  t.regex(result.content[0].text, /Stopped attacking zombie after 0 hit\(s\): health is low/);
  t.false(bot.attack.called);
});

test('attack-entity reports when nothing matches nearby', async (t) => {
  const { bot } = fightBot({ hitsToKill: 1, victimAt: new Vec3(40, 64, 0) });
  const result = await executor(bot, 'attack-entity')({ target: 'zombie' });
  t.regex(result.content[0].text, /No zombie within 16 blocks/);
});

function eatBot (food: number, items: Item[]) {
  const bot = Object.assign(new EventEmitter(), {
    version: '26.3',
    game: { gameMode: 'survival' },
    food,
    health: 14,
    inventory: { items: () => items, selectedItem: null, firstEmptyInventorySlot: () => 20 },
    equip: sinon.stub().resolves(),
    waitForTicks: sinon.stub().resolves(),
    clickWindow: sinon.stub().resolves(),
    consume: sinon.stub().callsFake(async () => {
      setTimeout(() => { bot.food = Math.min(20, bot.food + 8); bot.emit('health'); }, 10);
    })
  });
  return bot;
}

test('eat picks the best safe food and reports the change', async (t) => {
  const bot = eatBot(10, [item('rotten_flesh'), item('cooked_beef'), item('apple')]);
  const result = await executor(bot, 'eat')({});
  t.is(bot.equip.firstCall.args[0].name, 'cooked_beef');
  t.regex(result.content[0].text, /Ate cooked_beef: food 10 -> 18/);
});

test('eat refuses when not hungry, and when the named item is missing or not food', async (t) => {
  t.regex((await executor(eatBot(20, [item('apple')]), 'eat')({})).content[0].text, /Not hungry/);
  t.regex((await executor(eatBot(10, [item('apple')]), 'eat')({ item: 'bread' })).content[0].text, /No bread in inventory/);
  t.regex((await executor(eatBot(10, [item('stick')]), 'eat')({ item: 'stick' })).content[0].text, /stick isn't edible/);
});

test('get-status reports vitals and time until night', async (t) => {
  const bot = {
    health: 17.5, food: 15, foodSaturation: 2,
    time: { timeOfDay: 11800 },
    game: { dimension: 'overworld', gameMode: 'survival', difficulty: 'easy' }
  };
  const text = (await executor(bot, 'get-status')({})).content[0].text;
  t.regex(text, /Health 17\.5\/20, food 15\/20, saturation 2/);
  t.regex(text, /day; night in 1\.0 min/);
  t.regex(text, /difficulty easy/);
  bot.time.timeOfDay = 18000;
  t.regex((await executor(bot, 'get-status')({})).content[0].text, /night; dawn in 4\.2 min/);
});

test('attack-entity takes the weapon back when chasing put something else in hand', async (t) => {
  const { bot } = fightBot({ hitsToKill: 3, pathfinderSwaps: true });
  // the swap happens in lookAt, after the re-equip check: re-equip again on the next swing
  bot.lookAt = sinon.stub().resolves();
  bot.attack.callsFake(() => {
    bot.heldItem = item('dirt', 5);
    if (bot.attack.callCount >= 3) delete bot.entities[7];
  });
  const result = await executor(bot, 'attack-entity')({ target: 'zombie' });
  t.regex(result.content[0].text, /Killed zombie with 3 hit\(s\) \(iron_sword x3\)/);
  t.is(bot.equip.callCount, 3);
});

test('attack-entity names the other hostiles around when it stops at low health', async (t) => {
  const { bot } = fightBot({ hitsToKill: 99, health: 5 });
  bot.entities[8] = { id: 8, type: 'hostile', name: 'skeleton', isValid: true, position: new Vec3(6, 64, 0) };
  bot.entities[9] = { id: 9, type: 'animal', name: 'cow', isValid: true, position: new Vec3(3, 64, 0) };
  const result = await executor(bot, 'attack-entity')({ target: 'zombie' });
  t.regex(result.content[0].text, /Hostiles nearby: zombie 2 blocks away, skeleton 6 blocks away\. Retreat/);
  t.notRegex(result.content[0].text, /cow/);
});
