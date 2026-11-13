import { fromGate, nearHome, no, outsideBy, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Milestone, StepResult } from './progress.js';
import type { Pos, WorldMemory } from './memory.js';
import { addZone } from './milestones.js';
import { key, takeFromChests } from './chests.js';
import { toTheWoods, WOODS_DIRS } from './chores.js';
import { makeRoom, noRoom, room } from './pockets.js';
import { WILD_DISTANCE, YARD_FROM_BUILDS, nearestZone, type Zone } from './courtesy.js';
import { alongSide } from './work.js';

/**
 * Sugar cane on the lake shore (paper for books, books for the enchanting table and its shelves): a few stalks from
 * the wild, planted on the land cells right beside the water, and a daily round that cuts the top two blocks and
 * leaves the base to grow again.
 */

const MINUTE = 60_000;
const CANE_ON = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|sand|red_sand|mud|moss_block)$/;
const AIRY = /^(air|short_grass|tall_grass|fern|leaf_litter|dandelion|poppy|bush)$/;
const name = (b: string | null | undefined) => (b ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
const ok = (text: string): StepResult => ({ status: 'done', text });
const blocked = (text: string, retryMs = 30 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const SIDES4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/**
 * Shore cells for cane in a region read 3 high from the water's level (layer 0: the ground the cane stands on and the
 * water beside it; layers 1 and 2: open air for the cane): ground cane grows on, with water right next to it on some
 * side and air above. Returns the cells the cane goes in (a block above the ground), every other one along the shore,
 * and none right beside cane already standing (a patch planted on an earlier run keeps its gaps). `may` leaves out the
 * cells the bot may not plant on (past the leash, on a build).
 */
export function shoreCells(box: { x: number; y: number; z: number; width: number; height: number; length: number },
  blocks: (string | null)[], max: number, may: (p: Pos) => boolean = () => true): Pos[] {
  const { width: w, length: l } = box;
  const at = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= w || z >= l || y < 0 || y >= box.height ? '' : name(blocks[x + z * w + y * w * l]));
  const out: Pos[] = [];
  const taken = new Set<string>();
  for (let z = 0; z < l && out.length < max; z++) for (let x = 0; x < w && out.length < max; x++) {
    if (!CANE_ON.test(at(x, 0, z)) || !AIRY.test(at(x, 1, z)) || !AIRY.test(at(x, 2, z))) continue;
    if (!SIDES4.some(([dx, dz]) => at(x + dx, 0, z + dz) === 'water')) continue;
    // a gap between plants, so each can be cut without stepping on the next
    if (SIDES4.some(([dx, dz]) => taken.has(`${x + dx},${z + dz}`) || at(x + dx, 1, z + dz) === 'sugar_cane')) continue;
    const cell = { x: box.x + x, y: box.y + 1, z: box.z + z };
    if (!may(cell)) continue;
    taken.add(`${x},${z}`);
    out.push(cell);
  }
  return out;
}

const caneCount = async (ctx: Pick<GoalContext, 'call'>) =>
  (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items
    .filter(i => i.slot < 36 && i.name === 'sugar_cane').reduce((a, i) => a + i.count, 0);

// ------------------------------------------------------------------------------------------------ live and dead cells

/**
 * What gives cane its water: the game asks for water beside the block the cane stands on (still or flowing, or a block
 * water stands in: kelp, seagrass, a bubble column, anything waterlogged), or frosted ice.
 */
const WET = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass|frosted_ice)$/;
export const wet = (b: string | null | undefined): boolean => !!b && (WET.test(name(b)) || /waterlogged=true/.test(b));

/**
 * A cane cell as the game shows it now: its block (`base`, the cane's bottom block when it stands), the one above, and
 * whether the ground it stands on has water beside it (undefined: some of that ground is not loaded, or was not read).
 */
export interface CaneLook { base: string; mid: string; wet?: boolean }

/**
 * Read a cane cell: the cell and the two blocks above it, and the ground round the block it stands on (its four sides
 * at the ground's level, where the water must be). A part the game has not loaded reads as null, and says nothing.
 */
export async function lookAtCell(ctx: Pick<GoalContext, 'call'>, c: Pos): Promise<CaneLook> {
  const col = (await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...c, width: 1, height: 3, length: 1 })).blocks.map(name);
  const ring = (await ctx.call<{ blocks?: (string | null)[] }>('world.region', { x: c.x - 1, y: c.y - 1, z: c.z - 1, width: 3, height: 1, length: 3 })
    .catch(() => ({ blocks: [] as (string | null)[] }))).blocks ?? [];
  // the four sides of the ground block in a 3 x 1 x 3 read (x fastest, then z): north, west, east, south
  const sides = [1, 3, 5, 7].map(i => ring[i]);
  const water = sides.some(wet) ? true : sides.every(b => typeof b === 'string') ? false : undefined;
  return { base: col[0] ?? '', mid: col[1] ?? '', wet: water };
}

