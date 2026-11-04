import test from 'ava';
import sinon from 'sinon';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import nbt from 'prismarine-nbt';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolFactory } from '../../src/tool-factory.js';
import { MessageStore } from '../../src/message-store.js';
import { registerClientTools, mineflayerSlot, entityKind } from '../../src/client/tools.js';
import { mineflayerToolDefinitions } from '../../src/tools/register-all.js';
import type { BridgeClient } from '../../src/client/bridge-client.js';

const STATUS = {
  inWorld: true, username: 'Bot', screen: null, position: { x: 10.5, y: 64, z: -3.2 }, block: { x: 10, y: 64, z: -4 },
  health: 18, food: 17, saturation: 2.5, air: 20, underWater: false, inLava: false, dimension: 'overworld', gameMode: 'survival',
  difficulty: 'easy', timeOfDay: 11800, process: null, goal: null
};

function setup(responses: Record<string, unknown | ((p: Record<string, unknown>) => unknown)>) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) };
  const request = sinon.spy(async (method: string, params: Record<string, unknown> = {}) => {
    const r = responses[method];
    if (r === undefined) throw new Error(`unexpected bridge call ${method}`);
    return typeof r === 'function' ? (r as (p: Record<string, unknown>) => unknown)(params) : r;
  });
  const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-'));
  const store = new MessageStore();
  registerClientTools(new ToolFactory(server, connection), { request } as unknown as BridgeClient, store, { gameDir });
  const tools = (server.tool as sinon.SinonStub).getCalls();
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tools.find(c => c.args[0] === name)!.args[3](args);
    return { text: r.content.map((c: { text: string }) => c.text).join('\n'), isError: !!r.isError };
  };
  return { run, request, gameDir, store, tools };
}

test('the client backend offers every mineflayer tool with the same schema, plus its own', (t) => {
  const { tools } = setup({});
  const client = new Map(tools.map(c => [c.args[0] as string, c.args]));
  for (const def of mineflayerToolDefinitions()) {
    const args = client.get(def.name);
    t.truthy(args, `missing ${def.name}`);
    t.is(args![1], def.description);
    t.deepEqual(Object.keys(args![2] as object), Object.keys(def.schema), def.name);
  }
  t.deepEqual([...client.keys()].filter(n => !mineflayerToolDefinitions().some(d => d.name === n)).sort(), ['build-structure', 'mine-blocks', 'stop']);
});

test('read tools answer in the mineflayer wording', async (t) => {
  const { run } = setup({
    status: STATUS,
    inventory: { items: [{ slot: 0, name: 'stone_pickaxe', count: 1 }, { slot: 12, name: 'oak_log', count: 5 }, { slot: 40, name: 'shield', count: 1 }], selectedSlot: 0, held: null },
    'world.findBlocks': { positions: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }] },
    'world.block': { loaded: true, name: 'oak_log', properties: { axis: 'y' } },
    'world.entities': { entities: [{ id: 1, name: 'cow', category: 'creature', position: { x: 1.5, y: 64, z: 2.5 }, distance: 3 }, { id: 2, name: 'zombie', category: 'monster', position: { x: -4.2, y: 64, z: 0 }, distance: 6 }] }
  });
  t.is((await run('get-position')).text, 'Current position: (10, 64, -4)');
  t.regex((await run('get-status')).text, /^Health 18\/20, food 17\/20, saturation 2.5\nTime of day 11800 \(day; night in 1.0 min\)\nDimension overworld, game mode survival, difficulty easy\nBackend: game client with Baritone \(idle\)$/);
  t.is((await run('list-inventory')).text, 'Found 3 items in inventory:\n\n- stone_pickaxe (x1) in slot 36\n- oak_log (x5) in slot 12\n- shield (x1) in slot 45\n');
  t.is((await run('find-item', { nameOrType: 'log' })).text, 'Found 5 oak_log in inventory (slot 12)');
  t.is((await run('find-blocks', { blockType: 'oak_log', count: 5 })).text, 'Found 2 oak_log block(s) within 16 blocks:\n1. (1, 2, 3)\n2. (4, 5, 6)');
  t.is((await run('get-block-info', { x: 1.7, y: 2, z: 3 })).text, 'Found oak_log[axis=y] at position (1, 2, 3)');
  t.is((await run('find-entity', { type: 'hostile' })).text, 'Found zombie at position (-5, 64, 0)');
  t.is((await run('find-entity', { type: 'cow' })).text, 'Found cow at position (1, 64, 2)');
});

test('a bot not yet in the world says so instead of failing oddly', async (t) => {
  const { run } = setup({ status: { inWorld: false, username: 'Bot', screen: 'LevelLoadingScreen' } });
  const r = await run('get-position');
  t.true(r.isError);
  t.regex(r.text, /not in a world yet \(screen: LevelLoadingScreen\)/);
});

