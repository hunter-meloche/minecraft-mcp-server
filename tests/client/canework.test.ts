import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Brain } from '../../src/client/brain/brain.js';
import type { ClientRuntime, InventoryItem } from '../../src/client/tools.js';
import type { Goal, GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { Zone } from '../../src/client/brain/courtesy.js';
import { caneCellState, caneRound, liveCells, lookAtCell, plantCane } from '../../src/client/brain/cane.js';
import { CANE_CELLS, LADDER } from '../../src/client/brain/worktasks.js';
import { DRY_WAIT, dryUntil, pick, releaseOldestDry, sitesOf, workGoals, workOf, type WorkTask } from '../../src/client/brain/work.js';

/**
 * The cane rungs (worktasks.ts `cane patch`, `cane`) and the cane round over a stand-in world that answers as the
 * client does: world.region box by box (x fastest, then z, then y; null where not loaded), world.findBlocks the
 * nearest first round the bot (open to the sky when asked), place-block that the server refuses where cane cannot
 * stand, dig-block that brings down the cane above (and picks it up, or leaves it lying with collect: false). Shaped
 * like the live homestead on Nov 12: the yard's ground at y 62, the lake sunk to y 56 east of it round (-508, 2199),
 * the five old cells at y 63 with no water beside them, the farm's water inside the yard.
 */

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 12, 20, 0, 0);
const HOME: Pos = { x: -549, y: 63, z: 2183 };
const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
/** the lake as it stands: water at y 56, 9 x 9 */
const POND = { x1: -512, x2: -504, z1: 2195, z2: 2203, y: 56 };
const DEAD: Pos[] = [{ x: -519, y: 63, z: 2202 }, { x: -520, y: 63, z: 2203 }, { x: -518, y: 63, z: 2204 }, { x: -526, y: 63, z: 2205 }, { x: -524, y: 63, z: 2205 }];
const CHEST: Pos = { x: -547, y: 63, z: 2182 };
const k = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
type Box = { x: number; y: number; z: number; width: number; height: number; length: number };

/** The ground's top block by column: the yard's 62, and the lake's basin down to its shore at 56 (its bed at 55). */
function liveGround(x: number, z: number): number {
  const d = Math.max(POND.x1 - x, 0, x - POND.x2, POND.z1 - z, 0, z - POND.z2);
  return d === 0 ? POND.y - 1 : Math.min(YARD.y, POND.y - 1 + d);
}

/** A world of blocks: ground by `ground`, and what is set on it; nothing is loaded further than 160 from home. */
class Land {
  private over = new Map<string, string>();
  constructor(private ground: (x: number, z: number) => number = liveGround) {}
  at(x: number, y: number, z: number): string | null {
    if (horiz({ x, z }, HOME) > 160) return null;
    const o = this.over.get(`${x},${y},${z}`);
    if (o !== undefined) return o;
    const g = this.ground(x, z);
    return y > g ? 'air' : y === g ? 'grass_block[snowy=false]' : 'dirt';
  }
  set(p: Pos, block: string): void { this.over.set(k(p), block); }
  name(p: Pos): string { return (this.at(p.x, p.y, p.z) ?? '').replace(/\[.*$/, ''); }
  region(b: Box): (string | null)[] {
    const out: (string | null)[] = [];
    for (let y = 0; y < b.height; y++) for (let z = 0; z < b.length; z++) for (let x = 0; x < b.width; x++) out.push(this.at(b.x + x, b.y + y, b.z + z));
    return out;
  }
  /** what findBlocks scans: the blocks set on the ground (water, cane), the nearest to `from` first */
  find(block: string, from: Pos, maxDistance: number, count: number, openAbove: boolean): Pos[] {
    return [...this.over.entries()].filter(([, b]) => b.replace(/\[.*$/, '') === block).map(([key]) => { const [x, y, z] = key.split(',').map(Number); return { x, y, z }; })
      .filter(p => Math.hypot(p.x + 0.5 - from.x, p.y + 0.5 - from.y, p.z + 0.5 - from.z) <= maxDistance && (!openAbove || this.at(p.x, p.y + 1, p.z) === 'air'))
      .sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y, a.z - from.z) - Math.hypot(b.x - from.x, b.y - from.y, b.z - from.z)).slice(0, count);
  }
}

/** The live lake: its water, the farm's water in the yard (with farmland round it), and the five old cells, bare. */
function liveLand(): Land {
  const land = new Land();
  for (let x = POND.x1; x <= POND.x2; x++) for (let z = POND.z1; z <= POND.z2; z++) land.set({ x, y: POND.y, z }, 'water[level=0]');
  for (let x = -542; x <= -540; x++) for (let z = 2164; z <= 2166; z++) land.set({ x, y: 62, z }, 'farmland[moisture=7]');
  land.set({ x: -541, y: 62, z: 2165 }, 'water[level=0]');
  return land;
}

/** A stalk of cane `height` tall standing on (x, y - 1, z). */
const stalk = (land: Land, p: Pos, height: number) => { for (let i = 0; i < height; i++) land.set({ ...p, y: p.y + i }, 'sugar_cane[age=0]'); };

/** The live memory: the five cells, the chest with 34 cane, the yard, the enchanting room blocked on cane and leather. */
function liveWorld(over: Partial<WorldMemory> = {}): WorldMemory {
  return {
    landmarks: { chests: [{ ...CHEST }], farmland: [], foundAt: T0 }, leash: 96, yard: { ...YARD },
    chestItems: { [k(CHEST)]: { sugar_cane: 34 } },
    zones: { cane: DEAD.map(p => ({ ...p })), plot: [{ x: -545, y: 62, z: 2161, width: 9, length: 9 }] },
    progress: { done: ['cane'], journal: [], blocked: { id: 'enchanting/2', n: 94, at: T0 - MINUTE, need: { sugar_cane: 135, leather: 45 } } },
    ...over
  } as WorldMemory;
}

const countsOf = (items: InventoryItem[]) => {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return counts;
};
const look = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => ({
  now: T0, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { ...HOME }, dimension: 'overworld', sleeping: false, raining: false,
  thundering: false, process: null, items, counts: countsOf(items), slotsUsed: items.filter(i => i.slot < 36).length, home: { ...HOME, dimension: 'overworld' },
  distHome: 0, ...over
});
const KIT: InventoryItem[] = [{ slot: 0, name: 'iron_pickaxe', count: 1 }, { slot: 1, name: 'bread', count: 32 }];

/** How far the eye at `feet` is from the nearest point of block `p` (the reach the game measures, 4.5 at most). */
const reachOf = (feet: Pos, p: Pos) => {
  const eye = { x: feet.x + 0.5, y: feet.y + 1.62, z: feet.z + 0.5 };
  const near = (v: number, lo: number) => Math.max(lo, Math.min(lo + 1, v));
  return Math.hypot(eye.x - near(eye.x, p.x), eye.y - near(eye.y, p.y), eye.z - near(eye.z, p.z));
};

/**
 * The bot in that world, as the client tools answer: where it stands, its pockets, one chest. `refuse`: cells where
 * the server will not take a block (a sheep standing there); `zones`: someone else's builds as the mod reports them;
 * `unreachable`: places move-to-position finds no path to (it throws, as the tool does); `noWay`: blocks a walk does
 * not get to (it stops short, where it was). Every walk is written down, careful or not (`walks`), and so is every
 * dig-block or place-block out of the bot's reach (`baritone`): the tool then walks there by Baritone's own way, which
 * may bridge and pillar with cobblestone; and so is every dig-block that picks up its own drops (collect, the tool's
 * default: it walks onto each the same way). With collect: false the cut cane lies on the cell's ground (`lying`)
 * until the bot looks for drops (world.entities: by then the game's half second has gone by) from within a block of
 * it, on its level or up to two below (the game's pickup box): a walk away first leaves it there. dig.here digs from
 * where the bot stands, within reach, as the bridge's does.
 */
