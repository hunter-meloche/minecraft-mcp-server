/**
 * Quartz by its own Nether-side portal (P3a of the progression plan, stage 1 of the Nether trips, beside the barter).
 *
 * The trip (worktasks.ts NETHER_WORK `quartz`, from stage 1 while the home holds less quartz than its target, nether.ts
 * NETHER_STOCK's 64, carried and stored together): the Nether kit at home, through the home portal into its own hut
 * (anywhere else: the link is broken the one way, as the barter and the look have it: straight back, the setup held a
 * day), and out on foot. It reads the ground round its portal once and mines nether_quartz_ore within 24 of it:
 * - only ore the Nether left with a face open to air, as that one read has it: no tunnelling (nothing but the ore is
 *   dug, and an ore a dig bared behind another is left where it is);
 * - none with lava or fire within 2 of it, nor of the cell it stands on to dig it;
 * - none more than 4 under its portal's floor (the obsidian it stands on in the portal), nor standing lower;
 * - none of its own hut's walls or of the ground its portal stands on (within 4 of the portal);
 * - none within 16 of anyone's Nether build or of a natural fortress or bastion (the bridge's zones), none within 2 of a
 *   block only a player puts down there (cobblestone), and every walk 16 from the zones too;
 * - none under a block that falls (gravel would come down into the hole, or onto the bot), and no floor over a hole;
 * - at most 32 ore a trip.
 * Each from a cell a careful walk reaches (nothing broken or placed on the way, no lava within 2, never at a drop's
 * edge), with an open face of the ore in sight and reach, by its own hand (the bridge's dig.here: no walk and no
 * Baritone, so nothing else is broken; it refuses anyone's build, and a lit portal's frame, by itself), never the block
 * it stands on; what the ore drops is picked up on foot, never by lava.
 *
 * It stops at the trip's 32 ore or its time (45 s kept for the way back), the quartz at its target, on any hit taken, a
 * hoglin or a brute near, a ghast within 16 that sees it or a fireball coming at it (the barter's ghast rule, looked for
 * between the legs of every walk out too; a ghast further off or behind rock is watched: while one is within 32 the bot
 * walks and digs from no drop's edge within 2, and where only such an edge would do, it goes back as from a danger),
 * the pockets full, or no ore left that it may mine; and walks back into
 * its hut and through its own portal. A piglin turned aggressive near it sends it back at once and holds the barter and the quartz
 * for the rest of the game day (netherbarter.ts's own rule and memory: the same piglins round the same portal). Says
 * `nether: mined N quartz ore: M quartz picked up`.
 *
 * Coordinates are `nether (x, y, z)` and `overworld (x, y, z)` in the lines, as nether.ts says them. Nothing here is
 * used at the module's top level (worktasks.ts reaches it, and this module reaches most of the brain).
 */
import type { InventoryItem } from '../tools.js';
import { no, type Decline, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { WorkResult } from './work.js';
import { homePortal } from './portal.js';
import { NETHER, NETHER_STOCK, barterHold, gameDay, netherOf, netherStock, peekNether, portalCells } from './nether.js';
import {
  BACK_MS, KNOCK_GAP, LAVA_GAP, backThroughOwn, barterDanger, barterOpen, ghastAbout, ghastWatched, lavaBy, overDrop, takesAt, toOwnPortal, type Seen
} from './netherbarter.js';
import {
  DIG_REACH, EYE, FROM_BUILDS, GONE, PLACED_GAP, SETUP_HEALTH, SETUP_WAITS, blockAt, boxGap, boxOf, cellOf, clearTo, fetchSetupKit, footing, inNether,
  pathOf, placedIn, readGround, setOpen, setupShort, walkAlong, walkFrom, zoneBox, type Box, type Cell, type Grid, type NetherZone
} from './nethersetup.js';

const MINUTE = 60_000;

const fmt = (p: { x: number; y: number; z: number }) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const cellKey = (p: Pos) => `${p.x},${p.y},${p.z}`;
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
const add = (p: Pos, dx: number, dy: number, dz: number): Pos => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });
/** Along the ground, to an item where it lies (not its block). */
const across = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** A standing cell's middle, where the bot's feet are once it is there. */
const middleOf = (c: Pos): Pos => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
const passable = (c: Cell) => c === 'open' || c === 'plant';
const firm = (c: Cell) => c === 'dig' || c === 'solid' || c === 'falls';

