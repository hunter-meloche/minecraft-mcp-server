import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';
import { registerFurnaceTools } from '../src/tools/furnace-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import { BotConnection } from '../src/bot-connection.js';
import { settleInventory } from '../src/inventory-sync.js';
import { isReplaceable, protectPlacedBlock, isProtected, installBuildProtection } from '../src/build-protection.js';
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
