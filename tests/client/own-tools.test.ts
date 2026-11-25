import test from 'ava';
import sinon from 'sinon';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolFactory } from '../../src/tool-factory.js';
import { MessageStore } from '../../src/message-store.js';
import { brainRun, registerClientTools } from '../../src/client/tools.js';
import type { BridgeClient } from '../../src/client/bridge-client.js';
import type { ProtectionStore } from '../../src/build-protection.js';

// The bot's own blocks (the villager fetch: a lure, a cover, the lock's sill and its socket's wall block) over a fake
// bridge: own.put writes the record before the block goes down and tells the client mod at once (a kill between must
// not leave a block the take refuses, and in a village's zone dig.here takes only what the mod's list holds), a refused
// place leaves no record, `stay` never walks; own.take digs only what the record names (dig.here from where the bot
// stands, never `dig`), never a block someone put in the cell, and adopts a block only when the item is the one there.

const STATUS = {
  inWorld: true, username: 'Bot', screen: null, position: { x: 0.5, y: 64, z: 3.5 }, block: { x: 0, y: 64, z: 3 },
  health: 20, food: 20, dimension: 'overworld', gameMode: 'survival', timeOfDay: 2000, process: null, goal: null
};
const AT = { x: 0, y: 64, z: 0 };
const AIR = { loaded: true, name: 'air', properties: {} };
const block = (name: string, properties: Record<string, string> = {}) => ({ loaded: true, name, properties });
const pockets = (name: string, count: number) => ({ items: count ? [{ slot: 3, name, count }] : [], selectedSlot: 0, held: null });
const GOTO = { arrived: true, reason: 'done', seconds: 1, baritone: [], at: { x: 0, y: 64, z: 2 } };

/** A protection store kept in memory, as placed-blocks.json is on disk: what a second process finds after a kill. */
function memoryStore(): ProtectionStore & { keys: (world: string) => string[] } {
  const worlds = new Map<string, { keys: string[]; states: Record<string, string> }>();
  return {
    load: world => worlds.get(world)?.keys ?? [],
    loadStates: world => worlds.get(world)?.states ?? {},
    save: (world, keys, states) => { worlds.set(world, { keys: [...keys], states: { ...(states ?? worlds.get(world)?.states ?? {}) } }); },
    keys: world => worlds.get(world)?.keys ?? []
  };
}

function setup(given: Record<string, unknown | ((p: Record<string, unknown>) => unknown)>, opts: { store?: ProtectionStore; status?: Record<string, unknown> } = {}) {
  const responses: Record<string, unknown> = { status: { ...STATUS, ...opts.status }, 'protect.set': {}, ...given };
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) };
  const request = sinon.spy(async (method: string, params: Record<string, unknown> = {}) => {
    const r = responses[method];
    if (r === undefined) throw new Error(`unexpected bridge call ${method}`);
    return typeof r === 'function' ? (r as (p: Record<string, unknown>) => unknown)(params) : r;
  });
  const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-own-'));
  const rt = registerClientTools(new ToolFactory(server, connection), { request } as unknown as BridgeClient, new MessageStore(),
    { gameDir, ...(opts.store ? { protectionStore: opts.store } : {}) });
  const calls = (m: string) => request.getCalls().filter(c => c.args[0] === m).map(c => c.args[1] as Record<string, unknown>);
  /** the calls in their order, but the looks (status, the pockets, the cell) */
  const order = () => request.getCalls().map(c => c.args[0] as string).filter(m => !['status', 'inventory', 'world.block'].includes(m));
  /** the cells the client mod was last told are the bot's */
  const told = () => (calls('protect.set').at(-1)?.positions ?? []) as number[][];
  return { request, rt, own: rt.own!, calls, order, told };
}

