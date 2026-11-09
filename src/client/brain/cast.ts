import type { GoalContext } from './goals.js';
import { readBox } from './milestones.js';
import { prepare } from './project.js';
import { chestTotals, takeFromChests } from './chests.js';
import { fillAt, sourcesInSight } from './fluidpick.js';

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
  const haveLava = await countOf(ctx, 'lava_bucket');
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
  const y = ctx.world.yard;
  const outside = (p: P) => !y || p.x < y.x1 - 2 || p.x > y.x2 + 2 || p.z < y.z1 - 2 || p.z > y.z2 + 2;
  const sources = (await sourcesInSight(ctx, 'water', y?.y, 16)).filter(v => !v.why && outside(v.at));
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
  return { have, text: `cast ${casts} obsidian at (${c.x}, ${c.y}, ${c.z})${notes.length ? `; ${notes.join('; ')}` : ''}` };
}

