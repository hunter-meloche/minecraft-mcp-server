import type { GoalContext } from './goals.js';
import type { WorldMemory } from './memory.js';
import { readBox } from './milestones.js';
import { prepare } from './project.js';
import { chestTotals, takeFromChests } from './chests.js';
import { fillAt, holdHarmless, lakeSources, sourcesInSight } from './fluidpick.js';
import { progressOf, type Step, type StepResult } from './progress.js';
import { DEEP_TRIP, deepTripReady, pickMineStart } from './mine.js';
import { tripCheck } from './deep.js';
import { nearestZone, type Zone } from './courtesy.js';
import { walkHome } from './homeward.js';
import { leaveYard } from './yardgates.js';

/**
 * Obsidian cast at home from lava and water, when there's none to mine away from a lit portal (natural obsidian is
 * rare, deep by lava; the only obsidian the bot knew of was the community chest's portal). Lava from a still source
 * (a bucket per obsidian), water from the lake, and a 2-deep pit in plain lawn:
 *
 *   y      W        water poured here (the pit's walls hold it: it can't spread over the lawn)
 *   y-1    L -> O   lava poured here; the water on it turns it to obsidian
 *   S stands on the ground beside the pit (C - x) the whole time, never in it
 *
 * Each cast: lava in, water in, the water scooped back, the obsidian mined from above, and the water poured in once
 * more so the dropped obsidian floats up within reach (then scooped again). The pit is filled in after the last.
 */

type P = { x: number; y: number; z: number };
const NATURAL = /^(minecraft:)?(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|stone|deepslate|andesite|diorite|granite|tuff|gravel|sand|clay)(\[|$)/;
const OPEN = /^(minecraft:)?(air|cave_air|short_grass|tall_grass|fern|dandelion|poppy|leaf_litter|wildflowers|pink_petals)(\[|$)/;
/** burns near lava, or isn't the bot's to flood: nothing of these within 2 of the pit */
const KEEP_CLEAR = /(log|planks|leaves|fence|gate|door|torch|lantern|sapling|wheat|farmland|water|chest|bed|wool|carpet|hay|crafting|furnace|sign|cobblestone|_slab|_stairs|_wall)/;

/**
 * Where to cast: a lawn cell inside the yard whose pit stays sealed (natural ground on every side at y and y-1, and
 * under it), with standing room west of it, and nothing that burns or is built within 2 of it. Nearest `near` (home)
 * first, but not right by it. `blocks` is a readBox of `box` (x fastest, then z, then y), spanning ground y-2..y+2.
 */
export function castSite(blocks: (string | null)[], box: P & { width: number; height: number; length: number }, groundY: number, near: P): P | undefined {
  const at = (x: number, y: number, z: number) => {
    const ix = x - box.x, iy = y - box.y, iz = z - box.z;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= box.width || iy >= box.height || iz >= box.length) return null;
    return blocks[ix + iz * box.width + iy * box.width * box.length] ?? null;
  };
  const natural = (x: number, y: number, z: number) => NATURAL.test(at(x, y, z) ?? '');
  const open = (x: number, y: number, z: number) => OPEN.test(at(x, y, z) ?? '');
  const y = groundY;
  const out: P[] = [];
  for (let z = box.z + 2; z < box.z + box.length - 2; z++) for (let x = box.x + 2; x < box.x + box.width - 2; x++) {
    if (Math.hypot(x - near.x, z - near.z) < 6) continue;
    // the pit and its walls (natural, so the pit holds), the floor under the lava
    if (![[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => natural(x + dx, y, z + dz) && natural(x + dx, y - 1, z + dz))) continue;
    if (!natural(x, y - 2, z)) continue;
    // standing room beside it, open above the pit
    if (!open(x - 1, y + 1, z) || !open(x - 1, y + 2, z) || !open(x, y + 1, z)) continue;
    let clear = true;
    for (let dy = -1; dy <= 2 && clear; dy++) for (let dz = -2; dz <= 2 && clear; dz++) for (let dx = -2; dx <= 2 && clear; dx++) {
      if (KEEP_CLEAR.test(at(x + dx, y + dy, z + dz) ?? '')) clear = false;
    }
    if (clear) out.push({ x, y, z });
  }
  return out.sort((a, b) => Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z))[0];
}

/** How long the water takes (ms): to turn the lava, to float the dropped obsidian up, to drain. Tests set them to 0. */
/** Water buckets the cast carries: one, to turn the lava (the dropped obsidian is lifted out with dirt, not water). */
export const WATER_BUCKETS = 1;
/** Where a pool gave lava safely: zones[LAVA_POOL]. */
export const LAVA_POOL = 'lava:pool';

export const CAST_TIMING = { settle: 1500, float: 500, floatTries: 16, drain: 1500 };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const countOf = async (ctx: GoalContext, item: string) =>
  (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items
    .filter(i => i.slot < 36 && i.name === item).reduce((a, i) => a + i.count, 0);
const blockAt = async (ctx: GoalContext, p: P) =>
  ((await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...p, width: 1, height: 1, length: 1 })).blocks[0] ?? '').replace(/^minecraft:/, '');