test('own.put: the cell is the bot\'s own before the block goes down (the record written, the client mod told), then the item is selected and placed', async (t) => {
  let down = false;
  const seen: { record: number; told: number[][] }[] = [];
  const s = setup({
    'item.select': { held: 2 },
    place: () => { seen.push({ record: s.rt.builtNear(AT, 0).length, told: s.told() }); down = true; return { placed: true, block: 'fletching_table', face: 'down' }; },
    'world.block': () => (down ? block('fletching_table') : AIR)
  });
  const r = await s.own.put({ x: 0.4, y: 64, z: 0.9 }, 'fletching_table');
  t.deepEqual(r, { ok: true, placed: true, block: 'fletching_table' });
  // protection before the place: in the record and in the mod's list at the moment of the place
  t.deepEqual(seen, [{ record: 1, told: [[0, 64, 0]] }]);
  t.deepEqual(s.order(), ['protect.set', 'item.select', 'place']);
  t.deepEqual(s.calls('item.select')[0], { name: 'fletching_table' });
  t.deepEqual(s.calls('place')[0], { x: 0, y: 64, z: 0, face: 'down' });
  // the bot's own from then, with the state it stands in
  t.deepEqual(s.rt.builtNear(AT, 0), [{ at: AT, state: 'fletching_table' }]);
  // `face`: the side clicked against first (the sill's rail on the ground, a block set against a wall)
  const side = setup({ 'item.select': { held: 0 }, place: { placed: true, block: 'rail', face: 'north' }, 'world.block': block('rail', { shape: 'north_south', waterlogged: 'false' }) });
  t.like(await side.own.put(AT, 'minecraft:rail', { face: 'north' }), { ok: true, placed: true, block: 'rail' });
  t.deepEqual(side.calls('place')[0], { x: 0, y: 64, z: 0, face: 'north' });
  t.deepEqual(side.rt.builtNear(AT, 0), [{ at: AT, state: 'rail[shape=north_south,waterlogged=false]' }]);
});

test('a refused place leaves no record: the cell taken, nothing to place against, the item not carried', async (t) => {
  for (const reason of ['occupied by oak_fence', 'nothing solid next to it to place against', 'the bot is standing there']) {
    const s = setup({ 'item.select': { held: 0 }, place: { placed: false, reason, distance: null } });
    t.deepEqual(await s.own.put(AT, 'fletching_table'), { ok: false, placed: false, reason });
    t.deepEqual(s.rt.builtNear(AT, 2), [], reason);
    // the mod told so too: nothing of the bot's there
    t.deepEqual(s.told(), [], reason);
    t.false(s.order().includes('goto'), reason);
  }
  // the server did not take the click (no reason given): no record either
  const not = setup({ 'item.select': { held: 0 }, place: { placed: false, block: 'air', face: 'down' } });
  t.like(await not.own.put(AT, 'fletching_table'), { ok: false, placed: false });
  t.deepEqual(not.rt.builtNear(AT, 2), []);
  // not carried: never asked to place
  const none = setup({ 'item.select': () => { throw new Error('no fletching_table in inventory'); }, place: { placed: true, block: 'stone' } });
  t.deepEqual(await none.own.put(AT, 'fletching_table'), { ok: false, placed: false, reason: 'no fletching_table in inventory' });
  t.is(none.calls('place').length, 0);
  t.deepEqual(none.rt.builtNear(AT, 2), []);
  t.deepEqual(none.told(), []);
});

test('a refused place in a cell that was the bot\'s before (the lure still in the socket) leaves that record as it was', async (t) => {
  let table = false;
  const s = setup({
    'item.select': { held: 0 },
    place: () => (table ? { placed: false, reason: 'occupied by fletching_table' } : (table = true, { placed: true, block: 'fletching_table' })),
    'world.block': () => (table ? block('fletching_table') : AIR)
  });
  await s.own.put(AT, 'fletching_table');
  t.deepEqual(await s.own.put(AT, 'oak_planks'), { ok: false, placed: false, reason: 'occupied by fletching_table' });
  t.deepEqual(s.rt.builtNear(AT, 0), [{ at: AT, state: 'fletching_table' }]);
});

