import { fromGate, no, onHomeLevel, outsideBy, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { stepOf, type Milestone, type MilestoneState, type Step, type StepResult } from './progress.js';
import { buildStep, siteStep } from './milestones.js';
import { WART_STRIP, wartStrip } from './blueprints.js';
import { freeChestTotals, takeFromChests } from './chests.js';
import { makeRoom, noRoom, room } from './pockets.js';
import { holdHarmless } from './fluidpick.js';
import { NATURAL } from './site.js';
import type { InventoryItem } from '../tools.js';

/**
 * The nether wart farm (P4 of the progression plan): a strip of soul sand in the yard, two rows of six with a walk
 * between (blueprints.ts wartStrip: 12 cells on a 3 x 6 site that the site step finds as it finds every build's,
 * 2 clear of everything built, farmed or wet, off every zone and the sites the other milestones keep), the wart planted
 * from the fortress's few, and a round that harvests what is ripe (age 3: two to four wart a plant) and plants it again.
 * The brewing takes its wart from what this keeps beyond its replanting (brewing.ts wartKeep). Soul sand and wart come
 * only from the Nether (the fortress trips: wart and soul sand from under it; the barter: soul sand): until the home
 * has both the milestone waits, and says so.
 *
 * Nothing here is used at the module's top level but its own constants: the strip's build step is made at its first use
 * (portal.ts frameBuild has why).
 */

const MINUTE = 60_000;
const ID = 'wart-farm';
/** The zone the strip's build puts down (and `wart:cell`, `wart:walk`, its landmarks). */
export const ZONE = 'wart';
/** The strip's wart cells: two rows of its length. */
export const WART_CELLS = 2 * WART_STRIP.length;
/** The wart the round harvests up to (carried and in the chests): past it the ripe wart stays on the plant, nothing lost. */
export const WART_STOCK = 64;
/** A round at most this often: a plant grows a stage in some 11 min of random ticks (10% of each, 3 a chunk section a tick), ripe in about 35. */
export const WART_EVERY = 40 * MINUTE;
/** The waits for a harvest's drops (a test sets pollMs to nothing; the counts stand). */
export const WART_WAITS = { pollMs: 250, looks: 6 };

/** The wart farm's memory: the round's last look, and the cells it found bare (the brewing keeps wart for them). */
export interface WartMemory { at?: number; bare?: number; ripe?: number; growing?: number }

const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const ok = (text: string): StepResult => ({ status: 'done', text });
const blocked = (text: string, retryMs = 10 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });
const going = (text: string): StepResult => ({ status: 'progress', text });
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
const AIRY = /^(air|cave_air|short_grass|tall_grass|fern|leaf_litter|dandelion|poppy)$/;
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> => (await ctx.call<{ items: InventoryItem[] }>('inventory')).items;
const wartCarried = async (ctx: GoalContext) => (await inventory(ctx)).filter(i => i.slot >= 0 && i.slot < 36 && i.name === 'nether_wart').reduce((a, i) => a + i.count, 0);

/** How much of a kind the home has: carried and in the chests beyond what the jobs hold. */
const homeHas = (s: Pick<Snapshot, 'counts'>, world: WorldMemory, kind: string) => (s.counts.get(kind) ?? 0) + (freeChestTotals(world)[kind] ?? 0);

/** What the strip waits for from the Nether, pure, or undefined when the home has it: its soul sand and a wart to plant. */
export function wartWaits(s: Pick<Snapshot, 'counts'>, world: WorldMemory): string | undefined {
  const sand = homeHas(s, world, 'soul_sand'), wart = homeHas(s, world, 'nether_wart');
  if (sand >= WART_CELLS && wart >= 1) return undefined;
  return `the wart farm waits on the Nether: ${sand} of ${WART_CELLS} soul sand, ${wart} nether wart at home (the fortress and the barter bring them)`;
}

// ------------------------------------------------------------------------------------------------ a cell's look, pure

/** A wart cell as a region read shows it: ripe (age 3), growing, bare (open, soul sand under it), or something else there. */
export type WartCell = 'ripe' | 'growing' | 'bare' | 'other';