/** Empty buckets enough for `lava` lava buckets and a water bucket (crafted from iron); true when it has them. */
export async function bucketsFor(ctx: GoalContext, lava: number): Promise<string | undefined> {
  const water = await countOf(ctx, 'water_bucket');
  // full ones in the chests count too (a trip's room-making puts them away, and the cast takes them back out): asked
  // for four more empties it could not make, the cast was skipped with four lava buckets in the gear chest
  const haveLava = (await countOf(ctx, 'lava_bucket')) + (chestTotals(ctx.world).lava_bucket ?? 0);
  const empties = Math.max(0, lava - haveLava) + Math.max(0, WATER_BUCKETS - water);
  if ((await countOf(ctx, 'bucket')) < empties) {
    const short = await prepare(ctx, 'bucket', empties);
    if (Object.keys(short).length) return `buckets: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}`;
  }
  if (!(await fetchWater(ctx, WATER_BUCKETS))) return 'water: no still water in sight with a safe spot to fill a bucket at';
  return undefined;
}

/**
 * Lava into buckets from still sources in sight, up to `want`, the safe way (fluidpick.ts): pools open to the sky,
 * near the ground, filled from a safe spot beside them, never walked into. Returns how many lava buckets it carries.
 */
export async function fetchLava(ctx: GoalContext, want: number): Promise<number> {
  let have = await countOf(ctx, 'lava_bucket');
  if (have >= want || !ctx.world.lavaCasting) return have;
  // what's in the chests first (the stash had put four away)
  if ((chestTotals(ctx.world).lava_bucket ?? 0) > 0) { await takeFromChests(ctx, 'lava_bucket', want - have); have = await countOf(ctx, 'lava_bucket'); }
  if (have >= want) return have;
  // the ground level: the yard's (the land round here; under its feet it was in a dip at y 53, or a cave)
  const pos = (await ctx.call<{ position?: P }>('status').catch(() => ({}) as { position?: P })).position ?? ctx.s.position;
  const ground = ctx.world.yard?.y ?? Math.floor(pos.y) - 1;
  const sources = (await sourcesInSight(ctx, 'lava', ground)).filter(v => !v.why);
  for (const v of sources) {
    if (have >= want || ctx.signal.aborted) break;
    if (!(await countOf(ctx, 'bucket'))) break;
    const r = await fillAt(ctx, v, 'lava');
    ctx.progress(`lava: ${r.text.slice(0, 140)}`);
    have = await countOf(ctx, 'lava_bucket');
    // a pool that gave lava safely is remembered: the next trip goes straight there (the one found was 230 blocks
    // out, past where a trip's steps from the mine reach)
    if (r.ok) (ctx.world.zones ??= {})[LAVA_POOL] = [{ ...v.at }];
  }
  return have;
}

/** Water buckets (up to `n`) from still water open to the sky outside the yard (the lake), the same safe way. */
async function fetchWater(ctx: GoalContext, n: number): Promise<boolean> {
  if ((await countOf(ctx, 'water_bucket')) >= n) return true;
  // (never the cane patch's water: lakeSources)
  const sources = (await lakeSources(ctx, 16)).filter(v => !v.why);
  for (const v of sources.slice(0, 6)) {
    if (ctx.signal.aborted || (await countOf(ctx, 'water_bucket')) >= n || !(await countOf(ctx, 'bucket'))) break;
    const r = await fillAt(ctx, v, 'water');
    ctx.progress(`water: ${r.text.slice(0, 140)}`);
  }
  return (await countOf(ctx, 'water_bucket')) >= n;
}