// ------------------------------------------------------------------------------------------------ the rules

/** The ore, and what it drops: quartz (by Fortune 1 to 4 of it), the ore itself to a silk touch pickaxe. */
export const ORE = 'nether_quartz_ore';
const DROPS = ['quartz', ORE];
/** How far from its own portal the quartz is mined: the ore, and the cells it walks and stands on. */
export const QUARTZ_RADIUS = 24;
/** No ore lower than this under its portal's floor (the portal's bottom row of obsidian, what it stands on in it), and no cell it stands on whose floor is. */
export const QUARTZ_DEPTH = 4;
/**
 * The ore this near its own portal is its hut's (the walls, the floor, the ground the frame stands on: the hut reaches
 * 3 out of the portal's plane, 1 behind it and 2 under its floor, nethersetup.ts hutOf): left where it is.
 */
export const HUT_GAP = 4;
/** Ore mined on a trip at most. */
export const QUARTZ_TRIP = 32;
/** The quartz trip's whole time, from the kit at home to back through its own portal (the barter's), and what it still needs after the kit. */
export const QUARTZ_MAX_MS = 8 * MINUTE;
export const QUARTZ_LEAST_MS = 2 * MINUTE;
/** What a dig dropped is picked up within this of the ore's middle (it pops out a little and falls into the hole). */
export const DROP_RANGE = 2.5;
/** The waits, in looks a pollMs apart (a test sets pollMs to nothing; the counts stand): what a dig dropped has a moment to come down. */
export const QUARTZ_WAITS = { pollMs: 500, dropLooks: 2 };

/** The six faces of a block, as offsets. */
const FACES: readonly [number, number, number][] = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

/**
 * What one read of the ground round its portal holds for the quartz: its own portal's box (its inside), the height of
 * the portal's floor (its bottom row of obsidian), the zones the bridge's scan has down there, and the blocks only a
 * player puts down there (placedIn: cobblestone).
 */
export interface QuartzView { portal: Box; floor: number; zones: Box[]; placed: Pos[] }

/**
 * Why an ore may not be mined, pure, or null (see the top of the file): no quartz ore there; more than QUARTZ_RADIUS
 * from its portal; its hut's (within HUT_GAP of the portal); more than QUARTZ_DEPTH under the portal's floor; within
 * FROM_BUILDS of a zone; within PLACED_GAP of a block someone placed; lava or fire within LAVA_GAP of it every way (or
 * the ground there not read: an unloaded chunk might hold either); no face open to air (buried: the dig would be a
 * tunnel's); under a block that falls; a floor (open over it) with no firm ground under it (the dig would open a hole
 * to a drop or a cave). Judged on the ground as read on arrival.
 */
export function quartzFault(g: Grid, p: Pos, v: QuartzView): string | null {
  if (blockAt(g, p) !== ORE) return 'no quartz ore';
  const gap = boxGap(v.portal, cellBox(p));
  if (gap > QUARTZ_RADIUS) return `more than ${QUARTZ_RADIUS} from its portal`;
  if (gap <= HUT_GAP) return 'its own hut\'s, or the ground its portal stands on';
  if (p.y < v.floor - QUARTZ_DEPTH) return `more than ${QUARTZ_DEPTH} under its portal's floor`;
  if (v.zones.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS)) return `within ${FROM_BUILDS} of someone's build`;
  if (v.placed.some(c => Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y), Math.abs(c.z - p.z)) <= PLACED_GAP)) return `within ${PLACED_GAP} of a block someone placed`;
  let unread = false;
  for (let dx = -LAVA_GAP; dx <= LAVA_GAP; dx++) for (let dy = -LAVA_GAP; dy <= LAVA_GAP; dy++) for (let dz = -LAVA_GAP; dz <= LAVA_GAP; dz++) {
    const c = cellOf(blockAt(g, add(p, dx, dy, dz)));
    if (c === 'hot') return `lava or fire within ${LAVA_GAP}`;
    if (c === 'unknown') unread = true;
  }
  if (unread) return 'the ground round it not all read';
  if (!FACES.some(([dx, dy, dz]) => cellOf(blockAt(g, add(p, dx, dy, dz))) === 'open')) return 'no face open to air';
  const over = cellOf(blockAt(g, add(p, 0, 1, 0)));
  if (over === 'falls') return 'under a block that falls';
  if (passable(over) && !firm(cellOf(blockAt(g, add(p, 0, -1, 0))))) return 'a floor over a hole';
  return null;
}