/** A cell's state from its block (with its state: `nether_wart[age=3]`) and the one under it. */
export function wartCell(block: string | null | undefined, under: string | null | undefined): WartCell {
  const b = (block ?? '').replace(/^minecraft:/, '');
  const name = b.replace(/\[.*$/, '');
  const u = (under ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
  if (name === 'nether_wart') return /age=3/.test(b) ? 'ripe' : 'growing';
  return AIRY.test(name) && u === 'soul_sand' ? 'bare' : 'other';
}

/** The walk cell beside a wart cell (the strip's walk runs between its rows). */
export function walkFor(cell: Pos, walks: readonly Pos[]): Pos | undefined {
  return walks.find(w => w.y === cell.y && Math.abs(w.x - cell.x) + Math.abs(w.z - cell.z) === 1);
}

// ------------------------------------------------------------------------------------------------ tending the strip

/** What a look and a tending of the strip came to. */
export interface Tended { harvested: number; planted: number; got: number; ripe: number; growing: number; bare: number; other: number; unreached: number }

/**
 * The strip seen to: its cells read (the wart's layer and the soul sand under it), then, walk cell by walk cell in
 * order (on foot only, A11: the walk between the rows), the ripe ones on either side harvested when `harvest` says so
 * (dig.here from where it stands: no walk, nothing else broken), the drops waited for as they fall onto the soul sand
 * beside the bot (the game lets no one take a drop for its first half second), and the bare ones planted from what is
 * carried (a few from the chests first: one a bare cell). A cell with something else in it is left be. Counts at the end
 * are as the strip stands then.
 */
export async function tendStrip(ctx: GoalContext, harvest: boolean): Promise<Tended> {
  const cells = (ctx.world.zones?.[`${ZONE}:cell`] ?? []).map(c => ({ x: c.x, y: c.y, z: c.z }));
  const walks = (ctx.world.zones?.[`${ZONE}:walk`] ?? []).map(c => ({ x: c.x, y: c.y, z: c.z }));
  const out: Tended = { harvested: 0, planted: 0, got: 0, ripe: 0, growing: 0, bare: 0, other: 0, unreached: 0 };
  if (!cells.length) return out;
  const xs = cells.map(c => c.x), zs = cells.map(c => c.z);
  const box = { x: Math.min(...xs), y: cells[0].y - 1, z: Math.min(...zs), width: Math.max(...xs) - Math.min(...xs) + 1, height: 2, length: Math.max(...zs) - Math.min(...zs) + 1 };
  const read = async () => {
    const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', box);
    const at = (p: Pos) => blocks[(p.x - box.x) + (p.z - box.z) * box.width + (p.y - box.y) * box.width * box.length];
    return (c: Pos) => wartCell(at(c), at({ ...c, y: c.y - 1 }));
  };
  let look = await read();
  const bare = cells.filter(c => look(c) === 'bare').length + (harvest ? cells.filter(c => look(c) === 'ripe').length : 0);
  const before = await wartCarried(ctx);
  if (bare > before) await takeFromChests(ctx, 'nether_wart', bare - before).catch(() => 0);
  const start = await wartCarried(ctx);
  await holdHarmless(ctx);
  const plant = async (c: Pos) => {
    if ((await wartCarried(ctx)) < 1) return;
    const r = await ctx.act('place-block', { ...c, item: 'nether_wart', faceDirection: 'down' });
    if (/^Placed/.test(r.text)) { out.planted++; ctx.gain(1); }
  };
  for (const w of walks) {
    if (ctx.signal.aborted) break;
    const beside = cells.filter(c => { const f = walkFor(c, walks); return !!f && same(f, w); });
    const work = beside.filter(c => (harvest && look(c) === 'ripe') || look(c) === 'bare');
    if (!work.length) continue;
    const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...w, range: 0, careful: true, timeoutMs: 45_000 }, 60_000).catch(() => ({ arrived: false }));
    if (walk?.arrived === false) { out.unreached += work.length; continue; }
    for (const c of work) {
      if (ctx.signal.aborted) break;
      if (look(c) === 'ripe') {
        const d = await ctx.call<{ dug: boolean; reason?: string }>('dig.here', { ...c, timeoutMs: 10_000 }, 20_000).catch((e: unknown) => ({ dug: false, reason: e instanceof Error ? e.message : String(e) }));
        if (!d.dug) { ctx.progress(`wart cell ${fmt(c)}: not harvested (${d.reason ?? 'not dug'})`); continue; }
        out.harvested++;
        ctx.gain(1);
        await pickUp(ctx, c);
      }
      await plant(c);
    }
    look = await read();
  }
  look = await read();
  for (const c of cells) out[look(c)]++;
  out.got = Math.max(0, (await wartCarried(ctx)) - start + out.planted);
  return out;
}

