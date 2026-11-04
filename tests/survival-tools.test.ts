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
import { arena, mob, item as fakeItem } from './helpers/arena.js';
import pathfinderPkg from 'mineflayer-pathfinder';

const { goals } = pathfinderPkg;

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

test('attack-entity reports kills, landed hits and armor it put on', async (t) => {
  const { bot } = arena({ mobs: [mob('zombie', 2), mob('husk', 3)], items: [fakeItem('iron_sword'), fakeItem('iron_helmet')], damage: 10, misses: s => s === 1 });
  const text = (await executor(bot, 'attack-entity')({ target: 'hostile' })).content[0].text;
  t.regex(text, /^Put on iron_helmet\. Killed zombie, husk with 5 swing\(s\), 4 landed \(iron_sword x5\) in [\d.]+s\. Health 20\/20/);
});

test('attack-entity at low health says it fled and ate', async (t) => {
  const zombie = mob('zombie', 2);
  const { bot } = arena({ mobs: [zombie, mob('spider', 14)], items: [fakeItem('wooden_sword'), fakeItem('apple')], health: 4, food: 15 });
  // running works: the zombie is left behind
  bot.pathfinder.setGoal = sinon.spy((g: unknown) => { if (g instanceof goals.GoalInvert) zombie.position = new Vec3(40, 64, 0); });
  const text = (await executor(bot, 'attack-entity')({ target: 'zombie' })).content[0].text;
  t.regex(text, /Stopped fighting zombie after no swings: health is low\. Then fled from zombie, ate apple\./);
  t.regex(text, /Hostiles nearby: spider 14 blocks away\. Wall yourself in/);
});

test('attack-entity reports when nothing matches nearby', async (t) => {
  const { bot } = arena({ mobs: [mob('zombie', 40)] });
  t.regex((await executor(bot, 'attack-entity')({ target: 'zombie' })).content[0].text, /No zombie within 16 blocks/);
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