/**
 * Whether a cell can grow cane. Live: cane stands in it (the game takes cane off at once where it has no water beside
 * it, so standing cane is the proof), or water lies beside its ground. Dead: all four sides of its ground loaded and
 * none wet. Unknown otherwise: a cell is never written off on a read that did not see all of it.
 */
export function caneCellState(look: CaneLook): 'live' | 'dead' | 'unknown' {
  if (look.base === 'sugar_cane' || look.wet === true) return 'live';
  return look.wet === false ? 'dead' : 'unknown';
}

/** The patch's cells that can grow cane, as far as the bot knows: every cell but the ones last seen with no water beside them. */
export const liveCells = (world: WorldMemory): Pos[] => (world.zones?.cane ?? []).filter(c => world.caneDry?.[key(c)] === undefined);

/** Write down what a look at a cell found: a dead cell is marked (the patch rung drops it), a live one unmarked. */
function noteCell(world: WorldMemory, c: Pos, state: 'live' | 'dead' | 'unknown', now: number): void {
  if (state === 'dead') (world.caneDry ??= {})[key(c)] = now;
  else if (state === 'live' && world.caneDry?.[key(c)] !== undefined) {
    delete world.caneDry[key(c)];
    if (!Object.keys(world.caneDry).length) delete world.caneDry;
  }
}

/**
 * Look at every cell of the patch and take out the dead ones (no water beside their ground: by Nov 12 the lake had
 * sunk from beside the five first cells, at y 63, to y 55-56, and the round cut nothing 77 times in 100). A cell the
 * read did not see whole stays. Returns the cells dropped.
 */
export async function dropDeadCells(ctx: Pick<GoalContext, 'call' | 'world' | 'signal'>, now: number): Promise<Pos[]> {
  const cells = ctx.world.zones?.cane ?? [];
  const dead: Pos[] = [];
  for (const c of cells) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const state = caneCellState(await lookAtCell(ctx, c));
    noteCell(ctx.world, c, state, now);
    if (state === 'dead') dead.push(c);
  }
  if (dead.length) {
    ctx.world.zones!.cane = cells.filter(c => !dead.includes(c));
    for (const c of dead) delete ctx.world.caneDry?.[key(c)];
  }
  // (a mark of a cell no longer in the patch says nothing)
  const marks = ctx.world.caneDry;
  if (marks) {
    const inPatch = new Set((ctx.world.zones?.cane ?? []).map(key));
    for (const k of Object.keys(marks)) if (!inPatch.has(k)) delete marks[k];
    if (!Object.keys(marks).length) delete ctx.world.caneDry;
  }
  return dead;
}

// ------------------------------------------------------------------------------------------------ planting

/** How near the bot's own land may come to someone's build (as its yard): no cane is planted closer to one. */
const PLANT_FROM_BUILDS = YARD_FROM_BUILDS;
/** The shore round one water block that is read at a time (as the cane milestone always read it), blocks each way. */
const SHORE_REACH = 12;
/** How far from home open water is looked for: as far as the walk to the patch may be. */
export const WATER_FROM_HOME = 64;
/** How many places along the water are looked at in one go. */
const SHORES = 4;

/** the bot's own builds with a box (the plot, the pens, the storage house, the trees; not the fence, which is the whole yard) and the site the project keeps */
function ownBoxes(world: WorldMemory): { x: number; z: number; width: number; length: number }[] {
  const boxes = Object.entries(world.zones ?? {}).filter(([k]) => k !== 'fence').flatMap(([, zs]) => zs)
    .flatMap(b => (b.width && b.length ? [{ x: b.x, z: b.z, width: b.width, length: b.length }] : []));
  const site = world.progress?.current?.data?.site as { x: number; z: number; width?: number; length?: number } | undefined;
  if (site?.width && site.length) boxes.push({ x: site.x, z: site.z, width: site.width, length: site.length });
  return boxes;
}
const inBox = (p: { x: number; z: number }, b: { x: number; z: number; width: number; length: number }, margin: number) =>
  p.x >= b.x - margin && p.x < b.x + b.width + margin && p.z >= b.z - margin && p.z < b.z + b.length + margin;