/** The harvest's drops picked up before the bot walks on: a moment for them to fall, then until none lies by the cell (WART_WAITS.looks at most). */
async function pickUp(ctx: GoalContext, c: Pos): Promise<void> {
  for (let i = 0; i < WART_WAITS.looks; i++) {
    await pause(WART_WAITS.pollMs);
    if (ctx.signal.aborted) throw new Error('aborted');
    const lying = (await ctx.call<{ entities?: { item?: string; position: Pos }[] }>('world.entities', { maxDistance: 8, type: 'item' })
      .catch(() => undefined))?.entities ?? [];
    if (!lying.some(e => e.item === 'nether_wart' && Math.hypot(e.position.x - c.x - 0.5, e.position.z - c.z - 0.5) <= 1.5 && e.position.y >= c.y - 1 && e.position.y <= c.y + 2)) return;
  }
}

/** The strip in words: `5 ripe, 4 growing, 3 bare`. */
const stripWords = (t: Tended) => [`${t.ripe} ripe`, `${t.growing} growing`, `${t.bare} bare`, ...(t.other ? [`${t.other} with something else in them`] : [])].join(', ');

/** What the round found, into the farm's memory (the brewing keeps wart for the bare cells). */
function note(world: WorldMemory, t: Tended, now: number): void {
  world.wart = { at: now, bare: t.bare, ripe: t.ripe, growing: t.growing };
}

// ------------------------------------------------------------------------------------------------ the milestone

/** The strip of a milestone's data: along its site's long side (the site step may turn the 3 x 6). */
const planOf = (st: MilestoneState) => {
  const site = st.data.site as { width?: number; length?: number } | undefined;
  return wartStrip({ along: site && (site.width ?? 0) > (site.length ?? 0) ? 'x' : 'z' });
};

/** The soul sand and the wart from the Nether (wartWaits): a wait the project cannot end by itself (`waits`), said as it is. */
export const netherStep: Step = {
  name: 'soul sand and nether wart from the Nether',
  waits: v => wartWaits(v.s, v.world),
  run: async ctx => {
    const why = wartWaits(ctx.s, ctx.world);
    return why ? blocked(why, 30 * MINUTE) : ok(`${WART_CELLS} soul sand and nether wart at home`);
  }
};

let stripMade: Step | undefined;
const stripBuild = (): Step => (stripMade ??= buildStep(ZONE, planOf, 'wart farm\'s soul sand'));

/** The strip's build (buildStep: its cells and walk cleared, the zone `wart` and its `wart:cell` and `wart:walk`). */
export const buildStripStep: Step = {
  name: 'build the wart farm\'s soul sand',
  bill: view => stripBuild().bill?.(view) ?? {},
  run: async (ctx, st) => stripBuild().run(ctx, st)
};

/**
 * What may be lifted for a wart cell's soul sand: the yard's own ground (nothing built, nothing anyone put there), every
 * kind the site step finds free (site.ts NATURAL: a site over the stone a levelling cut bared, or over sand, had that
 * cell left be at every run, and the milestone never got past it), and a path.
 */
const GROUND = (b: string) => NATURAL.test(b) || b === 'dirt_path';
/** A dig of one ground block from beside it (dig.here holds the tool for it): deepslate by hand is 15 s. */
const GROUND_DIG_MS = 30_000;
const AIR = /^(air|cave_air|void_air)$/;
/** The ground cell under a wart cell, where its soul sand goes. */
const sandOf = (c: Pos): Pos => ({ x: c.x, y: c.y - 1, z: c.z });

/**
 * The soul sand set into the ground under each wart cell, from the walk beside it (on foot, A11), cell by cell: the
 * bridge's own dig of that one block of the yard's ground (dig.here: no Baritone, nothing else broken; the strip's build
 * placed nothing in the ground for that, blueprints.ts wartStrip), then the soul sand placed in its hole and the cell
 * read again. A cell over something other than the yard's ground is left be. The soul sand comes from the chests (the
 * Nether brings it: netherStep waited for it).
 */