function botIn(land: Land, world: WorldMemory, items: InventoryItem[], opts: { refuse?: string[]; zones?: Zone[]; chest?: Record<string, number>; unreachable?: string[]; noWay?: (p: Pos) => boolean } = {}) {
  const me = {
    pos: { ...HOME }, items: items.map(i => ({ ...i })), acts: [] as string[], said: [] as string[], gain: 0, gotos: [] as Pos[], chest: { sugar_cane: 34, ...opts.chest },
    walks: [] as { to: string; careful: boolean; range?: number }[], baritone: [] as string[], digs: [] as string[],
    lying: [] as { at: Pos; n: number }[]
  };
  const ac = new AbortController();
  const count = (name: string) => me.items.filter(i => i.slot < 36 && i.name === name).reduce((a, i) => a + i.count, 0);
  const add = (name: string, n: number) => {
    const has = me.items.find(i => i.slot < 36 && i.name === name);
    if (has) { has.count += n; return; }
    let slot = 0;
    while (me.items.some(i => i.slot === slot)) slot++;
    me.items.push({ slot, name, count: n });
  };
  const take = (name: string, n: number) => {
    const has = me.items.find(i => i.slot < 36 && i.name === name);
    if (!has) return;
    has.count -= n;
    if (has.count <= 0) me.items = me.items.filter(i => i !== has);
  };
  const at = (a: Record<string, unknown>): Pos => ({ x: Number(a.x), y: Number(a.y), z: Number(a.z) });
  const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
  // the game's rule for cane: on grass, dirt or sand, with water beside that block (or cane under it)
  const holdsCane = (p: Pos) => {
    const under = { ...p, y: p.y - 1 };
    if (land.name(under) === 'sugar_cane') return true;
    if (!/^(grass_block|dirt|sand)$/.test(land.name(under))) return false;
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => land.name({ x: under.x + dx, y: under.y, z: under.z + dz }) === 'water');
  };
  const ctx: GoalContext = {
    s: look(me.items), world, signal: ac.signal,
    progress: text => { me.said.push(text); },
    gain: n => { me.gain += n; },
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...me.pos }, dimension: 'overworld' }),
    call: (async (method: string, p: Record<string, unknown> = {}) => {
      if (method === 'inventory') return { items: me.items.map(i => ({ ...i })) };
      if (method === 'world.region') return { blocks: land.region(p as unknown as Box) };
      if (method === 'world.findBlocks') return { positions: land.find(String(p.block), me.pos, Number(p.maxDistance ?? 32), Number(p.count ?? 1), !!p.openAbove) };
      if (method === 'foreign.zones') return { zones: opts.zones ?? [] };
      if (method === 'world.entities') {
        const reached = (d: Pos) => Math.abs(me.pos.x - d.x) <= 1 && Math.abs(me.pos.z - d.z) <= 1 && me.pos.y <= d.y && me.pos.y >= d.y - 2;
        for (const d of me.lying.filter(l => reached(l.at))) add('sugar_cane', d.n);
        me.lying = me.lying.filter(l => !reached(l.at));
        return { entities: me.lying.map((l, i) => ({ id: i + 1, name: 'item', item: 'sugar_cane', count: l.n, position: { x: l.at.x + 0.5, y: l.at.y, z: l.at.z + 0.5 } })) };
      }
      if (method === 'goto') {
        me.gotos.push(at(p));
        const to = { x: Number(p.x), y: p.xz || p.y === undefined ? 63 : Number(p.y), z: Number(p.z) };
        me.walks.push({ to: k(to), careful: !!p.careful, ...(p.range !== undefined ? { range: Number(p.range) } : {}) });
        if (opts.noWay?.(to)) return { arrived: false, at: { ...me.pos } };
        me.pos = to;
        return { arrived: true };
      }
      if (method === 'dig.here') {
        const q = at(p);
        me.digs.push(k(q));
        const b = land.name(q);
        if (b === 'air') return { dug: false, reason: 'air' };
        if (reachOf(me.pos, q) > 4.5) return { dug: false, reason: 'out of reach or out of sight', block: b };
        land.set(q, 'air');
        return { dug: true, block: b };
      }
      return {};
    }) as GoalContext['call'],
    act: async (tool, a = {}) => {
      const p = at(a);
      me.acts.push(tool === 'take-from-chest' ? `${tool} ${a.count}` : ['go-home'].includes(tool) ? tool : `${tool} ${k(p)}`);
      // out of reach the tool walks there first, by Baritone's own way (it may place and break on the way)
      // (the bridge's place reaches 4.5 from the eye to the face it clicks: for cane, the top of the ground)
      const aim = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, eye = { x: me.pos.x + 0.5, y: me.pos.y + 1.62, z: me.pos.z + 0.5 };
      const far = tool === 'dig-block' ? reachOf(me.pos, p) > 4.5 : tool === 'place-block' && Math.hypot(eye.x - aim.x, eye.y - aim.y, eye.z - aim.z) > 4.5;
      if (far) me.baritone.push(`${tool} ${k(p)}`);
      if (tool === 'go-home') { me.pos = { ...HOME }; return { ok: true, text: 'Home' }; }
      if (tool === 'move-to-position') {
        if (opts.unreachable?.includes(k(p))) throw new Error(`Could not reach ${fmt(p)}: no path found`);
        me.pos = { ...p };
        return { ok: true, text: `Successfully moved to position near ${fmt(p)}` };
      }
      if (tool === 'take-from-chest') {
        const n = Math.min(Number(a.count), me.chest.sugar_cane ?? 0);
        me.chest.sugar_cane -= n;
        add('sugar_cane', n);
        return { ok: true, text: `Took ${n} sugar_cane from the chest at ${fmt(CHEST)}. It holds: ${me.chest.sugar_cane ? `sugar_cane x${me.chest.sugar_cane}` : 'nothing'}.` };
      }
      if (tool === 'place-block') {
        if (far) me.pos = { ...p };
        if (!count(String(a.item))) return { ok: true, text: `No ${a.item} in inventory to place` };
        if (land.name(p) !== 'air') return { ok: true, text: `There's already a block (${land.name(p)}) at ${fmt(p)}` };
        if (opts.refuse?.includes(k(p)) || !holdsCane(p)) return { ok: true, text: `Failed to place block at ${fmt(p)}: the server did not accept it` };
        land.set(p, 'sugar_cane[age=0]');
        take('sugar_cane', 1);
        return { ok: true, text: `Placed sugar_cane at ${fmt(p)} using down face` };
      }
      if (tool === 'dig-block') {
        if (far) me.pos = { ...p };
        const b = land.name(p);
        if (b === 'air') return { ok: true, text: `No block found at position ${fmt(p)}` };
        // as live: Baritone's dig of the scaffold in a cane cell by the water never broke it, and the tool's 60 s ran
        // out (2026-11-13, the same cells every round)
        const under = { ...p, y: p.y - 1 };
        if (b !== 'sugar_cane' && [p, under].some(q => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => land.name({ x: q.x + dx, y: q.y, z: q.z + dz }) === 'water'))) {
          throw new Error(`Could not dig ${b} at ${fmt(p)} (timeout).`);
        }
        // cane above a cut block has nothing to stand on: it comes down too, onto the ground under the base
        let n = 0;
        for (let y = p.y; b === 'sugar_cane' && land.name({ ...p, y }) === 'sugar_cane'; y++) { land.set({ ...p, y }, 'air'); n++; }
        if (b !== 'sugar_cane') land.set(p, 'air');
        if (n && a.collect === false) { me.lying.push({ at: { ...p, y: p.y - 1 }, n }); return { ok: true, text: `Dug ${b} at ${fmt(p)}` }; }
        // (picked up by the tool, which walks onto the drops by Baritone's way)
        if (n) { add('sugar_cane', n); me.baritone.push(`dig-block ${k(p)} (to the drops)`); }
        return { ok: true, text: `Dug ${b} at ${fmt(p)}${n ? `. Picked up sugar_cane x${n}` : ''}` };
      }
      return { ok: false, text: `no ${tool} here` };
    }
  };
  return { me, ctx, abort: () => ac.abort(), count };
}

const rung = (name: string): WorkTask => LADDER.find(t => t.name === name)!;
/** The ladder goal for one rung over a clock the test moves. */
const goalOf = (task: WorkTask, clock: { now: number }) => workGoals(() => undefined, [task], () => clock.now)[0];

/** Frozen all the way down: a write anywhere in it throws (the test files are modules, so strict). */
function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

// ---- the live and the dead cells ----

test('a cane cell is live with water beside its ground or cane standing in it, dead when all four sides are seen dry, and unknown otherwise', async (t) => {
  const land = liveLand();
  const call = (async (m: string, p: Record<string, unknown>) => (m === 'world.region' ? { blocks: land.region(p as unknown as Box) } : {})) as GoalContext['call'];
  // the five old cells: the lake has gone from beside them
  for (const c of DEAD) t.is(caneCellState(await lookAtCell({ call }, c)), 'dead', k(c));
  // a cell on the shore at the water's level, a block above the ground beside the water
  t.is(caneCellState(await lookAtCell({ call }, { x: -513, y: 57, z: 2199 })), 'live');
  // standing cane is the game's own word: it would have come off a cell with no water beside it
  stalk(land, DEAD[0], 2);
  t.is(caneCellState(await lookAtCell({ call }, DEAD[0])), 'live');
  // water at another level does not count, waterlogged blocks and kelp do
  const up = { x: -530, y: 63, z: 2190 };
  land.set({ x: -531, y: 63, z: 2190 }, 'water[level=0]');
  t.is(caneCellState(await lookAtCell({ call }, up)), 'dead', 'water beside the cane, not beside its ground');
  land.set({ x: -531, y: 62, z: 2190 }, 'oak_slab[type=bottom,waterlogged=true]');
  t.is(caneCellState(await lookAtCell({ call }, up)), 'live');
  // part of the ground not loaded: nothing is said of it
  const far = { x: -549 + 160, y: 63, z: 2183 };
  t.is(caneCellState(await lookAtCell({ call }, far)), 'unknown');
});

