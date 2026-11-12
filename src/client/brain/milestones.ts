import type { GoalContext } from './goals.js';
import type { MilestoneState, Step, StepResult } from './progress.js';
import { billCarry, billCarryCap, prepareBill } from './project.js';
import { takeFromChests } from './chests.js';
import { allItems, mostWood, progressOf, rawShort } from './progress.js';
import { findSite, growYard, occupancy, type Area } from './site.js';
import type { WorldMemory } from './memory.js';
import { billLeft, billOf, type Blueprint } from './blueprints.js';
import { YARD_FROM_BUILDS, zoneDistance, type Zone } from './courtesy.js';

/**
 * Building blocks for milestones: find room in the yard (growing it when there is none), get the materials together,
 * and build a blueprint there, remembering where it went.
 */

const MINUTE = 60_000;
export interface Yard extends Area { y: number }

/** What a blueprint gives a build step (see blueprints.ts). */
export type BuildPlan = Pick<Blueprint, 'name' | 'spec' | 'size' | 'bill' | 'landmarks' | 'groundOffset'>;

const ok = (text: string): StepResult => ({ status: 'done', text });
const going = (text: string): StepResult => ({ status: 'progress', text });
const blocked = (text: string, retryMs = 5 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });
/** Short of materials: the project waits longer each time the step comes back so, until all of `need` is there. */
const shortOf = (text: string, need: Record<string, number>): StepResult => ({ status: 'blocked', text, retryMs: 3 * MINUTE, need });

/** A blueprint in another wood: oak planks, logs, doors, fences and gates become the given wood's. */
export function inWood(bp: BuildPlan, wood: string): BuildPlan {
  if (wood === 'oak') return bp;
  const swap = (s: string) => s.replace(/^(minecraft:)?oak_(planks|log|door|fence_gate|fence|stairs|slab)(?=$|\[)/, `$1${wood}_$2`);
  return {
    ...bp,
    spec: { ...bp.spec, palette: Object.fromEntries(Object.entries(bp.spec.palette).map(([k, v]) => [k, swap(v)])) },
    bill: Object.fromEntries(Object.entries(bp.bill).map(([k, v]) => [swap(k), v]))
  };
}

/** Read any box, in slabs that fit one region call. */
export async function readBox(ctx: Pick<GoalContext, 'call'>, b: { x: number; y: number; z: number; width: number; height: number; length: number }): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  const per = Math.max(1, Math.floor(65_536 / (b.width * b.length)));
  for (let y = 0; y < b.height; y += per) {
    const part = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...b, y: b.y + y, height: Math.min(per, b.height - y) }, 60_000);
    out.push(...part.blocks);
  }
  return out;
}

/** Zones that are rings round an area (the fence), not footprints. */
const RINGS = new Set(['fence']);

const SOLID_TOP = /^(minecraft:)?(grass_block|dirt|coarse_dirt|podzol|stone|sand|gravel|clay|andesite|diorite|granite|deepslate|tuff)/;

/**
 * The yard: remembered once known; at first the square of 16 around home, its ground the most common natural
 * surface height in it.
 */
export async function yardOf(ctx: GoalContext): Promise<Yard> {
  if (ctx.world.yard) return ctx.world.yard;
  const home = ctx.s.home!;
  const box = { x: home.x - 16, y: home.y - 8, z: home.z - 16, width: 33, height: 14, length: 33 };
  const blocks = await readBox(ctx, box);
  const heights = new Map<number, number>();
  for (let z = 0; z < box.length; z++) for (let x = 0; x < box.width; x++) {
    for (let y = box.height - 1; y >= 0; y--) {
      const b = blocks[x + z * box.width + y * box.width * box.length] ?? '';
      if (SOLID_TOP.test(b)) { heights.set(box.y + y, (heights.get(box.y + y) ?? 0) + 1); break; }
      if (b && !/^(minecraft:)?(air|cave_air|short_grass|tall_grass|fern|leaf_litter|.*_leaves|.*_log|torch|.*flower.*|dandelion|poppy)/.test(b)) break;
    }
  }
  const y = [...heights].sort((a, b) => b[1] - a[1])[0]?.[0] ?? home.y - 1;
  ctx.world.yard = { x1: box.x, z1: box.z, x2: box.x + box.width - 1, z2: box.z + box.length - 1, y };
  return ctx.world.yard;
}