/**
 * What a planting run did: the cells it planted, how many would not take the cane, the water it planted by, and in
 * words. `full`: the shore it looked along is the patch's already, a cell or a gap beside one wherever cane can stand.
 */
export interface Planting { planted: Pos[]; refused: number; lake?: Pos; text: string; full?: true }

/**
 * Plant cane on the shore round the open water nearest home: up to `max` cells, every other one along the water, at
 * the water's level (the lake may lie well below the yard: on Nov 12 it stood at y 56 and the yard at 62). Open water
 * is looked for within 64 blocks of home, wherever in the yard the bot stands; the yard's own water (the farm's) is
 * left out, as is water under a roof, as the bucket step leaves them out. Every cell is within the leash, off the bot's own builds and the project's site, and away from
 * anyone else's. Cane comes from the chests first when too little is carried, and only once there are cells for it;
 * each cell that takes it goes into `zones.cane`, and a cell that will not take it is left out. `enough` ends the
 * planting early (the run's time is up). Counts each cell planted as gain.
 */
export async function plantCane(ctx: GoalContext, max: number, enough: () => boolean = () => false): Promise<Planting> {
  if (max <= 0) return { planted: [], refused: 0, text: 'no cell wanted' };
  const home = ctx.s.home;
  const yard = ctx.world.yard;
  // the client looks round the bot, and the yard is 97 long: from the tree farm, 46 north of home, the lake 39 east of
  // home is 64 off, and a look 64 round the bot found "no open water within 64 blocks" (the seven-day replay of the
  // Nov 12 homestead: the patch's first run came after the tree round). So the look goes as much further as the bot
  // stands from home, and keeps the water within 64 of home, the nearest to home first
  const reach = Math.min(WATER_FROM_HOME, ctx.world.leash);
  const off = home ? Math.ceil(horiz(ctx.s.position, home)) + 16 : 0;
  const water = (await ctx.call<{ positions: Pos[] }>('world.findBlocks', { block: 'water', maxDistance: Math.min(128, WATER_FROM_HOME + off), count: 256, openAbove: true })).positions
    .filter(w => (!yard || outsideBy(yard, w) > 2) && (!home || horiz(w, home) <= reach))
    .sort((a, b) => (home ? horiz(a, home) - horiz(b, home) : 0));
  if (!water.length) return { planted: [], refused: 0, text: `no open water within ${reach} blocks of home` };
  const zones = (await ctx.call<{ zones?: Zone[] }>('foreign.zones').catch(() => undefined))?.zones ?? [];
  const own = ownBoxes(ctx.world);
  // not on a cell of the patch or right beside one: a cell whose cane has gone (broken, popped off) reads as open
  // shore, and was planted again and listed twice, so the patch counted cells it did not have. Its base is the
  // round's to put back; and its gaps stay gaps
  const patch = ctx.world.zones?.cane ?? [];
  const may = (p: Pos) => (!home || horiz(p, home) <= ctx.world.leash) && !own.some(b => inBox(p, b, 1)) &&
    !patch.some(c => c.y === p.y && Math.abs(c.x - p.x) + Math.abs(c.z - p.z) <= 1) &&
    nearestZone(p, zones, true).distance >= PLANT_FROM_BUILDS;
  // the nearest water first, a stretch of shore at a time, until there are cells enough
  const cells: Pos[] = [];
  const looked: Pos[] = [];
  let lake: Pos | undefined;
  for (const w of water) {
    if (cells.length >= max || looked.length >= SHORES) break;
    if (looked.some(l => horiz(l, w) <= SHORE_REACH)) continue;
    // sky above it, or it is a pool under something (a pocket under the storage house had air right above it)
    const { blocks: col } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { x: w.x, y: w.y + 1, z: w.z, width: 1, height: 16, length: 1 });
    if (col.some(b => b && !/^(minecraft:)?(air|cave_air|void_air)$/.test(b))) continue;
    looked.push(w);
    const box = { x: w.x - SHORE_REACH, y: w.y, z: w.z - SHORE_REACH, width: 2 * SHORE_REACH + 1, height: 3, length: 2 * SHORE_REACH + 1 };
    const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', box);
    // (none right beside a cell an earlier stretch gave: the same gap along the whole shore)
    const more = shoreCells(box, blocks, max - cells.length, p => may(p) && !cells.some(c => Math.abs(c.x - p.x) + Math.abs(c.z - p.z) <= 1 && c.y === p.y));
    if (more.length && !lake) lake = w;
    cells.push(...more);
  }
  if (!cells.length) {
    const where = looked.map(w => `(${w.x}, ${w.y}, ${w.z})`).join(', ');
    // a shore the patch has planted already is full, not missing: every cell along it is cane or a gap beside cane
    const there = (ctx.world.zones?.cane ?? []).filter(c => looked.some(w => Math.abs(c.x - w.x) <= SHORE_REACH && Math.abs(c.z - w.z) <= SHORE_REACH)).length;
    if (there) return { planted: [], refused: 0, text: `the shore round ${where} is full (${there} cell(s) of the patch on it, a gap beside each)`, full: true };
    return { planted: [], refused: 0, text: !looked.length ? `no open water under the sky within ${reach} blocks of home` : `no shore to plant on round ${where}` };
  }
  let have = await caneCount(ctx);
  if (have < cells.length) {
    // (a chest out of reach is no reason to plant none: what is carried still goes in)
    await takeFromChests(ctx, 'sugar_cane', cells.length - have).catch(() => 0);
    have = await caneCount(ctx);
  }
  if (!have) return { planted: [], refused: 0, lake, text: 'no cane to plant (none carried, none in the chests)' };
  const planted: Pos[] = [];
  let refused = 0;
  for (const c of cells.slice(0, have)) {
    if (ctx.signal.aborted || enough()) break;
    const r = await ctx.act('place-block', { ...c, faceDirection: 'down', item: 'sugar_cane' });
    if (/^Placed/.test(r.text)) { planted.push(c); addZone(ctx.world, 'cane', c); ctx.gain(1); } else refused++;
  }
  const where = lake ? ` by (${lake.x}, ${lake.y}, ${lake.z})` : '';
  const text = planted.length ? `planted ${planted.length} cane on the shore${where}${refused ? `; ${refused} cell(s) would not take it` : ''}`
    : refused ? `the cane would not go in (${refused} cell(s) tried${where})` : 'nothing planted (stopped before the first cell)';
  return { planted, refused, lake, text };
}