test('dead cells are dropped and the patch planted on the shore at the water\'s level', async (t) => {
  // live Nov 12: the five cells at y 63 east of the yard, bare, the lake sunk to y 56 round (-508, 2199); 5 cane
  // carried, 34 in the chest. The farm's water is nearer home, but it is the yard's: not a shore for cane
  const land = liveLand();
  const world = liveWorld();
  const b = botIn(land, world, [...KIT, { slot: 2, name: 'sugar_cane', count: 5 }], { refuse: ['-513,57,2197'] });
  const clock = { now: T0 };
  const text = await goalOf(rung('cane patch'), clock).run(b.ctx);
  t.is(b.me.said[0], 'dropped 5 dry cell(s) (no water beside them): -519,63,2202 -520,63,2203 -518,63,2204 -526,63,2205 -524,63,2205');
  const cells = world.zones!.cane!;
  // every cell on the shore round the lake, a block above the water's level, beside the water, every other one along it
  t.true(cells.length > 10, `${cells.length} cells`);
  t.true(cells.every(c => c.y === POND.y + 1 && land.name(c) === 'sugar_cane'), JSON.stringify(cells));
  t.true(cells.every(c => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => land.name({ x: c.x + dx, y: POND.y, z: c.z + dz }) === 'water')));
  t.true(cells.every(a => cells.every(c => a === c || Math.abs(a.x - c.x) + Math.abs(a.z - c.z) > 1)), 'a gap between plants');
  t.false(cells.some(c => DEAD.some(d => k(d) === k(c))), 'the dry cells are gone');
  // the cell the server would not take is left out; cane from the chest made up what was carried
  t.false(cells.some(c => k(c) === '-513,57,2197'));
  t.deepEqual(b.me.acts.filter(a => a.startsWith('take-from-chest')), [`take-from-chest ${cells.length + 1 - 5}`]);
  t.is(b.me.gain, cells.length);
  t.is(text, `[shore] dropped 5 dry cell(s); planted ${cells.length} cane on the shore by (-512, 56, 2195); 1 cell(s) would not take it (${cells.length} of ${CANE_CELLS} cells); back home`);
  // nothing dug, nothing placed at the old cells or in the yard; no water placed anywhere
  t.false(b.me.acts.some(a => a.startsWith('dig-block')));
  t.false(b.me.acts.some(a => /place-block/.test(a) && !/,57,/.test(a)));
  t.false(b.me.acts.some(a => /bucket|use-item/.test(a)));
  t.is(world.caneDry, undefined);
  // and the next run's gate counts them live: the patch is short of 24 by what the shore could not hold
  t.is(liveCells(world).length, cells.length);
});

test('the patch looks for the water nearest home, wherever in the yard the bot stands, and a full shore says it is full', async (t) => {
  // the seven-day replay of the Nov 12 homestead: the patch's first run came after the tree round, the bot at the tree
  // farm 46 north of home, 64 from the lake; the look went 64 round the bot, found "no open water within 64 blocks",
  // and the shore waited 20 min, then 40
  const land = liveLand();
  const world = liveWorld({ zones: { plot: [{ x: -545, y: 62, z: 2161, width: 9, length: 9 }] } });
  const b = botIn(land, world, [...KIT, { slot: 2, name: 'sugar_cane', count: 30 }]);
  const trees = { x: -539, y: 63, z: 2138 };
  b.me.pos = { ...trees };
  const ctx = { ...b.ctx, s: look(b.me.items, { position: { ...trees }, distHome: Math.round(horiz(trees, HOME)) }) };
  const first = await plantCane(ctx, 24);
  t.true(first.planted.length > 10, first.text);
  t.regex(first.text, /^planted \d+ cane on the shore by \(-512, 56, 2195\)$/);
  // the shore planted as far as it goes: the next look says so, not that there is no shore
  const again = await plantCane({ ...ctx, s: look(b.me.items) }, 24);
  t.deepEqual(again, { planted: [], refused: 0, text: `the shore round (-512, 56, 2195) is full (${first.planted.length} cell(s) of the patch on it, a gap beside each)`, full: true });
  // with no patch on it, a shore with no ground for cane is no shore
  const bare = new Land(() => 62);
  for (let x = -512; x <= -504; x++) for (let z = 2195; z <= 2203; z++) bare.set({ x, y: 62, z }, 'water[level=0]');
  for (let x = -513; x <= -503; x++) for (const z of [2194, 2204]) bare.set({ x, y: 62, z }, 'stone');
  for (let z = 2194; z <= 2204; z++) for (const x of [-513, -503]) bare.set({ x, y: 62, z }, 'stone');
  const c = botIn(bare, liveWorld({ zones: {} }), [...KIT, { slot: 2, name: 'sugar_cane', count: 30 }]);
  t.is((await plantCane(c.ctx, 24)).text, 'no shore to plant on round (-512, 62, 2195)');
});

test('the patch plants within the leash and away from anyone else\'s build; no shore is a fruitless run, marked dry', async (t) => {
  // a friend's build by the lake's south side: no cane within 16 blocks of it
  const land = liveLand();
  const world = liveWorld();
  const theirs: Zone = { x1: -510, y1: 56, z1: 2210, x2: -500, y2: 60, z2: 2214, surface: true };
  const b = botIn(land, world, [...KIT, { slot: 2, name: 'sugar_cane', count: 30 }], { zones: [theirs] });
  const r = await plantCane(b.ctx, 24);
  // only the lake's north shore is 16 or more from it (the build stands 6 south of the lake)
  t.deepEqual(r.planted.map(k), ['-512,57,2194', '-510,57,2194', '-508,57,2194', '-506,57,2194', '-504,57,2194']);
  // the leash cut short to 30: the lake is 41 out, past it
  const near = botIn(liveLand(), liveWorld({ leash: 30 }), [...KIT, { slot: 2, name: 'sugar_cane', count: 30 }]);
  t.deepEqual(await plantCane(near.ctx, 24), { planted: [], refused: 0, text: 'no open water within 30 blocks of home' });

  // a world with no open water but the farm's: the run plants nothing and its shore waits 20 min
  const dry = new Land(() => 62);
  dry.set({ x: -541, y: 62, z: 2165 }, 'water[level=0]');
  const w = liveWorld();
  const clock = { now: T0 };
  const c = botIn(dry, w, [...KIT, { slot: 2, name: 'sugar_cane', count: 5 }]);
  t.is(await goalOf(rung('cane patch'), clock).run(c.ctx), '[shore] dropped 5 dry cell(s); no open water within 64 blocks of home (0 of 24 cells)');
  t.deepEqual(workOf(w).dry, { 'cane patch:shore': { n: 1, at: T0 } });
  t.false(c.me.acts.some(a => a.startsWith('take-from-chest')), 'no cane taken out for a shore it did not find');
});

test('a bare cell of the patch is the round\'s to put back: the planting takes neither it nor a cell beside it, and lists no cell twice', async (t) => {
  // a cell whose cane has gone (broken, popped off) reads as open shore: it was planted again and listed twice, and
  // the patch counted cells it did not have
  const land = liveLand();
  const world = liveWorld({ zones: {} });
  const b = botIn(land, world, [...KIT, { slot: 2, name: 'sugar_cane', count: 30 }]);
  const first = await plantCane(b.ctx, 24);
  t.true(first.planted.length > 10, first.text);
  const gone = first.planted[3];
  land.set(gone, 'air');
  const again = await plantCane(b.ctx, 24);
  t.deepEqual(again.planted, []);
  t.true(again.full);
  const keys = world.zones!.cane!.map(k);
  t.is(new Set(keys).size, keys.length, 'no cell twice');
  t.deepEqual(keys, first.planted.map(k));
  t.is(land.name(gone), 'air', 'left for the round');
});

