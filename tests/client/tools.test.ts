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
import { blockDrops, missingIngredients, packSlotsUsed, processName, registerClientTools, setFarmSettle, setStallTiming, mineflayerSlot, entityKind } from '../../src/client/tools.js';
import { mineflayerToolDefinitions } from '../../src/tools/register-all.js';
import type { ProtectionStore } from '../../src/build-protection.js';
import type { BridgeClient } from '../../src/client/bridge-client.js';

const STATUS = {
  inWorld: true, username: 'Bot', screen: null, position: { x: 10.5, y: 64, z: -3.2 }, block: { x: 10, y: 64, z: -4 },
  health: 18, food: 17, saturation: 2.5, air: 20, underWater: false, inLava: false, dimension: 'overworld', gameMode: 'survival',
  difficulty: 'easy', timeOfDay: 11800, process: null, goal: null
};

function setup(given: Record<string, unknown | ((p: Record<string, unknown>) => unknown)>, protectionStore?: ProtectionStore) {
  const responses: Record<string, unknown> = { status: STATUS, ...given };
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) };
  const request = sinon.spy(async (method: string, params: Record<string, unknown> = {}) => {
    const r = responses[method];
    if (r === undefined) throw new Error(`unexpected bridge call ${method}`);
    return typeof r === 'function' ? (r as (p: Record<string, unknown>) => unknown)(params) : r;
  });
  const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-'));
  const store = new MessageStore();
  registerClientTools(new ToolFactory(server, connection), { request } as unknown as BridgeClient, store, { gameDir, protectionStore });
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
  t.deepEqual([...client.keys()].filter(n => !mineflayerToolDefinitions().some(d => d.name === n)).sort(), ['build-structure', 'collect-items', 'drop-item', 'explore', 'farm', 'fish', 'go-home', 'level-area', 'mine-blocks', 'set-home', 'stop', 'store-in-chest', 'survey-area', 'take-from-chest', 'use-item-on-block']);
});

test('read tools answer in the mineflayer wording', async (t) => {
  const { run } = setup({
    status: STATUS,
    'guardian.status': { enabled: true, armor: ['iron_boots', 'shield'] },
    inventory: { items: [{ slot: 0, name: 'stone_pickaxe', count: 1 }, { slot: 12, name: 'oak_log', count: 5 }, { slot: 40, name: 'shield', count: 1 }], selectedSlot: 0, held: null },
    'world.findBlocks': { positions: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }] },
    'world.block': { loaded: true, name: 'oak_log', properties: { axis: 'y' } },
    'world.entities': { entities: [{ id: 1, name: 'cow', category: 'creature', position: { x: 1.5, y: 64, z: 2.5 }, distance: 3 }, { id: 2, name: 'zombie', category: 'monster', position: { x: -4.2, y: 64, z: 0 }, distance: 6 }] }
  });
  t.is((await run('get-position')).text, 'Current position: (10, 64, -4)');
  t.regex((await run('get-status')).text, /^Health 18\/20, food 17\/20, saturation 2.5\nTime of day 11800 \(day; night in 1.0 min\)\nDimension overworld, game mode survival, difficulty easy\nArmor: iron_boots, shield; auto-defend on; inventory 2\/36 slots used\nBackend: game client with Baritone \(idle\)$/);
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
  t.like(ok.request.getCalls().find(c => c.args[0] === 'goto')!.args[1], { x: 9, y: 64, z: 9, range: 1 });
  const stuck = setup({ goto: { arrived: false, reason: 'done', seconds: 19, baritone: ['Going to: GoalBlock{x=-677,y=59,z=-297}'], at: { x: -679, y: 61, z: -300 }, distance: 4.1 } });
  const r = await stuck.run('move-to-position', { x: -677, y: 59, z: -297 });
  t.true(r.isError);
  t.regex(r.text, /Could not reach \(-677, 59, -297\): no path found\. Stopped at \(-679, 61, -300\), 4.1 blocks away\. Baritone: Going to/);
});

test('mine-blocks reports what was gained', async (t) => {
  const { run, request } = setup({
    'world.findBlocks': { positions: [{ x: 1, y: 64, z: 1 }] },
    mine: { reason: 'done', seconds: 33, baritone: ['Mining [acacia_log]', 'Have 14 valid items'], gained: { acacia_log: 8 } }
  });
  t.is((await run('mine-blocks', { block: 'acacia_log', count: 14 })).text, 'Mined for 33s: acacia_log x8. Baritone: Mining [acacia_log] | Have 14 valid items');
  t.like(request.getCalls().find(c => c.args[0] === 'mine')!.args[1], { block: 'acacia_log', count: 14 });
});