export function caneMilestone(prereqs: string[]): Milestone {
  return {
    id: 'cane',
    title: 'sugar cane by the lake',
    prereqs,
    done: v => !!v.world.zones?.cane?.length,
    steps: [
      {
        name: 'find sugar cane',
        run: async (ctx, st) => {
          if ((await caneCount(ctx)) < 3) await takeFromChests(ctx, 'sugar_cane', 12);
          if ((await caneCount(ctx)) >= 3) return ok('cane in hand');
          // none in sight from home: off to where it found cane before, else one side of home a run, in turn (the
          // step only ever looked from home, found "no sugar_cane in sight" hourly from 09:57 on, and the enchanting
          // room behind it never started; all four sides at once would outrun the project's 9 minutes)
          const looked = Number(st.data.caneLooked ?? 0);
          const side = WOODS_DIRS[looked % WOODS_DIRS.length];
          const wild = await toTheWoods(ctx, ['sugar_cane'], false, { zone: 'wildcane', what: 'sugar cane', dirs: [side] });
          let r = wild.ok ? await ctx.act('mine-blocks', { block: 'sugar_cane', count: 6, timeoutMs: 4 * MINUTE }) : undefined;
          await ctx.act('go-home', { name: 'home', timeoutMs: 180_000 }).catch(() => undefined);
          if ((await caneCount(ctx)) >= 1) return ok((r?.text ?? wild.text).split('\n')[0].slice(0, 100));
          if (wild.ok && wild.text) delete ctx.world.zones?.wildcane; // seen, but none came of it: look elsewhere next time
          st.data.caneLooked = looked + 1;
          const why = r ? r.text.split('\n')[0].slice(0, 100) : wild.text;
          // the next side soon; once round all four, an hour (cane may come into reach as the yard and leash grow)
          return blocked(`no sugar cane found: ${why}`, (looked + 1) % WOODS_DIRS.length ? 5 * MINUTE : 60 * MINUTE);
        }
      },
      {
        name: 'plant cane on the lake shore',
        // (the work queue's cane patch plants the same way, later and up to the whole patch)
        run: async ctx => {
          const r = await plantCane(ctx, Math.min(12, await caneCount(ctx)));
          if (r.planted.length) return ok(r.text);
          return blocked(r.text, r.refused ? 20 * MINUTE : 60 * MINUTE);
        }
      }
    ]
  };
}