/** Lava anywhere round the stand spot or over the pit but the pit itself, as it is now (a bucket emptied off aim). */
async function strayLava(ctx: GoalContext, pit: P, stand: P): Promise<P | undefined> {
  const box = { x: Math.min(pit.x, stand.x) - 1, y: pit.y, z: pit.z - 1, width: Math.abs(pit.x - stand.x) + 3, height: stand.y - pit.y + 2, length: 3 };
  const blocks = (await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...box })).blocks;
  for (let i = 0; i < blocks.length; i++) {
    if (!/^(minecraft:)?lava/.test(blocks[i] ?? '')) continue;
    const p = { x: box.x + i % box.width, y: box.y + Math.floor(i / (box.width * box.length)), z: box.z + Math.floor(i / box.width) % box.length };
    if (p.x !== pit.x || p.y !== pit.y || p.z !== pit.z) return p;
  }
  return undefined;
}

/** The cast site, kept: chosen once in the yard and remembered. */
async function siteOf(ctx: GoalContext): Promise<P | undefined> {
  const kept = ctx.world.zones?.['obsidian:cast']?.[0];
  if (kept) return kept;
  const y = ctx.world.yard;
  if (!y || !ctx.s.home) return undefined;
  const box = { x: y.x1 + 1, y: y.y - 2, z: y.z1 + 1, width: y.x2 - y.x1 - 1, height: 5, length: y.z2 - y.z1 - 1 };
  const site = castSite(await readBox(ctx, box), box, y.y, ctx.s.home);
  if (site) (ctx.world.zones ??= {})['obsidian:cast'] = [site];
  return site;
}

/**
 * Cast obsidian at home until the inventory holds `want` or the lava runs out; returns how many it holds. Needs the
 * lava buckets, a water bucket and the diamond pickaxe carried.
 */