test('a full shore: the patch rung is unneeded until a cell is lost or a day has gone, and its mark is never let go early', async (t) => {
  // the live lake holds 20 cells, not 24: each try after the planting read every cell and the shore, planted nothing
  // and waited its mark, two tries a 160-min wait for as long as the bot lived (the 30 s release went to it)
  const land = liveLand();
  const world = liveWorld();
  const clock = { now: T0 };
  const task = rung('cane patch');
  const goal = goalOf(task, clock);
  const carry = [...KIT, { slot: 2, name: 'sugar_cane', count: 40 }];
  const planted = await goal.run(botIn(land, world, carry).ctx);
  const n = liveCells(world).length;
  t.regex(planted, new RegExp(`planted ${n} cane on the shore`));
  t.is(world.caneFull, undefined);
  t.is(await goal.run(botIn(land, world, carry).ctx), `[shore] the shore round (-512, 56, 2195) is full (${n} cell(s) of the patch on it, a gap beside each) (${n} of 24 cells)`);
  t.deepEqual(world.caneFull, { cells: n, at: T0 });
  const ask = (now: number) => { const c = pick(task, look(carry, { now }), world); return 'decline' in c ? `${c.decline.cause}: ${c.decline.text}` : `${c.variant}: ${c.why}`; };
  t.is(ask(T0 + 30 * MINUTE), `unneeded: the shore is full at ${n} cells`);
  t.is(releaseOldestDry(world, T0 + MINUTE, look(carry, { now: T0 + MINUTE }), [task]), undefined);
  // a day on, the shore is looked along again (the lake rises and sinks)
  t.regex(ask(T0 + 24 * 60 * MINUTE + 1), /^shore: \d+ blocks out/);
  // a cell noted dead by the round: one fewer than the shore was full at, and it wants again
  world.caneDry = { [k(world.zones!.cane![0])]: T0 };
  t.regex(ask(T0 + 30 * MINUTE), /^shore: \d+ blocks out/);
  // and a run that plants clears the note (the five old cells count until they are seen dry: full at 6, they are fewer)
  const w2 = liveWorld({ caneFull: { cells: 6, at: T0 - 60 * MINUTE } });
  t.regex(await goal.run(botIn(liveLand(), w2, carry).ctx), /planted \d+ cane on the shore/);
  t.is(w2.caneFull, undefined);
});

test('the patch\'s ready() is unneeded at 24 live cells and with no cane, and pure', (t) => {
  const task = rung('cane patch');
  const cells = (n: number) => Array.from({ length: n }, (_, i) => ({ x: -513, y: 57, z: 2195 + 2 * i }));
  const ask = (w: WorldMemory, items: InventoryItem[] = KIT) => { const c = pick(task, look(items), w); return 'decline' in c ? `${c.decline.cause}: ${c.decline.text}` : `${c.variant}: ${c.why}`; };
  const worlds = {
    live: liveWorld(),
    whole: liveWorld({ zones: { cane: cells(24) } }),
    // 24 cells, three of them seen with no water beside them by the round: 21 live, it wants
    marked: liveWorld({ zones: { cane: cells(24) }, caneDry: { '-513,57,2195': T0, '-513,57,2197': T0, '-513,57,2199': T0 } }),
    none: liveWorld({ chestItems: { [k(CHEST)]: { wheat: 64 } } }),
    unread: liveWorld({ chestItems: {} }),
    empty: liveWorld({ zones: {} })
  };
  for (const w of Object.values(worlds)) freeze(w);
  const before = JSON.stringify(worlds);
  // the five old cells are not known to be dry yet: they count, and the furthest is how far the run goes
  t.is(ask(worlds.live), 'shore: 37 blocks out');
  t.is(ask(worlds.whole), 'unneeded: 24 cells');
  t.is(ask(worlds.marked), 'shore: 68 blocks out');
  t.is(ask(worlds.none), 'unneeded: no cane to plant');
  t.is(ask(worlds.none, [...KIT, { slot: 2, name: 'sugar_cane', count: 1 }]), 'shore: 37 blocks out', 'one carried is cane to plant');
  t.is(ask(worlds.unread), 'unneeded: the chests are not all looked into yet');
  // no cell yet: open water is looked for within 64
  t.is(ask(worlds.empty), 'shore: 64 blocks out');
  // unneeded before anything that would keep it at home: full pockets do not lead its idle time
  const full = Array.from({ length: 36 }, (_, slot): InventoryItem => ({ slot, name: 'cobblestone', count: 64 }));
  t.is(ask(worlds.whole, full), 'unneeded: 24 cells');
  t.is(JSON.stringify(worlds), before);
});

// ---- the round ----

test('the cane round leaves dead cells alone: it cuts what grows, replants a live cell, and writes the dead one down', async (t) => {
  // live Nov 12: the round took cane from the chests to replant the five dry cells every 20 min, and cut nothing
  const land = liveLand();
  const grown = { x: -513, y: 57, z: 2199 }, bare = { x: -513, y: 57, z: 2197 }, dead = DEAD[0];
  stalk(land, grown, 3);
  const world = liveWorld({ zones: { cane: [dead, grown, bare] }, lastDone: {} });
  const b = botIn(land, world, KIT);
  const text = await caneRound.run({ ...b.ctx, s: { ...b.ctx.s, distHome: 0 } });
  t.is(text, 'cut 1 stalk(s) (2 cane), replanted 1; 1 cell(s) with no water beside them left alone');
  // one stalk from the chest for the one live bare cell; nothing walked to, taken or planted for the dead one
  t.deepEqual(b.me.acts, ['take-from-chest 1', 'dig-block -513,58,2199', 'place-block -513,57,2197']);
  t.is(land.name(grown), 'sugar_cane', 'the base stays');
  t.deepEqual(world.caneDry, { [k(dead)]: T0 });
  // the patch rung now counts it out, and its run drops it
  t.is(liveCells(world).length, 2);
  // a round with nothing but dead cells left does not want: nothing it could do
  const only = liveWorld({ zones: { cane: [dead] }, caneDry: { [k(dead)]: T0 }, lastDone: {} });
  t.deepEqual(caneRound.declines!(look(KIT), only), { cause: 'unneeded', text: 'no cane cell that can grow cane (1 with no water beside them: the cane patch drops them)' });
  // the water back beside it (the lake rises): the round sees it live again and the mark goes
  land.set({ x: dead.x + 1, y: 62, z: dead.z }, 'water[level=0]');
  const again = liveWorld({ zones: { cane: [dead] }, caneDry: { [k(dead)]: T0 }, lastDone: {} });
  await caneRound.run({ ...botIn(land, again, KIT).ctx });
  t.is(again.caneDry, undefined);
});

/**
 * The patch as brain.log had it on Nov 13: the six cells the round could not clear (cobblestone in each, dirt under
 * it, air above: the scaffold of a walk along the shore), and two with their cane grown 2 tall, at y 63 on the ground
 * by the yard's south-east corner, the water beside each cell's ground at y 62 (here: east of it).
 */
const FILLED: Pos[] = [{ x: -527, y: 63, z: 2210 }, { x: -523, y: 63, z: 2210 }, { x: -524, y: 63, z: 2211 }, { x: -522, y: 63, z: 2214 }, { x: -520, y: 63, z: 2212 }, { x: -519, y: 63, z: 2208 }];
const GROWN: Pos[] = [{ x: -520, y: 63, z: 2204 }, { x: -518, y: 63, z: 2206 }];
function filledLand(): Land {
  const land = new Land(() => 62);
  for (const c of [...FILLED, ...GROWN]) land.set({ x: c.x + 1, y: 62, z: c.z }, 'water[level=0]');
  for (const c of FILLED) { land.set(c, 'cobblestone'); land.set({ ...c, y: 62 }, 'dirt'); }
  for (const c of GROWN) stalk(land, c, 2);
  return land;
}
/** a walk onto water, or into (or onto) a cell of the patch */
const offLand = (land: Land, cells: Pos[], to: string) => {
  const [x, y, z] = to.split(',').map(Number);
  return land.name({ x, y: y - 1, z }) === 'water' || land.name({ x, y, z }) === 'water' || cells.some(c => c.x === x && c.z === z && y >= c.y && y <= c.y + 3);
};

test('the live filler cells: dug out by hand from a stand cell on the land beside them, never by Baritone\'s dig, and replanted', async (t) => {
  // live Nov 13: "cane cell -523,63,2210: cobblestone would not come out: Could not dig cobblestone at (-523, 63, 2210)
  // (timeout)", the same cells every round, 60 s each: some 4 min of a round's 6
  const land = filledLand();
  const cells = [...FILLED, ...GROWN];
  const world = liveWorld({ zones: { cane: cells.map(c => ({ ...c })) }, lastDone: {} });
  const b = botIn(land, world, [...KIT, { slot: 2, name: 'sugar_cane', count: 10 }]);
  const text = await caneRound.run(b.ctx);
  t.is(text, 'cut 2 stalk(s) (2 cane), replanted 6; cleared 6 cell(s) of scaffold; 0 skipped');
  // the filler with the direct dig, each from where the bot stood within reach; Baritone's dig only for the cut
  t.deepEqual(b.me.digs, FILLED.map(k));
  t.deepEqual(b.me.acts.filter(a => a.startsWith('dig-block')), GROWN.map(c => `dig-block ${c.x},${c.y + 1},${c.z}`));
  t.deepEqual(b.me.acts.filter(a => a.startsWith('place-block')), FILLED.map(c => `place-block ${k(c)}`));
  t.deepEqual(b.me.baritone, [], 'nothing done out of reach: no walk of Baritone\'s own');
  // the walks: careful, onto a stand cell on the land (never the water, never a cell of the patch)
  t.true(b.me.walks.length > 0);
  t.true(b.me.walks.every(w => w.careful && w.range === 0), JSON.stringify(b.me.walks));
  t.deepEqual(b.me.walks.filter(w => offLand(land, cells, w.to)), []);
  // only the filler came out: the cane in, its ground and the water as they were
  for (const c of FILLED) {
    t.is(land.name(c), 'sugar_cane', k(c));
    t.is(land.name({ ...c, y: 62 }), 'dirt');
    t.is(land.name({ x: c.x + 1, y: 62, z: c.z }), 'water');
  }
  for (const c of GROWN) t.is(land.name(c), 'sugar_cane', 'the base stays');
});