// ------------------------------------------------------------------------------------------------ wild cane

/** A stalk of cane: where its base stands (the bottom cane block) and how many blocks tall it is. */
export interface Stalk { x: number; y: number; z: number; height: number }

/** The stalks in a region read (x fastest, then z, then y): each column's runs of cane, from the block with none below it. */
export function stalksIn(box: { x: number; y: number; z: number; width: number; height: number; length: number }, blocks: (string | null)[]): Stalk[] {
  const { width: w, length: l, height: h } = box;
  const cane = (x: number, y: number, z: number) => y >= 0 && y < h && name(blocks[x + z * w + y * w * l]) === 'sugar_cane';
  const out: Stalk[] = [];
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    if (!cane(x, y, z) || cane(x, y - 1, z)) continue;
    // a column cut off by the bottom of the read is no base: its base stands lower down
    if (y === 0) continue;
    let height = 1;
    while (cane(x, y + height, z)) height++;
    out.push({ x: box.x + x, y: box.y + y, z: box.z + z, height });
  }
  return out;
}

/**
 * Where wild cane may be cut, and a find counts: within the leash; not the bot's own (its cane cells, its yard, its
 * builds and the project's site); and not by anyone else's build (a friend's cane patch by the river is theirs: the
 * same 24 blocks the hunt keeps from their builds).
 */
export function wildCane(world: WorldMemory, home: { x: number; z: number }, zones: Zone[]): (p: Pos) => boolean {
  const cells = world.zones?.cane ?? [];
  const yard = world.yard;
  const own = ownBoxes(world);
  return p => horiz(p, home) <= world.leash && !cells.some(c => horiz(c, p) <= 2) && !(yard && outsideBy(yard, p) <= 1) &&
    !own.some(b => inBox(p, b, 1)) && nearestZone(p, zones, true).distance >= WILD_DISTANCE;
}

/** What a visit to a stand of wild cane came to. */
export interface StandVisit {
  /** cane picked up */
  got: number;
  /** stalks cut (from the second block up), and bases left standing to grow again */
  cut: number; bases: number;
  /** not got to: why */
  unreached?: string;
  /** someone's build this near it: theirs, left alone */
  theirs?: number;
  /** no cane there any more */
  gone?: true;
}

/**
 * Cut a stand of wild cane: walk to it, and cut every stalk two or more tall at its second block (the rest comes down
 * with it), never the base: wild cane grows again only from its base, as the patch's does. What falls is picked up.
 * `wild` says which stalks are the bot's to cut; `enough` ends it early.
 */