export const sandStep: Step = {
  name: 'set the wart farm\'s soul sand into the ground',
  run: async ctx => {
    const cells = (ctx.world.zones?.[`${ZONE}:cell`] ?? []).map(c => ({ x: c.x, y: c.y, z: c.z }));
    const walks = (ctx.world.zones?.[`${ZONE}:walk`] ?? []).map(c => ({ x: c.x, y: c.y, z: c.z }));
    if (!cells.length) return blocked('no strip built', MINUTE);
    const xs = cells.map(c => c.x), zs = cells.map(c => c.z);
    const box = { x: Math.min(...xs), y: cells[0].y - 1, z: Math.min(...zs), width: Math.max(...xs) - Math.min(...xs) + 1, height: 1, length: Math.max(...zs) - Math.min(...zs) + 1 };
    const read = async () => {
      const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', box);
      return (p: Pos) => (blocks[(p.x - box.x) + (p.z - box.z) * box.width] ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
    };
    let look = await read();
    const todo = cells.filter(c => look(sandOf(c)) !== 'soul_sand');
    if (!todo.length) return ok(`soul sand under all ${cells.length} wart cells`);
    const sand = async () => (await inventory(ctx)).filter(i => i.slot >= 0 && i.slot < 36 && i.name === 'soul_sand').reduce((a, i) => a + i.count, 0);
    const had = await sand();
    if (had < todo.length) await takeFromChests(ctx, 'soul_sand', todo.length - had).catch(() => 0);
    if (!(await sand())) return { status: 'blocked', text: `no soul sand to set under ${todo.length} wart cell(s)`, retryMs: 30 * MINUTE, need: { soul_sand: todo.length } };
    await holdHarmless(ctx);
    let other = 0, unreached = 0;
    for (const w of walks) {
      if (ctx.signal.aborted) break;
      const here = todo.filter(c => { const f = walkFor(c, walks); return !!f && same(f, w); });
      if (!here.length) continue;
      const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...w, range: 0, careful: true, timeoutMs: 45_000 }, 60_000).catch(() => ({ arrived: false }));
      if (walk?.arrived === false) { unreached += here.length; continue; }
      for (const c of here) {
        if (ctx.signal.aborted || !(await sand())) break;
        const g = sandOf(c);
        const b = look(g);
        if (b === 'soul_sand') continue;
        if (!AIR.test(b)) {
          if (!GROUND(b)) { other++; ctx.progress(`wart cell ${fmt(c)}: ${b || 'nothing known'} under it: left be`); continue; }
          const d = await ctx.call<{ dug: boolean; reason?: string }>('dig.here', { ...g, timeoutMs: GROUND_DIG_MS }, GROUND_DIG_MS + 10_000).catch((e: unknown) => ({ dug: false, reason: e instanceof Error ? e.message : String(e) }));
          if (!d.dug) { ctx.progress(`wart cell ${fmt(c)}: its ${b} not dug (${d.reason ?? 'not dug'})`); continue; }
        }
        await ctx.act('place-block', { ...g, item: 'soul_sand', faceDirection: 'down' });
      }
      look = await read();
    }
    look = await read();
    const left = cells.filter(c => look(sandOf(c)) !== 'soul_sand');
    if (!left.length) return ok(`soul sand set under all ${cells.length} wart cells`);
    const why = `${other ? `, ${other} over something else` : ''}${unreached ? `, ${unreached} out of reach on foot` : ''}`;
    if (left.length < todo.length) return going(`soul sand under ${cells.length - left.length} of ${cells.length} wart cells${why}`);
    return blocked(`no soul sand set under the wart cells (${left.length} left${why})`);
  }
};

/**
 * The wart planted in the strip's cells (tendStrip, nothing harvested): done once every cell has wart, or some have and
 * none is left to plant (the round plants the rest as the harvests come); none at all to plant: short of it.
 */
export const plantStep: Step = {
  name: 'plant the nether wart',
  run: async ctx => {
    if (!ctx.world.zones?.[`${ZONE}:cell`]?.length) return blocked('no strip built', MINUTE);
    const t = await tendStrip(ctx, false);
    note(ctx.world, t, ctx.s.now);
    const growing = t.ripe + t.growing;
    if (!t.bare) return ok(`nether wart in all ${growing} cell(s) of the farm (planted ${t.planted} now)`);
    if (t.unreached) return blocked(`${t.unreached} wart cell(s) out of reach on foot; ${stripWords(t)}`);
    if (growing && !(await wartCarried(ctx)) && !(freeChestTotals(ctx.world).nether_wart ?? 0)) {
      return ok(`planted ${t.planted}: ${growing} of ${growing + t.bare} cells growing (the round plants the rest as the wart comes)`);
    }
    if (!growing) return { status: 'blocked', text: 'no nether wart to plant', retryMs: 30 * MINUTE, need: { nether_wart: 1 } };
    return going(`planted ${t.planted}; ${stripWords(t)}`);
  }
};

