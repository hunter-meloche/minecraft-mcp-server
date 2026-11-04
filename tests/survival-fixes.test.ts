import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';
import { registerFurnaceTools } from '../src/tools/furnace-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import { BotConnection } from '../src/bot-connection.js';
import { settleInventory } from '../src/inventory-sync.js';
import { isReplaceable, protectPlacedBlock, isProtected, installBuildProtection, jsonFileStore, worldIdFromSeed } from '../src/build-protection.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type mineflayer from 'mineflayer';

function smeltExecutor (bot: unknown) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  registerFurnaceTools(new ToolFactory(server, connection), () => bot as mineflayer.Bot);
  return (server.tool as sinon.SinonStub).getCalls().find(c => c.args[0] === 'smelt-item')!.args[3];
}

test('smelt-item keeps collecting until the input slot is empty', async (t) => {
  const furnace = new EventEmitter() as mineflayer.Furnace & EventEmitter;
  let input: { name: string; count: number } | null = { name: 'raw_iron', count: 3 };
  let output: { name: string; count: number } | null = null;
  furnace.putInput = sinon.stub().resolves();
  furnace.putFuel = sinon.stub().resolves();
  furnace.inputItem = (() => input) as never;
  furnace.fuelItem = (() => null) as never;
  furnace.outputItem = (() => output) as never;
  furnace.takeOutput = (async () => { const o = output!; output = null; return o; }) as never;
  furnace.close = sinon.stub();
  // the furnace finishes one item per "tick" of this fake
  const timer = setInterval(() => {
    if (!input) return;
    output = { name: 'iron_ingot', count: (output?.count ?? 0) + 1 };
    input = input.count > 1 ? { ...input, count: input.count - 1 } : null;
    furnace.emit('update');
  }, 20);
  const bot = {
    blockAt: () => ({ name: 'furnace' }),
    openFurnace: async () => furnace,
    inventory: { items: () => [{ name: 'raw_iron', count: 3, type: 1 }, { name: 'coal', count: 1, type: 2 }] }
  };
  const result = await smeltExecutor(bot)({ x: 0, y: 0, z: 0, inputItem: 'raw_iron', inputCount: 3, fuelItem: 'coal' });
  clearInterval(timer);
  t.regex(result.content[0].text, /Smelted 3 iron_ingot/);
});

test('smelt-item collects existing output when no input is left in the inventory', async (t) => {
  const furnace = new EventEmitter() as mineflayer.Furnace & EventEmitter;
  let output: { name: string; count: number } | null = { name: 'iron_ingot', count: 2 };
  furnace.putInput = sinon.stub().resolves();
  furnace.putFuel = sinon.stub().resolves();
  furnace.inputItem = (() => null) as never;
  furnace.fuelItem = (() => null) as never;
  furnace.outputItem = (() => output) as never;
  furnace.takeOutput = (async () => { const o = output!; output = null; return o; }) as never;
  furnace.close = sinon.stub();
  const bot = { blockAt: () => ({ name: 'furnace' }), openFurnace: async () => furnace, inventory: { items: () => [] } };
  const result = await smeltExecutor(bot)({ x: 0, y: 0, z: 0, inputItem: 'raw_iron', fuelItem: 'coal' });
  t.regex(result.content[0].text, /Smelted 2 iron_ingot/);
  t.false((furnace.putInput as sinon.SinonStub).called);
});

test('settleInventory puts a leftover cursor item into an empty slot', async (t) => {
  const bot = {
    waitForTicks: sinon.stub().resolves(),
    clickWindow: sinon.stub().resolves(),
    inventory: { selectedItem: { name: 'birch_log', count: 1 }, firstEmptyInventorySlot: () => 20 }
  };
  await settleInventory(bot as never);
  t.true(bot.clickWindow.calledOnceWith(20, 0, 0));
});

test('settleInventory does nothing when the cursor is empty', async (t) => {
  const bot = { waitForTicks: sinon.stub().resolves(), clickWindow: sinon.stub(), inventory: { selectedItem: null, firstEmptyInventorySlot: () => 20 } };
  await settleInventory(bot as never);
  t.false(bot.clickWindow.called);
});