export async function cutStand(ctx: GoalContext, at: Pos, wild: (p: Pos) => boolean, enough: () => boolean = () => false): Promise<StandVisit> {
  const visit: StandVisit = { got: 0, cut: 0, bases: 0 };
  const here = (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
  if (horiz(here, at) > 5) {
    try {
      await ctx.act('move-to-position', { ...at, range: 3, timeoutMs: 150_000 });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      return { ...visit, unreached: (e as Error).message.split('\n')[0].slice(0, 120) };
    }
  }
  if (ctx.signal.aborted) throw new Error('aborted');
  // there, the bot sees round it: a build it could not see from home makes the stand someone's
  const zones = (await ctx.call<{ zones?: Zone[] }>('foreign.zones').catch(() => undefined))?.zones ?? [];
  const near = nearestZone(at, zones, true);
  if (near.distance < WILD_DISTANCE) return { ...visit, theirs: Math.round(near.distance) };
  // (what was found may be a stalk's top block, three above its base: the read starts below that)
  const box = { x: at.x - 6, y: at.y - 4, z: at.z - 6, width: 13, height: 9, length: 13 };
  const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', box);
  const stalks = stalksIn(box, blocks).filter(st => wild(st)).sort((a, b) => horiz(a, at) - horiz(b, at));
  if (!stalks.length) return { ...visit, gone: true };
  visit.bases = stalks.length;
  let had = await caneCount(ctx);
  for (const st of stalks) {
    if (st.height < 2) continue;
    if (ctx.signal.aborted) throw new Error('aborted');
    if (enough()) break;
    const r = await ctx.act('dig-block', { x: st.x, y: st.y + 1, z: st.z, collect: true }).catch(e => ({ ok: false, text: (e as Error).message }));
    if (/^Dug/.test(r.text)) visit.cut++;
    // told stalk by stalk: a run stopped halfway keeps what it picked up
    const now = await caneCount(ctx);
    if (now > had) { ctx.gain(now - had); visit.got += now - had; }
    had = now;
  }
  return visit;
}

/** how far round a stop the bot looks for cane (the client has the chunks loaded well past it) */
const CANE_SIGHT = 48;

/**
 * Look along one side of home for wild cane, no further out than the leash (work.ts alongSide: stops 32 blocks apart,
 * the last 16 inside the leash), looking 48 round each stop. Returns the nearest cane that is the bot's to cut
 * (`wild`), or why none was found.
 */
export async function findWildCane(ctx: GoalContext, side: (typeof WOODS_DIRS)[number], wild: (p: Pos) => boolean, enough: () => boolean = () => false): Promise<{ at?: Pos; text: string; short?: true }> {
  const r = await alongSide(ctx, side, 'wild cane', async () => {
    // (as many as the bridge gives: the patch's own 24 cells, up to 72 blocks of cane nearer home, would fill a short list)
    const seen = (await ctx.call<{ positions?: Pos[] }>('world.findBlocks', { block: 'sugar_cane', maxDistance: CANE_SIGHT, count: 256 }).catch(() => undefined))?.positions ?? [];
    return seen.find(wild);
  }, enough);
  return { at: r.found, text: r.text, ...(r.short ? { short: true as const } : {}) };
}

// ------------------------------------------------------------------------------------------------ the round

/**
 * What a filler block in a cane cell can be: the scaffold kinds (Baritone's throwaway blocks, what tidy clears). Live
 * 2026-11-09: all five cane cells by the lake held cobblestone, the cane gone; the round only replanted into air, so
 * it cut 0 stalks every 20 min for 15 hours with 15 cane carried, and the enchanting room sat short of 120 cane.
 */
const FILLER = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack)$/;

/** What the round does with one of its cells, from the cell's block and the one above: cut, replant, clear, or leave. */
export function caneCellPlan(base: string, mid: string, haveCane: boolean): 'cut' | 'plant' | 'clear' | 'leave' {
  if (base === 'sugar_cane') return mid === 'sugar_cane' ? 'cut' : 'leave';
  if (!haveCane) return 'leave';
  if (AIRY.test(base)) return 'plant';
  // a scaffold block in the bot's own cane cell (anything else someone may have put there on purpose stays)
  return FILLER.test(base) && AIRY.test(mid) ? 'clear' : 'leave';
}

/**
 * Run now? The "no" is said in this order: no cane to see to (no patch, no cell in it that can grow cane, or the round
 * is not due); then what keeps a round that is due from going (not in the yard, no room for the stalks); the hour last.
 */
const gate = (s: Snapshot, world: WorldMemory): Gate => {
  const cells = world.zones?.cane?.length ?? 0;
  if (!cells) return { cause: 'unneeded', text: 'no cane patch' };
  if (!liveCells(world).length) return { cause: 'unneeded', text: `no cane cell that can grow cane (${cells} with no water beside them: the cane patch drops them)` };
  const last = world.lastDone?.cane ?? 0;
  if (!(s.now - last > 20 * MINUTE)) return no.notDue('cane', s.now, last, 20 * MINUTE);
  if (!nearHome(s, 24)) return no.away(s, 'cane', 24);
  // two slots free for the stalks, or the stash able to make them (the round does that first)
  if (room('yard', s, world) === 'no') return noRoom('yard', 'cane', s, world);
  return no.late(s, 'cane') ?? { want: 'daily round: the sugar cane' };
};

/**
 * Once a day: cut the cane down to its base (the stalk above the bottom block), and replant a missing base, in the
 * cells that can grow cane. A cell with no water beside its ground is left alone (nothing is walked to, taken from the
 * chests or planted for it: cane would not stay there) and written down, for the cane patch rung to drop.
 */