/**
 * The wart farm (P4), after the brewing stand: the soul sand and the wart from the Nether first (it waits on them), a
 * site, the strip cleared, its soul sand set in, the wart planted. Done once the world shows it: its zone, and nothing of it left to do.
 */
export function wartFarmMilestone(prereqs: string[]): Milestone {
  return {
    id: ID,
    title: 'a nether wart farm',
    prereqs,
    done: v => !!v.world.zones?.[ZONE]?.length && !(stepOf(v.world.progress, ID) > 0),
    steps: [netherStep, siteStep('wart farm', WART_STRIP.width, WART_STRIP.length), buildStripStep, sandStep, plantStep]
  };
}

// ------------------------------------------------------------------------------------------------ the round

/** In the yard (inside the fence line) on home's level: from where the strip is a walk on foot. */
const inYard = (s: Snapshot, world: WorldMemory) =>
  !!world.yard && !!s.home && s.dimension === 'overworld' && outsideBy(world.yard, s.position) === 0 && onHomeLevel(s.position, s.home);

/**
 * Run now? The "no" in this order: no farm (none, or not planted yet); enough wart at home and no cell bare to plant
 * (the ripe ones stay on the plant meanwhile); not due; then not in the yard, no room for the harvest; the hour last.
 */
const gate = (s: Snapshot, world: WorldMemory): Gate => {
  if (!world.zones?.[`${ZONE}:cell`]?.length) return { cause: 'unneeded', text: 'no wart farm' };
  if (!world.progress?.done?.includes(ID)) return { cause: 'unneeded', text: 'the wart farm is not planted yet' };
  const have = homeHas(s, world, 'nether_wart');
  const bare = world.wart?.bare ?? 0;
  if (have >= WART_STOCK && !(bare > 0)) return { cause: 'stocked', text: `enough nether wart at home (${have} of ${WART_STOCK})` };
  const last = world.lastDone?.wart ?? 0;
  if (!(s.now - last > WART_EVERY)) return no.notDue('wart', s.now, last, WART_EVERY);
  if (!inYard(s, world)) {
    return { cause: 'away', text: !s.home ? 'no home set' : s.dimension !== 'overworld' ? `in ${s.dimension}` : `${Math.round(s.distHome)} blocks from home, not in the yard on home's level (the wart round works from the yard)` };
  }
  if (room('yard', s, world) === 'no') return noRoom('yard', 'wart', s, world);
  return no.late(s, 'wart') ?? { want: 'round: the nether wart' };
};

/**
 * Every WART_EVERY: the ripe wart harvested (while the home has fewer than WART_STOCK) and planted again, the bare
 * cells planted, from the walk between the rows (tendStrip). What it found is kept for the brewing (world.wart). A
 * round stopped before it saw to a cell has not been done (as the cane's: its mark goes back).
 */
export const wartRound: Goal = {
  name: 'wart',
  priority: 29,
  timeoutMs: 5 * MINUTE,
  retryMs: 30 * MINUTE,
  gate,
  ...fromGate(gate),
  // a round that harvests nothing and plants nothing is busy time to no gain
  gains: true,
  run: async ctx => {
    const s = await makeRoom(ctx, 'yard');
    const marked = ctx.world.lastDone?.wart;
    const now = ctx.s.now;
    (ctx.world.lastDone ??= {}).wart = now;
    let t: Tended | undefined;
    try {
      t = await tendStrip(ctx, homeHas(s, ctx.world, 'nether_wart') < WART_STOCK);
      note(ctx.world, t, now);
      return `harvested ${t.harvested} wart plant(s) (${t.got} wart), planted ${t.planted}; ${stripWords(t)}${t.unreached ? `; ${t.unreached} cell(s) out of reach on foot` : ''}`;
    } finally {
      if (ctx.signal.aborted && !t?.harvested && !t?.planted) {
        if (marked === undefined) delete ctx.world.lastDone!.wart;
        else ctx.world.lastDone!.wart = marked;
      }
    }
  }
};