test('own.put too far: one careful walk into reach and once more, never a plain walk; with `stay` no walk at all', async (t) => {
  let tries = 0;
  const s = setup({
    'item.select': { held: 0 },
    place: () => (tries++ === 0 ? { placed: false, reason: 'too far', distance: 6.2 } : { placed: true, block: 'fletching_table', face: 'down' }),
    'world.block': block('fletching_table'),
    goto: GOTO
  });
  t.like(await s.own.put(AT, 'fletching_table'), { ok: true, placed: true });
  t.deepEqual(s.order().filter(m => m !== 'protect.set'), ['item.select', 'place', 'goto', 'item.select', 'place']);
  t.is(s.calls('goto').length, 1);
  t.like(s.calls('goto')[0], { x: 0, y: 64, z: 0, range: 2, careful: true });
  // still too far after the one walk: refused, no second walk, no record
  const far = setup({ 'item.select': { held: 0 }, place: { placed: false, reason: 'too far', distance: 7 }, goto: GOTO });
  t.like(await far.own.put(AT, 'fletching_table'), { ok: false, placed: false, reason: 'too far' });
  t.is(far.calls('goto').length, 1);
  t.deepEqual(far.rt.builtNear(AT, 2), []);
  // stay (from the post, the exit handler's anchor): never walks
  const stay = setup({ 'item.select': { held: 0 }, place: { placed: false, reason: 'too far', distance: 5 }, goto: GOTO });
  t.deepEqual(await stay.own.put(AT, 'fletching_table', { stay: true }), { ok: false, placed: false, reason: 'too far' });
  t.is(stay.calls('goto').length, 0);
  t.is(stay.calls('place').length, 1);
  t.deepEqual(stay.rt.builtNear(AT, 2), []);
});

test('a put whose reply was lost is read: the block there after all is the bot\'s own; room there, no record; a cell that cannot be read keeps the record', async (t) => {
  let down = false;
  const there = setup({
    'item.select': { held: 0 },
    place: () => { down = true; throw new Error('bridge call place timed out after 30000 ms'); },
    'world.block': () => (down ? block('fletching_table') : AIR)
  });
  const r = await there.own.put(AT, 'fletching_table');
  t.like(r, { ok: true, placed: true, block: 'fletching_table' });
  t.regex(r.reason!, /^the reply was lost \(bridge call place timed out after 30000 ms\); read down after$/);
  t.deepEqual(there.rt.builtNear(AT, 0), [{ at: AT, state: 'fletching_table' }]);
  // the use waited on the client's ticks behind the first read (room read there): read once more after a moment
  let reads = 0;
  const late = setup({
    'item.select': { held: 0 },
    place: () => { throw new Error('bridge call place timed out after 30000 ms'); },
    'world.block': () => (reads++ === 0 ? AIR : block('fletching_table'))
  });
  t.like(await late.own.put(AT, 'fletching_table'), { ok: true, placed: true });
  t.is(late.rt.builtNear(AT, 0).length, 1);
  // nothing of it there: not placed, off the record again
  const none = setup({ 'item.select': { held: 0 }, place: () => { throw new Error('bridge call place timed out after 30000 ms'); }, 'world.block': AIR });
  t.deepEqual(await none.own.put(AT, 'fletching_table'), { ok: false, placed: false, reason: 'bridge call place timed out after 30000 ms' });
  t.deepEqual(none.rt.builtNear(AT, 2), []);
  t.deepEqual(none.told(), []);
  // unread (the bridge gone): the record stays for the take's own read to decide
  const blind = setup({
    'item.select': { held: 0 },
    place: () => { throw new Error('bridge connection closed'); },
    'world.block': () => { throw new Error('bridge not connected'); }
  });
  t.like(await blind.own.put(AT, 'fletching_table'), { ok: false, placed: false, reason: 'bridge connection closed' });
  t.deepEqual(blind.rt.builtNear(AT, 0), [{ at: AT }]);
});