test('move-to-position: arrival, and an honest failure with what Baritone said', async (t) => {
  const ok = setup({ goto: { arrived: true, reason: 'done', seconds: 36, baritone: [], at: { x: 9, y: 64, z: 9 }, distance: 0.5 } });
  t.is((await ok.run('move-to-position', { x: 9, y: 64, z: 9 })).text, 'Successfully moved to position near (9, 64, 9)');
  t.like(ok.request.firstCall.args[1], { x: 9, y: 64, z: 9, range: 1 });
  const stuck = setup({ goto: { arrived: false, reason: 'done', seconds: 19, baritone: ['Going to: GoalBlock{x=-677,y=59,z=-297}'], at: { x: -679, y: 61, z: -300 }, distance: 4.1 } });
  const r = await stuck.run('move-to-position', { x: -677, y: 59, z: -297 });
  t.true(r.isError);
  t.regex(r.text, /Could not reach \(-677, 59, -297\): no path found\. Stopped at \(-679, 61, -300\), 4.1 blocks away\. Baritone: Going to/);
});

test('mine-blocks reports what was gained', async (t) => {
  const { run, request } = setup({ mine: { reason: 'done', seconds: 33, baritone: ['Mining [acacia_log]', 'Have 14 valid items'], gained: { acacia_log: 8 } } });
  t.is((await run('mine-blocks', { block: 'acacia_log', count: 14 })).text, 'Mined for 33s: acacia_log x8. Baritone: Mining [acacia_log] | Have 14 valid items');
  t.like(request.firstCall.args[1], { block: 'acacia_log', count: 14 });
});

test('build-structure checks materials, writes the schematic, and builds it', async (t) => {
  const spec = { palette: { L: 'oak_log[axis=y]' }, layers: [['L.L'], ['L.L']] };
  const poor = setup({ status: STATUS, inventory: { items: [{ slot: 1, name: 'oak_log', count: 2 }], selectedSlot: 0, held: null } });
  const refused = await poor.run('build-structure', { x: 0, y: 64, z: 0, spec, name: 'posts' });
  t.true(refused.isError);
  t.regex(refused.text, /Missing: oak_log 2\/4/);

  const rich = setup({
    status: STATUS,
    inventory: { items: [{ slot: 1, name: 'oak_log', count: 9 }], selectedSlot: 0, held: null },
    build: { reason: 'done', seconds: 30, baritone: ['Done building'], used: { oak_log: 4 } }
  });
  const r = await rich.run('build-structure', { x: -706.4, y: 73, z: -336, spec, name: 'posts' });
  t.is(r.text, 'Built posts at (-707, 73, -336) in 30s. Used: oak_log x4. Baritone: Done building');
  const file = path.join(rich.gameDir, 'schematics', 'posts.schem');
  t.like(rich.request.lastCall.args[1], { file, x: -707, y: 73, z: -336 });
  const parsed = nbt.simplify((await nbt.parse(zlib.gunzipSync(fs.readFileSync(file)))).parsed) as Record<string, unknown>;
  t.like(parsed, { Width: 3, Height: 2, Length: 1 });
});

test('tools the client backend does not have yet say so', async (t) => {
  const { run } = setup({});
  const r = await run('attack-entity', { target: 'zombie' });
  t.true(r.isError);
  t.regex(r.text, /not available on the client backend yet/);
});

test('slot and entity helpers', (t) => {
  t.deepEqual([0, 8, 9, 35, 36, 39, 40].map(mineflayerSlot), [36, 44, 9, 35, 8, 5, 45]);
  t.deepEqual(entityKind('zombie'), { type: 'hostile', name: 'zombie' });
  t.deepEqual(entityKind('player'), { type: 'player', name: 'player' });
});

test('dig-block digs through Baritone, walks onto the drops and reports the pickup', async (t) => {
  let invCalls = 0;
  const { run, request } = setup({
    inventory: () => ({ items: invCalls++ === 0 ? [] : [{ slot: 3, name: 'cobblestone', count: 1 }], selectedSlot: 0, held: null }),
    dig: { dug: true, block: 'stone', tool: 'wooden_pickaxe', reason: 'done', seconds: 2, baritone: [] },
    'world.entities': { entities: [{ id: 9, name: 'item', category: 'misc', position: { x: 5.4, y: 63, z: 5.6 }, distance: 2 }, { id: 8, name: 'item', category: 'misc', position: { x: 30, y: 64, z: 30 }, distance: 30 }] },
    goto: { arrived: true, reason: 'done', seconds: 1, baritone: [], at: { x: 5, y: 63, z: 5 }, distance: 0 }
  });
  t.is((await run('dig-block', { x: 5, y: 64, z: 5 })).text, 'Dug stone at (5, 64, 5) with wooden_pickaxe. Picked up cobblestone x1');
  const gotos = request.getCalls().filter(c => c.args[0] === 'goto');
  t.is(gotos.length, 1); // only the drop next to the block
  t.like(gotos[0].args[1], { x: 5, y: 63, z: 5, range: 0 });
});

