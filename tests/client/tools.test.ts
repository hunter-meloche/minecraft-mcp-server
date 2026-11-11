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
import { blockDrops, missingIngredients, packSlotsUsed, processName, registerClientTools, setFarmSettle, setStallTiming, mineflayerSlot, entityKind, pausedFor, offServer } from '../../src/client/tools.js';
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
  const rt = registerClientTools(new ToolFactory(server, connection), { request } as unknown as BridgeClient, store, { gameDir, protectionStore });
  const tools = (server.tool as sinon.SinonStub).getCalls();
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tools.find(c => c.args[0] === name)!.args[3](args);
    return { text: r.content.map((c: { text: string }) => c.text).join('\n'), isError: !!r.isError };
  };
  return { run, request, gameDir, store, tools, rt };
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
  t.deepEqual([...client.keys()].filter(n => !mineflayerToolDefinitions().some(d => d.name === n)).sort(), ['build-structure', 'collect-items', 'drop-item', 'explore', 'farm', 'fish', 'go-home', 'leave-server', 'level-area', 'mine-blocks', 'nearby-builds', 'rejoin-server', 'set-home', 'stop', 'store-in-chest', 'survey-area', 'take-from-chest', 'use-item-on-block']);
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

test('mine-blocks never digs up the home area: from home it walks out to ore beyond the zone first', async (t) => {
  let pos = { x: 0.5, y: 64, z: 0.5 };
  const status = () => ({ ...STATUS, hashedSeed: '7', position: pos, block: { x: Math.floor(pos.x), y: pos.y, z: Math.floor(pos.z) } });
  const zones: Record<string, unknown>[] = [];
  const gotos: Record<string, unknown>[] = [];
  let ores = [{ x: 3, y: 50, z: 0 }, { x: 0, y: 40, z: 45 }, { x: 60, y: 30, z: 0 }]; // under the lawn, then two outside
  const { run, request } = setup({
    status,
    'protect.zone': (p: Record<string, unknown>) => { zones.push(p); return { set: true }; },
    'world.findBlocks': () => ({ positions: ores }),
    goto: (p: Record<string, unknown>) => {
      gotos.push(p);
      pos = { x: Number(p.x), y: 64, z: Number(p.z) };
      return { arrived: true, reason: 'done', seconds: 9, baritone: [], at: { x: p.x, y: 64, z: p.z }, distance: 0 };
    },
    mine: { reason: 'done', seconds: 20, baritone: [], gained: { coal: 3 } }
  });
  await run('set-home');
  await run('get-position');
  t.deepEqual(zones.at(-1), { x: 0, z: 0, radius: 24 });
  t.regex((await run('mine-blocks', { block: 'coal_ore', count: 3 })).text, /^Mined for 20s: coal x3/);
  t.like(gotos[0], { x: 0, z: 45, xz: true }); // the nearest one outside the zone, not the one under the lawn
  // away from home it mines where it is
  gotos.length = 0;
  await run('mine-blocks', { block: 'coal_ore', count: 3 });
  t.is(gotos.length, 0);
  // nothing outside the zone in sight: says so, no mining
  pos = { x: 0.5, y: 64, z: 0.5 };
  ores = [{ x: 3, y: 50, z: 0 }];
  const r = await run('mine-blocks', { block: 'coal_ore', count: 3 });
  t.true(r.isError);
  t.regex(r.text, /No coal_ore in sight outside the home area/);
  t.is(request.getCalls().filter(c => c.args[0] === 'mine').length, 2);
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
  // a narrow lift: nothing in its cells needs breaking (air where the logs go), so nothing the bot built may break
  const halfBuild = half.request.getCalls().find(c => c.args[0] === 'build')!.args[1] as Record<string, unknown>;
  t.like(halfBuild, { keepProtection: true });
  t.is(halfBuild.allow, undefined);

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
  t.regex((await none.run('craft-item', { outputItem: 'wooden_pickaxe' })).text, /none within 48 blocks, and the bot could not make and place one \(it needs 4 planks or a log/);
});

test('craft-item with no table anywhere: a new bot with logs makes planks, a table, puts it down beside itself and crafts there', async (t) => {
  const inv = new Map<string, number>([['oak_log', 3], ['stick', 2]]);
  const crafts: string[] = [];
  const box = { x: -2, y: 63, z: -2, width: 5, height: 3, length: 5 };
  // grass under everything, air at the bot's height and over it
  const region = Array.from({ length: 75 }, (_, i) => (Math.floor(i / 25) === 0 ? 'grass_block' : 'air'));
  const { run, request } = setup({
    status: () => ({ ...STATUS, position: { x: 0.5, y: 64, z: 0.5 }, block: { x: 0, y: 64, z: 0 } }),
    inventory: () => ({ items: [...inv].map(([name, count], slot) => ({ slot, name, count })), selectedSlot: 0, held: null }),
    craft: (p: Record<string, unknown>) => {
      crafts.push(`${p.item}${p.x !== undefined ? ' at table' : ''}`);
      if (p.item === 'oak_planks') { inv.set('oak_log', 2); inv.set('oak_planks', 4); return { crafted: 1, gained: { oak_planks: 4 } }; }
      if (p.item === 'crafting_table') { inv.delete('oak_planks'); inv.set('crafting_table', 1); return { crafted: 1, gained: { crafting_table: 1 } }; }
      if (p.x === undefined) throw new Error('needs_table: wooden_pickaxe needs a crafting table');
      return { crafted: 1, gained: { wooden_pickaxe: 1 } };
    },
    'world.findBlocks': { positions: [] },
    'world.region': (p: Record<string, unknown>) => { t.like(p, box); return { blocks: region }; },
    'foreign.at': { inside: [true, false] },
    'item.select': { held: 0 },
    place: (p: Record<string, unknown>) => ({ placed: true, block: 'crafting_table', face: 'down', ...p }),
    goto: { arrived: true, reason: 'done', seconds: 1, baritone: [], at: { x: 0, y: 64, z: 0 }, distance: 1 }
  });
  t.is((await run('craft-item', { outputItem: 'wooden_pickaxe' })).text, 'Successfully crafted wooden_pickaxe 1 time(s)');
  t.deepEqual(crafts, ['wooden_pickaxe', 'oak_planks', 'crafting_table', 'wooden_pickaxe at table']);
  // the first spot beside it (x+1) is in someone's build: the next one
  const placed = request.getCalls().filter(c => c.args[0] === 'place').map(c => c.args[1] as Record<string, unknown>);
  t.like(placed[0], { x: -1, y: 64, z: 0 });
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

test('built blocks keep the state they were built with, for the brain to put back what goes missing', async (t) => {
  const saved: Record<string, string[]> = {};
  const states: Record<string, Record<string, string>> = {};
  const store: ProtectionStore = { load: w => saved[w] ?? [], save: (w, keys, st) => { saved[w] = keys; if (st) states[w] = st; }, loadStates: w => states[w] ?? {} };
  const status = { ...STATUS, hashedSeed: '-42' };
  const spec = { palette: { L: 'oak_log[axis=y]', S: 'oak_stairs[facing=east]' }, layers: [['LS']] };
  const { run, rt, request } = setup({
    status, 'item.select': { held: 'oak_stairs' }, place: { placed: true, block: 'wall_torch', face: 'west' },
    inventory: { items: [{ slot: 1, name: 'oak_log', count: 1 }, { slot: 2, name: 'oak_stairs', count: 1 }], selectedSlot: 0, held: null },
    'world.region': (p: Record<string, number>) => ({ blocks: p.width === 2 ? ['oak_log[axis=y]', 'oak_stairs[facing=east,half=bottom]'] : new Array(p.width * p.height * p.length).fill('air') }),
    build: { reason: 'done', seconds: 3, baritone: [], used: { oak_log: 1, oak_stairs: 1 } }
  }, store);
  t.false((await run('build-structure', { x: 0, y: 64, z: 0, spec, name: 'bit' })).isError);
  await run('place-block', { x: 0, y: 66, z: 1, item: 'torch' });
  t.deepEqual(states['seed:-42'], { 'overworld:0,64,0': 'oak_log[axis=y]', 'overworld:1,64,0': 'oak_stairs[facing=east,half=bottom]', 'overworld:0,66,1': 'wall_torch' });
  t.deepEqual(rt.builtNear({ x: 0, y: 64, z: 0 }, 1), [
    { at: { x: 0, y: 64, z: 0 }, state: 'oak_log[axis=y]' }, { at: { x: 1, y: 64, z: 0 }, state: 'oak_stairs[facing=east,half=bottom]' }]);
  t.is(await rt.restoreBlock({ x: 1, y: 64, z: 0 }, 'oak_stairs', 'east'), undefined);
  t.like(request.getCalls().filter(c => c.args[0] === 'place').at(-1)!.args[1], { x: 1, y: 64, z: 0, facing: 'east' });
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

test('a chest out of reach is walked up to on foot only at first; the walk that may dig or pillar comes second', async (t) => {
  // a chest two layers up in the storage house: the floor is within 3 of it, not within 2 (that walk pillared up)
  const chest = { x: 1, y: 65, z: 0 };
  const given = (failures: number) => {
    let opens = 0;
    return {
      inventory: { items: [{ slot: 3, name: 'iron_ingot', count: 32 }], selectedSlot: 0, held: null },
      'world.block': { loaded: true, name: 'chest' },
      'chest.open': () => { if (opens++ < failures) throw new Error('chest too far to open'); return { slots: 27, free: 27, items: {} }; },
      goto: { arrived: true, reason: 'done', seconds: 2, baritone: [], at: { x: 1, y: 63, z: 2 }, distance: 2.8 },
      'chest.deposit': { slots: 27, free: 26, items: { iron_ingot: 32 }, moved: 32 },
      'container.close': { ok: true }
    };
  };
  const walks = (request: ReturnType<typeof setup>['request']) => request.getCalls().filter(c => c.args[0] === 'goto').map(c => c.args[1]);
  // in reach after the careful walk: no other walk
  const near = setup(given(1));
  t.false((await near.run('store-in-chest', { ...chest, item: 'iron_ingot' })).isError);
  t.is(walks(near.request).length, 1);
  t.like(walks(near.request)[0], { ...chest, range: 3, careful: true });
  // still out of reach after it (a chest that needs a dug or bridged way): the walk as before
  const far = setup(given(2));
  t.false((await far.run('store-in-chest', { ...chest, item: 'iron_ingot' })).isError);
  t.is(walks(far.request).length, 2);
  t.like(walks(far.request)[0], { ...chest, range: 3, careful: true });
  t.like(walks(far.request)[1], { ...chest, range: 2 });
  t.falsy(walks(far.request)[1]?.careful);
  // the careful walk itself failing (no answer in time) is no reason to give the chest up: the walk as before follows
  const arrived = given(2).goto;
  const lost = setup({ ...given(2), goto: (p: Record<string, unknown>) => { if (p.careful) throw new Error('bridge call goto timed out'); return arrived; } });
  const stored = await lost.run('store-in-chest', { ...chest, item: 'iron_ingot' });
  t.false(stored.isError, stored.text);
  t.is(walks(lost.request).length, 2);
  t.like(walks(lost.request)[1], { ...chest, range: 2 });
  t.falsy(walks(lost.request)[1]?.careful);
  t.is(lost.request.getCalls().filter(c => c.args[0] === 'chest.open').length, 3);
});

test('a chest in reach with its lid held down is not walked up to again: the lid is freed', async (t) => {
  // "did not open" is a chest in reach: the walk to within 2 could not help, and for a chest two layers up it pillars
  const chest = { x: 1, y: 65, z: 0 };
  const lid = { x: 1, y: 66, z: 0 };
  const world: Record<string, string> = { '1,65,0': 'chest', '1,66,0': 'cobblestone' };
  const { run, request } = setup({
    inventory: { items: [{ slot: 3, name: 'iron_ingot', count: 32 }], selectedSlot: 0, held: null },
    'world.block': (p: Record<string, unknown>) => ({ loaded: true, name: world[`${p.x},${p.y},${p.z}`] ?? 'air', properties: { type: 'single' } }),
    'chest.open': () => { if (world['1,66,0'] !== 'air') throw new Error('the chest did not open (blocked lid, or not a chest)'); return { slots: 27, free: 27, items: {} }; },
    goto: { arrived: true, reason: 'done', seconds: 2, baritone: [], at: { x: 1, y: 63, z: 2 }, distance: 2.8 },
    dig: (p: Record<string, unknown>) => { world[`${p.x},${p.y},${p.z}`] = 'air'; return { dug: true }; },
    'chest.deposit': { slots: 27, free: 26, items: { iron_ingot: 32 }, moved: 32 },
    'container.close': { ok: true }
  });
  const stored = await run('store-in-chest', { ...chest, item: 'iron_ingot' });
  t.false(stored.isError, stored.text);
  const walks = request.getCalls().filter(c => c.args[0] === 'goto').map(c => c.args[1]);
  t.is(walks.length, 1);
  t.like(walks[0], { ...chest, range: 3, careful: true });
  t.deepEqual(request.getCalls().filter(c => c.args[0] === 'dig').map(c => c.args[1] as Record<string, unknown>).map(p => ({ x: p.x, y: p.y, z: p.z })), [lid]);
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

test('use-item-on-block with toggle tells the client to only open or close, never pour what is held', async (t) => {
  const { run, request } = setup({
    useOn: { used: true, before: 'oak_door', after: 'oak_door', properties: { open: 'false' }, held: 'water_bucket', changed: true }
  });
  await run('use-item-on-block', { x: 1, y: 64, z: 2, toggle: true });
  t.like(request.getCalls().find(c => c.args[0] === 'useOn')!.args[1], { x: 1, y: 64, z: 2, face: 'up', toggle: true });
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
  // the nearest surface water is a 3x3 pool at (1, 62, 1); the middle of a lake is at (9, 62, 1): the lake wins
  const pool = (p: Record<string, unknown>) => Number(p.x) + 2 === 1;
  const { run, request } = setup({
    inventory: { items: [{ slot: 2, name: 'fishing_rod', count: 1 }], selectedSlot: 0, held: null },
    'world.findBlocks': { positions: [{ x: 1, y: 62, z: 1 }, { x: 9, y: 62, z: 1 }] },
    // the open-water check (5x2x5), then the shore search (9x4x9): grass all around at the water's level, air above
    'world.region': (p: Record<string, unknown>) => (p.width === 5
      ? { blocks: [...Array(25).fill(null).map((_, i) => (!pool(p) || [6, 7, 8, 11, 12, 13, 16, 17, 18].includes(i) ? 'water[level=0]' : 'dirt')), ...Array(25).fill('air')] }
      : { blocks: [...Array(81).fill('dirt'), ...Array(81).fill('grass_block'), ...Array(162).fill('air')] }),
    goto: { arrived: true, reason: 'done', seconds: 2, baritone: [], at: { x: 3, y: 63, z: 1 }, distance: 2 },
    fish: { bites: 3, casts: 4, gained: { cod: 2, salmon: 1 }, seconds: 70 }
  });
  t.is((await run('fish', { times: 3 })).text, 'Fished at (9, 62, 1) for 70s: 3 bite(s) in 4 cast(s), caught cod x2, salmon x1.');
  t.like(request.getCalls().find(c => c.args[0] === 'fish')!.args[1], { x: 9, y: 62, z: 1, times: 3 });
  t.like(request.getCalls().find(c => c.args[0] === 'world.findBlocks')!.args[1], { block: 'water', openAbove: true });
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
  const params: Record<string, unknown>[] = [];
  const { run } = setup({
    'world.region': () => ({ blocks: world }),
    inventory: () => ({ items: dirt ? [{ slot: 1, name: 'dirt', count: dirt }] : [], selectedSlot: 0, held: null }),
    build: (p: Record<string, unknown>) => {
      const file = String(p.file);
      params.push(p);
      builds.push(file.replace(/^.*[\\/]/, ''));
      if (/cut/.test(file)) { world = ['stone', 'stone', 'dirt', 'air', 'air', 'air']; dirt = 1; } // the bump comes off as dirt
      else world = ['stone', 'stone', 'dirt', 'dirt', 'air', 'air'];                                     // the dip is filled
      return { reason: 'done', seconds: 2, baritone: [], used: {} };
    }
  });
  const r = await run('level-area', { x1: 0, z1: 0, x2: 1, z2: 0, level: 64, above: 1, below: 1 });
  t.deepEqual(builds, ['level_tile_cut.schem', 'level_tile_fill.schem']);
  // never the whole rule lifted: the cut may break only the kinds it cuts, the fill nothing (out of the storage house
  // Baritone went through its north wall on the way to a strip north of the fence)
  t.like(params[0], { keepProtection: true, allow: ['dirt'] });
  t.like(params[1], { keepProtection: true });
  t.is(params[1].allow, undefined);
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

test('pausedFor reads the blocks Baritone paused for', t => {
  t.deepEqual(pausedFor(['[Baritone] Missing materials for at least:', '[Baritone] 1x Block{minecraft:lantern}[hanging=false,waterlogged=false]',
    '[Baritone] Unable to do it. Pausing. resume to resume, cancel to cancel']), [{ id: 'lantern', count: 1 }]);
  t.deepEqual(pausedFor(['[Baritone] 10x Block{minecraft:oak_stairs}[facing=west]']), [{ id: 'oak_stairs', count: 10 }]);
  t.deepEqual(pausedFor(['[Baritone] Done building']), []);
});

test('set-home on a shared server: not near the builds of others nor in the spawn protection, unless forced', async t => {
  const status = () => ({ ...STATUS, hashedSeed: '9', position: { x: 100.5, y: 64, z: 100.5 }, block: { x: 100, y: 64, z: 100 }, spawn: { x: 0, y: 64, z: 0 } });
  const zones = [{ x1: 120, y1: 60, z1: 90, x2: 130, y2: 70, z2: 110, markers: 30, sample: 'oak_planks' }];
  const { run } = setup({ status, 'foreign.zones': () => ({ zones }) });
  const near = await run('set-home');
  t.true(near.isError);
  t.regex(near.text, /someone else's build is 20 blocks away/);
  t.false((await run('set-home', { x: 100, y: 64, z: 300 })).isError, 'far from it: fine');
  const spawn = await run('set-home', { x: 3, y: 64, z: 4 });
  t.true(spawn.isError);
  t.regex(spawn.text, /spawn protection/);
  t.false((await run('set-home', { force: true })).isError, 'forced');
});

test('set-home and nearby-builds measure in a straight line: a mineshaft far under the spot is no neighbour, a cellar right under it is', async t => {
  const status = () => ({ ...STATUS, hashedSeed: '9', position: { x: 100.5, y: 64, z: 100.5 }, block: { x: 100, y: 64, z: 100 } });
  const mineshaft = { x1: 60, y1: -50, z1: 60, x2: 140, y2: -20, z2: 140, markers: 900, surface: false, sample: 'oak_planks', kinds: ['oak_planks x600', 'oak_fence x200', 'rail x100'] };
  const tower = { x1: 90, y1: 141, z1: 90, x2: 110, y2: 155, z2: 110, markers: 137, surface: true, sample: 'glass', kinds: ['glass x137'] };
  let zones: object[] = [mineshaft, tower];
  const { run } = setup({ status, 'foreign.zones': () => ({ zones }) });
  t.false((await run('set-home')).isError, 'the mineshaft is 84 down, the sky build 77 up');
  const list = (await run('nearby-builds')).text;
  t.regex(list, /Builds on the surface \(1\)[^]*glass x137; 77 blocks away, 77 above/);
  t.regex(list, /Built under ground \(1;[^]*oak_planks x600, oak_fence x200, rail x100; 84 blocks away, 84 below/);
  zones = [{ x1: 95, y1: 52, z1: 95, x2: 105, y2: 56, z2: 105, markers: 3, surface: false, sample: 'chest' }];
  const cellar = await run('set-home');
  t.true(cellar.isError);
  t.regex(cellar.text, /something built under ground is 8 blocks away \(chest at y 52..56\)/);
});

test('off the server: tools say why and whether it comes back by itself; rejoin-server asks the mod to reconnect', async t => {
  t.regex(offServer({ screen: 'DisconnectedScreen', disconnected: { reason: 'Server closed', rejoin: true, inSeconds: 30 } }), /off the server: "Server closed"\. It rejoins by itself in about 30 s/);
  t.regex(offServer({ screen: 'DisconnectedScreen', disconnected: { reason: 'Kicked by an operator', rejoin: false } }), /no dropped connection \(a kick.*rejoin-server/);
  t.regex(offServer({ screen: 'TitleScreen' }), /not in a world yet \(screen: TitleScreen\)/);
  let asked = 0;
  const { run } = setup({ status: () => ({ ...STATUS, inWorld: false, disconnected: { reason: 'Kicked by an operator', rejoin: false } }), 'server.rejoin': () => { asked++; return { rejoining: true, server: 'localhost:25565' }; } });
  const off = await run('get-position');
  t.true(off.isError);
  t.regex(off.text, /no dropped connection \(a kick, a ban, the whitelist, a version mismatch/);
  t.regex((await run('rejoin-server')).text, /Rejoining localhost:25565/);
  t.is(asked, 1);
  const left: unknown[] = [];
  const on = setup({ 'server.leave': (a: unknown) => { left.push(a); return { left: true, rejoin: false }; } });
  t.regex((await on.run('leave-server')).text, /stays off until rejoin-server/);
  t.regex((await on.run('leave-server', { rejoin: true })).text, /rejoins by itself/);
  t.deepEqual(left, [{ rejoin: false }, { rejoin: true }]);
});

test('a new server with no home and nothing built: the mod still hears both (its build scanner waits for them)', async t => {
  const sent: string[] = [];
  let synced = { protectSynced: false, zoneSynced: false };
  const { run } = setup({
    status: () => ({ ...STATUS, hashedSeed: '77', protectedCount: 0, ...synced }),
    'protect.set': (p: Record<string, unknown>) => { sent.push(`set ${JSON.stringify(p.positions)}`); return {}; },
    'protect.zone': (p: Record<string, unknown>) => { sent.push(`zone ${JSON.stringify(p)}`); return { set: false }; }
  });
  await run('get-position');
  t.deepEqual(sent, ['set []', 'zone {"x":0,"z":0,"radius":0}']);
  synced = { protectSynced: true, zoneSynced: true };
  await run('get-position');
  t.is(sent.length, 2, 'nothing resent once the mod has both');
  synced = { protectSynced: false, zoneSynced: false }; // the client was relaunched
  await run('get-position');
  t.deepEqual(sent.slice(2), ['set []', 'zone {"x":0,"z":0,"radius":0}']);
});