test('protected and never placed: the record goes (killed between the record and the place, the next process takes air: record off, nothing dug)', async (t) => {
  const store = memoryStore();
  const world = { hashedSeed: 77 };
  const first = setup({
    'item.select': { held: 0 },
    // the kill: the record is on disk at the moment of the place, the block never goes down, nothing answers after
    place: () => { t.deepEqual(store.keys('seed:77'), ['overworld:0,64,0']); throw new Error('bridge connection closed'); },
    'world.block': () => { throw new Error('bridge not connected'); }
  }, { store, status: world });
  await first.rt.status();
  await first.own.put(AT, 'fletching_table');
  t.deepEqual(store.keys('seed:77'), ['overworld:0,64,0']);
  // the process after: a record with no block (within 24 of home the repair round would "put it back")
  const next = setup({ 'world.block': AIR, 'dig.here': { dug: true, block: 'fletching_table' } }, { store, status: world });
  await next.rt.status();
  t.deepEqual(next.rt.builtNear(AT, 0), [{ at: AT }]);
  t.deepEqual(await next.own.take(AT, 'fletching_table'), { ok: true, dug: false, reason: 'nothing there' });
  t.deepEqual(store.keys('seed:77'), []);
  t.deepEqual(next.rt.builtNear(AT, 2), []);
  t.deepEqual(next.told(), []);
  t.is(next.calls('dig.here').length, 0);
});

test('protected and never placed on grass: a tuft of grass, snow or water in the cell is nothing there, not someone\'s block (record off, ok, and so every time it is asked)', async (t) => {
  // a lure goes down on level grass: its cell is as often a tuft of it as air. Killed between the record and the place
  // the tuft still stands, and the take's read finds it: what the place itself goes into as into air is no block
  for (const [name, props] of [['short_grass', {}], ['tall_grass', { half: 'lower' }], ['fern', {}], ['snow', { layers: '1' }], ['water', { level: '0' }], ['fire', {}], ['vine', { north: 'true' }], ['leaf_litter', {}]] as [string, Record<string, string>][]) {
    const store = memoryStore();
    const world = { hashedSeed: 78 };
    const first = setup({
      'item.select': { held: 0 },
      place: () => { throw new Error('bridge connection closed'); },
      'world.block': () => { throw new Error('bridge not connected'); }
    }, { store, status: world });
    await first.rt.status();
    await first.own.put(AT, 'fletching_table');
    t.deepEqual(store.keys('seed:78'), ['overworld:0,64,0'], name);
    const next = setup({ 'world.block': block(name, props), 'dig.here': { dug: true, block: name } }, { store, status: world });
    await next.rt.status();
    t.deepEqual(await next.own.take(AT, 'fletching_table', { adopt: true }), { ok: true, dug: false, block: name, reason: 'nothing there' }, name);
    t.deepEqual(store.keys('seed:78'), [], name);
    t.deepEqual(next.told(), [], name);
    // asked again (the journal's entry not yet dropped): the same answer, never a failure
    t.deepEqual(await next.own.take(AT, 'fletching_table'), { ok: true, dug: false, block: name, reason: 'nothing there' }, name);
    t.is(next.calls('dig.here').length, 0, name);
  }
  // what a place does not go into is a block: snow lying deeper than one layer, a flower, a sapling
  for (const [name, props] of [['snow', { layers: '3' }], ['poppy', {}], ['oak_sapling', { stage: '0' }], ['torch', {}]] as [string, Record<string, string>][]) {
    const s = setup({ 'world.block': block(name, props), 'dig.here': { dug: true, block: name } });
    t.deepEqual(await s.own.take(AT, 'fletching_table', { adopt: true }),
      { ok: false, dug: false, block: name, reason: `the bot did not put that ${name} there (its fletching_table is gone)` }, name);
    t.is(s.calls('dig.here').length, 0, name);
  }
  // and the item asked for is never room: the bot's own snow (were it ever one) is dug as any block of its own
  let now = 'snow';
  const own = setup({ 'world.block': () => (now === 'air' ? AIR : block(now, { layers: '1' })), 'dig.here': () => { now = 'air'; return { dug: true, block: 'snow' }; }, inventory: pockets('snow', 0) });
  t.like(await own.own.take(AT, 'snow', { adopt: true, pickup: false }), { ok: true, dug: true });
});