test('grass, leaf litter and single snow layers are replaceable; stone and thick snow are not', (t) => {
  t.true(isReplaceable({ name: 'short_grass' }));
  t.true(isReplaceable({ name: 'leaf_litter' }));
  t.true(isReplaceable({ name: 'snow', getProperties: () => ({ layers: 1 }) }));
  t.false(isReplaceable({ name: 'snow', getProperties: () => ({ layers: 3 }) }));
  t.false(isReplaceable({ name: 'stone' }));
});

test('pathfinder may not break blocks the bot placed', (t) => {
  const bot = {} as mineflayer.Bot;
  const movements = { exclusionAreasBreak: [] as ((b: { position: Vec3 }) => number)[] };
  installBuildProtection(bot, movements);
  protectPlacedBlock(bot, new Vec3(-962, 113, -385));
  t.true(isProtected(bot, new Vec3(-961.6, 113.9, -384.2))); // any point inside the block
  t.is(movements.exclusionAreasBreak[0]({ position: new Vec3(-962, 113, -385) }), 100);
  t.is(movements.exclusionAreasBreak[0]({ position: new Vec3(-961, 113, -385) }), 0);
});

type Rule = (b: { position: Vec3 }) => number;
const fakeBot = (dimension = 'overworld') => Object.assign(new EventEmitter(), { game: { dimension } }) as unknown as mineflayer.Bot;
const tempStoreFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-protect-')), 'placed-blocks.json');

test('placed blocks stay protected for a new bot in the same world after a restart', (t) => {
  const file = tempStoreFile();
  const first = fakeBot();
  installBuildProtection(first, { exclusionAreasBreak: [] as Rule[] }, { store: jsonFileStore(file), world: 'seed:42' });
  protectPlacedBlock(first, new Vec3(-952, 115, -388));

  const second = fakeBot();
  const movements = { exclusionAreasBreak: [] as Rule[] };
  installBuildProtection(second, movements, { store: jsonFileStore(file), world: 'seed:42' });
  t.is(movements.exclusionAreasBreak[0]({ position: new Vec3(-952, 115, -388) }), 100);

  const otherWorld = fakeBot();
  installBuildProtection(otherWorld, { exclusionAreasBreak: [] as Rule[] }, { store: jsonFileStore(file), world: 'seed:7' });
  t.false(isProtected(otherWorld, new Vec3(-952, 115, -388)));
});

test('the same coordinates in another dimension are not protected', (t) => {
  const bot = fakeBot('overworld');
  installBuildProtection(bot, { exclusionAreasBreak: [] as Rule[] });
  protectPlacedBlock(bot, new Vec3(1, 2, 3));
  (bot.game as { dimension: string }).dimension = 'the_nether';
  t.false(isProtected(bot, new Vec3(1, 2, 3)));
});

test('a protected block that turns into air is forgotten, also in the saved file', (t) => {
  const file = tempStoreFile();
  const bot = fakeBot();
  installBuildProtection(bot, { exclusionAreasBreak: [] as Rule[] }, { store: jsonFileStore(file), world: 'seed:42' });
  protectPlacedBlock(bot, new Vec3(5, 64, 5));
  protectPlacedBlock(bot, new Vec3(6, 64, 5));
  bot.emit('blockUpdate', { name: 'cobblestone', position: new Vec3(5, 64, 5) } as never, { name: 'air', position: new Vec3(5, 64, 5) } as never);
  bot.emit('blockUpdate', null, { name: 'stone', position: new Vec3(6, 64, 5) } as never); // still solid: keep it
  t.false(isProtected(bot, new Vec3(5, 64, 5)));
  t.true(isProtected(bot, new Vec3(6, 64, 5)));
  t.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'seed:42': ['overworld:6,64,5'] });
});

test('a missing or corrupt protection file starts empty', (t) => {
  const file = tempStoreFile();
  t.deepEqual(jsonFileStore(file).load('seed:1'), []);
  fs.writeFileSync(file, '{not json');
  t.deepEqual(jsonFileStore(file).load('seed:1'), []);
});

test('worldIdFromSeed uses the decimal hashed seed and tolerates a missing one', (t) => {
  const signedBigIntLike = Object.assign([-1, -2], { toString: () => '-2' }); // protodef i64 stringifies to decimal
  t.is(worldIdFromSeed(signedBigIntLike), 'seed:-2');
  t.is(worldIdFromSeed(123n), 'seed:123');
  t.is(worldIdFromSeed(undefined), undefined);
});