/** world.region answers: all air the first time (the materials check), then `blocks` (the check after building). */
function afterBuild(blocks: string[]) {
  let calls = 0;
  return () => ({ blocks: calls++ === 0 ? blocks.map(() => 'air') : blocks });
}

test('build-structure checks materials, writes the schematic, and builds it', async (t) => {
  const spec = { palette: { L: 'oak_log[axis=y]' }, layers: [['L.L'], ['L.L']] };
  const empty = { blocks: ['air', 'air', 'air', 'air', 'air', 'air'] };
  const poor = setup({ status: STATUS, inventory: { items: [{ slot: 1, name: 'oak_log', count: 2 }], selectedSlot: 0, held: null }, 'world.region': empty });
  const refused = await poor.run('build-structure', { x: 0, y: 64, z: 0, spec, name: 'posts' });
  t.true(refused.isError);
  t.regex(refused.text, /Missing: oak_log 2\/4/);

  // half built already: two logs are enough to finish it
  const half = setup({
    status: STATUS, inventory: { items: [{ slot: 1, name: 'oak_log', count: 2 }], selectedSlot: 0, held: null },
    'world.region': (() => {
      let calls = 0;
      const half = ['oak_log[axis=y]', 'air', 'oak_log[axis=y]', 'air', 'air', 'air'];
      return () => ({ blocks: calls++ === 0 ? half : half.map((b, i) => i === 3 || i === 5 ? 'oak_log[axis=y]' : b) });
    })(),
    build: { reason: 'done', seconds: 5, baritone: [], used: { oak_log: 2 } }
  });
  t.false((await half.run('build-structure', { x: 0, y: 64, z: 0, spec, name: 'posts' })).isError);
  t.true(half.request.getCalls().some(c => c.args[0] === 'build'));

  const rich = setup({
    status: STATUS,
    inventory: { items: [{ slot: 1, name: 'oak_log', count: 9 }], selectedSlot: 0, held: null },
    build: { reason: 'done', seconds: 30, baritone: ['Done building'], used: { oak_log: 4, stone_pickaxe: 1 } },
    // the world afterwards (x, then z, then y): both posts stand, the gap is grass
    'world.region': afterBuild(['oak_log[axis=y]', 'short_grass', 'oak_log[axis=y]', 'oak_log[axis=y]', 'air', 'oak_log[axis=y]'])
  });
  const r = await rich.run('build-structure', { x: -706.4, y: 73, z: -336, spec, name: 'posts' });
  t.is(r.text, 'Built posts at (-707, 73, -336) in 30s: all 4 blocks in place. Used: oak_log x4; wore out: stone_pickaxe. Baritone: Done building');
  const file = path.join(rich.gameDir, 'schematics', 'posts.schem');
  const buildCall = rich.request.getCalls().find(c => c.args[0] === 'build')!;
  t.like(buildCall.args[1], { file, x: -707, y: 73, z: -336 });
  t.like(rich.request.getCalls().filter(c => c.args[0] === 'world.region').at(-1)!.args, ['world.region', { x: -707, y: 73, z: -336, width: 3, height: 2, length: 1 }]);
  const parsed = nbt.simplify((await nbt.parse(zlib.gunzipSync(fs.readFileSync(file)))).parsed) as Record<string, unknown>;
  t.like(parsed, { Width: 3, Height: 2, Length: 1 });
});

test('fly-to says it is not supported on the client backend', async (t) => {
  const { run } = setup({});
  const r = await run('fly-to', { x: 0, y: 100, z: 0 });
  t.true(r.isError);
  t.regex(r.text, /not supported on the client backend/);
});

test('attack-entity reports kills, landed hits, gear and threats like the mineflayer backend', async (t) => {
  const { run } = setup({
    status: { ...STATUS, health: 15, food: 17 },
    fight: { outcome: 'done', kills: ['zombie', 'skeleton'], vanished: ['creeper (exploded)'], unreachable: [], hits: 7, landed: 6,
      swungWith: { iron_sword: 7 }, seconds: 12.5, wore: ['iron_helmet'], target: 'skeleton', dropsAt: { x: 1, y: 64, z: 1 }, threats: 'spider 9 blocks away', health: 15 }
  });
  t.is((await run('attack-entity', { target: 'hostile' })).text,
    'Put on iron_helmet. Killed zombie, skeleton. Gone without dying: creeper (exploded) with 7 swing(s), 6 landed (iron_sword x7) in 12.5s. Health 15/20, food 17/20. Hostiles nearby: spider 9 blocks away.');
  const low = setup({
    status: { ...STATUS, health: 6 },
    fight: { outcome: 'low_health', kills: [], vanished: [], unreachable: [], hits: 2, landed: 2, swungWith: { stone_sword: 2 }, seconds: 5,
      wore: [], target: 'zombie', dropsAt: { x: 0, y: 64, z: 0 }, retreat: 'walled in at (0, 64, 0) (10 block(s) placed), ate bread', threats: 'zombie 2 blocks away', health: 6 }
  });
  t.regex((await low.run('attack-entity', { target: 'zombie' })).text,
    /^Stopped fighting zombie after 2 swing\(s\), 2 landed \(stone_sword x2\): health is low\. Then walled in at \(0, 64, 0\) \(10 block\(s\) placed\), ate bread\. Health 6\/20.*Wall yourself in/);
  const none = setup({ fight: { outcome: 'none' } });
  t.is((await none.run('attack-entity', { target: 'zombie' })).text, 'No zombie within 16 blocks');
});