test('a block put down as the run is cut short (the answer in, every call after refused) is the bot\'s own all the same: the take takes it; a put asked after the cut is never sent and leaves no record', async (t) => {
  const abort = new AbortController();
  let down = false;
  const s = setup({
    'item.select': { held: 0 },
    place: () => { down = true; abort.abort(); return { placed: true, block: 'fletching_table', face: 'down' }; },
    'world.block': () => (down ? block('fletching_table') : AIR),
    'dig.here': () => { down = false; return { dug: true, block: 'fletching_table' }; },
    inventory: () => pockets('fletching_table', down ? 0 : 1)
  });
  const r = await brainRun.run({ signal: abort.signal }, () => s.own.put(AT, 'fletching_table'));
  t.like(r, { ok: true, placed: true, block: 'fletching_table' });
  t.deepEqual(s.rt.builtNear(AT, 0), [{ at: AT, state: 'fletching_table' }]);
  // (the mod was told before the place: the cut run could tell it nothing after)
  t.deepEqual(s.told(), [[0, 64, 0]]);
  // a put asked after the cut
  const later = await brainRun.run({ signal: abort.signal }, () => s.own.put({ x: 3, y: 64, z: 0 }, 'fletching_table'));
  t.like(later, { ok: false, placed: false });
  t.is(s.calls('place').length, 1);
  t.deepEqual(s.rt.builtNear({ x: 3, y: 64, z: 0 }, 0), []);
  // the take, outside the cut run (care's, or the exit handler's)
  t.like(await s.own.take(AT, 'fletching_table', { pickup: false }), { ok: true, dug: true });
  t.false(down);
});

test('another kind came out (item.select took a name in part: dark_oak_planks for oak_planks): placed and the bot\'s own as it stands, but not ok', async (t) => {
  const s = setup({ 'item.select': { held: 0 }, place: { placed: true, block: 'dark_oak_planks', face: 'down' }, 'world.block': block('dark_oak_planks') });
  t.deepEqual(await s.own.put(AT, 'oak_planks'), { ok: false, placed: true, block: 'dark_oak_planks', reason: 'it came out dark_oak_planks, not oak_planks' });
  t.deepEqual(s.rt.builtNear(AT, 0), [{ at: AT, state: 'dark_oak_planks' }]);
});

test('own.take: the bot\'s own block dug from where it stands (dig.here, never dig), the drop waited for, and the cell the bot\'s no more', async (t) => {
  let there = false;
  let carried = 1;
  const s = setup({
    'item.select': { held: 0 },
    place: () => { there = true; carried--; return { placed: true, block: 'fletching_table', face: 'down' }; },
    'world.block': () => (there ? block('fletching_table') : AIR),
    'dig.here': () => { there = false; carried++; return { dug: true, block: 'fletching_table', tool: 'iron_axe' }; },
    inventory: () => pockets('fletching_table', carried),
    goto: GOTO
  });
  await s.own.put(AT, 'fletching_table');
  t.deepEqual(await s.own.take(AT, 'fletching_table'), { ok: true, dug: true, pickedUp: true });
  t.deepEqual(s.calls('dig.here'), [{ x: 0, y: 64, z: 0, timeoutMs: 15_000 }]);
  t.false(s.order().includes('dig'));
  // (it came in while the bot stood by: no walk)
  t.is(s.calls('goto').length, 0);
  t.deepEqual(s.rt.builtNear(AT, 2), []);
  t.deepEqual(s.told(), []);
  // gone already: nothing to dig
  t.deepEqual(await s.own.take(AT, 'fletching_table'), { ok: true, dug: false, reason: 'nothing there' });
  t.is(s.calls('dig.here').length, 1);
});