/** Remember a place a project made. */
export function addZone(world: WorldMemory, kind: string, z: { x: number; y: number; z: number; width?: number; length?: number }): void {
  world.zones ??= {};
  (world.zones[kind] ??= []).push(z);
}

/**
 * A step that finds a free w x l spot in the yard (2 blocks clear of buildings, farmland and water, near home) and
 * keeps it in the milestone's data as `site`; with no room, levels a strip beside the yard (never over water) and
 * tries again next time.
 */
export function siteStep(kind: string, width: number, length: number): Step {
  return {
    name: `find room for the ${kind}`,
    run: async (ctx, st) => {
      if (st.data.site) return ok('site chosen');
      const yard = await yardOf(ctx);
      const box = { x: yard.x1, y: yard.y - 1, z: yard.z1, width: yard.x2 - yard.x1 + 1, height: 6, length: yard.z2 - yard.z1 + 1 };
      const grid = occupancy(box, await readBox(ctx, box), yard.y);
      // not the fence: its zone is the ring round the whole yard (as a rectangle it left no room anywhere)
      const avoid = Object.entries(ctx.world.zones ?? {}).filter(([k]) => !RINGS.has(k)).flatMap(([, zs]) => zs).filter(z => z.width && z.length)
        .map(z => ({ x: z.x, z: z.z, width: z.width!, length: z.length! }));
      const site = findSite(grid, width, length, { near: ctx.s.home, clearance: 2, avoidRect: avoid });
      if (site) {
        st.data.site = { ...site, y: yard.y };
        return ok(`${kind} goes at (${site.x}, ${yard.y}, ${site.z})${site.rotated ? ', turned' : ''}`);
      }
      return growStep(ctx, yard, { width, length }, kind);
    }
  };
}

/** What a levelling fills with (fillShort counts cobbled deepslate as cobblestone). */
const FILL_KINDS = ['dirt', 'cobblestone', 'cobbled_deepslate'] as const;