test('wall-in and set-auto-defend', async (t) => {
  const { run } = setup({ wallin: { at: { x: 1, y: 64, z: 2 }, placed: 9, alreadySolid: 1, gaps: [] }, 'guardian.set': { enabled: false } });
  t.is((await run('wall-in')).text, "Walled in at (1, 64, 2) (9 block(s) placed). Dig out with dig-block when it's safe.");
  t.is((await run('set-auto-defend', { enabled: false })).text, 'Auto-defend off');
  const gaps = setup({ wallin: { at: { x: 1, y: 64, z: 2 }, placed: 7, alreadySolid: 0, gaps: [{ x: 2, y: 64, z: 2 }] } });
  t.is((await gaps.run('wall-in')).text, 'Walled in at (1, 64, 2) with 1 gap(s) left at (2, 64, 2) (7 placed).');
  const none = setup({ wallin: { error: 'no blocks to wall in with' } });
  t.regex((await none.run('wall-in')).text, /^No blocks to wall in with/);
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
  t.deepEqual(request.getCalls().map(c => c.args[0]).filter(m => m !== 'status' && m !== 'protect.set'), ['item.select', 'place', 'goto', 'place']);
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
  t.regex((await none.run('craft-item', { outputItem: 'wooden_pickaxe' })).text, /needs a crafting table and there is none within 48 blocks\. Craft a crafting_table/);
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

test('smelt-item adds fuel even when the furnace is still lit, and reports a furnace that runs dry', async (t) => {
  const { run, request } = setup({
    'world.block': { loaded: true, name: 'furnace' },
    // lit from the last job, nothing in the fuel slot: the leftover burn may be nearly spent
    'furnace.open': { open: true, input: null, fuel: null, output: null, lit: true },
    inventory: { items: [{ slot: 4, name: 'oak_log', count: 3 }, { slot: 5, name: 'oak_planks', count: 10 }], selectedSlot: 0, held: null },
    'furnace.put': { open: true },
    'furnace.status': { open: true, input: { name: 'oak_log', count: 1 }, fuel: null, output: null, lit: false },
    'furnace.take': { took: null },
    'container.close': { ok: true }
  });
  const r = await run('smelt-item', { x: 1, y: 64, z: 1, inputItem: 'oak_log', inputCount: 1, fuelItem: 'oak_planks', timeoutMs: 20000 });
  const puts = request.getCalls().filter(c => c.args[0] === 'furnace.put').map(c => c.args[1]);
  t.deepEqual(puts, [{ slot: 'fuel', name: 'oak_planks', count: 1 }, { slot: 'input', name: 'oak_log', count: 1 }]);
  t.is(r.text, 'Nothing smelted; the furnace ran out of fuel with 1 oak_log still in it. Add fuel (smelt-item again with fuelItem).');
});

test('build-structure checks the world and reports a build Baritone called done but left unfinished', async (t) => {
  const spec = { palette: { L: 'oak_log[axis=y]', P: 'oak_planks' }, layers: [['LPL'], ['L.L']] };
  const { run } = setup({
    status: STATUS,
    inventory: { items: [{ slot: 1, name: 'oak_log', count: 9 }, { slot: 2, name: 'oak_planks', count: 5 }], selectedSlot: 0, held: null },
    build: { reason: 'done', seconds: 422, baritone: [], used: { oak_planks: 1 } },
    // planks placed; one log lies sideways (wrong axis), two missing
    'world.region': afterBuild(['oak_log[axis=x]', 'oak_planks', 'air', 'air', 'air', 'oak_log[axis=y]']),
    // the hand pass gets nowhere either
    'item.select': { held: 'oak_log' },
    place: { placed: false, reason: 'nothing solid next to it to place against' },
    dig: { dug: true }
  });
  const r = await run('build-structure', { x: 0, y: 64, z: 0, spec, name: 'cabin' });
  t.true(r.isError);
  t.regex(r.text, /^Failed: Build of cabin ended after 422s with 2\/5 blocks in place\. Missing: oak_log x3 \(have 9\)\. Used: oak_planks x1\. Couldn't place: oak_log at \(0, 64, 0\): nothing solid next to it/);
  t.regex(r.text, /Run build-structure again to continue\.$/);
});

test('build-structure stops a stalled Baritone and places the rest by hand, facing the right way', async (t) => {
  setStallTiming(20, 80);
  t.teardown(() => setStallTiming(15_000, 60_000));
  const spec = { palette: { P: 'oak_planks', S: 'oak_stairs[facing=south,half=bottom]' }, layers: [['PS']] };
  let release: (v: unknown) => void = () => undefined;
  let world = ['oak_planks', 'air'];
  const { run, request } = setup({
    status: STATUS,
    inventory: { items: [{ slot: 1, name: 'oak_planks', count: 2 }, { slot: 2, name: 'oak_stairs', count: 2 }], selectedSlot: 0, held: null },
    'world.region': () => ({ blocks: world }),
    // Baritone never finishes on its own; cancel ends it
    build: () => new Promise(res => { release = res; }),
    cancel: () => { release({ reason: 'cancelled', seconds: 61, baritone: [], used: {} }); return { cancelled: true }; },
    'item.select': { held: 'oak_stairs' },
    place: () => { world = ['oak_planks', 'oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]']; return { placed: true, block: 'oak_stairs', face: 'west' }; }
  });
  // the first look (materials check) sees nothing built yet
  world = ['air', 'air'];
  const pending = run('build-structure', { x: 0, y: 64, z: 0, spec, name: 'step' });
  await new Promise(res => setTimeout(res, 10));
  world = ['oak_planks', 'air'];
  const r = await pending;
  t.is(r.text, 'Built step at (0, 64, 0) in 61s: all 2 blocks in place (1 placed by hand after Baritone stalled). Used: nothing.');
  t.like(request.getCalls().find(c => c.args[0] === 'place')!.args[1], { x: 1, y: 64, z: 0, facing: 'south' });
});

test('blocks the bot built are remembered per world, and mine-blocks digs around them', async (t) => {
  const saved: Record<string, string[]> = {};
  const store: ProtectionStore = { load: w => saved[w] ?? [], save: (w, keys) => { saved[w] = keys; } };
  const status = { ...STATUS, hashedSeed: '-42' };
  // place-block remembers the cabin wall log
  const builder = setup({ status, 'item.select': { held: 'oak_log' }, place: { placed: true, block: 'oak_log', face: 'down' } }, store);
  await builder.run('place-block', { x: 0, y: 65, z: 0, item: 'oak_log' });
  t.deepEqual(saved['seed:-42'], ['overworld:0,65,0']);

  // a later session in the same world: the wall is the nearest oak log, a tree is further
  let logs = 2;
  const digs: unknown[] = [];
  const miner = setup({
    status,
    'world.findBlocks': () => ({ positions: [{ x: 0, y: 65, z: 0 }, { x: 8, y: 64, z: 3 }] }),
    inventory: () => ({ items: [{ slot: 1, name: 'oak_log', count: logs }], selectedSlot: 0, held: null }),
    dig: (p: Record<string, unknown>) => { digs.push(p); logs++; return { dug: true, block: 'oak_log', reason: 'done' }; },
    'world.entities': { entities: [] }
  }, store);
  const r = await miner.run('mine-blocks', { block: 'oak_log', count: 3 });
  t.like(digs, [{ x: 8, y: 64, z: 3 }]);
  t.is(digs.length, 1);
  t.false(miner.request.getCalls().some(c => c.args[0] === 'mine')); // not Baritone's mine process
  // the game client got the list (it becomes Baritone's no-break list near the builds)
  t.deepEqual(miner.request.getCalls().find(c => c.args[0] === 'protect.set')?.args[1], { positions: [[0, 65, 0]] });
  t.regex(r.text, /^Mined 1 oak_log one by one in [\d.]+s, leaving 1 that belong to your builds: oak_log x1\.$/);
});

test('build-structure leaves blocks the bot placed in cells the spec clears (a rebuild cleared the cabin door)', async (t) => {
  const saved: Record<string, string[]> = { 'seed:-42': ['overworld:1,64,0'] }; // the door the bot hung
  const store: ProtectionStore = { load: w => saved[w] ?? [], save: (w, keys) => { saved[w] = keys; } };
  const spec = { palette: { L: 'oak_log[axis=y]' }, layers: [['L.L']] };
  const { run, gameDir } = setup({
    status: { ...STATUS, hashedSeed: '-42' },
    inventory: { items: [{ slot: 1, name: 'oak_log', count: 2 }], selectedSlot: 0, held: null },
    // before: only the door; after: the logs too
    'world.region': (() => { let n = 0; return () => ({ blocks: n++ === 0 ? ['air', 'oak_door[half=lower]', 'air'] : ['oak_log[axis=y]', 'oak_door[half=lower]', 'oak_log[axis=y]'] }); })(),
    build: { reason: 'done', seconds: 3, baritone: [], used: { oak_log: 2 } }
  }, store);
  t.false((await run('build-structure', { x: 0, y: 64, z: 0, spec, name: 'wall' })).isError);
  const parsed = nbt.simplify((await nbt.parse(zlib.gunzipSync(fs.readFileSync(path.join(gameDir, 'schematics', 'wall.schem'))))).parsed) as { Palette: Record<string, number>; BlockData: number[] };
  const byIndex = Object.fromEntries(Object.entries(parsed.Palette).map(([k, v]) => [v, k]));
  t.deepEqual(parsed.BlockData.map(b => byIndex[b]), ['minecraft:oak_log[axis=y]', 'minecraft:structure_void', 'minecraft:oak_log[axis=y]']);
});

test('store-in-chest walks to the chest, stores the items and reports what it holds', async (t) => {
  let opens = 0;
  const { run, request } = setup({
    inventory: { items: [{ slot: 3, name: 'iron_ingot', count: 32 }], selectedSlot: 0, held: null },
    'world.block': { loaded: true, name: 'chest' },
    'chest.open': () => { if (opens++ === 0) throw new Error('chest too far to open'); return { slots: 27, free: 27, items: {} }; },
    goto: { arrived: true, reason: 'done', seconds: 2, baritone: [], at: { x: 1, y: 64, z: 2 }, distance: 1 },
    'chest.deposit': { slots: 27, free: 26, items: { iron_ingot: 32 }, moved: 32 },
    'container.close': { ok: true }
  });
  const r = await run('store-in-chest', { x: 1, y: 64, z: 0, item: 'iron_ingot' });
  t.is(r.text, 'Stored 32 iron_ingot in the chest at (1, 64, 0). It holds: iron_ingot x32; 26/27 slots free.');
  t.like(request.getCalls().find(c => c.args[0] === 'chest.deposit')!.args[1], { name: 'iron_ingot' });
  t.is(request.lastCall.args[0], 'container.close');
  const none = setup({ inventory: { items: [], selectedSlot: 0, held: null } });
  t.true((await none.run('store-in-chest', { x: 1, y: 64, z: 0, item: 'iron_ingot' })).isError);
});

test('take-from-chest takes what was asked and says when the chest has none', async (t) => {
  const { run, request } = setup({
    'world.block': { loaded: true, name: 'chest' },
    'chest.open': { slots: 27, free: 26, items: { iron_ingot: 32 } },
    'chest.withdraw': { slots: 27, free: 26, items: { iron_ingot: 5 }, moved: 27 },
    'container.close': { ok: true }
  });
  t.is((await run('take-from-chest', { x: 1, y: 64, z: 0, item: 'iron_ingot', count: 27 })).text, 'Took 27 iron_ingot from the chest at (1, 64, 0). It holds: iron_ingot x5.');
  t.like(request.getCalls().find(c => c.args[0] === 'chest.withdraw')!.args[1], { name: 'iron_ingot', count: 27 });
  t.true((await run('take-from-chest', { x: 1, y: 64, z: 0, item: 'diamond' })).isError);
});

test('processName makes Baritone process names readable', (t) => {
  t.is(processName('Mine BlockOptionalMetaLookup{[BlockOptionalMeta{block=Block{minecraft:iron_ore},properties={}}, BlockOptionalMeta{block=Block{minecraft:deepslate_iron_ore},properties={}}]}'), 'Mine iron_ore, deepslate_iron_ore');
  t.is(processName('Defend against husk'), 'Defend against husk');
});

test('mine-blocks says so when nothing in the inventory can harvest the block', async (t) => {
  const { run } = setup({
    'world.findBlocks': { positions: [] },
    mine: () => { throw new Error('needs_tool: stone drops nothing without the right tool (usually a pickaxe), and there is none in the inventory'); }
  });
  const r = await run('mine-blocks', { block: 'stone', count: 8 });
  t.true(r.isError);
  t.is(r.text, 'Failed: stone drops nothing without the right tool (usually a pickaxe), and there is none in the inventory. Craft one first.');
});

test('blockDrops: what mine-blocks counts for a block', (t) => {
  t.deepEqual(blockDrops('stone'), ['cobblestone']);
  t.deepEqual(blockDrops('iron_ore'), ['raw_iron']);
  t.deepEqual(blockDrops('oak_log'), ['oak_log']);
  t.deepEqual(blockDrops('sweet_berry_bush'), ['sweet_berry_bush']);
});

test('farm reports what it gathered, counted once the items have arrived', async (t) => {
  setFarmSettle(5);
  t.teardown(() => setFarmSettle(1500));
  let n = 0;
  const { run, request } = setup({
    // before the job, then after it (the harvest flew in after the process ended)
    inventory: () => ({ items: n++ < 1 ? [] : [{ slot: 3, name: 'wheat', count: 9 }, { slot: 4, name: 'wheat_seeds', count: 4 }], selectedSlot: 0, held: null }),
    farm: { reason: 'timeout', seconds: 60, baritone: [], gained: {} },
    // no farmland around: nothing to replant
    'world.region': { blocks: [] }
  });
  t.is((await run('farm', { range: 16, timeoutMs: 60000 })).text, 'Farmed for 60s (time limit): wheat x9, wheat_seeds x4.');
  t.like(request.getCalls().find(c => c.args[0] === 'farm')!.args[1], { range: 16, timeoutMs: 60000 });
});

test('use-item-on-block tills with a hoe and reports the change', async (t) => {
  const { run, request } = setup({
    'item.select': { held: 'wooden_hoe' },
    useOn: { used: true, before: 'grass_block', after: 'farmland', properties: { moisture: '0' } }
  });
  t.is((await run('use-item-on-block', { x: 1, y: 64, z: 2, item: 'wooden_hoe' })).text, 'Used wooden_hoe on grass_block at (1, 64, 2): it became farmland[moisture=0]');
  t.like(request.getCalls().find(c => c.args[0] === 'useOn')!.args[1], { x: 1, y: 64, z: 2, face: 'up' });
});

test('use-item-on-block clears grass on top before tilling again', async (t) => {
  let tills = 0;
  const { run, request } = setup({
    'item.select': { held: 'stone_hoe' },
    useOn: () => (tills++ === 0
      ? { used: true, before: 'grass_block', after: 'grass_block', properties: {}, held: 'stone_hoe', result: 'Pass[]' }
      : { used: true, before: 'grass_block', after: 'farmland', properties: { moisture: '0' }, held: 'stone_hoe' }),
    'world.block': { loaded: true, name: 'leaf_litter' },
    dig: { dug: true, block: 'leaf_litter', reason: 'done' }
  });
  t.is((await run('use-item-on-block', { x: 1, y: 64, z: 2, item: 'stone_hoe' })).text, 'Used stone_hoe on grass_block at (1, 64, 2): it became farmland[moisture=0]');
  t.like(request.getCalls().find(c => c.args[0] === 'dig')!.args[1], { x: 1, y: 65, z: 2 });
});

test('missingIngredients names what a craft is short of', (t) => {
  t.is(missingIngredients('diamond_sword', 1, new Map([['diamond', 2]])), 'stick x1 (have 0)');
  t.is(missingIngredients('diamond_sword', 1, new Map([['diamond', 2], ['stick', 1]])), '');
});

test('drop-item throws items out', async (t) => {
  const { run } = setup({
    inventory: { items: [{ slot: 9, name: 'diorite', count: 16 }], selectedSlot: 0, held: null },
    'item.drop': { dropped: 16 }
  });
  t.is((await run('drop-item', { item: 'diorite' })).text, 'Dropped 16 diorite');
  t.true((await run('drop-item', { item: 'gold_ingot' })).isError);
});

test('fish finds open water, walks there and reports the catch', async (t) => {
  const { run, request } = setup({
    inventory: { items: [{ slot: 2, name: 'fishing_rod', count: 1 }], selectedSlot: 0, held: null },
    'world.findBlocks': { positions: [{ x: 1, y: 62, z: 1 }] },
    // the pond check (3x2x3), then the shore search (9x4x9): grass all around at the water's level, air above
    'world.region': (p: Record<string, unknown>) => (p.width === 3
      ? { blocks: [...Array(9).fill('water[level=0]'), ...Array(9).fill('air')] }
      : { blocks: [...Array(81).fill('dirt'), ...Array(81).fill('grass_block'), ...Array(162).fill('air')] }),
    goto: { arrived: true, reason: 'done', seconds: 2, baritone: [], at: { x: 3, y: 63, z: 1 }, distance: 2 },
    fish: { bites: 3, casts: 4, gained: { cod: 2, salmon: 1 }, seconds: 70 }
  });
  t.is((await run('fish', { times: 3 })).text, 'Fished at (1, 62, 1) for 70s: 3 bite(s) in 4 cast(s), caught cod x2, salmon x1.');
  t.like(request.getCalls().find(c => c.args[0] === 'fish')!.args[1], { x: 1, y: 62, z: 1, times: 3 });
});

test('collect-items walks onto drops near a point and swims to unreachable ones', async (t) => {
  let invCalls = 0;
  let listed = 0;
  const { run, request } = setup({
    inventory: () => ({ items: invCalls++ === 0 ? [] : [{ slot: 1, name: 'diamond_sword', count: 1 }], selectedSlot: 0, held: null }),
    'world.entities': () => ({ entities: listed++ === 0 ? [{ id: 5, name: 'item', category: 'misc', position: { x: 11, y: 64, z: -3 }, distance: 1 }] : [] }),
    goto: { arrived: false, reason: 'done', seconds: 1, baritone: [], at: { x: 10, y: 64, z: -4 }, distance: 1 },
    steer: { reached: true, distance: 0.3, at: { x: 11, y: 64, z: -3 } }
  });
  t.is((await run('collect-items', { x: 10, y: 64, z: -3 })).text, 'Collected around (10, 64, -3): diamond_sword x1.');
  t.true(request.getCalls().some(c => c.args[0] === 'steer'));
});

test('packSlotsUsed counts hotbar and backpack slots only', (t) => {
  t.is(packSlotsUsed([{ slot: 0 }, { slot: 35 }, { slot: 36 }, { slot: 39 }, { slot: 40 }, { slot: 35 }]), 2);
});

test('farm replants bare farmland with seeds from the inventory', async (t) => {
  setFarmSettle(1);
  t.teardown(() => setFarmSettle(1500));
  let seeds = 2;
  const placed: unknown[] = [];
  // range 4 around the bot at (10, 64, -4): a 9 x 4 x 9 box from (6, 62, -8)
  const w = 9, l = 9;
  const blocks = Array(w * l * 4).fill('air');
  for (let y = 0; y < 2; y++) for (let i = 0; i < w * l; i++) blocks[i + y * w * l] = 'dirt';
  // three farmland cells at y 63 with air above; there are only two seeds
  for (const x of [5, 6, 7]) blocks[x + 4 * w + 1 * w * l] = 'farmland[moisture=7]';
  const { run } = setup({
    inventory: () => ({ items: seeds ? [{ slot: 3, name: 'wheat_seeds', count: seeds }] : [], selectedSlot: 0, held: null }),
    farm: { reason: 'done', seconds: 4, baritone: ['Farm failed'], gained: {} },
    'world.region': { blocks },
    'item.select': { held: 'wheat_seeds' },
    place: (p: Record<string, unknown>) => { placed.push(p); seeds--; return { placed: true, block: 'wheat', face: 'down' }; }
  });
  const r = await run('farm', { range: 4 });
  t.is(placed.length, 2);
  t.regex(r.text, /Planted 2 \(wheat_seeds\)\./);
});

test('set-home and go-home: saved per world, walked back to in legs', async (t) => {
  let pos = { x: 10.5, y: 64, z: -3.2 };
  const status = () => ({ ...STATUS, hashedSeed: '7', position: pos, block: { x: Math.floor(pos.x), y: pos.y, z: Math.floor(pos.z) } });
  const legs: Record<string, unknown>[] = [];
  const { run } = setup({
    status,
    goto: (p: Record<string, unknown>) => {
      legs.push(p);
      pos = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
      return { arrived: true, reason: 'done', seconds: 5, baritone: [], at: { x: p.x, y: p.y, z: p.z }, distance: 0 };
    }
  });
  t.true((await run('go-home')).isError); // none saved yet
  t.is((await run('set-home')).text, "Home 'home' set at (10, 64, -4) (overworld)");
  pos = { x: 10, y: 70, z: 500 }; // wandered 500 blocks south
  const r = await run('go-home');
  t.regex(r.text, /^Home: at \(10, 64, -4\)/);
  t.true(legs.filter(l => l.xz).length >= 2); // long way: legs at any height first
  t.like(legs.at(-1), { x: 10, y: 64, z: -4, range: 2 });
});

test('explore walks legs in a direction until the target shows up', async (t) => {
  let pos = { x: 0, y: 64, z: 0 };
  let looks = 0;
  const { run, request } = setup({
    status: () => ({ ...STATUS, hashedSeed: '7', position: pos, block: pos }),
    goto: (p: Record<string, unknown>) => { pos = { x: Number(p.x), y: 64, z: Number(p.z) }; return { arrived: true, reason: 'done', seconds: 20, baritone: [], at: pos, distance: 3 }; },
    'world.entities': () => ({ entities: looks++ < 2 ? [] : [{ id: 3, name: 'sheep', category: 'passive', position: { x: 5, y: 66, z: 250 }, distance: 40 }] })
  });
  const r = await run('explore', { target: 'sheep', direction: 'south', step: 100 });
  t.regex(r.text, /^Found sheep at \(5, 66, 250\), 250 blocks south of where the search began; the bot is at \(0, 64, 200\)\. No home set\.$/);
  t.deepEqual(request.getCalls().filter(c => c.args[0] === 'goto').map(c => [c.args[1]?.z, c.args[1]?.xz]), [[100, true], [200, true]]);
});

test('level-area works in tiles: cuts, then fills when it has the blocks', async (t) => {
  // 2 x 3 x 1 box from y 63 (level 64): a 1-high bump at x=0 (dirt at y 65), a dip at x=1 (ground y 63)
  let world = ['stone', 'stone', 'dirt', 'air', 'dirt', 'air'];   // y63: stone stone; y64: dirt air; y65: dirt air
  let dirt = 0;
  const builds: string[] = [];
  const { run } = setup({
    'world.region': () => ({ blocks: world }),
    inventory: () => ({ items: dirt ? [{ slot: 1, name: 'dirt', count: dirt }] : [], selectedSlot: 0, held: null }),
    build: (p: Record<string, unknown>) => {
      const file = String(p.file);
      builds.push(file.replace(/^.*[\\/]/, ''));
      if (/cut/.test(file)) { world = ['stone', 'stone', 'dirt', 'air', 'air', 'air']; dirt = 1; } // the bump comes off as dirt
      else world = ['stone', 'stone', 'dirt', 'dirt', 'air', 'air'];                                     // the dip is filled
      return { reason: 'done', seconds: 2, baritone: [], used: {} };
    }
  });
  const r = await run('level-area', { x1: 0, z1: 0, x2: 1, z2: 0, level: 64, above: 1, below: 1 });
  t.deepEqual(builds, ['level_tile_cut.schem', 'level_tile_fill.schem']);
  t.regex(r.text, /^Level \(0, 0\)\.\.\(1, 0\) to ground y 64: cut 1 block\(s\) \(ground 1\), fill 1 dirt \+ 0 cobblestone/);
  t.regex(r.text, /Worked 1\/1 tile\(s\) of 8x8 in \d+s\. Now level\.$/);
});

test('move-to-position blocks running water around a bot stuck in it, then tries again', async (t) => {
  let gotos = 0;
  const placed: unknown[] = [];
  const { run } = setup({
    // the bot stands at (10, 64, -4) with water running in from the north cell at its feet
    'world.region': { blocks: ['stone', 'water[level=3]', 'stone', 'stone', 'water[level=4]', 'stone', 'stone', 'stone', 'stone', ...Array(9).fill('air')] },
    goto: () => (gotos++ === 0
      ? { arrived: false, reason: 'timeout', seconds: 30, baritone: [], at: { x: 10, y: 64, z: -4 }, distance: 7 }
      : { arrived: true, reason: 'done', seconds: 8, baritone: [], at: { x: 9, y: 70, z: -4 }, distance: 0 }),
    inventory: { items: [{ slot: 1, name: 'cobblestone', count: 10 }], selectedSlot: 0, held: null },
    'item.select': { held: 'cobblestone' },
    place: (p: Record<string, unknown>) => { placed.push(p); return { placed: true, block: 'cobblestone', face: 'down' }; }
  });
  t.is((await run('move-to-position', { x: 9, y: 70, z: -4 })).text, 'Successfully moved to position near (9, 70, -4)');
  t.is(gotos, 2);
  t.like(placed, [{ x: 10, y: 64, z: -5 }]); // the north cell; not the bot's own
});

test('build-structure takes down scaffolding the build left beside it', async (t) => {
  // a 1x1x1 structure (one log) at (0, 64, 0); the box around it is 13 x 9 x 13 from (-6, 62, -6)
  const W = 13, L = 13, H = 9;
  const idx = (x: number, y: number, z: number) => (x + 6) + (z + 6) * W + (y - 62) * W * L;
  let phase = 0; // 0: before the build, 1: after
  const digs: unknown[] = [];
  const { run } = setup({
    inventory: { items: [{ slot: 1, name: 'oak_log', count: 1 }], selectedSlot: 0, held: null },
    'world.region': (p: Record<string, unknown>) => {
      if (p.width === 1) return { blocks: [phase ? 'oak_log[axis=y]' : 'air'] }; // the structure itself
      const blocks = Array(W * L * H).fill('air');
      if (phase) { blocks[idx(2, 64, 0)] = 'cobblestone'; blocks[idx(2, 65, 0)] = 'cobblestone'; } // a 2-high pillar
      return { blocks };
    },
    build: () => { phase = 1; return { reason: 'done', seconds: 3, baritone: [], used: { oak_log: 1 } }; },
    dig: (p: Record<string, unknown>) => { digs.push(p); return { dug: true, block: 'cobblestone', reason: 'done' }; }
  });
  const r = await run('build-structure', { x: 0, y: 64, z: 0, spec: { palette: { L: 'oak_log[axis=y]' }, layers: [['L']] }, name: 'post' });
  t.regex(r.text, /all 1 blocks in place; took down 2 scaffold block\(s\) it left/);
  t.like(digs, [{ x: 2, y: 65, z: 0 }, { x: 2, y: 64, z: 0 }]); // top down
});