test('own.take steps carefully into reach and sight once when the dig cannot see the block, and walks onto the cell for a drop that did not come in', async (t) => {
  let digs = 0;
  let onCell = false;
  const s = setup({
    'item.select': { held: 0 },
    place: { placed: true, block: 'fletching_table', face: 'down' },
    'world.block': () => (digs > 1 ? AIR : block('fletching_table')),
    'dig.here': () => (++digs === 1 ? { dug: false, reason: 'out of reach or out of sight', block: 'fletching_table' } : { dug: true, block: 'fletching_table' }),
    inventory: () => pockets('fletching_table', onCell ? 1 : 0),
    goto: (p: Record<string, unknown>) => { if (p.range === 0) onCell = true; return GOTO; }
  });
  await s.own.put(AT, 'fletching_table');
  t.deepEqual(await s.own.take(AT, 'fletching_table'), { ok: true, dug: true, pickedUp: true });
  t.is(digs, 2);
  t.deepEqual(s.calls('goto').map(g => [g.range, g.careful]), [[2, true], [0, true]]);
  // not seen after the one walk either: not dug, still the bot's
  const blind = setup({
    'item.select': { held: 0 }, place: { placed: true, block: 'fletching_table' }, 'world.block': block('fletching_table'),
    'dig.here': { dug: false, reason: 'out of reach or out of sight', block: 'fletching_table' }, inventory: pockets('fletching_table', 0), goto: GOTO
  });
  await blind.own.put(AT, 'fletching_table');
  t.deepEqual(await blind.own.take(AT, 'fletching_table'), { ok: false, dug: false, reason: 'out of reach or out of sight' });
  t.is(blind.calls('goto').length, 1);
  t.is(blind.rt.builtNear(AT, 0).length, 1);
});

test('`stay` never walks: not into reach of a block the dig cannot see, not onto the cell for the drop; `pickup: false` does not look for it', async (t) => {
  let dug = false;
  const s = setup({
    'item.select': { held: 0 },
    place: { placed: true, block: 'oak_planks', face: 'down' },
    'world.block': () => (dug ? AIR : block('oak_planks')),
    'dig.here': { dug: false, reason: 'out of reach or out of sight', block: 'oak_planks' },
    inventory: pockets('oak_planks', 0),
    goto: GOTO
  });
  await s.own.put(AT, 'oak_planks');
  t.deepEqual(await s.own.take(AT, 'oak_planks', { stay: true }), { ok: false, dug: false, reason: 'out of reach or out of sight' });
  t.is(s.calls('dig.here').length, 1);
  t.is(s.calls('goto').length, 0);
  t.is(s.rt.builtNear(AT, 0).length, 1);
  // dug from the post, the drop out of reach behind the wall: waited for, never walked onto
  const post = setup({
    'item.select': { held: 0 },
    place: { placed: true, block: 'fletching_table', face: 'down' },
    'world.block': () => (dug ? AIR : block('fletching_table')),
    'dig.here': () => { dug = true; return { dug: true, block: 'fletching_table' }; },
    inventory: pockets('fletching_table', 0),
    goto: GOTO
  });
  await post.own.put(AT, 'fletching_table');
  dug = false;
  t.deepEqual(await post.own.take(AT, 'fletching_table', { stay: true }), { ok: true, dug: true, pickedUp: false });
  t.is(post.calls('goto').length, 0);
  // the pockets looked into before the dig and four times after
  t.is(post.calls('inventory').length, 5);
  // the lock's S_out lure: stay, no pickup (the drop is fetched later, by its journal entry)
  const out = setup({
    'item.select': { held: 0 },
    place: { placed: true, block: 'fletching_table', face: 'down' },
    'world.block': block('fletching_table'),
    'dig.here': { dug: true, block: 'fletching_table' }
  });
  await out.own.put(AT, 'fletching_table');
  t.deepEqual(await out.own.take(AT, 'fletching_table', { stay: true, pickup: false }), { ok: true, dug: true });
  t.deepEqual(out.order().filter(m => m !== 'protect.set'), ['item.select', 'place', 'dig.here']);
  t.deepEqual(out.rt.builtNear(AT, 2), []);
});