test('a cell whose filler cannot be got at on foot is left be for the rest of the day: said once, never dug by Baritone, and tried again the next day', async (t) => {
  // one cell on a spit of land out in the water, no stand cell within reach of it; one whose stand cells no careful
  // walk gets to (fenced off from the land side)
  const land = filledLand();
  const spit = { x: -520, y: 63, z: 2230 };
  for (let x = spit.x - 5; x <= spit.x + 5; x++) for (let z = spit.z - 5; z <= spit.z + 5; z++) if (x !== spit.x || z !== spit.z) land.set({ x, y: 62, z }, 'water[level=0]');
  land.set(spit, 'cobblestone');
  land.set({ ...spit, y: 62 }, 'dirt');
  const penned = FILLED[0];
  const fenced = (p: Pos) => horiz(p, penned) <= 5;
  const world = liveWorld({ zones: { cane: [{ ...spit }, { ...penned }] }, lastDone: {} });
  const carry = [...KIT, { slot: 2, name: 'sugar_cane', count: 10 }];
  const at = (now: number, opts: { noWay?: (p: Pos) => boolean } = {}) => {
    const b = botIn(land, world, carry, opts);
    return { b, ctx: { ...b.ctx, s: { ...b.ctx.s, now } } };
  };
  const first = at(T0, { noWay: fenced });
  t.is(await caneRound.run(first.ctx), 'cut 0 stalk(s) (0 cane); cleared 0 cell(s) of scaffold; 2 skipped');
  t.deepEqual(first.b.me.said, [
    'cane cell -520,63,2230: cobblestone not dug out (no stand cell in reach on foot): left be for today',
    'cane cell -527,63,2210: cobblestone not dug out (no way to a stand cell on foot): left be for today'
  ]);
  // no 60 s dig of Baritone's: three careful walks toward the fenced one, that got nowhere, and nothing more
  t.false(first.b.me.acts.some(a => a.startsWith('dig-block')));
  t.deepEqual(first.b.me.digs, []);
  t.is(first.b.me.walks.length, 3);
  t.true(first.b.me.walks.every(w => w.careful));
  t.deepEqual(world.caneSkip, { [k(spit)]: T0, [k(penned)]: T0 });
  // the next round the same day passes both by: no walk, no dig, no line
  const again = at(T0 + 30 * MINUTE, { noWay: fenced });
  t.is(await caneRound.run(again.ctx), 'cut 0 stalk(s) (0 cane); cleared 0 cell(s) of scaffold; 2 skipped');
  t.deepEqual([again.b.me.said, again.b.me.walks, again.b.me.digs, again.b.me.acts], [[], [], [], []]);
  t.deepEqual(world.caneSkip, { [k(spit)]: T0, [k(penned)]: T0 });
  // the next day (UTC) both are tried again: the fence is open now, and the spit is still out of reach (and a mark
  // for a cell no longer in the patch goes, today's or not)
  const tomorrow = Date.UTC(2026, 10, 13, 0, 5, 0);
  world.caneSkip![k({ x: -530, y: 63, z: 2212 })] = tomorrow;
  const next = at(tomorrow);
  t.is(await caneRound.run(next.ctx), 'cut 0 stalk(s) (0 cane), replanted 1; cleared 1 cell(s) of scaffold; 1 skipped');
  t.deepEqual(next.b.me.said, ['cane cell -520,63,2230: cobblestone not dug out (no stand cell in reach on foot): left be for today']);
  t.deepEqual(next.b.me.digs, [k(penned)]);
  t.is(land.name(penned), 'sugar_cane');
  t.deepEqual(world.caneSkip, { [k(spit)]: tomorrow });
});

test('the patch and the round walk the shore carefully, onto stand cells on the land, and plant and cut only from within reach', async (t) => {
  // live Nov 13 the scaffold came back between rounds: place-block's and dig-block's own walks, for a cell out of
  // reach, are Baritone's, which bridge along the shore
  const land = liveLand();
  const world = liveWorld();
  const patch = botIn(land, world, [...KIT, { slot: 2, name: 'sugar_cane', count: 30 }]);
  await goalOf(rung('cane patch'), { now: T0 }).run(patch.ctx);
  const cells = world.zones!.cane!;
  t.true(cells.length > 10, `${cells.length} cells`);
  t.deepEqual(patch.me.baritone, []);
  t.true(patch.me.walks.every(w => w.careful), JSON.stringify(patch.me.walks));
  t.deepEqual(patch.me.walks.filter(w => w.range === 0 && offLand(land, cells, w.to)), []);
  // grown: the round cuts every stalk, each from a stand cell beside its cell
  for (const c of cells) stalk(land, { ...c, y: c.y + 1 }, 1);
  const round = botIn(land, world, KIT);
  const cuts: number[] = [];
  const act = round.ctx.act;
  round.ctx.act = async (tool, a = {}) => {
    if (tool === 'dig-block') cuts.push(horiz(round.me.pos, { x: Number(a.x), z: Number(a.z) }));
    return act(tool, a);
  };
  t.is(await caneRound.run(round.ctx), `cut ${cells.length} stalk(s) (${cells.length} cane)`);
  t.deepEqual(round.me.baritone, []);
  t.true(round.me.walks.every(w => w.careful && w.range === 0), JSON.stringify(round.me.walks));
  t.deepEqual(round.me.walks.filter(w => offLand(land, cells, w.to)), []);
  t.true(cuts.every(d => d <= 1), JSON.stringify(cuts));
  t.true(cells.every(c => land.name(c) === 'sugar_cane'), 'the bases stay');
});

test('with the yard\'s gates known, the patch and the round go out to the shore by the east gate, its cell inside and then the one outside, and the walk home comes in by it: no walk over the fence', async (t) => {
  // the lake is east of the yard: Baritone's way to it from home was over the east fence, and its scaffold stood on
  // the posts there (Nov 13). Every walk is careful from the yard to the shore; home over the lake's slope, then
  // through the gate carefully (yardgates.ts)
  const gates = [{ x: -549, y: 63, z: 2119 }, { x: -533, y: 63, z: 2183 }, { x: -549, y: 63, z: 2215 }, { x: -565, y: 63, z: 2183 }];
  const land = liveLand();
  const world = liveWorld({ zones: { cane: DEAD.map(p => ({ ...p })), plot: [{ x: -545, y: 62, z: 2161, width: 9, length: 9 }], 'fence:gate': gates.map(g => ({ ...g })) } });
  const inside = (p: { x: number; z: number }) => p.x > YARD.x1 && p.x < YARD.x2 && p.z > YARD.z1 && p.z < YARD.z2;
  /** the walks that go from one side of the fence to the other, from where the walk before ended */
  const crossings = (walks: { to: string }[]) => walks.map(w => w.to.split(',').map(Number)).map(([x, , z]) => ({ x, z }))
    .flatMap((p, i, all) => (i > 0 && inside(all[i - 1]) !== inside(p) ? [`${all[i - 1].x},${all[i - 1].z} -> ${p.x},${p.z}`] : []));
  const patch = botIn(land, world, [...KIT, { slot: 2, name: 'sugar_cane', count: 30 }]);
  t.regex(await goalOf(rung('cane patch'), { now: T0 }).run(patch.ctx), /planted \d+ cane on the shore .*; back home$/);
  t.deepEqual(patch.me.walks.slice(0, 2), [{ to: '-535,63,2183', careful: true, range: 1 }, { to: '-531,63,2183', careful: true, range: 1 }]);
  t.deepEqual(patch.me.walks.slice(-2), [{ to: '-531,63,2183', careful: false, range: 1 }, { to: '-535,63,2183', careful: true, range: 1 }]);
  t.deepEqual(crossings([{ to: k(HOME) }, ...patch.me.walks]), ['-535,2183 -> -531,2183', '-531,2183 -> -535,2183']);
  t.deepEqual(patch.me.said.filter(l => /the yard by/.test(l)), ['out of the yard by its east gate (-533, 63, 2183)', 'into the yard by its east gate (-533, 63, 2183)']);
  t.is(patch.me.acts.at(-1), 'go-home');
  t.deepEqual(patch.me.baritone, []);
  // grown: the round goes out by the same gate (the walk home is the next goal's)
  const cells = world.zones!.cane!;
  for (const c of cells) stalk(land, { ...c, y: c.y + 1 }, 1);
  const round = botIn(land, world, KIT);
  t.is(await caneRound.run(round.ctx), `cut ${cells.length} stalk(s) (${cells.length} cane)`);
  t.deepEqual(round.me.walks.slice(0, 2), [{ to: '-535,63,2183', careful: true, range: 1 }, { to: '-531,63,2183', careful: true, range: 1 }]);
  t.deepEqual(crossings([{ to: k(HOME) }, ...round.me.walks]), ['-535,2183 -> -531,2183']);
  t.true(round.me.walks.slice(2).every(w => w.careful && w.range === 0), JSON.stringify(round.me.walks));
});

