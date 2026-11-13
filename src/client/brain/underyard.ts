import { HOME_ZONE } from '../tools.js';
// (goals.ts takes underNow from here, for the shelter and the walk back: each uses the other's exports inside functions only)
import { BELOW_HOME, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';

/**
 * Out from under the yard. The bridge keeps Baritone from breaking ground or ore whenever the bot stands in the home
 * zone's column (the yard's rectangle and a margin of 6 round it, at any depth: Protection.java nearZone), so that its
 * miner digs no holes in the lawn. Under the yard that leaves Baritone nothing it may break. Live on Nov 12 a deep
 * trip's mining followed the gold from the mine start east of the yard to (-534, 8, 2182), 55 below the lawn: go-home
 * and the retreat stopped in a second each time (`Stopped 57 blocks from home`), the bot walled itself into a pocket of
 * its own dirt, and for an hour break out waited on a zombie in the cave. The lead dug it out by hand: the wall, a
 * tunnel 2 high east at the bot's level to past the margin, then a walk up to the surface there, where Baritone is
 * free to dig. The goal below does the same; a trip down that finds itself under the yard comes up (deep.ts oreTrip).
 */

const MINUTE = 60_000;
/** How far past the yard's rectangle the bridge holds its rule (Protection.java ZONE_MARGIN). */
export const ZONE_MARGIN = 6;
/** More than this below the yard's ground, in its column, the bot is under the yard. */
export const UNDER_BY = 8;
/** The tunnel goes on this far past the column's edge: the climb starts where Baritone may dig. */
const PAST = 3;
/** Under this health the bot does not tunnel into a cave: the Guardian eats to heal first, for a minute at most. */
const HURT = 8;
/** A creeper this near: no wall is opened on its side (it would come through and blow up). */
const CREEPER_NEAR = 8;
/** Gravel and sand fall into a cell just dug: it is looked at and dug again this many times at most. */
const DIG_ROUNDS = 6;
/** The overworld's top: the climb's column is read up to here for the ground. */
const TOP = 319;
/** Baritone's walk drops this far at most onto a lower floor (its fall without water). */
const DROP = 3;
/** A climb stopped under ground it may not break: the shaft over the bot's head is dug this many times at most. */
const SHAFT_ROUNDS = 4;
/** What the bot digs over its head from where it stands: 2 over its feet to here (in reach of its eyes). */
const SHAFT_UP = 5;
/** A climb shut over it past the margin (water over the cap, more of the yard's kinds than the shaft digs): the tunnel goes on this far along its side, and up from there. */
const FURTHER = 4;
/** And this many times at most. */
const FURTHER_TRIES = 2;
/** A side whose climb failed is left for the others this long: from the same pocket the same climb fails the same way. */
const CLIMB_FAILED_MS = 60 * MINUTE;

/** The sides whose climb failed lately, and until when each is left out. */
const climbFailed = new Map<string, number>();
/** For tests: no climb has failed yet. */
export function resetOutFromUnder(): void { climbFailed.clear(); }

let POLL_MS = 3000;
let HEAL_MS = MINUTE;
/** For tests: a shorter wait between looks at the bot's health, and a shorter wait for it to heal. */
export function setOutFromUnderTiming(pollMs: number, healMs: number): void { POLL_MS = pollMs; HEAL_MS = healMs; }

/** The home zone's column as the bridge holds it, and the yard's ground. */
export interface Column { x1: number; z1: number; x2: number; z2: number; ground: number }

/**
 * The column: the yard's rectangle (the brain hands it to the bridge each tick) and the margin round it; with no yard
 * known, the bridge's circle of HOME_ZONE round home, taken here as the square round it (its corners are outside the
 * circle: a few blocks more of tunnel, no harm done). Its ground: the yard's, or home's level.
 */
export function homeColumn(home: Pos, yard?: WorldMemory['yard']): Column {
  const r = yard ?? { x1: home.x - HOME_ZONE, z1: home.z - HOME_ZONE, x2: home.x + HOME_ZONE, z2: home.z + HOME_ZONE, y: home.y };
  return { x1: r.x1 - ZONE_MARGIN, z1: r.z1 - ZONE_MARGIN, x2: r.x2 + ZONE_MARGIN, z2: r.z2 + ZONE_MARGIN, ground: r.y };
}

/** In the column, by the block the bot stands in (the bridge goes by it). */
const inColumn = (c: Column, p: { x: number; z: number }) => {
  const x = Math.floor(p.x), z = Math.floor(p.z);
  return x >= c.x1 && x <= c.x2 && z >= c.z1 && z <= c.z2;
};
const below = (c: Column, p: { y: number }) => c.ground - Math.floor(p.y);

/**
 * Under the yard: in the home zone's column and more than UNDER_BY below the yard's ground, or below home's level
 * there (BELOW_HOME under home: goals.ts onHomeLevel). The two meet whatever the yard's ground is to home: with the
 * ground at 62 and home at 63, feet at 54 were neither, and only the walk home wanted, which stops at once down there.
 */
export function underYard(p: Pos, home: Pos | undefined, yard?: WorldMemory['yard']): boolean {
  if (!home) return false;
  const c = homeColumn(home, yard);
  return inColumn(c, p) && (below(c, p) > UNDER_BY || p.y < home.y - BELOW_HOME);
}

/** The same for a look: in the home's dimension (the bridge holds the zone there only). */
export const underNow = (s: Pick<Snapshot, 'home' | 'dimension' | 'position'>, world: WorldMemory): boolean =>
  !!s.home && !!s.position && s.home.dimension === s.dimension && underYard(s.position, s.home, world.yard);

type Side = { name: 'east' | 'west' | 'south' | 'north'; dx: number; dz: number; end: number };

/** The four ways out, each to PAST beyond the column's edge, the shortest first. */
function sidesOut(c: Column, feet: Pos): (Side & { steps: number })[] {
  const sides: Side[] = [
    { name: 'east', dx: 1, dz: 0, end: c.x2 + PAST }, { name: 'west', dx: -1, dz: 0, end: c.x1 - PAST },
    { name: 'south', dx: 0, dz: 1, end: c.z2 + PAST }, { name: 'north', dx: 0, dz: -1, end: c.z1 - PAST }
  ];
  return sides.map(s => ({ ...s, steps: stepsLeft(s, feet) })).sort((a, b) => a.steps - b.steps);
}
/** The cells from here to the side's end. */
const stepsLeft = (s: Side, p: Pos) => (s.dx ? (s.end - p.x) * s.dx : (s.end - p.z) * s.dz);
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const floored = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

const LIQUID = /^(minecraft:)?(lava|water|flowing_lava|flowing_water)(\[|$)/;
const LAVA = /^(minecraft:)?(flowing_)?lava(\[|$)/;
/** What the ground of the climb's column is not: the air, and what stands on the ground (trees, plants, snow). */
const NOT_GROUND = /^(minecraft:)?(air|cave_air|void_air|\w+_leaves|\w+_log|\w+_wood|vine|short_grass|tall_grass|fern|large_fern|dead_bush|\w+_sapling|snow|dandelion|poppy|\w+_tulip|cornflower|oxeye_daisy|azure_bluet|allium|blue_orchid|lily_of_the_valley|sweet_berry_bush|torch|wall_torch)(\[|$)/;
/** Open to walk in: what the tunnel's cells may hold once dug. */
const OPEN = /^(minecraft:)?(air|cave_air|void_air|torch|wall_torch|short_grass|tall_grass|fern|vine)(\[|$)/;

type Region = { x: number; y: number; z: number; width: number; height: number; length: number };
/** The blocks of a box; undefined when the look failed or came back short (that is no "nothing there": a way into lava would count as clear). */
async function region(ctx: GoalContext, box: Region): Promise<(string | null)[] | undefined> {
  const blocks = (await ctx.call<{ blocks?: (string | null)[] }>('world.region', box).catch(() => undefined))?.blocks;
  return blocks && blocks.length >= box.width * box.height * box.length ? blocks : undefined;
}
const cellOf = (box: Region, i: number): Pos =>
  ({ x: box.x + i % box.width, y: box.y + Math.floor(i / (box.width * box.length)), z: box.z + Math.floor(i / box.width) % box.length });

/**
 * The column above a place, from 2 over its feet to the top: the ground in it (the highest block that is not air or
 * what stands on the ground; undefined where nothing of it is loaded), and the first lava in it. `unseen`: the look failed.
 */
async function columnAbove(ctx: GoalContext, at: Pos): Promise<{ ground?: number; lava?: Pos; unseen?: true }> {
  const up = { x: at.x, y: at.y + 2, z: at.z, width: 1, height: TOP - (at.y + 2) + 1, length: 1 };
  const column = await region(ctx, up);
  if (!column) return { unseen: true };
  const lava = column.findIndex(b => !!b && LAVA.test(b));
  let ground: number | undefined;
  for (let i = column.length - 1; i >= 0 && ground === undefined; i--) {
    const b = column[i];
    if (b && !NOT_GROUND.test(b)) ground = up.y + i;
  }
  return { ...(ground !== undefined ? { ground } : {}), ...(lava >= 0 ? { lava: cellOf(up, lava) } : {}) };
}

/**
 * What stands in the way of a side, looked at before a block is dug: lava or water in the tunnel's cells or beside,
 * above or below them (once a wall is opened it runs in), or past its end (the last cell dug opens onto it), or lava
 * in the column the climb at its end goes up. A look that failed shuts the side too: the next try looks again.
 */
async function lookAhead(ctx: GoalContext, side: Side, feet: Pos): Promise<string | undefined> {
  const steps = stepsLeft(side, feet);
  const xs = side.dx ? [feet.x + side.dx, feet.x + side.dx * (steps + 1)] : [feet.x - 1, feet.x + 1];
  const zs = side.dz ? [feet.z + side.dz, feet.z + side.dz * (steps + 1)] : [feet.z - 1, feet.z + 1];
  const box = { x: Math.min(...xs), y: feet.y - 1, z: Math.min(...zs), width: Math.abs(xs[1] - xs[0]) + 1, height: 4, length: Math.abs(zs[1] - zs[0]) + 1 };
  const cells = await region(ctx, box);
  if (!cells) return 'could not look ahead';
  const wet = cells.findIndex(b => !!b && LIQUID.test(b));
  if (wet >= 0) return `${LAVA.test(cells[wet]!) ? 'lava' : 'water'} at ${fmt(cellOf(box, wet))}`;
  const up = await columnAbove(ctx, { x: side.dx ? side.end : feet.x, y: feet.y, z: side.dz ? side.end : feet.z });
  if (up.unseen) return 'could not look up the climb';
  return up.lava ? `lava on the way up at ${fmt(up.lava)}` : undefined;
}

/**
 * Where the careful walk into a cell just dug (or open already) stands the bot: on its floor, or on a cave's floor up
 * to DROP below it. Baritone's walk goes only to a place the bot can stand in (a cell with air under it has no path,
 * and the bot stays put), and falls that far at most. `met`: a liquid under it, or no floor within reach.
 */
async function floorOf(ctx: GoalContext, cell: Pos): Promise<{ at: Pos } | { met: string }> {
  const box = { x: cell.x, y: cell.y - DROP - 1, z: cell.z, width: 1, height: DROP + 1, length: 1 };
  const under = await region(ctx, box);
  // (no look: the step as it stands; one that does not go shuts the side)
  if (!under) return { at: cell };
  for (let i = under.length - 1; i >= 0; i--) {
    const b = under[i];
    const at = { ...cell, y: box.y + i };
    if (b && LIQUID.test(b)) return { met: `${LAVA.test(b) ? 'lava' : 'water'} at ${fmt(at)}` };
    if (!b || !OPEN.test(b)) return { at: { ...cell, y: at.y + 1 } };
  }
  return { met: `no floor within ${DROP} under ${fmt(cell)}` };
}

/**
 * Dig the cell 2 high ahead of the bot (the upper first: what falls from above it falls into it), and dig it again
 * while something stands in it (gravel, sand). `met`: a liquid, or what the bridge would not dig (someone else's build,
 * bedrock): this way is shut.
 */
async function digAhead(ctx: GoalContext, cell: Pos): Promise<{ dug: number; met?: string }> {
  let dug = 0;
  const box = { x: cell.x, y: cell.y, z: cell.z, width: 1, height: 2, length: 1 };
  for (let round = 0; round < DIG_ROUNDS; round++) {
    const now = round === 0 ? undefined : await region(ctx, box);
    // (the first round digs both without looking: the look-ahead has just read them. A look again that fails: the
    // careful step tells whether the cell is open)
    if (round > 0 && !now) return { dug };
    const solid = [1, 0].filter(dy => !now || (now[dy] !== null && now[dy] !== undefined && !OPEN.test(now[dy]!)));
    if (!solid.length) return { dug };
    for (const dy of solid) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const at = { ...cell, y: cell.y + dy };
      if (now && LIQUID.test(now[dy]!)) return { dug, met: `${LAVA.test(now[dy]!) ? 'lava' : 'water'} at ${fmt(at)}` };
      // (not walking onto the drops: that walk is Baritone's own, free to place, and it may go down into a cave below
      // the tunnel. The bot walks over them in the tunnel, and picks them up so)
      const r = await ctx.act('dig-block', { ...at, collect: false }).catch((e: Error) => ({ ok: false, text: e.message }));
      if (ctx.signal.aborted) throw new Error('aborted');
      // (the bot's own wall is dug like the rock: dig lifts the bridge's rule for the one block's kind)
      if (/^No block/.test(r.text)) continue;
      if (/\b(lava|water)\b/.test(r.text)) return { dug, met: `${/\blava\b/.test(r.text) ? 'lava' : 'water'} at ${fmt(at)}` };
      if (!r.ok || !/^Dug/.test(r.text)) return { dug, met: `could not dig at ${fmt(at)}: ${r.text.slice(0, 80)}` };
      dug++;
      ctx.gain(1);
    }
  }
  return { dug, met: `${fmt(cell)} keeps filling up` };
}

/**
 * Dig the shaft over the bot's head, from 2 over its feet to SHAFT_UP over them, from the bottom (each block seen
 * through the last). Not when a liquid is in it or just over it (it would run down onto the bot). `met`: why not, or what the
 * bridge would not dig.
 */
async function digShaft(ctx: GoalContext, feet: Pos): Promise<{ dug: number; met?: string }> {
  const box = { x: feet.x, y: feet.y + 2, z: feet.z, width: 1, height: SHAFT_UP, length: 1 };
  const cells = await region(ctx, box);
  if (!cells) return { dug: 0, met: 'could not look up' };
  const wet = cells.findIndex(b => !!b && LIQUID.test(b));
  if (wet >= 0) return { dug: 0, met: `${LAVA.test(cells[wet]!) ? 'lava' : 'water'} over its head at ${fmt(cellOf(box, wet))}` };
  let dug = 0;
  for (let i = 0; i < cells.length - 1; i++) {
    if (!cells[i] || OPEN.test(cells[i]!)) continue;
    if (ctx.signal.aborted) throw new Error('aborted');
    const at = cellOf(box, i);
    const r = await ctx.act('dig-block', { ...at, collect: false }).catch((e: Error) => ({ ok: false, text: e.message }));
    if (ctx.signal.aborted) throw new Error('aborted');
    if (/^No block/.test(r.text)) continue;
    if (!r.ok || !/^Dug/.test(r.text)) return { dug, met: `could not dig at ${fmt(at)}: ${r.text.slice(0, 80)}` };
    dug++;
    ctx.gain(1);
  }
  return { dug };
}

/**
 * Run now? Whenever the bot is in the home zone's column more than 8 below the yard's ground (or below home's level
 * there), by day or night: there
 * Baritone may break nothing, so nothing else the bot does can get it out (go-home stops in a second), and staying is
 * a pocket in a cave with the mobs.
 */
export const outFromUnder: Goal = {
  name: 'out from under',
  // above break out (92): the way out of a wall-in under the yard is this tunnel, not a hole in the wall
  priority: 93,
  timeoutMs: 10 * MINUTE,
  retryMs: 20_000,
  // the night under the yard is no place to leave it: a while, and it tries again
  failHoldMs: 10 * MINUTE,
  wants: (s, world) => {
    if (s.sleeping || !underNow(s, world)) return null;
    const c = homeColumn(s.home!, world.yard);
    return `${below(c, s.position)} under the yard's ground at ${fmt(floored(s.position))}: Baritone may break nothing here`;
  },
  run: async ctx => {
    const text = await outFrom(ctx);
    // out: the next time under the yard is another pocket
    climbFailed.clear();
    return text;
  }
};

async function outFrom(ctx: GoalContext): Promise<string> {
  const home = ctx.s.home!;
  const col = homeColumn(home, ctx.world.yard);
  const stopped = () => { if (ctx.signal.aborted) throw new Error('aborted'); };
  const look = async () => { const s = await ctx.status().catch(() => undefined); stopped(); return s; };
  const underHere = (p: Pos) => underYard(p, home, ctx.world.yard);
  let st = await look();
  let feet = floored(st?.position ?? ctx.s.position);
  if (!underHere(feet)) return `not under the yard at ${fmt(feet)}`;
  // hurt: not into a cave like this. The Guardian eats to heal; a minute at most in a run (with nothing to eat it
  // never will, and the pocket is no better a place to be)
  let healLeft = HEAL_MS;
  const heal = async (): Promise<void> => {
    let health = st?.health ?? ctx.s.health;
    if (health >= HURT || healLeft <= 0) return;
    ctx.progress(`health ${Math.round(health)}: waiting for the Guardian to eat before tunnelling on`);
    const from = Date.now();
    while (health < HURT && Date.now() - from < healLeft) {
      await new Promise(r => setTimeout(r, POLL_MS));
      st = await look();
      health = st?.health ?? health;
    }
    healLeft -= Date.now() - from;
    if (health < HURT) ctx.progress(`health ${Math.round(health)} after the wait: out all the same`);
  };
  await heal();
  /** the ways found shut, and what each leg did */
  const shut: string[] = [];
  const legs: string[] = [];
  // a creeper by the pocket: no wall is opened on its side (it would come through and blow up), and only with one on
  // every side does the bot wait (the next try looks again). One shut in a cave behind the rock may stay there for
  // good, as the zombie did: the way away from it is dug as ever
  const { entities = [] } = await ctx.call<{ entities?: { name: string; distance: number; position?: Pos }[] }>('world.entities', { maxDistance: CREEPER_NEAR }).catch(() => ({ entities: [] }));
  const creepers = entities.filter(e => e.name === 'creeper');
  for (const side of sidesOut(col, feet)) {
    const by = creepers.find(c => !c.position || (c.position.x - (feet.x + 0.5)) * side.dx > 0 || (c.position.z - (feet.z + 0.5)) * side.dz > 0);
    if (!by) continue;
    shut.push(`${side.name}: creeper ${by.distance.toFixed(0)} blocks away`);
    ctx.progress(`${side.name} is shut (creeper ${by.distance.toFixed(0)} blocks away): the next way out`);
  }
  if (creepers.length && shut.length === 4) throw new Error(`waiting: creeper ${creepers[0].distance.toFixed(0)} blocks away`);
  // a side whose climb failed lately is left for the others (from the same pocket the same climb fails the same way,
  // and the run after it took the same nearest side again); every side failed: they are all tried again
  const failed = (['east', 'west', 'south', 'north'] as const).filter(n => (climbFailed.get(n) ?? 0) > Date.now());
  if (failed.length === 4) climbFailed.clear();
  else for (const n of failed) {
    if (shut.some(w => w.startsWith(`${n}:`))) continue;
    shut.push(`${n}: its climb failed within the hour`);
    ctx.progress(`${n} is shut (its climb failed within the hour): the next way out`);
  }

  /** the last place in the column the bot stood on its way out: the way back to it, after a climb that failed out there */
  let back: Pos | undefined;
  /** the side the last leg went: the climb is at its end */
  let lastSide: Side | undefined;
  /**
   * A leg along a side to its end, a step at a time: the two cells ahead dug, then a careful walk into them (walk
   * only: nothing placed, and under the yard nothing could be broken), from wherever the bot then stands. `met`: what
   * shut the way; `up`: the run's words when the bot rose out from under on the way.
   */
  const tunnel = async (side: Side, leg: string): Promise<{ dug: number; met?: string; up?: string }> => {
    let dug = 0;
    while (stepsLeft(side, feet) > 0) {
      const cell = { x: feet.x + side.dx, y: feet.y, z: feet.z + side.dz };
      const d = await digAhead(ctx, cell);
      dug += d.dug;
      if (d.met) return { dug, met: d.met };
      // onto the cell's floor, or a cave's a little lower (a step into a cell with no floor never goes)
      const floor = await floorOf(ctx, cell);
      if ('met' in floor) return { dug, met: floor.met };
      const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...floor.at, range: 0, careful: true, timeoutMs: 20_000 }, 35_000).catch(() => ({ arrived: false }));
      stopped();
      const was = feet;
      st = await look();
      feet = floored(st?.position ?? (walk?.arrived === false ? feet : floor.at));
      if (stepsLeft(side, feet) >= stepsLeft(side, was)) return { dug, met: `could not walk on from ${fmt(was)}` };
      if (inColumn(col, feet)) {
        if (!underHere(feet)) return { dug, up: `${leg}: no longer under the yard at ${fmt(feet)}` };
        back = feet;
      }
      // dropped into a cave on the way: the rest of the way is looked at again from down there
      if (feet.y !== was.y) {
        const met = await lookAhead(ctx, side, feet);
        if (met) return { dug, met };
      }
      await heal();
    }
    return { dug };
  };

  for (let turn = 0; turn < 4; turn++) {
    feet = floored((st = await look())?.position ?? feet);
    // out of the column sideways: the climb, from here
    if (!inColumn(col, feet)) break;
    // risen to the yard's ground somehow (the Guardian swims it up out of a flood): nothing to dig out of
    if (!underHere(feet)) return `${legs.length ? `${legs.join('; ')}; ` : ''}no longer under the yard at ${fmt(feet)}`;
    back = feet;
    const side = sidesOut(col, feet).find(s => !shut.some(w => w.startsWith(`${s.name}:`)));
    if (!side) break;
    const ahead = await lookAhead(ctx, side, feet);
    if (ahead) { shut.push(`${side.name}: ${ahead}`); ctx.progress(`${side.name} is shut (${ahead}): the next way out`); continue; }
    const leg = `tunnel ${side.name} from ${fmt(feet)} to ${side.dx ? 'x' : 'z'} ${side.end}`;
    ctx.progress(leg);
    lastSide = side;
    const { dug, met, up: risen } = await tunnel(side, leg);
    if (risen) return risen;
    legs.push(`${leg}${met ? `: ${met}` : ''} (${dug} dug)`);
    if (!met) break;
    shut.push(`${side.name}: ${met}`);
    ctx.progress(`${side.name}: ${met}: the next way out`);
  }
  if (inColumn(col, feet)) throw new Error(`every way out is shut: ${shut.join('; ')}`);
  // out past the margin, where Baritone may dig: up to the ground above, or the yard's level where none is seen
  const climbUp = async () => {
    const ground = (await columnAbove(ctx, feet)).ground ?? col.ground;
    const to = { x: feet.x, y: ground + 1, z: feet.z };
    const climb = async () => {
      const r = await ctx.act('move-to-position', { ...to, range: 1, timeoutMs: 3 * MINUTE }).catch((e: Error) => ({ ok: false, text: e.message }));
      stopped();
      return r;
    };
    let r = await climb();
    // Within 24 of what the bot built (the yard's dirt and grass) the bridge keeps Baritone from breaking those kinds
    // anywhere (Protection.java), and out here, 9 from the fence, the climb's top is that near: a cap of dirt and grass
    // over it stops the climb a few blocks under the surface. The bot digs the shaft over its head itself (dig lifts the
    // rule for the one block's kind), and the climb goes on up it
    for (let round = 0; !r.ok && round < SHAFT_ROUNDS; round++) {
      const at = floored((await look())?.position ?? feet);
      // (stepped back under the yard on the way: out from under looks again from there, another way)
      if (inColumn(col, at)) break;
      const shaft = await digShaft(ctx, at);
      if (shaft.dug) legs.push(`dug ${shaft.dug} over its head at ${fmt(at)}`);
      if (shaft.met) legs.push(`the shaft over ${fmt(at)}: ${shaft.met}`);
      if (!shaft.dug) break;
      ctx.progress(`dug ${shaft.dug} over its head at ${fmt(at)}: the climb goes on`);
      r = await climb();
    }
    return { r, up: to };
  };
  let { r, up } = await climbUp();
  // the way up shut over it out here (a pond over the cap, which the shaft is not dug into): on along the same side,
  // away from the yard, and up from there; a few times, and never past the leash
  for (let n = 0; !r.ok && lastSide && n < FURTHER_TRIES; n++) {
    feet = floored((await look())?.position ?? feet);
    // (back under the yard: out from under looks again from there; up at the top all the same: nothing to dig)
    if (inColumn(col, feet) || feet.y >= up.y - 1) break;
    const on: Side = { ...lastSide, end: (lastSide.dx ? feet.x : feet.z) + (lastSide.dx + lastSide.dz) * FURTHER };
    const end = lastSide.dx ? { x: on.end, z: feet.z } : { x: feet.x, z: on.end };
    if (Math.hypot(end.x - home.x, end.z - home.z) > ctx.world.leash) break;
    const leg = `on ${on.name} from ${fmt(feet)} to ${on.dx ? 'x' : 'z'} ${on.end}`;
    const ahead = await lookAhead(ctx, on, feet);
    if (ahead) { legs.push(`${leg}: ${ahead}`); break; }
    ctx.progress(`the climb failed: ${leg}`);
    const t = await tunnel(on, leg);
    if (t.up) return t.up;
    legs.push(`${leg}${t.met ? `: ${t.met}` : ''} (${t.dug} dug)`);
    if (t.met) break;
    ({ r, up } = await climbUp());
  }
  const top = floored((await look())?.position ?? feet);
  const done = legs.length ? `${legs.join('; ')}; ` : '';
  if (!r.ok) {
    // that side is left for the others a while, and the bot, still deep down out here, goes back under the yard
    // where it can: out here out from under does not want, and nothing else would try again (each other goal's walk is
    // Baritone's, into the margin). Not from near the surface: that would be back down into the pit
    let after = '';
    if (lastSide) { climbFailed.set(lastSide.name, Date.now() + CLIMB_FAILED_MS); after = `; the next try goes another way than ${lastSide.name}`; }
    if (!inColumn(col, top) && below(col, top) > UNDER_BY && back) {
      await ctx.call('goto', { ...back, range: 0, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => undefined);
      stopped();
      const now = floored((await look())?.position ?? top);
      after = `${inColumn(col, now) ? `; back under the yard at ${fmt(now)}` : `; could not get back under the yard from ${fmt(now)}`}${after}`;
    }
    throw new Error(`${done}the climb to ${fmt(up)} failed: ${r.text.slice(0, 120)}${after}`);
  }
  ctx.progress(`climbed to ${fmt(top)}`);
  return `${done}climbed to ${fmt(top)}`;
}