/** The ore of a read that it may mine, pure (each that quartzFault passes), and how many of the others fell to each fault. */
export function quartzSurvey(g: Grid, v: QuartzView): { ores: Pos[]; faults: Map<string, number> } {
  const ores: Pos[] = [];
  const faults = new Map<string, number>();
  for (let iy = 0; iy < g.height; iy++) for (let iz = 0; iz < g.length; iz++) for (let ix = 0; ix < g.width; ix++) {
    const p = { x: g.x + ix, y: g.y + iy, z: g.z + iz };
    if (blockAt(g, p) !== ORE) continue;
    const why = quartzFault(g, p, v);
    if (why) faults.set(why, (faults.get(why) ?? 0) + 1);
    else ores.push(p);
  }
  return { ores, faults };
}

/**
 * The cells the quartz trip may walk and stand on, pure: the barter's ground (netherbarter.ts barterGround: FROM_BUILDS
 * from every zone, no lava or fire within LAVA_GAP, at no drop's edge) within QUARTZ_RADIUS of its portal, and none
 * whose floor is more than QUARTZ_DEPTH under the portal's. Each cell judged once; `forget` lets go of the judgements
 * round a cell the trip dug (its own map of the ground changed there).
 */
export function quartzGround(g: Grid, v: QuartzView): { may: (p: Pos) => boolean; forget: (p: Pos) => void } {
  const judged = new Map<string, boolean>();
  const may = (p: Pos): boolean => {
    const k = cellKey(p);
    let ok = judged.get(k);
    if (ok === undefined) {
      ok = boxGap(v.portal, cellBox(p)) <= QUARTZ_RADIUS && p.y - 1 >= v.floor - QUARTZ_DEPTH && !v.zones.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS) &&
        !lavaBy(g, p) && !overDrop(g, p);
      judged.set(k, ok);
    }
    return ok;
  };
  // (a cell's judgement reads 2 across and 3 under it, its sides and a drop's depth under them, and the columns open
  // within 2 across of it down to their bottom (lavaBy): a dug cell is in the judgement of cells 5 round it, and of
  // every cell over it up the read's top)
  const forget = (p: Pos) => {
    for (let dx = -5; dx <= 5; dx++) for (let dy = -5; p.y + dy < g.y + g.height; dy++) for (let dz = -5; dz <= 5; dz++) judged.delete(cellKey(add(p, dx, dy, dz)));
  };
  return { may, forget };
}

/**
 * Where to stand to dig an ore, pure: of the cells a walk reaches (`reach`), one whose eye sees a face of the ore open
 * to air (dig.here's own rule: the face's middle within DIG_REACH of the eye, nothing in the way), never the cell on
 * top of it (it would dig its own floor out from under itself); the one of fewest steps, then the nearest the face.
 * Undefined with none.
 */