test('cane goes in only from where the bridge\'s place reaches it, wherever in its block the careful walk left the bot', async (t) => {
  // the place reaches 4.5 from the real eye to the top of the ground, and a walk ends on the block, not in its middle:
  // from the stand for the first cell, the second is 3.95 from the eye over that block's middle, 4.5 and more from
  // its far side, where place-block says "too far" and walks the rest by Baritone's way
  const land = new Land(() => 62);
  const cells: Pos[] = [{ x: -520, y: 63, z: 2230 }, { x: -518, y: 63, z: 2232 }];
  for (const c of cells) land.set({ x: c.x + 1, y: 62, z: c.z }, 'water[level=0]');
  const world = liveWorld({ zones: { cane: cells.map(c => ({ ...c })) }, lastDone: {} });
  const b = botIn(land, world, [...KIT, { slot: 2, name: 'sugar_cane', count: 10 }]);
  const from: number[] = [];
  const act = b.ctx.act;
  b.ctx.act = async (tool, a = {}) => {
    if (tool === 'place-block') from.push(Math.hypot(b.me.pos.x + 0.5 - (Number(a.x) + 0.5), b.me.pos.y + 1.62 - Number(a.y), b.me.pos.z + 0.5 - (Number(a.z) + 0.5)));
    return act(tool, a);
  };
  t.is(await caneRound.run(b.ctx), 'cut 0 stalk(s) (0 cane), replanted 2');
  t.is(from.length, 2);
  t.true(from.every(d => d + Math.SQRT1_2 <= 4.5), JSON.stringify(from));
  t.deepEqual(b.me.baritone, []);
  t.is(b.me.walks.length, 2, 'a careful walk to each');
  t.true(b.me.walks.every(w => w.careful));
});

test('a cut is made from beside the cell and no higher, and the cane picked up before the walk on', async (t) => {
  // the cane falls onto the cell's ground, and the game picks up a drop only down to half a block under the feet:
  // cut from the step above it, it lies there. Beside the cell the land is a block up on three sides (the water on
  // the fourth): the corners, level with it, are where the cut is made from
  const land = new Land(() => 62);
  const c = { x: -520, y: 63, z: 2230 };
  land.set({ x: c.x + 1, y: 62, z: c.z }, 'water[level=0]');
  for (const [dx, dz] of [[-1, 0], [0, -1], [0, 1]]) land.set({ x: c.x + dx, y: 63, z: c.z + dz }, 'dirt');
  stalk(land, c, 3);
  const world = liveWorld({ zones: { cane: [{ ...c }] }, lastDone: {} });
  const b = botIn(land, world, KIT);
  t.is(await caneRound.run(b.ctx), 'cut 1 stalk(s) (2 cane)');
  t.deepEqual(b.me.lying, [], 'none left lying');
  t.is(b.me.walks.length, 1);
  const [x, y, z] = b.me.walks[0].to.split(',').map(Number);
  t.true(Math.abs(x - c.x) === 1 && Math.abs(z - c.z) === 1 && y === c.y, b.me.walks[0].to);
  t.deepEqual(b.me.baritone, []);
  // a stalk on a spit, the water 3 out all round it: the nearest land is 4 off, out of sure reach (and the cane would
  // lie where it fell): not cut, and said
  const spit = new Land(() => 62);
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (dx || dz) spit.set({ x: c.x + dx, y: 62, z: c.z + dz }, 'water[level=0]');
  stalk(spit, c, 3);
  const far = botIn(spit, liveWorld({ zones: { cane: [{ ...c }] }, lastDone: {} }), KIT);
  t.is(await caneRound.run(far.ctx), 'cut 0 stalk(s) (0 cane); 1 cell(s) out of reach on foot');
  t.deepEqual([far.me.walks, far.me.acts], [[], []]);
  t.is(spit.name({ ...c, y: c.y + 2 }), 'sugar_cane');
});

test('only the filler comes out: a block put in a cell since the look, or while the bot walked to it, stays', async (t) => {
  // dig.here breaks whatever is there (bar a build the mod knows as someone's): the cell is read once more after the
  // walk, just before the dig
  const land = filledLand();
  const cells = [...FILLED, ...GROWN];
  const world = liveWorld({ zones: { cane: cells.map(c => ({ ...c })) }, lastDone: {} });
  const b = botIn(land, world, [...KIT, { slot: 2, name: 'sugar_cane', count: 10 }]);
  const [walked, looked] = [FILLED[1], FILLED[2]];
  let armed = false, swapped = false;
  const call = b.ctx.call;
  b.ctx.call = (async (method: string, p: Record<string, unknown> = {}, ms?: number) => {
    const view = method === 'world.region' && p.width === 9;
    // someone's planks in one cell after the round's first look, before its turn
    if (view && p.x === looked.x - 4 && p.z === looked.z - 4) land.set(looked, 'oak_planks');
    // and a chest in another while the bot walks to it
    if (view) armed = p.x === walked.x - 4 && p.z === walked.z - 4;
    if (method === 'dig.here') armed = false;
    if (method === 'goto' && armed) { land.set(walked, 'chest[facing=north]'); armed = false; swapped = true; }
    return call(method, p, ms);
  }) as GoalContext['call'];
  t.is(await caneRound.run(b.ctx), 'cut 2 stalk(s) (2 cane), replanted 4; cleared 4 cell(s) of scaffold; 1 skipped');
  t.true(swapped, 'the bot walked to the cell');
  t.deepEqual(b.me.said, [`cane cell ${k(walked)}: cobblestone not dug out (chest in it now): left be for today`]);
  t.is(land.name(walked), 'chest');
  t.is(land.name(looked), 'oak_planks');
  t.false(b.me.digs.includes(k(walked)) || b.me.digs.includes(k(looked)), JSON.stringify(b.me.digs));
  t.false(b.me.acts.some(a => a === `place-block ${k(walked)}` || a === `place-block ${k(looked)}`));
  t.deepEqual(Object.keys(world.caneSkip ?? {}), [k(walked)]);
});

test('filler that holds back water beside the cell stays in, and the cell is dropped from the patch for the patch to plant another', async (t) => {
  // dug out, the water beside it would run into the cell and on over the shore; and left be a day at a time, the cell
  // counted as live for good, so the patch rung never planted one in its place
  const land = filledLand();
  const cells = [...FILLED, ...GROWN];
  const c = FILLED[1];
  const water = { x: c.x + 1, y: 63, z: c.z };
  land.set(water, 'water[level=0]');
  const world = liveWorld({ zones: { cane: cells.map(q => ({ ...q })) }, lastDone: {} });
  const b = botIn(land, world, [...KIT, { slot: 2, name: 'sugar_cane', count: 10 }]);
  t.is(await caneRound.run(b.ctx), 'cut 2 stalk(s) (2 cane), replanted 5; cleared 5 cell(s) of scaffold; 1 skipped');
  t.deepEqual(b.me.said, [`cane cell ${k(c)}: cobblestone left in (water beside it would run in): dropped from the patch`]);
  t.false(b.me.digs.includes(k(c)));
  t.is(land.name(c), 'cobblestone');
  t.is(land.name(water), 'water');
  t.false(world.zones!.cane!.some(q => k(q) === k(c)));
  t.is(liveCells(world).length, cells.length - 1, 'one cell fewer: the patch rung plants another');
  t.is(world.caneSkip, undefined);
});

// ---- wild cane ----