export const caneRound: Goal = {
  name: 'cane',
  priority: 29,
  timeoutMs: 6 * MINUTE,
  retryMs: 30 * MINUTE,
  gate,
  ...fromGate(gate),
  // a round that cuts nothing and plants nothing (the cells bare and no cane to plant) is busy time to no gain
  gains: true,
  run: async ctx => {
    // room for the stalks first (home to the chests where the pockets are too full; the walk to the cane is the
    // round's own, as ever). Before the round is written down: one that could make no room has not been
    await makeRoom(ctx, 'yard');
    const marked = ctx.world.lastDone?.cane;
    (ctx.world.lastDone ??= {}).cane = ctx.s.now;
    let cut = 0, replanted = 0, cleared = 0;
    // a round stopped before it saw to a cell has not been done: the brain lets a goal stopped for something more
    // urgent go again as soon as it is wanted, and the mark above kept it off for the day. Live 2026-11-12: repair
    // cut in 5 s after each morning's start (the walk brings the bot near home), and the round ran on 1 day of 9
    try {
      const cells = ctx.world.zones!.cane;
      const seen = new Map<Pos, CaneLook>();
      for (const c of cells) seen.set(c, await lookAtCell(ctx, c));
      // the cells that can grow cane: a dead one (no water beside it) is written down for the cane patch rung, and
      // nothing more: live 2026-11-12, the lake had sunk away from all five cells and the round took cane from the
      // chests to replant them every 20 min, cane that would not stay
      const dead = cells.filter(c => caneCellState(seen.get(c)!) === 'dead');
      for (const c of cells) noteCell(ctx.world, c, caneCellState(seen.get(c)!), ctx.s.now);
      const growing = cells.filter(c => !dead.includes(c));
      // bases to put back, and too few carried: a few from the chests first. Live 2026-11-10: the stash had put every
      // stalk away (37 in the food chest), all five cells stood empty, and the round "cut 0 stalk(s) (0 cane)" every
      // 20 min for 9 hours with nothing to replant, while the enchanting room waited on 98 cane.
      const bare = growing.map(c => seen.get(c)!).filter(({ base, mid }) => caneCellPlan(base, mid, true) !== 'leave' && base !== 'sugar_cane').length;
      // (a chest out of reach is no reason to skip the cutting: live, stranded on a scaffold, "chest too far to open")
      if (bare && (await caneCount(ctx)) < bare) await takeFromChests(ctx, 'sugar_cane', bare - (await caneCount(ctx))).catch(() => 0);
      const before = await caneCount(ctx);
      for (const c of growing) {
        if (ctx.signal.aborted) break;
        const { base, mid } = seen.get(c)!;
        const plan = caneCellPlan(base, mid, base !== 'sugar_cane' && (await caneCount(ctx)) > 0);
        if (plan === 'cut') {
          // cutting the second block brings the rest down with it
          const r = await ctx.act('dig-block', { x: c.x, y: c.y + 1, z: c.z, collect: true });
          if (/^Dug/.test(r.text)) { cut++; ctx.gain(1); }
        } else if (plan === 'plant' || plan === 'clear') {
          if (plan === 'clear') {
            const d = await ctx.act('dig-block', { ...c, collect: true }).catch(e => ({ ok: false, text: (e as Error).message }));
            if (!/^Dug|^No block/.test(d.text)) { ctx.progress(`cane cell ${c.x},${c.y},${c.z}: ${base} would not come out: ${d.text.slice(0, 100)}`); continue; }
            cleared++;
          }
          const r = await ctx.act('place-block', { ...c, faceDirection: 'down', item: 'sugar_cane' });
          if (/^Placed/.test(r.text)) { replanted++; ctx.gain(1); }
        }
      }
      const got = (await caneCount(ctx)) - before + replanted;
      return `cut ${cut} stalk(s) (${Math.max(0, got)} cane)${replanted ? `, replanted ${replanted}` : ''}${cleared ? ` (${cleared} cell(s) cleared of scaffold first)` : ''}` +
        (dead.length ? `; ${dead.length} cell(s) with no water beside them left alone` : '');
    } finally {
      if (ctx.signal.aborted && !cut && !replanted && !cleared) {
        if (marked === undefined) delete ctx.world.lastDone!.cane;
        else ctx.world.lastDone!.cane = marked;
      }
    }
  }
};