export async function castObsidian(ctx: GoalContext, want: number): Promise<{ have: number; text: string }> {
  let have = await countOf(ctx, 'obsidian');
  if (!ctx.world.lavaCasting) return { have, text: 'obsidian casting is off (lava-casting turns it on)' };
  if (!(await countOf(ctx, 'lava_bucket')) && (chestTotals(ctx.world).lava_bucket ?? 0) > 0) await takeFromChests(ctx, 'lava_bucket', want - have);
  const w = await countOf(ctx, 'water_bucket');
  if (w < WATER_BUCKETS && (chestTotals(ctx.world).water_bucket ?? 0) > 0) await takeFromChests(ctx, 'water_bucket', WATER_BUCKETS - w);
  const c = await siteOf(ctx);
  if (!c) return { have, text: 'no lawn in the yard to cast obsidian in (a 5 x 5 patch of plain ground, nothing built or burning by it)' };
  const pit = { x: c.x, y: c.y - 1, z: c.z }, top = { ...c };
  const wallLow = { x: c.x + 1, y: c.y - 1, z: c.z }, wallHigh = { x: c.x + 1, y: c.y, z: c.z };
  const stand = { x: c.x - 1, y: c.y + 1, z: c.z };
  const goStand = async () => {
    // the lava and water buckets out of the hand for the walk: they come out of the chests into the hotbar (often the
    // slot in hand), and a pour or a scoop leaves a full one in it; a door or a gate on the way is a right click
    await holdHarmless(ctx);
    const g = await ctx.call<{ arrived: boolean }>('goto', { ...stand, range: 0, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
    return g.arrived;
  };
  if (!(await goStand())) return { have, text: `could not get to the casting spot at (${stand.x}, ${stand.y}, ${stand.z})` };
  // the pit: two blocks of lawn dug by hand from the spot beside it
  for (const p of [top, pit]) {
    if (!/^(air|cave_air|water|lava)/.test(await blockAt(ctx, p))) await ctx.call('dig.here', { ...p, timeoutMs: 15_000 }, 25_000).catch(() => undefined);
  }
  const use = (p: P, item: string, face: string) => ctx.act('use-item-on-block', { ...p, item, face });
  let casts = 0;
  const notes: string[] = [];
  while (have < want && !ctx.signal.aborted) {
    // the last cast's water drains from the pit before lava goes in (lava on flowing water is cobblestone)
    if (casts) await sleep(CAST_TIMING.drain);
    if (!(await countOf(ctx, 'lava_bucket'))) { notes.push('out of lava'); break; }
    if ((await countOf(ctx, 'water_bucket')) < WATER_BUCKETS) { notes.push(`${await countOf(ctx, 'water_bucket')} water bucket(s), not ${WATER_BUCKETS}`); break; }
    if (!(await goStand())) { notes.push('lost the casting spot'); break; }
    if (!/^(air|cave_air)/.test(await blockAt(ctx, pit))) { notes.push(`the pit isn't empty (${await blockAt(ctx, pit)})`); break; }
    await use(wallLow, 'lava_bucket', 'west');
    // the lava only in the pit: any anywhere round the stand spot or the pit's top is scooped straight back, and no more
    const stray = await strayLava(ctx, pit, stand);
    if (stray) {
      await use(stray, 'bucket', 'up');
      notes.push(`lava went to (${stray.x}, ${stray.y}, ${stray.z}), not the pit: scooped back, stopped`);
      break;
    }
    if (!/^lava/.test(await blockAt(ctx, pit))) { notes.push(`the lava didn't go in (${await blockAt(ctx, pit)})`); break; }
    const poured = await use(wallHigh, 'water_bucket', 'west');
    await sleep(CAST_TIMING.settle);
    const formed = /^obsidian/.test(await blockAt(ctx, pit));
    // what the pour did, for when it didn't work (the first such run left the lava in the pit, the water gone)
    const seen = `pit ${await blockAt(ctx, pit)}, above it ${await blockAt(ctx, top)}; the pour: ${poured.text.replace(/\s+/g, ' ').slice(0, 200)}`;
    await use(top, 'bucket', 'up'); // the water back
    if (!formed) { notes.push(`no obsidian formed (${seen})`); break; }
    await ctx.call('item.select', { name: 'diamond_pickaxe' }).catch(() => undefined);
    const d = await ctx.call<{ dug: boolean; reason?: string }>('dig.here', { ...pit, timeoutMs: 20_000 }, 30_000).catch(e => ({ dug: false, reason: (e as Error).message }));
    if (!d.dug) { notes.push(`couldn't mine it: ${d.reason}`); break; }
    // the obsidian lies at the pit's bottom, out of reach: the pit filled back with dirt pushes it up, out onto the
    // ground beside the bot, which picks it up (an item in a block is pushed to the nearest open space). Floating it
    // up on water never worked: of six drops one came up, the rest lay there till lava burned them or they despawned
    const before = have;
    if ((await countOf(ctx, 'dirt')) < 2) { notes.push('no dirt to lift the obsidian out with'); break; }
    await use(wallLow, 'dirt', 'west');
    await use(wallHigh, 'dirt', 'west');
    let got = false;
    for (let i = 0; i < CAST_TIMING.floatTries && !got; i++) {
      await sleep(CAST_TIMING.float);
      got = (await countOf(ctx, 'obsidian')) > before;
    }
    if (!got) {
      // out on the ground by the pit: picked up from round the spot (nothing of the pit's left open to fall in)
      await ctx.act('collect-items', { radius: 3, timeoutMs: 15_000 }).catch(() => undefined);
      got = (await countOf(ctx, 'obsidian')) > before;
    }
    casts++;
    have = await countOf(ctx, 'obsidian');
    if (!got) { notes.push(`the obsidian didn't come up out of the pit: stopped`); break; }
    // the pit again for the next cast
    if (have < want && (await countOf(ctx, 'lava_bucket'))) {
      if (!(await goStand())) { notes.push('lost the casting spot'); break; }
      for (const p of [top, pit]) await ctx.call('dig.here', { ...p, timeoutMs: 15_000 }, 25_000).catch(() => undefined);
    }
  }
  // lava left in the pit (the water didn't turn it): scooped back into a bucket, not sealed under dirt
  if (/^lava/.test(await blockAt(ctx, pit)) && (await countOf(ctx, 'bucket'))) await use(pit, 'bucket', 'up');
  // the lawn back: the pit filled with dirt (a block dug up from it, or what's carried); not over an obsidian left
  // lying at its bottom (the next run floats it up)
  const left = notes.some(n => /didn't come up/.test(n));
  for (const [p, wall] of (left ? [] : [[pit, wallLow], [top, wallHigh]]) as [P, P][]) {
    if (/^(air|cave_air|water)/.test(await blockAt(ctx, p)) && (await countOf(ctx, 'dirt'))) await use(wall, 'dirt', 'west').catch(() => undefined);
  }
  // whatever walks next (the stash, the walk home) goes with a harmless hand: a stray lava scooped back, or the water
  // taken up again, is a full bucket in it, and with no dirt to fill the pit nothing else took its place
  await holdHarmless(ctx);
  return { have, text: `cast ${casts} obsidian at (${c.x}, ${c.y}, ${c.z})${notes.length ? `; ${notes.join('; ')}` : ''}` };
}


// ------------------------------------------------------------------------------------------------ the obsidian step

const MINUTE = 60_000;
const ok = (text: string): StepResult => ({ status: 'done', text });
const going = (text: string): StepResult => ({ status: 'progress', text });
const blocked = (text: string, retryMs = 20 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });

/** How far a trip for obsidian looks: steps of this many blocks out from the mine, scanning after each. */
const OBSIDIAN_STEP = 40;
const OBSIDIAN_STEPS = 3;
/** Free slots an obsidian trip wants (buckets of lava and the obsidian itself, not ore). */
export const OBSIDIAN_TRIP_SLOTS = 3;

type Box = { x: number; z: number; width?: number; length?: number };

/**
 * Obsidian in sight to dig: every obsidian block the loaded chunks hold (all depths), nearest first, less a lit
 * nether portal's frame (anything within 4 of a portal block; the mod refuses those anyway), and less the bot's own
 * frames standing unlit (`keep`: the portal zone's footprint, a block round it): the portal milestone's frame stands a
 * step before it is lit, and an obsidian step after it (the Nether side's, P2b) would have dug its own frame for it.
 */
export function obsidianTargets(obsidian: P[], portals: P[], from: P, keep: Box[] = []): P[] {
  const d2 = (a: P, b: P) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
  const kept = (p: P) => keep.some(b => p.x >= b.x - 1 && p.x <= b.x + (b.width ?? 1) && p.z >= b.z - 1 && p.z <= b.z + (b.length ?? 1));
  return obsidian.filter(p => !portals.some(q => d2(p, q) <= 16) && !kept(p)).sort((a, b) => d2(a, from) - d2(b, from));
}

const countAll = async (ctx: GoalContext, item: string) =>
  (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items
    .filter(i => i.name === item).reduce((a, i) => a + i.count, 0);

/**
 * The cells of the portals of others seen lit in this dimension (world.nether.seen, kept across restarts). A frame
 * whose portal has gone out (a creeper's or a ghast's blast) is no lit portal for findBlocks, and obsidian is no
 * marker of a build for the bridge: without these its frame would be dug like wild obsidian, the community's portal
 * (about 30 off the east leg of the obsidian runs) among them. Expanded here, not with nether.ts portalCells: nether.ts
 * reaches cast.ts through portal.ts.
 */
export function seenPortalCells(world: WorldMemory, dimension: string): P[] {
  const out: P[] = [];
  const list: unknown = world.nether?.seen?.[dimension];
  for (const p of Array.isArray(list) ? list as { x: number; y: number; z: number; axis?: string; width?: number; height?: number }[] : []) {
    if (!p || ![p.x, p.y, p.z].every(v => typeof v === 'number' && Number.isFinite(v))) continue;
    const w = p.width ?? 2, h = p.height ?? 3;
    for (let up = 0; up < h; up++) for (let a = 0; a < w; a++) out.push(p.axis === 'z' ? { x: p.x, y: p.y + up, z: p.z + a } : { x: p.x + a, y: p.y + up, z: p.z });
  }
  return out;
}

/** Dig obsidian in sight until the inventory holds `want`; returns how many it holds. */
async function digObsidian(ctx: GoalContext, want: number): Promise<number> {
  const find = (block: string) => ctx.call<{ positions: P[] }>('world.findBlocks', { block, maxDistance: 96, count: 128 }).catch(() => ({ positions: [] as P[] }));
  const st = await ctx.call<{ position?: P; dimension?: string }>('status').catch(() => undefined);
  const here = st?.position ?? ctx.s.position;
  const obsidian = (await find('obsidian')).positions;
  // the lit portals in sight, and those of others seen lit before (one gone out keeps its frame all the same)
  const portals = [...(await find('nether_portal')).positions, ...seenPortalCells(ctx.world, st?.dimension ?? ctx.s.dimension)];
  const targets = obsidianTargets(obsidian, portals, here, ctx.world.zones?.portal ?? []);
  let have = await countAll(ctx, 'obsidian');
  for (const p of targets.slice(0, 8)) {
    if (have >= want || ctx.signal.aborted) break;
    const r = await ctx.act('dig-block', { ...p });
    ctx.progress(`obsidian at (${p.x}, ${p.y}, ${p.z}): ${r.text.split('\n')[0].slice(0, 100)}`);
    have = await countAll(ctx, 'obsidian');
  }
  return have;
}

/**
 * The milestones with an obsidian step (obsidianStep), and where it is in their steps: while one of them is still at
 * or before it, the stash keeps the casting's buckets carried (chores.ts castingAhead). `built`: the world shows the
 * milestone past it (the room or the frame built; the done list counts too). `after`: the milestones it waits for, so
 * that a cast two milestones off holds no buckets (the enchanting room has none here: it was cast for from the
 * start). tree.ts's milestones and this list are checked against each other in the tests.
 */
export const OBSIDIAN_MILESTONES: readonly { milestone: string; step: number; built: (world: WorldMemory) => boolean; after?: readonly string[] }[] = [
  { milestone: 'enchanting', step: 0, built: w => !!w.zones?.enchanting?.length },
  { milestone: 'nether-portal', step: 0, built: w => !!w.zones?.portal?.length, after: ['workshop'] }
];

/**
 * A milestone's obsidian step: `want` obsidian carried (what the chests hold is taken out first; marked carried so the
 * stash leaves it). It digs obsidian in sight that no portal's frame owns (obsidianTargets), then casts the rest at
 * home from lava (castObsidian: buckets from iron, water from the lake, lava open to the sky in sight), and what is
 * still short, a trip out from the mine's departure point for natural obsidian or lava, kitted out like a deep trip.
 * The enchanting room's ("mine 4 obsidian") was its first; the portal's gathers 20 a `batch` a run (lava buckets don't
 * stack: a cast of 20 would take 20 slots), coming back as progress until it has them all.
 */
export function obsidianStep(id: string, want: number, opts: { name?: string; batch?: number } = {}): Step {
  // the stash's buckets go by the list: a milestone it doesn't know would cast with them put away
  if (!OBSIDIAN_MILESTONES.some(o => o.milestone === id)) throw new Error(`obsidianStep for ${id}: add it to OBSIDIAN_MILESTONES (castingAhead)`);
  return {
    name: opts.name ?? `mine ${want} obsidian`,
    run: async (ctx, st) => {
      // what it gathers for the room stays carried: the step took the obsidian from the chest, the pockets went to
      // 28, the stash (more urgent) put it back, and round again every 15 s
      const p = progressOf(ctx.world);
      p.carry = [...new Set([...(p.carry ?? []), 'obsidian'])];
      const stored = chestTotals(ctx.world).obsidian ?? 0;
      if (stored && (await countAll(ctx, 'obsidian')) < want) await takeFromChests(ctx, 'obsidian', want);
      const have = await countAll(ctx, 'obsidian');
      if (have >= want) return ok(`${have} obsidian`);
      // this run's share: all of it, or a batch more (then on again next run, as progress)
      const goal = opts.batch ? Math.min(want, have + opts.batch) : want;
      const reached = (n: number, how = '') => (n >= want ? ok(`${n} obsidian${how}`) : going(`${n}/${want} obsidian${how}`));
      if (!(await countAll(ctx, 'diamond_pickaxe'))) return blocked('waiting for a diamond pickaxe to mine obsidian with', 30 * MINUTE);
      // obsidian in sight (the loaded chunks, every depth) that isn't a lit portal's frame, one block at a time:
      // Baritone's own miner went for the nearest obsidian it knew, which was the community chest's portal, walked
      // a hundred blocks toward it twice, and gave up ("Unable to find any path") as the portal guard stopped it
      let got = await digObsidian(ctx, goal);
      if (got >= goal) return reached(got, ' (near home)');
      // cast it at home from lava and water (castObsidian): buckets from iron, water from the lake, lava open to the
      // sky in sight; what's still short, a trip out for natural obsidian or lava
      const cast = async () => {
        if (!(await countAll(ctx, 'lava_bucket'))) return;
        const c = await castObsidian(ctx, goal);
        ctx.progress(c.text);
        got = c.have;
      };
      const noBuckets = await bucketsFor(ctx, goal - got);
      if (!noBuckets) {
        await fetchLava(ctx, goal - got);
        await cast();
        if (got >= goal) return reached(got, ', cast at home');
      } else ctx.progress(`casting obsidian: ${noBuckets}`);
      // none near home: out from the mine's departure point, kitted out like a deep trip, looking a step at a time
      // kitted out like a deep trip, but the pockets needn't be as empty: it brings back a few buckets and 4
      // obsidian, not a load of ore (it sat at home all morning, "4 free slots < 10", with the storage house full)
      const check = tripCheck(ctx.s);
      const ready = deepTripReady(check.slotsFree >= OBSIDIAN_TRIP_SLOTS ? { ...check, slotsFree: Math.max(check.slotsFree, DEEP_TRIP.slotsFree) } : check);
      if (!ready.ok) return blocked(`no obsidian or lava in sight near home; a trip out for it waits for: ${ready.why}`, 15 * MINUTE);
      const zones = (await ctx.call<{ zones: Zone[] }>('foreign.zones').catch(() => ({ zones: [] as Zone[] }))).zones;
      const start = pickMineStart(ctx.s.home!, ctx.world.yard, ctx.world.zones?.mine?.[0], q => nearestZone(q, zones, true).distance);
      if (!start) return blocked("every side of the yard has someone else's build by it: no trip out from here", 60 * MINUTE);
      (ctx.world.zones ??= {}).mine = [start];
      // a different way each trip
      const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
      const turn = ((st.data.obsidianTurn as number | undefined) ?? 0) % 4;
      st.data.obsidianTurn = turn + 1;
      const [dx, dz] = dirs[turn];
      const lavaEnough = async () => !noBuckets && got + (await countAll(ctx, 'lava_bucket')) >= goal;
      // out with the water bucket carried (and lava taken from the chests), home with the lava: never in hand on the
      // walks (fluidpick.ts holdHarmless; a lava bucket a door's right click poured on the way would be a fire)
      await holdHarmless(ctx);
      // a pool that gave lava before: straight there first
      const pool = ctx.world.zones?.[LAVA_POOL]?.[0];
      if (pool && !noBuckets) {
        ctx.progress(`obsidian: to the lava pool at (${pool.x}, ${pool.z})`);
        // (out of the yard by the gate on the way, not over the fence: yardgates.ts)
        await leaveYard(ctx, pool);
        await ctx.call('goto', { x: pool.x, y: pool.y, z: pool.z, xz: true, range: 8, timeoutMs: 180_000 }, 195_000).catch(() => undefined);
        await fetchLava(ctx, goal - got);
        if (!(await countAll(ctx, 'lava_bucket'))) delete ctx.world.zones![LAVA_POOL]; // dry, or no safe spot now: look again
      }
      for (let step = 0; step <= OBSIDIAN_STEPS && got < goal && !(await lavaEnough()) && !ctx.signal.aborted; step++) {
        const at = { x: start.x + dx * OBSIDIAN_STEP * step, y: start.y, z: start.z + dz * OBSIDIAN_STEP * step };
        ctx.progress(`obsidian: looking round (${at.x}, ${at.z})`);
        await leaveYard(ctx, at);
        await ctx.call('goto', { ...at, xz: true, range: 6, timeoutMs: 120_000 }, 135_000).catch(() => undefined);
        got = await digObsidian(ctx, goal);
        if (got < goal && !noBuckets) await fetchLava(ctx, goal - got);
        if (await lavaEnough()) break;
      }
      // (the obsidian and the lava pools it found may be down in a cave: from there it climbs out first)
      await holdHarmless(ctx);
      await walkHome(ctx, { timeoutMs: 300_000 }).catch(() => undefined);
      if (got < goal) await cast();
      if (got >= goal) return reached(got);
      return blocked(`short of obsidian (${got}/${want}): none in sight, and not enough lava, on a trip ${['north', 'east', 'south', 'west'][turn]} from the mine`, 20 * MINUTE);
    }
  };
}