/** A stand of wild cane by a stream 70 east of home (three stalks: 3, 2 and 1 tall), and the bot's own patch on the lake shore. */
function wildLand(): { land: Land; stand: Pos; patch: Pos[] } {
  const land = liveLand();
  for (let z = 2181; z <= 2187; z++) land.set({ x: -478, y: 62, z }, 'water[level=0]');
  stalk(land, { x: -479, y: 63, z: 2182 }, 3);
  stalk(land, { x: -479, y: 63, z: 2184 }, 2);
  stalk(land, { x: -479, y: 63, z: 2186 }, 1);
  const patch = [{ x: -513, y: 57, z: 2195 }, { x: -513, y: 57, z: 2197 }, { x: -513, y: 57, z: 2199 }];
  for (const c of patch) stalk(land, c, 2);
  return { land, stand: { x: -479, y: 63, z: 2182 }, patch };
}

test('the cane rung: a side that finds cane cuts it from the second block up, leaves the bases, and records the stand', async (t) => {
  const { land, patch } = wildLand();
  const world = liveWorld({ zones: { cane: patch } });
  const clock = { now: T0 };
  const goal = goalOf(rung('cane'), clock);
  t.is(goal.wants(look(KIT), world), 'north: 96 blocks out');
  // east first (the side a test wants: the queue's turn is the memory's)
  workOf(world).next.cane = 1;
  const b = botIn(land, world, KIT);
  const text = await goal.run(b.ctx);
  t.is(text, '[east] found wild cane east, 70 blocks from home: +3 sugar_cane at (-479, 63, 2182) (cut 2 stalk(s) above the base, 3 base(s) left to grow); back home');
  // its own patch on the lake shore, nearer home, is not wild cane: the stand by the stream is what it went to
  t.deepEqual(b.me.acts, ['move-to-position -479,63,2182', 'dig-block -479,64,2182', 'dig-block -479,64,2184', 'go-home']);
  t.true(patch.every(c => land.name(c) === 'sugar_cane' && land.name({ ...c, y: c.y + 1 }) === 'sugar_cane'), 'the patch untouched');
  for (const z of [2182, 2184, 2186]) t.is(land.name({ x: -479, y: 63, z }), 'sugar_cane', `the base at z ${z} stays`);
  t.deepEqual(sitesOf(world, 'cane'), [{ x: -479, y: 63, z: 2182 }]);
  t.is(b.me.said.find(l => l.startsWith('wild cane')), 'wild cane east at (-479, 63, 2182), 70 blocks from home');
  // out to the leash and no further: one leg, the stand in sight from 32 out
  t.true(b.me.gotos.every(g => horiz(g, HOME) <= 96 - 16));
  t.deepEqual(workOf(world).dry, {});

  // the stand first next time; grown back by one, it is cut again, the base left
  stalk(land, { x: -479, y: 64, z: 2186 }, 1);
  // (ahead of the sides' turn; after the deep trip today, as an unblocker already tried today without one is)
  t.is(goal.wants(look(KIT), world), 'stand -479,2182: 70 blocks out (one such trip today already: the deep trip first)');
  const again = botIn(land, world, KIT);
  t.is(await goal.run(again.ctx), '[stand -479,2182] +1 sugar_cane at (-479, 63, 2182) (cut 1 stalk(s) above the base, 3 base(s) left to grow); back home');
  t.deepEqual(again.me.acts, ['move-to-position -479,63,2182', 'dig-block -479,64,2186', 'go-home']);
  // nothing grown since: no cane, the stand waits (a dry mark), and it is kept
  const bare = botIn(land, world, KIT);
  workOf(world).next.cane = 0;
  t.is(await goal.run(bare.ctx), '[stand -479,2182] no cane picked up at (-479, 63, 2182) (none grown back yet: 3 base(s) left to grow); back home');
  t.is(workOf(world).dry['cane:stand -479,2182'].n, 1);
  t.is(sitesOf(world, 'cane').length, 1);
  // all of it gone (dug out by someone): the stand is forgotten, and its mark with it (its key names a place no
  // longer kept: it stayed in brain.json for good)
  for (const z of [2182, 2184, 2186]) land.set({ x: -479, y: 63, z }, 'air');
  workOf(world).dry = { 'cane:stand -479,2182': { n: 1, at: T0 - 30 * MINUTE } };
  workOf(world).next.cane = 0;
  t.is(await goal.run(botIn(land, world, KIT).ctx), '[stand -479,2182] no cane at (-479, 63, 2182) any more: forgotten; back home');
  t.deepEqual(sitesOf(world, 'cane'), []);
  t.deepEqual(workOf(world).dry, {});
});

test('the cane rung: a remembered stand it cannot get to waits a dry mark and the sides have their turns; a side the run\'s time cut short keeps its count', async (t) => {
  // held back as a failure (untried), the stand was chosen first again every time and the sides never ran
  const { land, patch } = wildLand();
  const world = liveWorld({ zones: { cane: patch } });
  workOf(world).sites.cane = [{ x: -479, y: 63, z: 2182 }];
  const clock = { now: T0 };
  const goal = goalOf(rung('cane'), clock);
  t.is(goal.wants(look(KIT), world), 'stand -479,2182: 70 blocks out');
  const b = botIn(land, world, KIT, { unreachable: ['-479,63,2182'] });
  t.is(await goal.run(b.ctx), '[stand -479,2182] could not reach the stand at (-479, 63, 2182): Could not reach (-479, 63, 2182): no path found');
  t.deepEqual(workOf(world).dry['cane:stand -479,2182'], { n: 1, at: T0 });
  t.deepEqual(sitesOf(world, 'cane'), [{ x: -479, y: 63, z: 2182 }]);
  t.is(goal.wants(look(KIT), world), 'north: 96 blocks out (one such trip today already: the deep trip first)');
  // the run's time out at the first stop out: not "none within the leash", and the side's count stays
  let tick = T0;
  t.deepEqual(await rung('cane').run(botIn(land, liveWorld({ zones: { cane: patch } }), KIT).ctx, 'south', 0, () => tick++),
    { gain: 0, text: 'no wild cane seen south from home: the run\'s time ran out', mark: 'same' });
});

test('the cane rung looks along a side from outside the yard: out by its gate, no stop inside the fence; with its gate shut, no other gate, and a dry side', async (t) => {
  const { land, patch } = wildLand();
  const gates = [{ x: -549, y: 63, z: 2119 }, { x: -533, y: 63, z: 2183 }, { x: -549, y: 63, z: 2215 }, { x: -565, y: 63, z: 2183 }];
  const world = () => liveWorld({ zones: { cane: patch, 'fence:gate': gates.map(g => ({ ...g })) } });
  // north: 32 out is inside the yard and 64 out the north gate: out through it (careful, to its cells), then 80 out
  const b = botIn(land, world(), KIT);
  const careful: boolean[] = [];
  const call = b.ctx.call;
  b.ctx.call = (async (method: string, p: Record<string, unknown> = {}, ms?: number) => {
    if (method === 'goto') careful.push(!!p.careful && !p.xz);
    return call(method, p, ms);
  }) as GoalContext['call'];
  t.deepEqual(await rung('cane').run(b.ctx, 'north', 6 * MINUTE, () => T0), { gain: 0, text: 'no wild cane north within the leash (96 from home)' });
  t.deepEqual(b.me.gotos.map(g => `${g.x},${g.z}`), ['-549,2121', '-549,2117', '-549,2103']);
  t.deepEqual(careful, [true, true, false]);
  // every gate shut to it (a walk to the cell outside one stops inside): out by its own side's gate or not at all
  // (from another side's, the walk to "any height" at the stop goes round the fence or back across the yard), and
  // nothing looked at out there: a side with none for the wrapper's mark, not a held failure that comes back to it
  const shut = botIn(land, world(), KIT);
  const inner = shut.ctx.call;
  shut.ctx.call = (async (method: string, p: Record<string, unknown> = {}, ms?: number) =>
    (method === 'goto' && !p.xz && gates.some(g => Math.hypot(g.x - Number(p.x), g.z - Number(p.z)) <= 2.1 && (Number(p.x) < YARD.x1 || Number(p.x) > YARD.x2 || Number(p.z) < YARD.z1 || Number(p.z) > YARD.z2))
      ? { arrived: false } : inner(method, p, ms))) as GoalContext['call'];
  t.deepEqual(await rung('cane').run(shut.ctx, 'north', 6 * MINUTE, () => T0), { gain: 0, text: 'no wild cane looked for north: no way out of the yard by the north gate (-549, 63, 2119)' });
  t.deepEqual(shut.me.gotos.map(g => `${g.x},${g.z}`), ['-549,2121']);
  t.false(shut.me.gotos.some(g => g.z <= 2103));
});