test('own.take refuses a block not in the record: the item asked for stands there, but the bot never put it', async (t) => {
  const s = setup({ 'world.block': block('fletching_table'), 'dig.here': { dug: true, block: 'fletching_table' }, inventory: pockets('fletching_table', 0) });
  t.deepEqual(await s.own.take(AT, 'fletching_table'), { ok: false, dug: false, reason: 'the bot did not put that fletching_table there' });
  t.deepEqual(await s.own.take(AT, 'fletching_table', { stay: true, pickup: false }), { ok: false, dug: false, reason: 'the bot did not put that fletching_table there' });
  t.is(s.calls('dig.here').length, 0);
  // an unloaded cell: nothing known, nothing done, the record as it was
  const far = setup({ 'item.select': { held: 0 }, place: { placed: true, block: 'fletching_table' }, 'world.block': { loaded: false }, 'dig.here': { dug: true } });
  await far.own.put(AT, 'fletching_table');
  t.deepEqual(await far.own.take(AT, 'fletching_table'), { ok: false, dug: false, reason: 'not loaded' });
  t.is(far.calls('dig.here').length, 0);
  t.is(far.rt.builtNear(AT, 0).length, 1);
});

test('a foreign block in the cell is never dug: someone broke the bot\'s lure and put their own block there, theirs now, and the cell the bot\'s no more', async (t) => {
  let now = 'air';
  const s = setup({
    'item.select': { held: 0 },
    place: () => { now = 'fletching_table'; return { placed: true, block: 'fletching_table', face: 'down' }; },
    'world.block': () => block(now),
    'dig.here': { dug: true, block: 'cobblestone' },
    inventory: pockets('fletching_table', 0)
  });
  await s.own.put(AT, 'fletching_table');
  now = 'cobblestone';
  t.deepEqual(await s.own.take(AT, 'fletching_table'), { ok: false, dug: false, block: 'cobblestone', reason: 'the bot did not put that cobblestone there (its fletching_table is gone)' });
  t.is(s.calls('dig.here').length, 0);
  t.deepEqual(s.rt.builtNear(AT, 2), []);
  t.deepEqual(s.told(), []);
  // not with `adopt` either, and not their own table put where the bot's stood once the record is off
  t.like(await s.own.take(AT, 'fletching_table', { adopt: true }), { ok: false, dug: false });
  now = 'fletching_table';
  t.like(await s.own.take(AT, 'fletching_table'), { ok: false, dug: false, reason: 'the bot did not put that fletching_table there' });
  t.is(s.calls('dig.here').length, 0);
  t.deepEqual(s.rt.builtNear(AT, 2), []);
});

test('the bot\'s own block of another kind in the cell (the lock\'s wall block back in the socket, asked for as the lure) is neither dug nor forgotten', async (t) => {
  let now = 'air';
  const s = setup({
    'item.select': { held: 0 },
    place: () => { now = 'oak_planks'; return { placed: true, block: 'oak_planks', face: 'down' }; },
    'world.block': () => block(now),
    'dig.here': { dug: true, block: 'oak_planks' }
  });
  await s.own.put(AT, 'oak_planks');
  t.deepEqual(await s.own.take(AT, 'fletching_table'), { ok: false, dug: false, block: 'oak_planks', reason: 'the bot\'s own oak_planks stands there, not its fletching_table' });
  t.is(s.calls('dig.here').length, 0);
  t.deepEqual(s.rt.builtNear(AT, 0), [{ at: AT, state: 'oak_planks' }]);
});

