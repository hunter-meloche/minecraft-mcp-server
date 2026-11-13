import { nearHome, type Goal, type GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { storageHouse, STORAGE_HOUSE_MAX_CHESTS, type Side } from './blueprints.js';
import { key, peekChest } from './chests.js';
import { prepare } from './project.js';
import { readCells } from './repair.js';
import { assignChests, CATEGORIES, giveChests } from './storage.js';

/**
 * The storage house's chests kept up: one that went missing (broken by a player, a creeper) is put back where the
 * house has it, and when a kind of thing has no room left (the stash's storageFull) the next double chest goes in,
 * up to the house's six on the ground and as many again in each of two layers stacked on them. The chests it finds are
 * the home's chests from then on.
 *
 * Before this, storageFull was only noted: the pockets filled to 35/36 with dirt and seeds, the project goal (which
 * waits for room) never ran, and the bot idled a whole day. The landmark list had also lost one of the house's four
 * double chests, so the stash never put anything in it.
 */

const MINUTE = 60_000;
/** Look the house over this often anyway (a chest broken by a player shows only when it's looked at). */
const CHECK_EVERY = 30 * MINUTE;

export interface ChestCell { at: Pos; state: string }

/** Layers of chests in the storage house: the ground row and two stacked on it (its walls are 4 high). */
export const STORAGE_LAYERS = 3;

const AIR = /^(minecraft:)?(air|cave_air|void_air)$/;
const isChest = (b: string | null | undefined) => /^(minecraft:)?(chest|trapped_chest|barrel)(\[|$)/.test(b ?? '');

/** The side of the storage site its door is on. */
function doorSide(site: { x: number; z: number; width: number; length: number }, door?: { x: number; z: number }): Side {
  if (!door) return 'south';
  if (door.z === site.z) return 'north';
  if (door.z === site.z + site.length - 1) return 'south';
  if (door.x === site.x) return 'west';
  return 'east';
}

/**
 * Every chest cell the storage house can hold (six double chests), in the order they go in (the back first, the
 * west row before the east), in world coordinates with the state each half wants. Empty with no storage house.
 */
export function storageChestCells(world: WorldMemory): ChestCell[] {
  const z = world.zones?.storage?.[0];
  if (!z?.width || !z.length) return [];
  const site = { x: z.x, z: z.z, width: z.width, length: z.length };
  const bp = storageHouse({ chests: STORAGE_HOUSE_MAX_CHESTS, doorSide: doorSide(site, world.zones?.['storage:door']?.[0]) });
  const y0 = z.y + bp.groundOffset;
  const cells: (ChestCell & { pair: number })[] = [];
  bp.landmarks.filter(l => l.kind === 'chest').forEach((l, i) => {
    const ch = bp.spec.layers[l.at.y]?.[l.at.z]?.[l.at.x] ?? ' ';
    const state = bp.spec.palette[ch];
    if (state) cells.push({ at: { x: z.x + l.at.x, y: y0 + l.at.y, z: z.z + l.at.z }, state, pair: Math.floor(i / 2) });
  });
  // the blueprint lists a row's pairs from the back: interleave the rows, pair by pair
  const rows = [...new Set(cells.map(c => c.state.replace(/,type=\w+/, '')))];
  const byRow = rows.map(r => cells.filter(c => c.state.replace(/,type=\w+/, '') === r));
  const ground: ChestCell[] = [];
  for (let i = 0; byRow.some(r => r.length > i); i += 2) for (const r of byRow) ground.push(...r.slice(i, i + 2));
  // then stacked on those, layer by layer: a chest opens with another chest on its lid (it's no solid block), and the
  // house's walls are 4 high, so two more layers fit with air over the top one (a chest under the roof wouldn't open).
  // The full house had six double chests and no room left; this makes eighteen
  const out: ChestCell[] = [];
  for (let layer = 0; layer < STORAGE_LAYERS; layer++) out.push(...ground.map(c => ({ at: { ...c.at, y: c.at.y + layer }, state: c.state })));
  return out;
}

export interface StoragePlan {
  /** cells of the house's chests that stand no more: put back */
  replace: ChestCell[];
  /** the next double chest, for a kind with no room */
  add: ChestCell[];
  /** the house holds all six and a kind still has no room */
  maxed: boolean;
  /** the chests standing in the house (one per container: left halves and singles) */
  standing: Pos[];
}

/**
 * What to do about the house's chests, from what stands in its chest cells. A cell is "the house's" once a chest
 * stood there (zones storage:chest, written as chests go in): those are put back. A kind without room adds the next
 * pair of cells that never had one.
 */
export function storagePlan(cells: ChestCell[], blocks: (string | null)[], built: Set<string>, full: string[]): StoragePlan {
  const replace: ChestCell[] = [];
  const free: ChestCell[] = [];
  const standing: Pos[] = [];
  let unseen = 0;
  cells.forEach((c, i) => {
    const b = blocks[i];
    if (b === null || b === undefined) { unseen++; return; } // not loaded: no news
    if (isChest(b)) { if (!/type=right/.test(b)) standing.push(c.at); return; }
    if (built.has(key(c.at))) replace.push(c);
    else if (AIR.test(b)) free.push(c);
  });
  let add: ChestCell[] = [];
  if (full.length && !replace.length) {
    // the next whole pair, both cells free; else the next free cell alone (a label sign or a single chest beside it)
    for (let i = 0; i + 1 < cells.length; i += 2) {
      if (free.includes(cells[i]) && free.includes(cells[i + 1])) { add = [cells[i], cells[i + 1]]; break; }
    }
    if (!add.length && free.length) add = [free[0]];
  }
  return { replace, add, maxed: !!full.length && !unseen && !replace.length && !add.length, standing };
}

/** A build-structure spec placing these cells (each with its state), and where it goes. */
export function chestSpec(cells0: ChestCell[]): { origin: Pos; spec: { palette: Record<string, string>; layers: string[][] } } {
  // by facing only: a chest joins its neighbour or stands single, and either is storage. Asked for left and right
  // halves, the first went in single, the second couldn't make the pair, and the build gave up on both
  const cells = cells0.map(c => ({ ...c, state: c.state.replace(/,?type=\w+/, '').replace('[]', '') }));
  const min = (k: keyof Pos) => Math.min(...cells.map(c => c.at[k]));
  const max = (k: keyof Pos) => Math.max(...cells.map(c => c.at[k]));
  const o = { x: min('x'), y: min('y'), z: min('z') };
  const W = max('x') - o.x + 1, H = max('y') - o.y + 1, L = max('z') - o.z + 1;
  const states = [...new Set(cells.map(c => c.state))];
  const palette = Object.fromEntries(states.map((s, i) => [String.fromCharCode(65 + i), s]));
  const ch = (s: string) => String.fromCharCode(65 + states.indexOf(s));
  const layers: string[][] = [];
  for (let y = 0; y < H; y++) {
    const rows: string[] = [];
    for (let z = 0; z < L; z++) {
      let row = '';
      for (let x = 0; x < W; x++) {
        const c = cells.find(q => q.at.x === o.x + x && q.at.y === o.y + y && q.at.z === o.z + z);
        row += c ? ch(c.state) : ' ';
      }
      rows.push(row);
    }
    layers.push(rows);
  }
  return { origin: o, spec: { palette, layers } };
}

/** Put chests in these cells: crafted first (planks from logs), then placed by the build tool, facing as the house has them. */
async function placeChests(ctx: GoalContext, cells: ChestCell[]): Promise<number> {
  const short = await prepare(ctx, 'chest', cells.length);
  if (Object.keys(short).length) throw new Error(`short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')} for ${cells.length} chest(s)`);
  let placed = 0;
  // a row's pair at a time (a build box over two rows would span the aisle)
  for (let i = 0; i < cells.length; i += 2) {
    const part = cells.slice(i, i + 2);
    const { origin, spec } = chestSpec(part);
    const r = await ctx.act('build-structure', { ...origin, spec, name: 'storage_chests', timeoutMs: 120_000 });
    ctx.progress(r.text.split('\n')[0].slice(0, 140));
    const now = await readCells(ctx, part.map(c => c.at));
    placed += now.filter(b => /chest/.test(b ?? '')).length;
  }
  return placed;
}

const chestCellsKey = 'storage:chest';

export const storageGoal: Goal = {
  name: 'storage',
  // just under the stash: full pockets with nowhere to put things stop everything else (the projects wait for room)
  priority: 58,
  timeoutMs: 8 * MINUTE,
  retryMs: 10 * MINUTE,
  wants: (s, world) => {
    if (s.sleeping || s.activity !== 'work' || s.dimension !== 'overworld' || !s.home || !nearHome(s, 16)) return null;
    if (!world.zones?.storage?.length) return null; // no storage house yet: the storage milestone builds it
    const last = world.lastDone?.storage ?? 0;
    if (world.storageFull?.length) {
      // the house full up: once in a while, in case things were taken out
      if (world.storageMaxedAt && s.now - world.storageMaxedAt < 6 * 60 * MINUTE) return null;
      return `no room for ${world.storageFull.join(', ')}`;
    }
    return s.now - last > CHECK_EVERY ? 'look over the storage chests' : null;
  },
  run: async ctx => {
    (ctx.world.lastDone ??= {}).storage = ctx.s.now;
    const cells = storageChestCells(ctx.world);
    if (!cells.length) return 'no storage house';
    const did: string[] = [];
    // an empty chest another category can spare comes before a new one
    if (ctx.world.storageFull?.length) {
      const before = assignChests(ctx.world.landmarks.chests, CATEGORIES, ctx.world.chestItems ?? {}, ctx.world.chestAssign ?? {});
      const lent = giveChests(before, ctx.world.chestItems ?? {}, ctx.world.storageFull);
      ctx.world.chestAssign = lent.assign;
      const served = ctx.world.storageFull.filter(c => !lent.short.includes(c));
      if (served.length) did.push(`gave an empty chest to ${served.join(', ')}`);
      if (lent.short.length) ctx.world.storageFull = lent.short;
      else { delete ctx.world.storageFull; return did.join('; '); }
    }
    const blocks = await readCells(ctx, cells.map(c => c.at));
    const built = new Set((ctx.world.zones?.[chestCellsKey] ?? []).map(p => key(p)));
    const plan = storagePlan(cells, blocks, built, ctx.world.storageFull ?? []);
    if (plan.replace.length) {
      const n = await placeChests(ctx, plan.replace);
      did.push(`put back ${n}/${plan.replace.length} chest half(s)`);
    }
    if (plan.add.length) {
      const n = await placeChests(ctx, plan.add);
      if (n) {
        const zones = (ctx.world.zones ??= {});
        const stand = await readCells(ctx, plan.add.map(c => c.at));
        zones[chestCellsKey] = [...(zones[chestCellsKey] ?? []), ...plan.add.filter((_, i) => /chest/.test(stand[i] ?? '')).map(c => c.at)];
      }
      did.push(n ? `added ${n} chest(s) at (${plan.add[0].at.x}, ${plan.add[0].at.y}, ${plan.add[0].at.z}) for ${ctx.world.storageFull!.join(', ')}`
        : `couldn't add a chest at (${plan.add[0].at.x}, ${plan.add[0].at.y}, ${plan.add[0].at.z})`);
    }
    if (plan.maxed) {
      ctx.world.storageMaxedAt = ctx.s.now;
      did.push(`the storage house holds all ${STORAGE_HOUSE_MAX_CHESTS * STORAGE_LAYERS} double chests and there's still no room for ${ctx.world.storageFull!.join(', ')}`);
    } else {
      delete ctx.world.storageMaxedAt;
    }
    // the home's chests, as they stand now: the house's (one per container), and any outside it
    const after = await readCells(ctx, cells.map(c => c.at));
    const standing = storagePlan(cells, after, built, []).standing;
    const inHouse = new Set(cells.map(c => key(c.at)));
    const others = ctx.world.landmarks.chests.filter(c => !inHouse.has(key(c)));
    const before = new Set(ctx.world.landmarks.chests.map(key));
    ctx.world.landmarks.chests = [...standing, ...others];
    const found = standing.filter(c => !before.has(key(c)));
    for (const c of found) await peekChest(ctx, c).catch(() => undefined);
    if (found.length) did.push(`${found.length} chest(s) now counted that weren't`);
    // the chests just built belong to the categories they were built for
    if (plan.add.length && found.length && ctx.world.storageFull?.length) {
      const now = assignChests(ctx.world.landmarks.chests, CATEGORIES, ctx.world.chestItems ?? {}, ctx.world.chestAssign ?? {});
      ctx.world.chestAssign = giveChests(now, ctx.world.chestItems ?? {}, ctx.world.storageFull, found.map(c => key(c))).assign;
    }
    // a chest gone from the list is gone for the stash's sorting too
    for (const k of Object.keys(ctx.world.chestItems ?? {})) if (inHouse.has(k) && !standing.some(c => key(c) === k)) delete ctx.world.chestItems![k];
    if (plan.add.length || plan.replace.length || found.length) delete ctx.world.storageFull; // the stash finds out again
    return did.join('; ') || `all ${standing.length} chest(s) in place`;
  }
};