export async function growStep(ctx: GoalContext, yard: Yard, footprint: { width: number; length: number }, kind: string): Promise<StepResult> {
  const m = 24;
  const box = { x: yard.x1 - m, y: yard.y - 4, z: yard.z1 - m, width: yard.x2 - yard.x1 + 1 + 2 * m, height: 14, length: yard.z2 - yard.z1 + 1 + 2 * m };
  const blocks = await readBox(ctx, box);
  const col = (x: number, z: number) => {
    const ix = x - box.x, iz = z - box.z;
    if (ix < 0 || iz < 0 || ix >= box.width || iz >= box.length) return { h: null as number | null, water: false };
    for (let y = box.height - 1; y >= 0; y--) {
      const b = blocks[ix + iz * box.width + y * box.width * box.length] ?? '';
      if (/^(minecraft:)?water/.test(b)) return { h: box.y + y, water: true };
      if (SOLID_TOP.test(b)) return { h: box.y + y, water: false };
    }
    return { h: null, water: false };
  };
  // never toward someone else's build (a friend's base, a village): no side whose strip comes within 16 of one on the
  // surface, or within 8 of something built under ground (a cellar right under the strip)
  const zones = (await ctx.call<{ zones: Zone[] }>('foreign.zones').catch(() => ({ zones: [] as Zone[] }))).zones;
  const theirs = (x: number, z: number) => zones.some(zn => zoneDistance({ x, y: yard.y, z }, zn) < ((zn.surface ?? true) ? YARD_FROM_BUILDS : 8));
  const g = growYard(yard, footprint, { isWater: (x, z) => col(x, z).water, heightAt: (x, z) => col(x, z).h, level: yard.y, forbid: theirs });
  if (!g) return blocked(`no room in the yard for the ${kind}, and no dry land beside it to grow into`, 60 * MINUTE);
  ctx.progress(`growing the yard to the ${g.side} for the ${kind}`);
  const strip = { x1: g.strip.x1, z1: g.strip.z1, x2: g.strip.x2, z2: g.strip.z2, level: yard.y };
  // the fill first: level-area only fills from the pockets, and a shortfall it reports as work still to do never sent
  // anyone for dirt (plot1 re-ran every 5 min for hours, "fill 53 dirt (have 15)", the bot idle in between)
  const p = progressOf(ctx.world);
  // what the fill takes out of the chests is the project's until the strip is level: with 640 cobblestone stored the
  // stash threw the fill's 86 away as glut, and the next try took it out of the chests again. Marked before the fill
  // is fetched (a run stopped between two chests left 200 dirt carried and unmarked), with the time of this try: a
  // growth that is given up never comes back here to clear it, so the mark lapses by itself
  p.fill = [...FILL_KINDS];
  p.fillAt = ctx.s.now;
  const short = await fillShort(ctx, strip);
  // the trips' need is a total, not what's left: met, it goes, or they would keep fetching dirt
  if (!Object.keys(short).length && p.need && Object.keys(p.need).every(k => k === 'dirt' || k === 'cobblestone')) p.need = undefined;
  if (Object.keys(short).length) {
    p.need = short;
    return shortOf(`growing the yard to the ${g.side} for the ${kind}: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')} to fill it (the stock trips fetch it)`, short);
  }
  const r = await ctx.act('level-area', { ...strip, timeoutMs: 8 * MINUTE });
  if (/Now level|Already level/.test(r.text)) {
    p.fill = undefined;
    p.fillAt = undefined;
    ctx.world.yard = { ...g.newYard, y: yard.y };
    // the fence follows the yard: its old side comes down and the ring goes up round the new yard, before the next build
    if (ctx.world.zones?.fence?.length) {
      ctx.world.fenceMove = { side: g.side, old: { x1: yard.x1, z1: yard.z1, x2: yard.x2, z2: yard.z2, y: yard.y } };
      p.done = p.done.filter(id => id !== 'perimeter');
    }
    return going(`grew the yard to the ${g.side} (${g.strip.x1}..${g.strip.x2}, ${g.strip.z1}..${g.strip.z2})`);
  }
  const why = r.text.split('\n').pop()?.slice(0, 100);
  // a leveling that failed outright (part of the area not loaded: the bot was far off) waits; one that got partway
  // goes on next time (it spun 4 times in 15 s on "Failed: Part of the area...")
  if (!r.ok || /^Failed/.test(r.text)) return blocked(`leveling ground to the ${g.side} for the ${kind}: ${why}`, 5 * MINUTE);
  return going(`leveling ground to the ${g.side} for the ${kind}: ${why}`);
}

/** What levelling a box would fill with (level-area's dry run: "fill 53 dirt + 22 cobblestone"). */
export function fillOf(text: string): { dirt: number; cobblestone: number } | undefined {
  const m = /fill (\d+) dirt \+ (\d+) cobblestone/.exec(text);
  return m ? { dirt: Number(m[1]), cobblestone: Number(m[2]) } : undefined;
}

/**
 * Get a levelling's fill into the pockets from the home chests; what's still short (raw materials, as progress.need)
 * the stock trips fetch. Empty when it's all carried.
 */
async function fillShort(ctx: GoalContext, box: { x1: number; z1: number; x2: number; z2: number; level: number }): Promise<Record<string, number>> {
  const dry = await ctx.act('level-area', { ...box, dryRun: true });
  const fill = fillOf(dry.text);
  if (!fill) return {};
  const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
  const has = (re: RegExp) => inv.items.filter(i => i.slot < 36 && re.test(i.name)).reduce((a, i) => a + i.count, 0);
  const short: Record<string, number> = {};
  for (const [item, want, re] of [['dirt', fill.dirt, /^dirt$/], ['cobblestone', fill.cobblestone, /^(cobblestone|cobbled_deepslate)$/]] as const) {
    let have = has(re);
    if (have < want) have += await takeFromChests(ctx, item, want - have);
    if (have < want) short[item] = want - have;
  }
  return short;
}