test('`adopt` only with the item matching: a block the journal names, lost from the record, is protected again first (the mod told before the dig); another block there is never adopted', async (t) => {
  let now = 'fletching_table';
  const told: number[][][] = [];
  const s = setup({
    'world.block': () => block(now),
    'dig.here': () => { told.push(s.told()); now = 'air'; return { dug: true, block: 'fletching_table' }; },
    inventory: () => pockets('fletching_table', now === 'air' ? 1 : 0)
  });
  t.deepEqual(await s.own.take(AT, 'fletching_table', { adopt: true }), { ok: true, dug: true, pickedUp: true });
  t.deepEqual(told, [[[0, 64, 0]]]);
  t.deepEqual(s.rt.builtNear(AT, 2), []);
  t.deepEqual(s.told(), []);
  // the item does not match what stands there: not adopted, not dug, no record made
  now = 'smithing_table';
  t.like(await s.own.take(AT, 'fletching_table', { adopt: true }), { ok: false, dug: false });
  t.is(s.calls('dig.here').length, 1);
  t.deepEqual(s.rt.builtNear(AT, 2), []);
  t.deepEqual(s.told(), []);
});

test('a dig that fails leaves the block the bot\'s own; one that finds air after all takes the record off', async (t) => {
  const s = setup({
    'item.select': { held: 0 }, place: { placed: true, block: 'fletching_table' }, 'world.block': block('fletching_table'),
    'dig.here': { dug: false, reason: 'timeout', block: 'fletching_table' }, inventory: pockets('fletching_table', 0), goto: GOTO
  });
  await s.own.put(AT, 'fletching_table');
  t.deepEqual(await s.own.take(AT, 'fletching_table'), { ok: false, dug: false, reason: 'timeout' });
  t.is(s.rt.builtNear(AT, 0).length, 1);
  t.is(s.calls('goto').length, 0);
  // a village's zone and a mod that does not know the cell: its refusal is passed on, never forced
  const zone = setup({
    'item.select': { held: 0 }, place: { placed: true, block: 'fletching_table' }, 'world.block': block('fletching_table'),
    'dig.here': { dug: false, reason: 'someone else\'s build (force: true to dig it anyway)', block: 'fletching_table' }, inventory: pockets('fletching_table', 0)
  });
  await zone.own.put(AT, 'fletching_table');
  t.like(await zone.own.take(AT, 'fletching_table'), { ok: false, dug: false });
  t.deepEqual(zone.calls('dig.here'), [{ x: 0, y: 64, z: 0, timeoutMs: 15_000 }]);
  // gone between the read and the dig
  const gone = setup({
    'item.select': { held: 0 }, place: { placed: true, block: 'fletching_table' }, 'world.block': block('fletching_table'),
    'dig.here': { dug: false, reason: 'air' }, inventory: pockets('fletching_table', 0)
  });
  await gone.own.put(AT, 'fletching_table');
  t.deepEqual(await gone.own.take(AT, 'fletching_table'), { ok: true, dug: false, reason: 'nothing there' });
  t.deepEqual(gone.rt.builtNear(AT, 2), []);
});

test('a take cut short after its dig still says the block is dug (the caller writes the drop down); the cell is the bot\'s no more', async (t) => {
  const abort = new AbortController();
  let there = false;
  const s = setup({
    'item.select': { held: 0 },
    place: () => { there = true; return { placed: true, block: 'fletching_table' }; },
    'world.block': () => (there ? block('fletching_table') : AIR),
    'dig.here': () => { there = false; abort.abort(); return { dug: true, block: 'fletching_table' }; },
    inventory: pockets('fletching_table', 0),
    goto: GOTO
  });
  await s.own.put(AT, 'fletching_table');
  const r = await brainRun.run({ signal: abort.signal }, () => s.own.take(AT, 'fletching_table'));
  t.deepEqual(r, { ok: true, dug: true, pickedUp: false });
  t.is(s.calls('goto').length, 0);
  t.deepEqual(s.rt.builtNear(AT, 2), []);
});

test('the runtime gives the rails home and the own blocks side by side', (t) => {
  const s = setup({});
  t.is(typeof s.rt.own?.put, 'function');
  t.is(typeof s.rt.own?.take, 'function');
  t.is(typeof s.rt.rails?.lay, 'function');
});