export function digStance(g: Grid, reach: Map<string, { from: string | null; n: number }>, ore: Pos): { at: Pos; n: number } | undefined {
  const open = (p: Pos) => cellOf(blockAt(g, p)) === 'open';
  const faces = FACES.filter(([dx, dy, dz]) => open(add(ore, dx, dy, dz)));
  if (!faces.length) return undefined;
  let best: { at: Pos; n: number; d: number } | undefined;
  // (the eye 1.62 over the feet, 4.4 at most from a face: the feet from 6 under the ore to 4 over it)
  for (let dy = -6; dy <= 4; dy++) for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
    if (dx === 0 && dz === 0 && dy === 1) continue;
    const at = add(ore, dx, dy, dz);
    const r = reach.get(cellKey(at));
    if (!r || (best && r.n > best.n)) continue;
    const eye = { x: at.x + 0.5, y: at.y + EYE, z: at.z + 0.5 };
    for (const [fx, fy, fz] of faces) {
      const fc = { x: ore.x + 0.5 + 0.49 * fx, y: ore.y + 0.5 + 0.49 * fy, z: ore.z + 0.5 + 0.49 * fz };
      const d = dist3(eye, fc);
      if (d > DIG_REACH || (best && r.n === best.n && d >= best.d) || !clearTo(open, eye, fc, ore)) continue;
      best = { at, n: r.n, d };
    }
  }
  return best && { at: best.at, n: best.n };
}

/**
 * Whether what an ore drops can be picked up from the ground a walk reaches, pure: it falls from the ore's cell through
 * the open cells under it to the first floor, and some cell the walk reaches (`reach`) a block across from it at most
 * takes it up (takesAt); or it rests in the pit the ore leaves in a floor, which the walk steps down into from the cell
 * over it or one beside that. An ore high in a wall (3 and more over the floor in front of it) is none: its quartz stays
 * up in the hole, out of reach, and the ore and the trip's time would go for nothing.
 */
export function dropReach(g: Grid, reach: Map<string, { from: string | null; n: number }>, ore: Pos): boolean {
  let y = ore.y;
  while (passable(cellOf(blockAt(g, { x: ore.x, y: y - 1, z: ore.z })))) y--;
  const item = { x: ore.x + 0.5, y, z: ore.z + 0.5 };
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -2; dy <= 0; dy++) {
    const q = { x: ore.x + dx, y: y + dy, z: ore.z + dz };
    if (reach.has(cellKey(q)) && across(middleOf(q), item) <= 1.2 && takesAt(middleOf(q), item)) return true;
  }
  const top = add(ore, 0, 1, 0);
  return y === ore.y && passable(cellOf(blockAt(g, top))) && passable(cellOf(blockAt(g, add(top, 0, 1, 0)))) &&
    [top, add(top, 1, 0, 0), add(top, -1, 0, 0), add(top, 0, 0, 1), add(top, 0, 0, -1)].some(c => reach.has(cellKey(c)));
}

/** The game's pickup box (netherbarter.ts takesAt: the barter's loot and the quartz's drops alike). */
export { takesAt };

// ------------------------------------------------------------------------------------------------ the gate

/** The quartz is open as the barter is: from stage 1, its own portal standing and the two sides linked. */
export const quartzOpen = (world: WorldMemory): boolean => barterOpen(world);

/**
 * Whether the quartz trip can set out now, pure: not held (a piglin turned on the bot by its portal today: the
 * barter's hold), the quartz under its target (carried and stored), not hurt past what the run heals at home, and
 * nothing of the Nether kit short that the chests lack (the setup's own list: three pickaxes among it). The hour is
 * the rung's.
 */
export function quartzReady(s: Snapshot, world: WorldMemory): Decline | null {
  const held = barterHold(world, s.now);
  if (held) return { cause: 'hold', text: `quartz held for the day: ${held.why}` };
  const have = netherStock('quartz', s, world);
  if (have >= NETHER_STOCK.quartz) return { cause: 'stocked', text: `quartz at its target (${have}/${NETHER_STOCK.quartz})` };
  if (s.health < SETUP_HEALTH) return no.health(s, 'the quartz', SETUP_HEALTH, 10);
  const short = setupShort(s, world);
  if (short.length) return { cause: 'kit', text: `quartz: short of ${short.join(', ')} (carried or in the chests)` };
  return null;
}

// ------------------------------------------------------------------------------------------------ the trip