/**
 * A step that builds a blueprint on the milestone's site: materials first (from the chests, crafted, or left to the
 * stock trips), then build-structure, which only places what's missing, so a stopped build picks up where it was.
 */
export function buildStep(kind: string, plan: (st: MilestoneState) => BuildPlan, label = kind): Step {
  return {
    name: `build the ${label}`,
    bill: () => ({}),
    run: async (ctx, st) => {
      const site = st.data.site as { x: number; z: number; y: number } | undefined;
      if (!site) return blocked('no site chosen', MINUTE);
      // one wood for the whole build (the kind there's most of when it starts; a half-built house stays one wood)
      st.data.wood ??= mostWood(allItems(ctx.s, ctx.world));
      const bp = inWood(plan(st), st.data.wood as string);
      const wood = st.data.wood as string;
      // only what isn't in place yet (a half-built house, a fence moved out), plus the extras the spec doesn't place
      const origin0 = { x: site.x, y: site.y + bp.groundOffset, z: site.z };
      const there = await readBox(ctx, { ...origin0, ...bp.size });
      const left = billLeft(bp.spec, there, bp.size);
      const all = billOf(bp.spec);
      const bill = { ...left };
      for (const [k, n] of Object.entries(bp.bill)) { const extra = n - (all[k] ?? 0); if (extra > 0) bill[k] = (bill[k] ?? 0) + extra; }
      // short of something that's slow to come (the enchanting room's cane and leather for its books, for days):
      // the trips are sent for it and nothing is taken out of the chests yet, and nothing is kept carried, so the
      // stash puts the rest away. Taken out and kept for the whole wait, 128 planks, 64 logs and 47 sticks sat in the
      // pockets and every trip waited for room
      const dry = rawShort(bill, allItems(ctx.s, ctx.world));
      if (Object.keys(dry).length) {
        const p = progressOf(ctx.world);
        p.need = dry;
        p.carry = p.carryCap = undefined;
        return shortOf(`gathering for the ${label}: short of ${Object.entries(dry).map(([k, v]) => `${v} ${k}`).join(', ')}`, dry);
      }
      // all there: what the bill is crafted from stays carried while it's made and built (the enchanting room's books,
      // diamonds and obsidian were taken out and put back every 15 s otherwise)
      progressOf(ctx.world).carry = [...new Set([...billCarry(bp.bill, wood), `${wood}_log`, `${wood}_planks`, 'stick'])];
      progressOf(ctx.world).carryCap = billCarryCap(bill, ctx.s.counts, wood);
      const short = await prepareBill(ctx, bill);
      if (Object.keys(short).length) {
        return shortOf(`gathering for the ${label}: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}`, short);
      }
      const origin = { x: site.x, y: site.y + bp.groundOffset, z: site.z };
      const r = await ctx.act('build-structure', { ...origin, spec: bp.spec, name: bp.name, timeoutMs: 8 * MINUTE });
      if (/all \d+ blocks in place/.test(r.text)) {
        for (const l of bp.landmarks) addZone(ctx.world, `${kind}:${l.kind}`, { x: origin.x + l.at.x, y: origin.y + l.at.y, z: origin.z + l.at.z });
        addZone(ctx.world, kind, { x: site.x, y: site.y, z: site.z, width: bp.size.width, length: bp.size.length });
        ctx.world.landmarks.foundAt = 0; // look for the new chests, beds and tables
        progressOf(ctx.world).carry = progressOf(ctx.world).carryCap = undefined;
        return ok(`${label} built at (${origin.x}, ${origin.y}, ${origin.z})`);
      }
      // the whole story in the log (what couldn't be placed and why), a line in the journal
      ctx.progress(r.text.replace(/\s+/g, ' ').slice(0, 600));
      return going(r.text.split('\n')[0].slice(0, 140));
    }
  };
}