test('place-block selects the item, walks closer when too far, and reports the face', async (t) => {
  let tries = 0;
  const { run, request } = setup({
    'item.select': { held: 0 },
    place: () => (tries++ === 0 ? { placed: false, reason: 'too far' } : { placed: true, block: 'cobblestone', face: 'down' }),
    goto: { arrived: true, reason: 'done', seconds: 3, baritone: [], at: { x: 0, y: 64, z: 2 }, distance: 2 }
  });
  t.is((await run('place-block', { x: 0, y: 64, z: 0, item: 'cobblestone' })).text, 'Placed cobblestone at (0, 64, 0) using down face');
  t.deepEqual(request.getCalls().map(c => c.args[0]), ['item.select', 'place', 'goto', 'place']);
  const occupied = setup({ place: { placed: false, reason: 'occupied by stone' } });
  t.is((await occupied.run('place-block', { x: 0, y: 64, z: 0 })).text, "There's already a block (stone) at (0, 64, 0)");
});

test('eat picks the best safe food and reports hunger before and after', async (t) => {
  const { run, request } = setup({
    status: { ...STATUS, food: 12 },
    inventory: { items: [{ slot: 1, name: 'rotten_flesh', count: 3 }, { slot: 2, name: 'cooked_porkchop', count: 2 }], selectedSlot: 0, held: null },
    'item.select': { held: 2 },
    use: { finished: true, food: 20, foodBefore: 12, health: 18, healthBefore: 18 }
  });
  t.is((await run('eat')).text, 'Ate cooked_porkchop: food 12 -> 20, health 18 -> 18');
  t.like(request.getCalls().find(c => c.args[0] === 'item.select')!.args[1], { name: 'cooked_porkchop' });
});

test('craft-item uses the inventory grid, and falls back to the nearest table', async (t) => {
  const grid = setup({ craft: { crafted: 2, gained: { oak_planks: 8 } } });
  t.is((await grid.run('craft-item', { outputItem: 'oak_planks', amount: 2 })).text, 'Successfully crafted oak_planks 2 time(s)');

  let first = true;
  const table = setup({
    craft: (p: Record<string, unknown>) => {
      if (first) { first = false; throw new Error('needs_table: wooden_pickaxe needs a crafting table'); }
      return { crafted: 1, gained: { wooden_pickaxe: 1 }, ...p };
    },
    'world.findBlocks': { positions: [{ x: 3, y: 64, z: 3 }] },
    goto: { arrived: true, reason: 'done', seconds: 2, baritone: [], at: { x: 3, y: 64, z: 1 }, distance: 2 }
  });
  t.is((await table.run('craft-item', { outputItem: 'wooden_pickaxe' })).text, 'Successfully crafted wooden_pickaxe 1 time(s)');
  t.like(table.request.lastCall.args[1], { item: 'wooden_pickaxe', x: 3, y: 64, z: 3 });

  const none = setup({
    craft: () => { throw new Error('needs_table: x'); },
    'world.findBlocks': { positions: [] },
    inventory: { items: [], selectedSlot: 0, held: null }
  });
  t.regex((await none.run('craft-item', { outputItem: 'wooden_pickaxe' })).text, /needs a crafting table and there is none within 16 blocks\. Craft a crafting_table/);
});

test('smelt-item opens the furnace, adds only the fuel needed, and collects the output', async (t) => {
  let polls = 0;
  const { run, request } = setup({
    'world.block': { loaded: true, name: 'furnace' },
    'furnace.open': { open: true, input: null, fuel: null, output: null, lit: false },
    inventory: { items: [{ slot: 4, name: 'raw_iron', count: 5 }, { slot: 5, name: 'coal', count: 3 }], selectedSlot: 0, held: null },
    'furnace.put': { open: true },
    'furnace.status': () => {
      polls++;
      if (polls === 1) return { open: true, input: { name: 'raw_iron', count: 2 }, fuel: null, output: { name: 'iron_ingot', count: 3 }, lit: true };
      if (polls === 2) return { open: true, input: null, fuel: null, output: { name: 'iron_ingot', count: 2 }, lit: false };
      return { open: true, input: null, fuel: null, output: null, lit: false };
    },
    'furnace.take': () => ({ took: polls === 1 ? { name: 'iron_ingot', count: 3 } : { name: 'iron_ingot', count: 2 } }),
    'container.close': { ok: true }
  });
  const r = await run('smelt-item', { x: 1, y: 64, z: 1, inputItem: 'raw_iron', inputCount: 5, fuelItem: 'coal' });
  t.is(r.text, 'Smelted 5 iron_ingot');
  const puts = request.getCalls().filter(c => c.args[0] === 'furnace.put').map(c => c.args[1]);
  t.deepEqual(puts, [{ slot: 'fuel', name: 'coal', count: 1 }, { slot: 'input', name: 'raw_iron', count: 5 }]);
  t.is(request.lastCall.args[0], 'container.close');
});