type Inv = { items: InventoryItem[] };
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> => (await ctx.call<Inv>('inventory').catch((): Inv => ({ items: [] }))).items ?? [];
const quartzOf = (items: InventoryItem[]) => items.filter(i => i.slot >= 0 && i.slot < 36 && i.name === 'quartz').reduce((a, i) => a + i.count, 0);
const freeSlots = (items: InventoryItem[]) => 36 - new Set(items.filter(i => i.slot >= 0 && i.slot < 36).map(i => i.slot)).size;
/** Counts by name, as a look's. */
const countsOf = (items: InventoryItem[]) => { const m = new Map<string, number>(); for (const i of items) m.set(i.name, (m.get(i.name) ?? 0) + i.count); return m; };

/**
 * The quartz trip (see the top of the file). From home with the Nether kit (or it does not set out: untried), through
 * the home portal into its own hut, out on foot to the ore round it, and back through its own portal at the end;
 * `nether: mined N quartz ore: M quartz picked up` said once it is done. Gain: the quartz it brought back. Out of the
 * Nether halfway (a death), it stops at once and writes nothing more.
 */
export async function quartzRun(ctx: GoalContext, budgetMs: number, now: () => number): Promise<WorkResult> {
  const began = now();
  const left = () => Math.min(budgetMs, QUARTZ_MAX_MS) - (now() - began);
  const world = ctx.world;
  const home = homePortal(world);
  const own = peekNether(world).portal;
  if (!home) return { gain: 0, text: 'no home portal lit', untried: true };
  if (!own) return { gain: 0, text: 'no portal of its own down there to mine by', untried: true };
  const lacking = await fetchSetupKit(ctx);
  if (lacking) return { gain: 0, text: `not setting out: ${lacking}`, untried: true };
  if (left() < QUARTZ_LEAST_MS) {
    return { gain: 0, text: `not setting out: the kit took ${Math.round((now() - began) / 1000)} s, too little of the quartz trip's ${QUARTZ_MAX_MS / MINUTE} min is left`, untried: true };
  }
  const to = await toOwnPortal(ctx, home, own, now, 'quartz');
  if ('result' in to) return to.result;
  const { arrived, homeShape } = to;
  if (left() <= BACK_MS) return { gain: 0, text: `out of the quartz trip's ${QUARTZ_MAX_MS / MINUTE} min on the way down: no quartz` };

  // ---- the ground round its portal (the bridge's scan follows the protection sync: a moment), then the zones down
  // there, asked once the read is in (the bridge's scan reads loaded chunks only: a build in a chunk that came in while
  // the ground was read was in no answer asked before it, as setupRun found; its scan reaches 48 round the bot, past
  // the 24 and the 16 from builds the quartz keeps)
  await pause(SETUP_WAITS.loadMs);
  if (ctx.signal.aborted) throw new Error('aborted');
  const pb = boxOf(portalCells(arrived));
  const floor = pb.y1 - 1;
  // (the radius and the lava rule's 2 round the furthest ore and cell, a block more; down to the lava rule under the
  // lowest ore and floor, up as high as an eye reaches over the highest cell it may stand on near the portal)
  const out = QUARTZ_RADIUS + LAVA_GAP + 1;
  const g = await readGround(ctx, {
    x1: pb.x1 - out, y1: Math.max(1, floor - QUARTZ_DEPTH - LAVA_GAP - 1), z1: pb.z1 - out,
    x2: pb.x2 + out, y2: Math.min(126, pb.y2 + 12), z2: pb.z2 + out
  });
  const asked = await ctx.call<{ zones?: NetherZone[] }>('foreign.zones', { dimension: NETHER }).catch(() => undefined);
  // (no word of the builds down there: no rule of 16 from them to dig and walk by. Back through its portal, from where
  // it stands by it)
  if (!asked) {
    const b = await backThroughOwn(ctx, arrived, homeShape, now);
    return { gain: 0, text: `no quartz mined: the bridge did not say where the builds down there are; ${b.text}`, mark: 'same', ...(b.cameBack ? { cameBack: true as const } : {}) };
  }
  const zones = (asked.zones ?? []).map(zoneBox);
  const view: QuartzView = { portal: pb, floor, zones, placed: placedIn(g) };
  const survey = quartzSurvey(g, view);
  const ground = quartzGround(g, view);
  const st0 = await ctx.status().catch(() => undefined);
  const start = footing(g, st0?.position ?? to.me);
  if (!start) return { gain: 0, text: `no ground to stand on by its portal at nether ${fmt(arrived)}: no quartz` };

  // ---- the looks: where it stands, what is round it, and what would send it back (the barter's rules)
  let health = st0?.health ?? 20;
  let me: Pos = st0?.position ?? to.me;
  let ents: Seen[] = [];
  let stop: string | undefined;
  let angry: string | undefined;
  /** sent back by a danger (not by the ore): the trip says nothing of the quartz there */
  let danger = false;
  let gone = false;
  /** a ghast within GHAST_WATCH at the last look: the ground it walks and digs from keeps KNOCK_GAP from drops (judged as it is: the trip digs) */
  let watched = false;
  const walkable = (p: Pos) => ground.may(p) && (!watched || !overDrop(g, p, KNOCK_GAP));
  /** A look round (between the legs of every walk out too): false when something sends it back (`stop` says what) or it is out of the Nether (`gone`). */
  const watch = async (): Promise<boolean> => {
    if (ctx.signal.aborted) throw new Error('aborted');
    const st = await ctx.status().catch(() => undefined);
    if ((st?.dimension ?? NETHER) !== NETHER) { gone = true; return false; }
    me = st?.position ?? me;
    ents = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 64 }).catch(() => ({ entities: [] as Seen[] }))).entities ?? [];
    const was = health;
    health = st?.health ?? health;
    watched = ghastWatched(ents);
    const d = barterDanger(ents, health, was, { g, me });
    if (d) { stop = d.why; danger = true; if (d.angry) angry = d.why; return false; }
    if (st?.onFire) { stop = 'on fire'; danger = true; return false; }
    return true;
  };
  /**
   * Between the legs of a walk out: a look round, and with a ghast come within GHAST_WATCH since it set out, the rest
   * of the way at no drop's edge (false with nothing set: the walk is planned again).
   */
  const onTheWay = (path: Pos[]) => {
    const calm = !watched;
    return async () => (await watch()) && (!calm || !watched || path.slice(1).every(p => walkable(p)));
  };
  const reachFrom = () => {
    const here = footing(g, me);
    if (!here) return new Map<string, { from: string | null; n: number }>();
  // (with a ghast watched, the cell it stands on at a drop's edge (a walk planned before it came ended there) is no
  // place to dig, toss or pick up from: only the way off it. The search keeps its start whatever the rule, so the plan
  // made again would pick that very cell, n 0, and the check after the walk let the thing be)
    const reach = walkFrom(g, [here], walkable);
    if (watched && !walkable(here)) reach.delete(cellKey(here));
    return reach;
  };

  /** What a dig dropped (new items within DROP_RANGE of the ore) picked up on foot, never by lava: false when sent back. */
  const pickUp = async (around: Pos, before: Set<number>): Promise<boolean> => {
    const passed = new Set<number>();
    const waited = new Set<number>();
    for (let round = 0; round < 6; round++) {
      if (!(await watch())) return false;
      const next = ents.filter(e => e.name === 'item' && DROPS.includes(e.item ?? 'quartz') && !before.has(e.id) && !passed.has(e.id) && dist3(e.position, around) <= DROP_RANGE)
        .sort((a, b) => dist3(a.position, me) - dist3(b.position, me))[0];
      if (!next) return true;
      // (in reach of the pickup where it stands: a look more; still lying there after it, a cell to take it from)
      if (takesAt(me, next.position) && !waited.has(next.id)) { waited.add(next.id); await pause(QUARTZ_WAITS.pollMs); continue; }
      const reach = reachFrom();
      const c = { x: Math.floor(next.position.x), y: Math.floor(next.position.y), z: Math.floor(next.position.z) };
      let best: { p: Pos; n: number } | undefined;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -2; dy <= 0; dy++) {
        const q = add(c, dx, dy, dz);
        const r = reach.get(cellKey(q));
        if (r && across(middleOf(q), next.position) <= 1.2 && takesAt(middleOf(q), next.position) && (!best || r.n < best.n)) best = { p: q, n: r.n };
      }
      // (in a hole it cannot stand by, by lava, at a drop's edge, or where it stands already: left where it lies)
      if (!best || best.n === 0) { passed.add(next.id); continue; }
      const way = pathOf(reach, best.p);
      const w = await walkAlong(ctx, way, 4, onTheWay(way));
      if (w === 'gone') { gone = true; return false; }
      if (w === 'back') { if (stop || gone) return false; continue; }
      if (w === 'stuck') passed.add(next.id);
    }
    return true;
  };

  // ---- the mining: the ore of fewest steps to a place to dig it from, then the next
  const tried = new Set<string>();
  /** ores whose walk was planned again (a ghast come near): once each */
  const replanned = new Set<string>();
  let dug = 0;
  let refused = 0;
  let got = 0;
  const startQuartz = quartzOf(await inventory(ctx));
  /** The quartz come into the pockets since the start that is not booked yet, booked. */
  const book = (items: InventoryItem[]) => {
    const more = quartzOf(items) - startQuartz - got;
    if (more > 0) { got += more; ctx.gain(more); }
  };
  while (!stop && !gone) {
    if (dug >= QUARTZ_TRIP) { stop = `the trip's ${QUARTZ_TRIP} ore mined`; break; }
    if (left() < BACK_MS) { stop = 'the quartz trip\'s time is up'; break; }
    if (!(await watch())) break;
    const items = await inventory(ctx);
    book(items);
    if (freeSlots(items) < 2) { stop = `pockets full (${36 - freeSlots(items)}/36 slots)`; break; }
    const have = netherStock('quartz', { items, counts: countsOf(items) }, world);
    if (have >= NETHER_STOCK.quartz) { stop = `quartz at its target (${have}/${NETHER_STOCK.quartz})`; break; }
    const reach = reachFrom();
    let target: { ore: Pos; at: Pos; n: number } | undefined;
    for (const ore of survey.ores) {
      if (tried.has(cellKey(ore))) continue;
      const st = digStance(g, reach, ore);
      if (st && (!target || st.n < target.n) && dropReach(g, reach, ore)) target = { ore, ...st };
    }
    if (!target) {
      // (a ghast watched, and what is left only from a drop's edge: the ghast keeps the bot off it, not the ground: back
      // as from a danger, so the wait does not grow as for a place with no ore)
      const here = footing(g, me);
      const plain = watched && here ? walkFrom(g, [here], ground.may) : undefined;
      if (plain && survey.ores.some(ore => !tried.has(cellKey(ore)) && digStance(g, plain, ore) && dropReach(g, plain, ore))) {
        stop = `${ghastAbout(ents)}: the quartz ore only from a drop's edge`;
        danger = true;
        break;
      }
      const faults = [...survey.faults].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${k}`).join(', ');
      // (some tried and done with, dug or not: what is left is out of sight, or none)
      stop = tried.size ? `no more quartz ore it may mine within ${QUARTZ_RADIUS} of its portal`
        : survey.ores.length ? `none of the ${survey.ores.length} quartz ore it may mine within ${QUARTZ_RADIUS} of its portal in sight of ground it may stand on`
          : `no quartz ore it may mine within ${QUARTZ_RADIUS} of its portal${faults ? ` (${faults})` : ''}`;
      break;
    }
    const k = cellKey(target.ore);
    tried.add(k);
    const way = pathOf(reach, target.at);
    const walked = await walkAlong(ctx, way, 4, onTheWay(way));
    if (walked === 'gone') { gone = true; break; }
    // (a ghast come within GHAST_WATCH with a drop's edge ahead: the ore tried again from a place planned anew, once;
    // a second time, let be)
    const again = () => { if (!replanned.has(k)) { replanned.add(k); tried.delete(k); } };
    if (walked === 'back') { if (stop || gone) break; again(); continue; }
    if (walked === 'stuck') continue;
    if (!(await watch())) break;
    // (and come so on the last leg, the bot at a drop's edge: no dig from there, a place off it first)
    const here = footing(g, me);
    if (watched && here && overDrop(g, here, KNOCK_GAP)) { again(); continue; }
    const before = new Set(ents.filter(e => e.name === 'item').map(e => e.id));
    const r = await ctx.call<{ dug?: boolean; reason?: string }>('dig.here', { ...target.ore, timeoutMs: 15_000 }, 25_000)
      .catch((e: Error) => ({ dug: false, reason: e.message }));
    if (ctx.signal.aborted) throw new Error('aborted');
    if (!r?.dug) {
      // (dug by someone since the read: open now. Out of sight after all, someone's, a timeout: said once, let be)
      if (r?.reason === 'air') { setOpen(g, target.ore); ground.forget(target.ore); continue; }
      if (!refused) ctx.progress(`quartz: could not dig the ore at nether ${fmt(target.ore)}: ${(r?.reason ?? 'no answer').slice(0, 100)}`);
      refused += 1;
      continue;
    }
    dug += 1;
    setOpen(g, target.ore);
    ground.forget(target.ore);
    // ---- what it dropped: a moment for it to come down, then picked up on foot
    let back = false;
    for (let i = 0; i < QUARTZ_WAITS.dropLooks; i++) {
      await pause(QUARTZ_WAITS.pollMs);
      if (!(await watch())) { back = true; break; }
    }
    if (back) break;
    const ok = await pickUp({ x: target.ore.x + 0.5, y: target.ore.y, z: target.ore.z + 0.5 }, before);
    book(await inventory(ctx));
    if (!ok) break;
  }
  if (!gone) book(await inventory(ctx));

  // ---- done: said, and back into the hut and through its own portal
  const did = dug ? `mined ${dug} quartz ore: ${got} quartz${refused ? ` (${refused} it could not dig)` : ''}` : `no quartz mined${refused ? ` (${refused} it could not dig)` : ''}`;
  if (dug) ctx.progress(`nether: mined ${dug} quartz ore: ${got ? `${got} quartz picked up` : 'nothing picked up'}`);
  if (gone || !(await inNether(ctx))) return { gain: got, text: dug ? `${did}; ${GONE.text}` : GONE.text, ...(dug ? { worked: true as const } : {}) };
  if (angry) {
    (netherOf(world).barter ??= {}).held = { day: gameDay(world), at: now(), why: angry.slice(0, 160) };
    ctx.progress(`nether: ${angry}: back to its portal, the barter and the quartz held for the day`);
  }
  const why = `${stop ?? 'done'}${angry ? ', the barter and the quartz held for the day' : ''}`;
  // (turned back by a danger before an ore: the place is not found empty of quartz, and the wrapper's dry mark must
  // not grow 20, 40, 80, 160 min as for one: the mark stays as it was, 20 min at least. An ore mined is the trip's work:
  // only then does it count for the stages)
  const mark = { ...(danger && !dug ? { mark: 'same' as const } : {}), ...(dug ? { worked: true as const } : {}) };
  const here = footing(g, me);
  // (a ghast watched: the way back keeps from drops' edges too, where there is such a way; else the plain ground's)
  const wayBack = (ok: (p: Pos) => boolean) => (here ? walkFrom(g, [here], p => same(p, start) || ok(p)) : undefined);
  let way = wayBack(walkable);
  if (!way?.has(cellKey(start)) && watched) way = wayBack(ground.may);
  if (!way?.has(cellKey(start))) return { gain: got, text: `${did}; ${why}; no way back on foot to its hut`, ...mark };
  const w = await walkAlong(ctx, pathOf(way, start), 4);
  if (w === 'gone') return { gain: got, text: `${did}; ${GONE.text}`, ...(dug ? { worked: true as const } : {}) };
  if (w === 'stuck') return { gain: got, text: `${did}; ${why}; stuck on the way back to its hut`, ...mark };
  const b = await backThroughOwn(ctx, arrived, homeShape, now);
  return { gain: got, text: `${did}; ${why}; ${b.text}`, ...mark, ...(b.cameBack ? { cameBack: true as const } : {}) };
}
