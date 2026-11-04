import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'events';
import { registerFurnaceTools } from '../src/tools/furnace-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import { BotConnection } from '../src/bot-connection.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';

const createMockItem = (fields: {
  name: string;
  count: number;
  type: number;
  metadata: number;
  slot?: number;
}): Item => fields as unknown as Item;

test('registerFurnaceTools registers smelt-item tool', (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerFurnaceTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const smeltCall = toolCalls.find(call => call.args[0] === 'smelt-item');
  t.truthy(smeltCall);
  t.true(String(smeltCall!.args[1]).startsWith('Smelt items using a furnace-like block'));
});

test('smelt-item returns error when no furnace block found', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    blockAt: sinon.stub().returns(null)
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerFurnaceTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const smeltCall = toolCalls.find(call => call.args[0] === 'smelt-item');
  const executor = smeltCall!.args[3];

  const result = await executor({
    x: 1,
    y: 2,
    z: 3,
    inputItem: 'iron_ore',
    fuelItem: 'coal'
  });

  t.true(result.content[0].text.includes('No furnace block found'));
});

test('smelt-item loads input and fuel and takes output', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const furnace = new EventEmitter() as mineflayer.Furnace & EventEmitter;
  const outputItem = createMockItem({
    name: 'iron_ingot',
    count: 1,
    type: 100,
    metadata: 0,
    slot: 0
  });

  furnace.putInput = sinon.stub().resolves();
  furnace.putFuel = sinon.stub().resolves();
  furnace.takeOutput = sinon.stub().resolves(outputItem);
  furnace.inputItem = sinon.stub().returns(null);
  furnace.fuelItem = sinon.stub().returns(null);
  furnace.outputItem = sinon.stub().returns(outputItem);
  furnace.close = sinon.stub();

  const mockBot = {
    blockAt: sinon.stub().returns({ name: 'furnace' }),
    openFurnace: sinon.stub().resolves(furnace),
    inventory: {
      items: () => [
        createMockItem({ name: 'iron_ore', count: 3, type: 15, metadata: 0 }),
        createMockItem({ name: 'coal', count: 2, type: 263, metadata: 0 })
      ]
    }
  } as unknown as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerFurnaceTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const smeltCall = toolCalls.find(call => call.args[0] === 'smelt-item');
  const executor = smeltCall!.args[3];

  const result = await executor({
    x: 1,
    y: 2,
    z: 3,
    inputItem: 'iron_ore',
    fuelItem: 'coal'
  });

  t.true(result.content[0].text.includes('Smelted 1 iron_ingot'));
  t.true((furnace.putInput as sinon.SinonStub).calledOnce);
  t.true((furnace.putFuel as sinon.SinonStub).calledOnce);
  t.true((furnace.takeOutput as sinon.SinonStub).calledOnce);
  t.true((furnace.close as sinon.SinonStub).calledOnce);
});

test('smelt-item returns validation error for non-positive counts', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerFurnaceTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const smeltCall = toolCalls.find(call => call.args[0] === 'smelt-item');
  const executor = smeltCall!.args[3];

  const inputCountResult = await executor({
    x: 1,
    y: 2,
    z: 3,
    inputItem: 'iron_ore',
    inputCount: 0,
    fuelItem: 'coal',
    fuelCount: 1
  });

  t.true(inputCountResult.isError);
  t.true(inputCountResult.content[0].text.includes('Invalid tool arguments'));
  t.true(inputCountResult.content[0].text.includes('inputCount'));

  const fuelCountResult = await executor({
    x: 1,
    y: 2,
    z: 3,
    inputItem: 'iron_ore',
    inputCount: 1,
    fuelItem: 'coal',
    fuelCount: -1
  });

  t.true(fuelCountResult.isError);
  t.true(fuelCountResult.content[0].text.includes('Invalid tool arguments'));
  t.true(fuelCountResult.content[0].text.includes('fuelCount'));
});

function startSmelt (opts: { fuelInSlot?: { name: string; count: number } | null; burning?: number; inventory: { name: string; count: number }[] }) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const furnace = new EventEmitter() as mineflayer.Furnace & EventEmitter;
  furnace.putInput = sinon.stub().resolves();
  furnace.putFuel = sinon.stub().resolves();
  furnace.inputItem = sinon.stub().returns(null);
  furnace.fuelItem = sinon.stub().returns(opts.fuelInSlot ?? null);
  furnace.outputItem = sinon.stub().returns(null);
  furnace.close = sinon.stub();
  Object.assign(furnace, { fuel: opts.burning ?? 0 });
  const bot = {
    blockAt: () => ({ name: 'furnace' }),
    openFurnace: async () => furnace,
    inventory: { items: () => opts.inventory.map((i, n) => createMockItem({ ...i, type: 10 + n, metadata: 0 })) }
  };
  registerFurnaceTools(new ToolFactory(server, connection), () => bot as unknown as mineflayer.Bot);
  const run = (server.tool as sinon.SinonStub).getCalls().find(c => c.args[0] === 'smelt-item')!.args[3];
  return { run, putFuel: furnace.putFuel as sinon.SinonStub };
}

test('smelt-item adds only the fuel the input still needs', async (t) => {
  // 3 coal in the slot covers 24 items: none added for 5
  const stocked = startSmelt({ fuelInSlot: { name: 'coal', count: 3 }, inventory: [{ name: 'raw_iron', count: 5 }, { name: 'coal', count: 9 }] });
  const r1 = await stocked.run({ x: 0, y: 0, z: 0, inputItem: 'raw_iron', inputCount: 5, fuelItem: 'coal', takeOutput: false });
  t.false(stocked.putFuel.called);
  t.is(r1.content[0].text, 'Started smelting 5 raw_iron');

  // 10 items from an empty furnace: 2 coal
  const empty = startSmelt({ inventory: [{ name: 'raw_iron', count: 10 }, { name: 'coal', count: 9 }] });
  await empty.run({ x: 0, y: 0, z: 0, inputItem: 'raw_iron', inputCount: 10, fuelItem: 'coal', takeOutput: false });
  t.is(empty.putFuel.firstCall.args[2], 2);

  // fuelCount caps it; planks smelt 1.5 each
  const planks = startSmelt({ inventory: [{ name: 'porkchop', count: 6 }, { name: 'oak_planks', count: 20 }] });
  await planks.run({ x: 0, y: 0, z: 0, inputItem: 'porkchop', inputCount: 6, fuelItem: 'oak_planks', takeOutput: false });
  t.is(planks.putFuel.firstCall.args[2], 4);
  const capped = startSmelt({ inventory: [{ name: 'porkchop', count: 6 }, { name: 'oak_planks', count: 20 }] });
  await capped.run({ x: 0, y: 0, z: 0, inputItem: 'porkchop', inputCount: 6, fuelItem: 'oak_planks', fuelCount: 2, takeOutput: false });
  t.is(capped.putFuel.firstCall.args[2], 2);
});