test('the cane rung: wild cane by someone\'s build or past the leash is not the bot\'s; a side with none is a terrain mark that goes on doubling', async (t) => {
  const { land } = wildLand();
  // a friend's house 10 from the stand: it is theirs
  const theirs: Zone = { x1: -470, y1: 62, z1: 2180, x2: -466, y2: 66, z2: 2185, surface: true };
  const { patch } = wildLand();
  const world = liveWorld({ zones: { cane: patch } });
  const clock = { now: T0 };
  const goal = goalOf(rung('cane'), clock);
  workOf(world).next.cane = 1;
  const b = botIn(land, world, KIT, { zones: [theirs] });
  t.is(await goal.run(b.ctx), '[east] no wild cane east within the leash (96 from home); back home');
  t.false(b.me.acts.some(a => a.startsWith('dig-block')));
  t.deepEqual(sitesOf(world, 'cane'), []);
  // the legs out: 32, 64 and 80 east of home, none past the leash
  t.deepEqual(b.me.gotos.map(g => Math.round(horiz(g, HOME))), [32, 64, 80]);

  // the stand 105 out instead: seen from the last leg, past the leash, left alone
  const far = new Land();
  for (let z = 2181; z <= 2187; z++) far.set({ x: -443, y: 62, z }, 'water[level=0]');
  stalk(far, { x: -444, y: 63, z: 2183 }, 3);
  const w2 = liveWorld();
  workOf(w2).next.cane = 1;
  t.is(await goal.run(botIn(far, w2, KIT).ctx), '[east] no wild cane east within the leash (96 from home); back home');

  // the side's mark: a terrain mark, 20 min after the first dry run, and past 160 min it goes on doubling
  t.deepEqual(workOf(w2).dry['cane:east'], { n: 1, at: T0 });
  t.is(dryUntil(w2, 'cane:east'), T0 + DRY_WAIT[0]);
  workOf(w2).dry['cane:east'] = { n: 4, at: T0 - 200 * MINUTE };
  workOf(w2).next.cane = 1;
  clock.now = T0;
  t.is(goal.wants(look(KIT), w2), 'east: 96 blocks out, 4 dry before (dry 4 times: after the deep trip)');
  await goal.run(botIn(far, w2, KIT).ctx);
  t.deepEqual(workOf(w2).dry['cane:east'], { n: 5, at: T0 });
  t.is(dryUntil(w2, 'cane:east') - T0, 320 * MINUTE);
  workOf(w2).dry['cane:east'] = { n: 6, at: T0 };
  t.is(dryUntil(w2, 'cane:east') - T0, 640 * MINUTE);
});

test('the cane rung is unneeded while a live patch of 12+ grows it, and when no cane is short', (t) => {
  const task = rung('cane');
  const cells = (n: number) => Array.from({ length: n }, (_, i) => ({ x: -513, y: 57, z: 2195 + 2 * i }));
  const ask = (w: WorldMemory, items: InventoryItem[] = KIT) => { const c = pick(task, look(items), w); return 'decline' in c ? `${c.decline.cause}: ${c.decline.text}` : `${c.variant}: ${c.why}`; };
  const worlds = {
    // short of 135 - 34 = 101: the five old cells grow nothing, and are fewer than 12 anyway
    live: liveWorld(),
    grows: liveWorld({ zones: { cane: cells(12) } }),
    // 12 cells, but the round saw one of them dry: 11 live, the patch is too small to wait on
    marked: liveWorld({ zones: { cane: cells(12) }, caneDry: { '-513,57,2195': T0 } }),
    met: liveWorld({ chestItems: { [k(CHEST)]: { sugar_cane: 135 } } }),
    free: liveWorld({ progress: { done: ['cane'], journal: [] } }),
    // (a chest not looked into may hold the bill: a half-read list shows the cane short)
    unread: liveWorld({ chestItems: {} }),
    // a stand found before, 70 out, and one past the leash (an older find under a longer leash)
    stands: liveWorld({ work: { dry: {}, next: {}, sites: { cane: [{ x: -479, y: 63, z: 2182 }, { x: -440, y: 63, z: 2183 }] }, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } } })
  };
  for (const w of Object.values(worlds)) freeze(w);
  const before = JSON.stringify(worlds);
  t.is(ask(worlds.live), 'north: 96 blocks out');
  t.is(ask(worlds.grows), 'unneeded: the patch grows it (12 cells)');
  t.is(ask(worlds.marked), 'north: 96 blocks out');
  t.is(ask(worlds.met), 'unneeded: the project has its sugar_cane');
  // what is carried counts too: 34 stored and 101 carried
  t.is(ask(worlds.live, [...KIT, { slot: 2, name: 'sugar_cane', count: 64 }, { slot: 3, name: 'sugar_cane', count: 37 }]), 'unneeded: the project has its sugar_cane');
  t.is(ask(worlds.free), 'unneeded: the project is not waiting on sugar_cane');
  t.is(ask(worlds.unread), 'unneeded: the chests are not all looked into yet');
  // the stand within the leash first, then the four sides; the one past the leash is not offered
  const stands = task.variants(look(KIT), worlds.stands).map(v => `${v.id} ${v.dist}`);
  t.deepEqual(stands, ['stand -479,2182 70', 'north 96', 'east 96', 'south 96', 'west 96']);
  t.is(JSON.stringify(worlds), before);
});

// ---- the log ----

const settle = () => new Promise(r => setTimeout(r, 20));

/** A brain over the stand-in world with only the given rungs, in the world `seed:1`; `said` is its log without the times. */
function brainIn(land: Land, world: WorldMemory, items: InventoryItem[], tasks: WorkTask[], zones: Zone[] = []) {
  const b = botIn(land, world, items, { zones });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canework-'));
  const file = path.join(dir, 'brain.json');
  const logFile = path.join(dir, 'brain.log');
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': world }));
  const reply = (r: { ok: boolean; text: string }) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) });
  const actions = Object.fromEntries(['go-home', 'move-to-position', 'take-from-chest', 'place-block', 'dig-block'].map(tool => [tool, async (a: Record<string, unknown>) => reply(await b.ctx.act(tool, a))]));
  const rt = {
    actions,
    call: (async (method: string, p?: Record<string, unknown>) => b.ctx.call(method, p)) as ClientRuntime['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...b.me.pos }, block: { ...b.me.pos }, timeOfDay: 1000, hashedSeed: '1',
      dimension: 'overworld', sleeping: false, thundering: false, process: null, health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: 'overworld' }),
    lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const goals: Goal[] = workGoals(() => undefined, tasks, () => T0);
  const brain = new Brain(rt, { tickMs: 1e9, now: () => T0, goals, logFile, memoryFile: file });
  brain.setEnabled(true);
  return {
    brain, me: b.me,
    tick: async () => { await brain.tick(); await settle(); await settle(); },
    said: () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => l.slice(25)).filter(l => !/^(autonomy|landmarks:|idle )/.test(l)),
    off: async () => { brain.setEnabled(false); await settle(); }
  };
}

test.serial('done work: cane patch and done work: cane, as brain.log says them', async (t) => {
  // the patch: the five old cells dropped, the lake shore planted
  const p = brainIn(liveLand(), liveWorld(), [...KIT, { slot: 2, name: 'sugar_cane', count: 5 }], [rung('cane patch')]);
  await p.tick();
  const patch = p.said();
  const planted = /planted (\d+) cane/.exec(patch.find(l => l.startsWith('done ')) ?? '')?.[1];
  t.deepEqual(patch, [
    'start work: cane patch: shore: 37 blocks out',
    'work: cane patch: dropped 5 dry cell(s) (no water beside them): -519,63,2202 -520,63,2203 -518,63,2204 -526,63,2205 -524,63,2205',
    `done work: cane patch in 0s: [shore] dropped 5 dry cell(s); planted ${planted} cane on the shore by (-512, 56, 2195) (${planted} of 24 cells); back home`
  ]);
  t.true(Number(planted) > 10);
  await p.off();

  // wild cane: east, the patch above it small (none live), the rungs above say why they did not run instead
  const { land } = wildLand();
  const w = liveWorld({ zones: { cane: wildLand().patch }, chestItems: { [k(CHEST)]: { wheat: 64 } } });
  w.work = { dry: {}, next: { cane: 1 }, sites: {}, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } };
  const c = brainIn(land, w, KIT, [rung('cane patch'), rung('cane')]);
  await c.tick();
  t.deepEqual(c.said(), [
    'start work: cane: east: 96 blocks out',
    'work: cane: skipped: cane patch (unneeded: no cane to plant)',
    'work: cane: looking east for wild cane, 32 blocks out',
    'work: cane: wild cane east at (-479, 63, 2182), 70 blocks from home',
    'done work: cane in 0s: [east] found wild cane east, 70 blocks from home: +3 sugar_cane at (-479, 63, 2182) (cut 2 stalk(s) above the base, 3 base(s) left to grow); back home'
  ]);
  await c.off();
});
