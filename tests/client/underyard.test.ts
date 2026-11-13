import test from 'ava';
import { Brain, decide } from '../../src/client/brain/brain.js';
import { brainRun, type ClientRuntime, type InventoryItem } from '../../src/client/tools.js';
import { ABOVE_HOME, BELOW_HOME, breakOut, nearHome, nearHomeAt, no, onHomeLevel, resetBreakOut, shelterGoal, type GoalContext, type Snapshot } from '../../src/client/brain/goals.js';
import { bedGoal } from '../../src/client/brain/home.js';
import { signsGoal } from '../../src/client/brain/signs.js';
import { repairGoal } from '../../src/client/brain/repair.js';
import { yardGrowGoal } from '../../src/client/brain/yardgrow.js';
import { enchantGoal } from '../../src/client/brain/enchant.js';
import { donateGoal, missionGoal } from '../../src/client/brain/community.js';
import { inYardOrNear } from '../../src/client/brain/pockets.js';
import { homeColumn, outFromUnder, resetOutFromUnder, setOutFromUnderTiming, underYard } from '../../src/client/brain/underyard.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import { BED, HOME, KEPT, T0, WORN, liveWorld, lookAt, realGoals, roundsAt } from '../helpers/homestead.js';

/**
 * Out from under the yard (Nov 12, 21:45Z to 22:52Z): a deep trip's mining followed the gold from the mine start east
 * of the yard to (-534, 8, 2182), 55 below the lawn and 15 from home across the ground. The bridge's home-zone rule
 * (the yard's rectangle and 6 round it, at any depth) left Baritone nothing to break there, go-home stopped in a
 * second, the bot walled itself in with its own dirt, break out waited an hour on a zombie in the cave, and every home
 * chore took the pocket for home. These tests are on the live homestead (tests/helpers/homestead.ts) and on a stand-in
 * of the rock round the pocket.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// (the sides whose climb failed are the module's: none at the start of each test)
test.beforeEach(() => { resetOutFromUnder(); });
const reply = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const settle = () => new Promise(r => setTimeout(r, 20));

/** The live yard (brain.json): the fence's rectangle, its ground at y 62. */
const YARD = liveWorld().yard!;
/** Where the bot stood walled in. */
const POCKET: Pos = { x: -534, y: 8, z: 2182 };
const key = (p: Pos) => `${p.x},${p.y},${p.z}`;
const across = (p: { x: number; z: number }) => Math.hypot(p.x - HOME.x, p.z - HOME.z);

test('home is a place on its level: 8 under it or 16 over it is still home, further is not, however near across the ground', (t) => {
  t.is(BELOW_HOME, 8);
  t.is(ABOVE_HOME, 16);
  const s = (y: number, d = 15) => lookAt([], 3000, { position: { x: HOME.x + d, y, z: HOME.z }, distHome: d });
  t.true(nearHome(s(63), 16));
  t.true(nearHome(s(55), 16));
  t.false(nearHome(s(54), 16));
  t.true(nearHome(s(79), 16));
  t.false(nearHome(s(80), 16));
  // across the ground it counts as it did
  t.false(nearHome(s(63, 17), 16));
  t.true(nearHomeAt({ x: HOME.x + 8, y: 60, z: HOME.z }, HOME, 10));
  t.false(nearHomeAt({ x: HOME.x + 8, y: 8, z: HOME.z }, HOME, 10));
  t.false(nearHomeAt({ x: HOME.x + 11, y: 63, z: HOME.z }, HOME, 10));
  // nothing known, nothing to say: a look with no place (or no home) is on the level as before
  t.true(onHomeLevel(undefined, HOME));
  t.true(onHomeLevel({ y: 8 }, undefined));
  // the words a chore declines with from down there say where the bot is
  t.deepEqual(no.away(s(8), 'cane', 24), { cause: 'away', text: '15 blocks from home and 55 below it (cane works within 24, on home\'s level)' });
  t.deepEqual(no.away(s(90), 'cane', 24), { cause: 'away', text: '15 blocks from home and 27 above it (cane works within 24, on home\'s level)' });
  t.deepEqual(no.away(s(63, 50), 'cane', 24), { cause: 'away', text: '50 blocks from home (cane works within 24)' });
});

test('under the yard: in the yard\'s rectangle or the bridge\'s margin of 6 round it, at any depth, and more than 8 below the yard\'s ground or below home\'s level', (t) => {
  const under = (x: number, y: number, z: number) => underYard({ x, y, z }, HOME, YARD);
  t.deepEqual(homeColumn(HOME, YARD), { x1: -571, z1: 2113, x2: -527, z2: 2221, ground: 62 });
  t.true(under(-534, 8, 2182), 'the live pocket');
  t.false(under(-534, 63, 2182), 'the lawn');
  t.true(under(-534, 53, 2182));
  // 8 under the ground (62) is 9 under home (63): off its level, so under the yard too. The two meet: with feet at 54
  // the bot was neither, and only the walk home wanted, which stops at once down there
  t.true(under(-534, 54, 2182));
  t.true(under(-534, 54.9, 2182));
  t.false(nearHome(lookAt([], 3000, { position: { x: -534, y: 54, z: 2182 }, distHome: 15 }), 16));
  t.false(under(-534, 55, 2182), 'a cellar 7 under the ground, on home\'s level, is no trap');
  t.true(nearHome(lookAt([], 3000, { position: { x: -534, y: 55, z: 2182 }, distHome: 15 }), 16));
  // the margin all round, by the block the bot stands in (the bridge goes by it)
  t.true(under(-527, 8, 2182));
  t.true(under(-526.5, 8, 2182.5));
  t.false(under(-526, 8, 2182));
  t.true(under(-571, 8, 2182));
  t.false(under(-572, 8, 2182));
  t.true(under(-549, 8, 2113));
  t.false(under(-549, 8, 2112));
  t.true(under(-549, 8, 2221));
  t.false(under(-549, 8, 2222));
  t.false(under(-493, 8, 2183), 'the mine start\'s shaft, 34 past the margin');
  // no yard known: the bridge's circle of 24 round home, taken as its square
  t.true(underYard({ x: HOME.x + 30, y: 8, z: HOME.z + 30 }, HOME));
  t.false(underYard({ x: HOME.x + 31, y: 8, z: HOME.z }, HOME));
  t.false(underYard(POCKET, undefined, YARD));
});

/** The live pockets with a haul to put away, ore to smelt and the diamond kit worn. */
const HAUL: InventoryItem[] = [
  ...KEPT.map(([name, count], slot) => ({ slot, name, count })),
  ...['dirt', 'cobblestone', 'cobbled_deepslate', 'andesite'].map((name, i) => ({ slot: 25 + i, name, count: 64 })),
  { slot: 30, name: 'raw_gold', count: 32 }, { slot: 31, name: 'coal', count: 20 }, ...WORN.map(i => ({ ...i }))
];

test('the live afternoon, 55 under the yard: no home chore takes the pocket for home, and out from under runs, ahead of break out', (t) => {
  const world = roundsAt(liveWorld(), 3 * HOUR);
  const goals = realGoals();
  const look = (p: Pos, over: Partial<Snapshot> = {}) => lookAt(HAUL, 3000, { position: { ...p }, distHome: across(p), ...over });
  const wanting = (s: Snapshot) => goals.filter(g => g.wants(s, world)).map(g => g.name);
  // 8 from home across the ground, on its level: the chores and the rounds all want (the stash, smelt, the rounds)
  const by = { x: -541, z: 2183 };
  const level = wanting(look({ ...by, y: 63 }));
  for (const chore of ['stash', 'smelt', 'farm', 'tidy', 'trees', 'pens', 'cane', 'lights', 'storage', 'project', 'work: cane patch']) t.true(level.includes(chore), chore);
  t.false(level.includes('out from under'));
  // the same 8 out, 55 below: none of them; the way out alone (the walk back to the yard is for once it is up: down
  // here it stops in a second, and three of those would hold it)
  t.deepEqual(wanting(look({ ...by, y: 8 })), ['out from under']);
  // the live pocket itself, 15 out (the cane round's 24, the trees' 24, the storage's 16 all took it for home)
  const pocket = look(POCKET);
  t.deepEqual(wanting(pocket), ['out from under']);
  t.false(inYardOrNear(pocket, world));
  t.true(inYardOrNear(look({ x: -549, y: 63, z: 2125 }), world), 'the yard\'s far end, 58 out on its level, is in it');
  t.is(goals.find(g => g.name === 'cane')!.declines!(pocket, world)?.text, '15 blocks from home and 55 below it (cane works within 24, on home\'s level)');
  // walled in there by day: out from under, not break out (its hole in the wall leads nowhere Baritone may dig)
  const walled = look(POCKET, { boxedIn: [{ x: -533, y: 8, z: 2182 }] });
  t.deepEqual(wanting(walled).slice(0, 2), ['out from under', 'break out']);
  t.is(decide(walled, world, goals, new Map())?.goal.name, 'out from under');
  // hurt, or in the evening: neither the retreat nor the shelter's walk home before dark (each is a go-home, which
  // stops in a second down here: three of those held the shelter until the morning, and the retreat for the day,
  // while out from under waited out a creeper). Out from under heals first and digs out; they are for once it is up
  t.deepEqual(wanting(look(POCKET, { health: 9 })), ['out from under']);
  t.is(decide(look(POCKET, { health: 9 }), world, goals, new Map())?.goal.name, 'out from under');
  const evening = lookAt(HAUL, 11_500, { position: { ...POCKET }, distHome: across(POCKET) });
  t.deepEqual(wanting(evening), ['out from under']);
  // up past the fence, 25 out on the surface: they want as ever, and the walk back to the yard by day
  const up = { x: -524, y: 69, z: 2182 };
  t.true(wanting(look(up, { health: 9 })).includes('retreat'));
  t.is(goals.find(g => g.name === 'shelter')!.wants(lookAt(HAUL, 11_500, { position: up, distHome: across(up) }), world), 'evening: head home before dark');
  t.true(wanting(look(up)).includes('idle'));
  // and at night down there the shelter still walls in (its go-home stops, and the night is spent in the box)
  t.is(goals.find(g => g.name === 'shelter')!.wants(lookAt(HAUL, 15_000, { position: { ...POCKET }, distHome: across(POCKET) }), world), 'night: get home');
});

test('the home chores whose "at home" was across the ground alone: each wants on the lawn, and none 55 under it at the same distance out', (t) => {
  // 8 from home across the ground: within the reach of each (the repair's 10, the bed's and community's 16, the
  // signs' and enchant's 24, the yard grow's 32)
  const by = { x: -541, z: 2183 };
  const at = (y: number, over: Partial<Snapshot>, items: InventoryItem[]) => lookAt(items, 3000, { position: { ...by, y }, distHome: across(by), ...over });
  const both = (name: string, wants: (s: Snapshot) => string | null, over: Partial<Snapshot> = {}, items: InventoryItem[] = HAUL) => {
    t.truthy(wants(at(63, over, items)), `${name} on the lawn`);
    t.is(wants(at(8, over, items)), null, `${name} 55 under it`);
  };
  // the bed: the cabin's bed cell with no bed in it, and one carried
  const bedless = liveWorld();
  delete bedless.landmarks.bed;
  bedless.zones!['home:bed'] = [{ ...BED }];
  both('bed', s => bedGoal.wants(s, bedless), {}, [...HAUL, { slot: 33, name: 'white_bed', count: 1 }]);
  // the signs: a chest without its sign, the round due
  const signs = roundsAt(liveWorld(), 3 * HOUR);
  delete signs.chestSigns!['-547,63,2182'];
  both('signs', s => signsGoal.wants(s, signs));
  // the repair round: something it built by home, the round due
  const repair = repairGoal({ builtNear: () => [{ at: { x: -549, y: 63, z: 2190 }, state: 'oak_planks' }] } as unknown as ClientRuntime);
  const due = roundsAt(liveWorld(), 3 * HOUR);
  both('repair', s => repair.wants(s, due));
  // room asked of the yard
  const grow = { ...liveWorld(), yardGrow: { width: 9, length: 9, why: 'a barn', at: T0 } } as WorldMemory;
  both('yard grow', s => yardGrowGoal.wants(s, grow));
  // level 30, the enchanting table, a diamond pickaxe carried and lapis
  const table = liveWorld();
  table.zones!['enchanting:table'] = [{ x: -547, y: 63, z: 2208 }];
  both('enchant', s => enchantGoal.wants(s, table), { xpLevel: 30 }, [...HAUL, { slot: 33, name: 'lapis_lazuli', count: 16 }]);
  // the community: a mission gathered and owed; and iron to spare for the donation round
  const mission = liveWorld();
  mission.community!.missions.push({ id: 2, item: 'diamond', count: 8, chest: 'community1', gathered: 8, delivered: 0, status: 'active', createdAt: T0, updatedAt: T0 });
  both('community', s => missionGoal.wants(s, mission));
  t.is(missionGoal.declines!(at(8, {}, HAUL), mission)?.text, '8 blocks from home and 55 below it (community works within 16, on home\'s level)');
  both('donate', s => donateGoal.wants(s, liveWorld()), {}, [...HAUL, { slot: 33, name: 'iron_ingot', count: 64 }]);
});

// ------------------------------------------------------------------------------------------------ the rock

const OPEN = /^(air|cave_air)$/;
const LIQUID = /^(lava|water)(\[|$)/;
type Seen = { id: number; name: string; category: string; position: Pos };

/**
 * The rock round the pocket as the client and the bridge answer for it: the lawn at y 62 over the yard and its
 * margin, a stone hill east of it (its top at 68: the lead came up at (-516, 69, 2182)), stone below, deepslate under
 * y 0; and what a test puts in it. `dig-block` is the bridge's dig: it lifts the zone rule for the one block's kind
 * and digs what is in reach (more than 4.5 from the eyes its builder would have to walk, and under the zone it may
 * break nothing else on the way: it times out); a liquid "digs" (the bridge counts a replaceable block as dug) and
 * stays; someone else's build is refused; gravel falls into what was dug under it. The careful `goto` is Baritone's
 * GoalBlock: it walks into the next cell only, to a place open 2 high with a floor under it, dropping 3 at most on
 * the way (a cell with air under it has no path, and the bot stays put). `move-to-position` is Baritone free to dig
 * and pillar, straight up here: from inside the zone's column it may break nothing and finds no way up through the
 * rock, and within 24 of a block the bot built it breaks nothing of that block's kind (Protection.java: the yard's
 * dirt and grass), so a cap of those stops it under them.
 */
class Rock {
  private cells = new Map<string, string>();
  /** cells the client has not loaded: world.region answers null there */
  unseen = new Set<string>();
  /** someone else's build */
  theirs = new Set<string>();
  /** cells the careful walk does not get into (Baritone finds no way, walk only) */
  noWalk = new Set<string>();
  /** blocks the bot built (placed-blocks.json): within 24 of one, its kind is one Baritone may not break */
  built: Pos[] = [];
  bot: Pos;
  health = 20;
  /** health gained at each look (the Guardian eating), and what it is at most */
  healing = 0;
  entities: Seen[] = [];
  dug: Pos[] = [];
  climbed: Pos[] = [];
  /** what a dig of these cells does to the mobs (the auto-defend kills the zombie through the gap) */
  onDig?: (p: Pos) => void;

  constructor(at: Pos = POCKET) { this.bot = { ...at }; }
  ground(x: number): number { return x > YARD.x2 + 6 ? 68 : YARD.y; }
  at(p: Pos): string {
    const c = this.cells.get(key(p));
    if (c) return c;
    const g = this.ground(p.x);
    return p.y > g ? 'air' : p.y === g && g === YARD.y ? 'grass_block' : p.y < 0 ? 'deepslate' : 'stone';
  }
  set(p: Pos, b: string): void { this.cells.set(key(p), b); }
  inZone(p: Pos): boolean { return p.x >= YARD.x1 - 6 && p.x <= YARD.x2 + 6 && p.z >= YARD.z1 - 6 && p.z <= YARD.z2 + 6; }
  open(p: Pos): boolean { return OPEN.test(this.at(p)); }
  centre(): Pos { return { x: this.bot.x + 0.5, y: this.bot.y, z: this.bot.z + 0.5 }; }

  region(b: { x: number; y: number; z: number; width: number; height: number; length: number }): (string | null)[] {
    const out: (string | null)[] = [];
    for (let y = 0; y < b.height; y++) for (let z = 0; z < b.length; z++) for (let x = 0; x < b.width; x++) {
      const p = { x: b.x + x, y: b.y + y, z: b.z + z };
      out.push(this.unseen.has(key(p)) ? null : this.at(p));
    }
    return out;
  }

  seen(maxDistance: number) {
    const me = this.centre();
    return this.entities.map(e => ({ ...e, distance: Math.hypot(e.position.x - me.x, e.position.y - me.y, e.position.z - me.z) }))
      .filter(e => e.distance <= maxDistance).sort((a, b) => a.distance - b.distance);
  }

  dig(p: Pos): { ok: boolean; text: string } {
    const b = this.at(p);
    const at = `(${p.x}, ${p.y}, ${p.z})`;
    if (OPEN.test(b)) return { ok: true, text: `No block found at position ${at}` };
    if (this.theirs.has(key(p))) throw new Error(`Could not dig ${b} at ${at} (someone else's build (force: true to dig it anyway)).`);
    const eye = { x: this.bot.x + 0.5, y: this.bot.y + 1.62, z: this.bot.z + 0.5 };
    if (Math.hypot(p.x + 0.5 - eye.x, p.y + 0.5 - eye.y, p.z + 0.5 - eye.z) > 4.5) throw new Error(`Could not dig ${b} at ${at} (timeout).`);
    if (LIQUID.test(b)) return { ok: true, text: `Dug ${b.replace(/\[.*$/, '')} at ${at}` };
    this.set(p, 'air');
    this.dug.push({ ...p });
    for (let y = p.y; /^(gravel|sand)$/.test(this.at({ ...p, y: y + 1 })); y++) { this.set({ ...p, y }, this.at({ ...p, y: y + 1 })); this.set({ ...p, y: y + 1 }, 'air'); }
    this.onDig?.(p);
    return { ok: true, text: `Dug ${b} at ${at} with diamond_pickaxe. Picked up 1 ${b === 'stone' ? 'cobblestone' : b}` };
  }

  step(to: Pos): { arrived: boolean; at: Pos } {
    // further off along a straight way at its own level, open 2 high on a floor all the way (the tunnel it dug): there
    const along = Math.abs(to.x - this.bot.x) + Math.abs(to.z - this.bot.z);
    if (along > 1 && to.y === this.bot.y && (to.x === this.bot.x || to.z === this.bot.z)) {
      const dx = Math.sign(to.x - this.bot.x), dz = Math.sign(to.z - this.bot.z);
      const way = Array.from({ length: along }, (_, i) => ({ x: this.bot.x + dx * (i + 1), y: to.y, z: this.bot.z + dz * (i + 1) }));
      if (!way.every(c => this.open(c) && this.open({ ...c, y: c.y + 1 }) && !this.open({ ...c, y: c.y - 1 }) && !this.noWalk.has(key(c)))) return { arrived: false, at: { ...this.bot } };
      this.bot = { ...to };
      return { arrived: true, at: { ...to } };
    }
    const near = Math.abs(to.x - this.bot.x) + Math.abs(to.z - this.bot.z) === 1 && to.y <= this.bot.y && to.y >= this.bot.y - 3;
    // over open cells from the bot's level down to the place, and a floor under that
    const way = near && Array.from({ length: this.bot.y - to.y + 2 }, (_, i) => ({ ...to, y: to.y + i })).every(p => this.open(p));
    if (!way || this.open({ ...to, y: to.y - 1 }) || this.noWalk.has(key(to))) return { arrived: false, at: { ...this.bot } };
    this.bot = { ...to };
    return { arrived: true, at: { ...to } };
  }

  /** the kinds Baritone may not break with the bot's feet at `p`: those of what it built within 24 */
  guarded(p: Pos): Set<string> {
    return new Set(this.built.filter(b => Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z) <= 24).map(b => this.at(b)));
  }

  climb(to: Pos): { ok: boolean; text: string } {
    const stuck = () => new Error(`Could not reach (${to.x}, ${to.y}, ${to.z}): no path found. Stopped at (${this.bot.x}, ${this.bot.y}, ${this.bot.z}), ${Math.round(to.y - this.bot.y)} blocks away.`);
    if (this.inZone(this.bot)) throw stuck();
    // up its own column: the block over its head broken (or open) at each step, or it stops under it
    for (let y = this.bot.y; y < to.y; y++) {
      const over = { ...this.bot, y: y + 2 };
      if (!this.open(over) && this.guarded({ ...this.bot, y }).has(this.at(over))) { this.bot = { ...this.bot, y }; throw stuck(); }
      this.set(over, 'air');
    }
    this.climbed.push({ ...to });
    this.bot = { ...to };
    return { ok: true, text: `Successfully moved to position near (${to.x}, ${to.y}, ${to.z})` };
  }
}

/** The live pocket: a cell 2 high walled with the bot's dirt (four sides and a roof), a cave beyond its east wall with a zombie in it, diagonally outside. */
function livePocket(at: Pos = POCKET): Rock {
  const r = new Rock(at);
  r.set(at, 'air');
  r.set({ ...at, y: at.y + 1 }, 'air');
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) r.set({ x: at.x + dx, y: at.y + dy, z: at.z + dz }, 'dirt');
  r.set({ ...at, y: at.y + 2 }, 'dirt');
  for (let x = at.x + 1; x <= at.x + 4; x++) for (let z = at.z - 1; z <= at.z + 1; z++) for (const y of [at.y, at.y + 1]) if (!(x === at.x + 1 && z === at.z)) r.set({ x, y, z }, 'cave_air');
  r.entities.push({ id: 7, name: 'zombie', category: 'monster', position: { x: at.x + 2.5, y: at.y, z: at.z + 1.5 } });
  return r;
}
/** The wall the Guardian put up: the four sides 2 high, and the roof. */
const wallOf = (at: Pos): Pos[] => [...[[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([dx, dz]) => [0, 1].map(dy => ({ x: at.x + dx, y: at.y + dy, z: at.z + dz }))), { ...at, y: at.y + 2 }];

/** A run's context over the rock: the look from where the bot stands, the bridge's calls and the tools as the rock answers them. */
function ctxIn(rock: Rock, over: Partial<Snapshot> = {}, world: WorldMemory = liveWorld()) {
  const said: string[] = [];
  const ac = new AbortController();
  const tools: string[] = [];
  let gained = 0;
  const s = lookAt(HAUL, 3000, { position: rock.centre(), distHome: across(rock.bot), health: rock.health, ...over });
  const ctx: GoalContext = {
    s, world, signal: ac.signal,
    progress: text => { said.push(text); },
    gain: n => { gained += n; },
    status: async () => {
      rock.health = Math.min(20, rock.health + rock.healing);
      return { inWorld: true, username: 'claudebot', screen: null, position: rock.centre(), block: { ...rock.bot }, health: rock.health, dimension: 'overworld' };
    },
    call: (async (method: string, p: Record<string, unknown> = {}) => {
      if (method === 'world.region') return { blocks: rock.region(p as Parameters<Rock['region']>[0]) };
      if (method === 'world.entities') return { entities: rock.seen(Number(p.maxDistance ?? 32)) };
      if (method === 'goto') {
        if (!p.careful) throw new Error('a walk under the yard is careful');
        return rock.step({ x: Number(p.x), y: Number(p.y), z: Number(p.z) });
      }
      return {};
    }) as GoalContext['call'],
    act: async (tool, a = {}) => {
      tools.push(tool);
      const p = { x: Math.floor(Number(a.x)), y: Math.floor(Number(a.y)), z: Math.floor(Number(a.z)) };
      if (tool === 'dig-block') return rock.dig(p);
      if (tool === 'move-to-position') return rock.climb(p);
      if (tool === 'go-home') return rock.inZone(rock.bot) ? { ok: false, text: 'Stopped 57 blocks from home after 1s' } : { ok: true, text: 'Home' };
      if (tool === 'wall-in') { for (const c of wallOf(rock.bot)) if (rock.open(c)) rock.set(c, 'dirt'); return { ok: true, text: `Walled in at (${rock.bot.x}, ${rock.bot.y}, ${rock.bot.z})` }; }
      throw new Error(`no tool ${tool}`);
    }
  };
  return { ctx, said, tools, gained: () => gained, abort: () => ac.abort() };
}

const lookIn = (rock: Rock, over: Partial<Snapshot> = {}) => lookAt(HAUL, 3000, { position: rock.centre(), distHome: across(rock.bot), ...over });

test.serial('out from under, the live pocket: through its own dirt wall and the cave, 2 high east at its level to 3 past the margin, then up where Baritone may dig', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  const world = liveWorld();
  t.is(outFromUnder.wants(lookIn(rock), world), '54 under the yard\'s ground at (-534, 8, 2182): Baritone may break nothing here');
  const run = ctxIn(rock);
  t.is(await outFromUnder.run(run.ctx), 'tunnel east from (-534, 8, 2182) to x -524 (14 dug); climbed to (-524, 69, 2182)');
  t.deepEqual(run.said, ['tunnel east from (-534, 8, 2182) to x -524', 'climbed to (-524, 69, 2182)']);
  t.is(run.gained(), 14, 'a gain for every block dug: the loop watch sees it is getting somewhere');
  // its own wall east first (the dirt), the cave open already, then the stone to x -524: at its own level only
  t.deepEqual(rock.dug.slice(0, 2), [{ x: -533, y: 9, z: 2182 }, { x: -533, y: 8, z: 2182 }]);
  t.true(rock.dug.every(p => (p.y === 8 || p.y === 9) && p.z === 2182 && p.x > POCKET.x && p.x <= -524));
  // the rest of the wall stays: no stray blocks dug down there for nothing
  t.deepEqual(wallOf(POCKET).filter(p => rock.at(p) === 'dirt').length, 7);
  // up outside the margin (x -527 is its edge), where the hole Baritone digs is no hole in the lawn
  t.deepEqual(rock.climbed, [{ x: -524, y: 69, z: 2182 }]);
  t.false(rock.inZone(rock.climbed[0]));
  t.is(outFromUnder.wants(lookIn(rock), world), null);
  // the walk home from up there is the surface's: go-home was never asked down here, where it stops in a second
  t.false(run.tools.includes('go-home'));
});

test.serial('out from under: lava ahead on the nearest side is never dug toward; it turns to the next nearest', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  rock.set({ x: -528, y: 8, z: 2183 }, 'lava[level=0]');
  const run = ctxIn(rock);
  t.is(await outFromUnder.run(run.ctx), 'tunnel west from (-534, 8, 2182) to x -574 (80 dug); climbed to (-574, 63, 2182)');
  t.deepEqual(run.said.slice(0, 2), ['east is shut (lava at (-528, 8, 2183)): the next way out', 'tunnel west from (-534, 8, 2182) to x -574']);
  t.false(rock.dug.some(p => p.x > POCKET.x), 'nothing dug east');
  t.true(rock.dug.every(p => p.y === 8 || p.y === 9), 'under the whole yard, at its own level only: 55 below the lawn');
  t.false(rock.inZone(rock.climbed[0]));
});

test.serial('out from under: water a dig turns up (unseen till then) shuts that way: it goes on from where it stands to the next nearest side', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  const wet = { x: -529, y: 9, z: 2182 };
  rock.set(wet, 'water[level=0]');
  rock.unseen.add(key(wet));
  const run = ctxIn(rock);
  t.is(await outFromUnder.run(run.ctx),
    'tunnel east from (-534, 8, 2182) to x -524: water at (-529, 9, 2182) (2 dug); tunnel south from (-530, 8, 2182) to z 2224 (82 dug); climbed to (-530, 63, 2224)');
  t.true(run.said.includes('east: water at (-529, 9, 2182): the next way out'));
  t.is(rock.at(wet), 'water[level=0]');
  t.false(rock.inZone(rock.climbed[0]));
});

test.serial('out from under: what the bridge will not dig (someone else\'s build: an old mineshaft) shuts that way, and nothing of it is dug', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  for (const y of [8, 9]) { rock.set({ x: -526, y, z: 2182 }, 'oak_planks'); rock.theirs.add(key({ x: -526, y, z: 2182 })); }
  const run = ctxIn(rock);
  const text = await outFromUnder.run(run.ctx);
  t.regex(text, /^tunnel east from \(-534, 8, 2182\) to x -524: could not dig at \(-526, 9, 2182\): Could not dig oak_planks at \(-526, 9, 2182\) \(someone else's build/);
  t.regex(text, /; tunnel south from \(-527, 8, 2182\) to z 2224 \(\d+ dug\); climbed to \(-527, 63, 2224\)$/);
  t.false(rock.dug.some(p => rock.theirs.has(key(p))));
});

test.serial('out from under: a careful step that does not go shuts that way too; the next is dug from where the bot stands', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  rock.noWalk.add(key({ x: -529, y: 8, z: 2182 }));
  const run = ctxIn(rock);
  t.regex(await outFromUnder.run(run.ctx), /^tunnel east from \(-534, 8, 2182\) to x -524: could not walk on from \(-530, 8, 2182\) \(4 dug\); tunnel south from \(-530, 8, 2182\) to z 2224 \(82 dug\); climbed to \(-530, 63, 2224\)$/);
});

test.serial('out from under: with every way out shut by lava it digs nothing and fails, and three failures hold it 10 min, not the night', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  for (const p of [{ x: -533, y: 7, z: 2182 }, { x: -535, y: 7, z: 2182 }, { x: -534, y: 7, z: 2183 }, { x: -534, y: 7, z: 2181 }]) rock.set(p, 'lava[level=0]');
  const run = ctxIn(rock);
  await t.throwsAsync(outFromUnder.run(run.ctx), {
    message: 'every way out is shut: east: lava at (-533, 7, 2182); west: lava at (-535, 7, 2182); south: lava at (-534, 7, 2183); north: lava at (-534, 7, 2181)'
  });
  t.deepEqual(rock.dug, []);
  t.is(outFromUnder.failHoldMs, 10 * MINUTE);
  t.is(outFromUnder.retryMs, 20_000);
});

test.serial('out from under, hurt: it waits for the Guardian to eat before it tunnels into the cave, a minute at most, and then goes all the same', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  rock.health = 5;
  rock.healing = 1;
  const healthAtDig: number[] = [];
  rock.onDig = () => { healthAtDig.push(rock.health); };
  const run = ctxIn(rock, { health: 5 });
  t.regex(await outFromUnder.run(run.ctx), /climbed to \(-524, 69, 2182\)$/);
  t.is(run.said[0], 'health 6: waiting for the Guardian to eat before tunnelling on');
  t.true(healthAtDig.every(h => h >= 8), `${healthAtDig.join(', ')}`);
  // nothing to eat: health stays; after the wait it goes (the pocket is no better a place to be)
  const hungry = livePocket();
  hungry.health = 5;
  const h = ctxIn(hungry, { health: 5 });
  t.regex(await outFromUnder.run(h.ctx), /climbed to \(-524, 69, 2182\)$/);
  t.deepEqual(h.said.slice(0, 2), ['health 5: waiting for the Guardian to eat before tunnelling on', 'health 5 after the wait: out all the same']);
});

test.serial('out from under opens no wall on a creeper\'s side: it digs out the other way, and waits only with one on every side', async (t) => {
  setOutFromUnderTiming(1, 100);
  // in the cave east and south of the pocket: out west, through its own wall on that side
  const rock = livePocket();
  rock.entities = [{ id: 9, name: 'creeper', category: 'monster', position: { x: -531.5, y: 8, z: 2183.5 } }];
  const run = ctxIn(rock);
  t.is(await outFromUnder.run(run.ctx), 'tunnel west from (-534, 8, 2182) to x -574 (80 dug); climbed to (-574, 63, 2182)');
  t.deepEqual(run.said.slice(0, 2), ['east is shut (creeper 2 blocks away): the next way out', 'south is shut (creeper 2 blocks away): the next way out']);
  t.false(rock.dug.some(p => p.x > POCKET.x || p.z !== POCKET.z), 'not a block dug on its side');
  // one shut in a cave 6 west, behind the rock (it never despawns, as the zombie did not): out east as ever
  const behind = livePocket();
  behind.entities = [{ id: 9, name: 'creeper', category: 'monster', position: { x: -539.5, y: 8, z: 2182.5 } }];
  t.is(await outFromUnder.run(ctxIn(behind).ctx), 'tunnel east from (-534, 8, 2182) to x -524 (14 dug); climbed to (-524, 69, 2182)');
  // one on every side: it waits (the next try looks again), and nothing is dug
  const round = livePocket();
  round.entities = [[-531.5, 2183.5], [-537.5, 2181.5]].map(([x, z], i) => ({ id: 9 + i, name: 'creeper', category: 'monster', position: { x, y: 8, z } }));
  await t.throwsAsync(outFromUnder.run(ctxIn(round).ctx), { message: 'waiting: creeper 2 blocks away' });
  t.deepEqual(round.dug, []);
});

test.serial('out from under: lava one past the tunnel\'s end (the last cell dug would open onto it) shuts that way', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  rock.set({ x: -523, y: 8, z: 2182 }, 'lava[level=0]');
  const run = ctxIn(rock);
  t.regex(await outFromUnder.run(run.ctx), /^tunnel west from \(-534, 8, 2182\) to x -574 \(80 dug\); climbed to \(-574, 63, 2182\)$/);
  t.is(run.said[0], 'east is shut (lava at (-523, 8, 2182)): the next way out');
  t.false(rock.dug.some(p => p.x > POCKET.x));
});

test.serial('out from under: a look ahead that fails is no clear way: nothing is dug, and the next try looks again', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  rock.set({ x: -528, y: 8, z: 2183 }, 'lava[level=0]');
  const run = ctxIn(rock);
  const call = run.ctx.call;
  run.ctx.call = (async (method: string, p?: Record<string, unknown>) => {
    if (method === 'world.region') throw new Error('timed out');
    return call(method, p);
  }) as GoalContext['call'];
  await t.throwsAsync(outFromUnder.run(run.ctx), { message: 'every way out is shut: east: could not look ahead; west: could not look ahead; south: could not look ahead; north: could not look ahead' });
  t.deepEqual(rock.dug, []);
  // a short answer is no look either
  const short = ctxIn(livePocket());
  const rest = short.ctx.call;
  short.ctx.call = (async (method: string, p?: Record<string, unknown>) => (method === 'world.region' ? { blocks: ['stone'] } : rest(method, p))) as GoalContext['call'];
  await t.throwsAsync(outFromUnder.run(short.ctx), { message: /^every way out is shut: east: could not look ahead;/ });
});

test.serial('out from under: a cave floor a little lower on the way is walked down onto (a careful step into a cell with no floor has no path); a drop deeper than 3 shuts that way', async (t) => {
  setOutFromUnderTiming(1, 100);
  // beyond the pocket's cave, one a block lower (its floor at y 6) across the way east
  const rock = livePocket();
  for (let x = -531; x <= -529; x++) for (const y of [7, 8, 9]) rock.set({ x, y, z: 2182 }, 'cave_air');
  const run = ctxIn(rock);
  t.is(await outFromUnder.run(run.ctx), 'tunnel east from (-534, 8, 2182) to x -524 (12 dug); climbed to (-524, 69, 2182)');
  // down there the tunnel goes on at the cave's level
  t.true(rock.dug.filter(p => p.x > -531).every(p => p.y === 7 || p.y === 8));
  t.deepEqual(rock.climbed, [{ x: -524, y: 69, z: 2182 }]);
  // a shaft down to y 2 across the way: no walk down it, and the next nearest side
  const deep = livePocket();
  for (let y = 2; y <= 9; y++) deep.set({ x: -531, y, z: 2182 }, 'cave_air');
  const d = ctxIn(deep);
  t.is(await outFromUnder.run(d.ctx), 'tunnel east from (-534, 8, 2182) to x -524: no floor within 3 under (-531, 8, 2182) (2 dug); tunnel west from (-532, 8, 2182) to x -574 (80 dug); climbed to (-574, 63, 2182)');
  t.false(d.tools.includes('go-home'));
});

test.serial('out from under: a cap of dirt and grass over the climb, within 24 of the yard\'s built dirt (which Baritone may not break), is dug from under it, and the climb goes on', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  // the top of the climb's column east of the fence: grass over three of dirt, 9 from the yard's built lawn
  for (const y of [65, 66, 67]) rock.set({ x: -524, y, z: 2182 }, 'dirt');
  rock.set({ x: -524, y: 68, z: 2182 }, 'grass_block');
  rock.set({ x: -533, y: 61, z: 2182 }, 'dirt');
  rock.built = [{ x: -533, y: 61, z: 2182 }, { x: -533, y: 62, z: 2182 }];
  const run = ctxIn(rock);
  t.is(await outFromUnder.run(run.ctx), 'tunnel east from (-534, 8, 2182) to x -524 (14 dug); dug 4 over its head at (-524, 63, 2182); climbed to (-524, 69, 2182)');
  t.true(run.said.includes('dug 4 over its head at (-524, 63, 2182): the climb goes on'));
  t.deepEqual(rock.dug.slice(-4), [65, 66, 67, 68].map(y => ({ x: -524, y, z: 2182 })));
  t.is(run.gained(), 18);
  // what the bot built is not touched: only the cap over its own head
  t.is(rock.at({ x: -533, y: 61, z: 2182 }), 'dirt');
  // a pond over the cap: no shaft dug up into it (it would run down onto the bot). The climb stops under it, past
  // the margin, where out from under does not want: it tunnels on east 4 from there and comes up beside the pond
  const wet = livePocket();
  for (const y of [65, 66, 67]) wet.set({ x: -524, y, z: 2182 }, 'dirt');
  wet.set({ x: -524, y: 68, z: 2182 }, 'grass_block');
  wet.set({ x: -524, y: 69, z: 2182 }, 'water[level=0]');
  wet.set({ x: -533, y: 61, z: 2182 }, 'dirt');
  wet.built = [{ x: -533, y: 61, z: 2182 }];
  const w = ctxIn(wet);
  t.is(await outFromUnder.run(w.ctx),
    'tunnel east from (-534, 8, 2182) to x -524 (14 dug); the shaft over (-524, 63, 2182): water over its head at (-524, 69, 2182); on east from (-524, 63, 2182) to x -520 (8 dug); climbed to (-520, 69, 2182)');
  t.true(w.said.includes('the climb failed: on east from (-524, 63, 2182) to x -520'));
  t.is(wet.at({ x: -524, y: 65, z: 2182 }), 'dirt');
  t.is(wet.at({ x: -524, y: 69, z: 2182 }), 'water[level=0]');
  t.deepEqual(wet.climbed, [{ x: -520, y: 69, z: 2182 }]);
});

/** Baritone's climb from one place fails: the bot left where `stop` puts it, and the call's error. */
function failClimbAt(rock: Rock, from: (to: Pos) => boolean, stop: (bot: Pos) => Pos = bot => bot) {
  const climb = rock.climb.bind(rock);
  rock.climb = to => {
    if (!from(to) || rock.inZone(rock.bot)) return climb(to);
    rock.bot = stop(rock.bot);
    throw new Error(`Could not reach (${to.x}, ${to.y}, ${to.z}): no path found. Stopped at (${rock.bot.x}, ${rock.bot.y}, ${rock.bot.z}).`);
  };
}

test.serial('out from under: a climb that steps back under the margin (the next run would take the same nearest side) is left for the others: the next run goes another way', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  const world = liveWorld();
  // the climb at the east end's spot goes up a staircase west, back into the margin, and stops there
  failClimbAt(rock, to => to.x === -524 && to.z === 2182, bot => ({ x: -527, y: bot.y + 3, z: bot.z }));
  await t.throwsAsync(outFromUnder.run(ctxIn(rock).ctx), {
    message: /^tunnel east from \(-534, 8, 2182\) to x -524 \(14 dug\); the climb to \(-524, 69, 2182\) failed: Could not reach .*; the next try goes another way than east$/
  });
  t.deepEqual(rock.bot, { x: -527, y: 11, z: 2182 });
  t.truthy(outFromUnder.wants(lookIn(rock), world));
  // east is nearest from there too (3 to its end): left out, the next nearest is south
  const next = ctxIn(rock);
  t.is(await outFromUnder.run(next.ctx), 'tunnel south from (-527, 11, 2182) to z 2224 (84 dug); climbed to (-527, 63, 2224)');
  t.is(next.said[0], 'east is shut (its climb failed within the hour): the next way out');
  t.is(outFromUnder.wants(lookIn(rock), world), null);
});

test.serial('out from under: no way up at the end of the tunnel nor further along it: back into the column through the tunnel, so the next try comes, and goes another way', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  const world = liveWorld();
  // Baritone finds no path up anywhere east of the margin, and stays where it stands
  failClimbAt(rock, to => to.x >= -524);
  const first = ctxIn(rock);
  const failed = await outFromUnder.run(first.ctx).catch((e: Error) => e.message);
  t.regex(failed, /^tunnel east from \(-534, 8, 2182\) to x -524 \(14 dug\); dug 4 over its head at \(-524, 8, 2182\); on east from \(-524, 8, 2182\) to x -520 \(8 dug\); dug 4 over its head at \(-520, 8, 2182\); on east from \(-520, 8, 2182\) to x -516 \(8 dug\); dug 4 over its head at \(-516, 8, 2182\); the climb to \(-516, 69, 2182\) failed: Could not reach/);
  t.regex(failed, /; back under the yard at \(-527, 8, 2182\); the next try goes another way than east$/);
  // in the column again, at its edge: out from under wants, and the next try takes the next nearest side
  t.deepEqual(rock.bot, { x: -527, y: 8, z: 2182 });
  t.truthy(outFromUnder.wants(lookIn(rock), world));
  t.is(await outFromUnder.run(ctxIn(rock).ctx), 'tunnel south from (-527, 8, 2182) to z 2224 (84 dug); climbed to (-527, 63, 2224)');
  // never past the leash: 33 from home at the furthest
  t.true(rock.dug.every(p => Math.hypot(p.x - HOME.x, p.z - HOME.z) <= liveWorld().leash));
});

test.serial('out from under: with every side\'s climb failed, they are all tried again (no hour-long "every way out is shut")', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  const col = homeColumn(HOME, YARD);
  // every climb steps back to the column's edge, 3 higher
  failClimbAt(rock, () => true, bot => ({ x: Math.min(col.x2, Math.max(col.x1, bot.x)), y: bot.y + 3, z: Math.min(col.z2, Math.max(col.z1, bot.z)) }));
  const ways: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await outFromUnder.run(ctxIn(rock).ctx).catch((e: Error) => e.message);
    ways.push(/^tunnel (\w+)/.exec(r)?.[1] ?? r);
  }
  // each side once, then all four again from the nearest
  t.deepEqual(ways.slice(0, 4).sort(), ['east', 'north', 'south', 'west']);
  t.not(ways[4].slice(0, 22), 'every way out is shut');
  t.true(['east', 'west', 'south', 'north'].includes(ways[4]), ways[4]);
});

test('out from under wants only under the yard: not in its own mine shaft past the margin, not in a cellar 8 under the lawn, not at home, not asleep', (t) => {
  const world = liveWorld();
  const at = (p: Pos, over: Partial<Snapshot> = {}) => outFromUnder.wants(lookAt(HAUL, 3000, { position: p, distHome: across(p), ...over }), world);
  t.truthy(at(POCKET));
  t.truthy(at(POCKET, { activity: 'rest', timeOfDay: 15_000 }), 'by night as by day');
  t.is(at({ x: -493, y: 8, z: 2183 }), null);
  t.is(at({ x: -549, y: 55, z: 2183 }), null);
  t.is(at({ ...HOME }), null);
  t.is(at(POCKET, { sleeping: true }), null);
  t.is(at(POCKET, { dimension: 'the_nether' }), null);
});

// ------------------------------------------------------------------------------------------------ break out

/** A wall-in in a cave 60 east of home, outside the yard: the zombie in the cave beyond its east wall. */
const CAVE: Pos = { x: -489, y: 30, z: 2182 };
const IRON = ['iron_boots', 'iron_leggings', 'iron_chestplate', 'iron_helmet'].map((name, i): InventoryItem => ({ slot: 36 + i, name, count: 1 }));

test.serial('break out never waits for good: the third run that finds the same zombie, the bot well and armoured, opens the wall toward it and lets the Guardian fight', async (t) => {
  resetBreakOut();
  const rock = livePocket(CAVE);
  // the zombie comes through the gap, and the auto-defend kills it
  rock.onDig = p => { if (p.x === CAVE.x + 1 && p.z === CAVE.z) rock.entities = []; };
  const s = lookIn(rock, { boxedIn: wallOf(CAVE) });
  t.is(breakOut.wants(s, liveWorld()), 'walled in, and it is day');
  for (let i = 0; i < 2; i++) await t.throwsAsync(breakOut.run(ctxIn(rock, { boxedIn: wallOf(CAVE) }).ctx), { message: 'waiting: zombie 2 blocks away' });
  t.deepEqual(rock.dug, []);
  const third = ctxIn(rock, { boxedIn: wallOf(CAVE) });
  t.is(await breakOut.run(third.ctx), 'opened the wall toward the zombie (health 20, diamond armour); then dug out of the wall-in (7 more of 9 block(s))');
  t.is(third.said[0], 'opened the wall toward the zombie (health 20, diamond armour)');
  // its side of the wall first (the east, the zombie standing diagonally out there), then the rest of what it built
  t.deepEqual(rock.dug.slice(0, 2), [{ x: CAVE.x + 1, y: CAVE.y, z: CAVE.z }, { x: CAVE.x + 1, y: CAVE.y + 1, z: CAVE.z }]);
  t.is(rock.dug.length, 9);
});

test.serial('break out: the fight still on after the opening (the zombie about, the bot hurt): it digs out the rest of its wall all the same (with a side open no run comes after it)', async (t) => {
  resetBreakOut();
  const rock = livePocket(CAVE);
  rock.healing = -7;
  for (let i = 0; i < 2; i++) await t.throwsAsync(breakOut.run(ctxIn(rock, { boxedIn: wallOf(CAVE) }).ctx));
  t.is(await breakOut.run(ctxIn(rock, { boxedIn: wallOf(CAVE) }).ctx), 'opened the wall toward the zombie (health 20, diamond armour); still about; then dug out of the wall-in (7 more of 9 block(s))');
  t.deepEqual(rock.dug.slice(0, 2), [{ x: CAVE.x + 1, y: CAVE.y, z: CAVE.z }, { x: CAVE.x + 1, y: CAVE.y + 1, z: CAVE.z }]);
  t.is(rock.dug.length, 9);
});

test.serial('break out on the lawn (the Nov 10 wall-in: its own dirt east and west at the feet only, north 2 high, the roof): the zombie east, it opens its north side 2 high, never a 1-high gap under a block, and leaves nothing of its wall', async (t) => {
  // brain.log Nov 10 01:16: walled in at (-540, 63, 2187), 5 block(s) placed. East and west the head cells were solid
  // already, and the south side: only the north side is the wall-in's own at both heights
  const at: Pos = { x: -540, y: 63, z: 2187 };
  const box = () => {
    const rock = new Rock(at);
    const own: Pos[] = [{ x: -539, y: 63, z: 2187 }, { x: -541, y: 63, z: 2187 }, { x: -540, y: 63, z: 2186 }, { x: -540, y: 64, z: 2186 }, { x: -540, y: 65, z: 2187 }];
    for (const c of own) rock.set(c, 'dirt');
    const theirs: Pos[] = [{ x: -539, y: 64, z: 2187 }, { x: -541, y: 64, z: 2187 }, { x: -540, y: 63, z: 2188 }, { x: -540, y: 64, z: 2188 }];
    for (const c of theirs) rock.set(c, c.z === 2188 ? 'chest' : 'oak_planks');
    rock.entities = [{ id: 7, name: 'zombie', category: 'monster', position: { x: -537.5, y: 63, z: 2187.5 } }];
    return { rock, own, theirs };
  };
  // the zombie comes round to the gap and the auto-defend kills it there
  resetBreakOut();
  const a = box();
  a.rock.onDig = p => { if (p.x === -540 && p.y === 64 && p.z === 2186) a.rock.entities = []; };
  for (let i = 0; i < 2; i++) await t.throwsAsync(breakOut.run(ctxIn(a.rock, { boxedIn: a.own }).ctx), { message: 'waiting: zombie 2 blocks away' });
  t.is(await breakOut.run(ctxIn(a.rock, { boxedIn: a.own }).ctx), 'opened the wall toward the zombie (health 20, diamond armour); then dug out of the wall-in (3 more of 5 block(s))');
  t.deepEqual(a.rock.dug.slice(0, 2), [{ x: -540, y: 63, z: 2186 }, { x: -540, y: 64, z: 2186 }]);
  // still about after the half minute (here: the bot hurt): the rest of the wall is dug as well, since with its north
  // side open the box is no box, and break out never wants again
  resetBreakOut();
  const b = box();
  b.rock.healing = -7;
  for (let i = 0; i < 2; i++) await t.throwsAsync(breakOut.run(ctxIn(b.rock, { boxedIn: b.own }).ctx));
  t.is(await breakOut.run(ctxIn(b.rock, { boxedIn: b.own }).ctx), 'opened the wall toward the zombie (health 20, diamond armour); still about; then dug out of the wall-in (3 more of 5 block(s))');
  for (const r of [a.rock, b.rock]) {
    t.notDeepEqual(r.dug[0], { x: -539, y: 63, z: 2187 }, 'not the 1-high gap east, under the planks');
    t.deepEqual(r.dug.slice(0, 2), [{ x: -540, y: 63, z: 2186 }, { x: -540, y: 64, z: 2186 }]);
    t.deepEqual(a.own.filter(c => r.at(c) !== 'air'), [], 'nothing of its wall is left on the lawn');
    t.deepEqual(a.theirs.map(c => r.at(c)), ['oak_planks', 'oak_planks', 'chest', 'chest']);
  }
});

test.serial('break out waits on when it is too weak to fight, or the mob is one it does not open to: a creeper, a skeleton, three at once', async (t) => {
  const waits = async (rock: Rock, over: Partial<Snapshot>, runs = 4) => {
    resetBreakOut();
    const said: string[] = [];
    for (let i = 0; i < runs; i++) said.push(await breakOut.run(ctxIn(rock, { boxedIn: wallOf(CAVE), ...over }).ctx).catch((e: Error) => e.message));
    t.deepEqual(rock.dug, [], JSON.stringify(over));
    return said;
  };
  // health 13, or iron short of a piece, or leather: it waits
  t.deepEqual(await waits(livePocket(CAVE), { health: 13 }), Array(4).fill('waiting: zombie 2 blocks away'));
  const noHelmet = [...HAUL.filter(i => i.slot < 36), ...IRON.slice(0, 3)];
  t.deepEqual(await waits(livePocket(CAVE), { items: noHelmet }), Array(4).fill('waiting: zombie 2 blocks away'));
  // never a creeper (it would blow the wall and the bot up), nor a skeleton through the gap
  for (const name of ['creeper', 'skeleton']) {
    const rock = livePocket(CAVE);
    rock.entities[0].name = name;
    t.deepEqual(await waits(rock, {}), Array(4).fill(`waiting: ${name} 2 blocks away`));
  }
  const crowd = livePocket(CAVE);
  crowd.entities.push({ ...crowd.entities[0], id: 8, position: { x: CAVE.x + 3.5, y: CAVE.y, z: CAVE.z + 1.5 } }, { ...crowd.entities[0], id: 9, position: { x: CAVE.x + 4.5, y: CAVE.y, z: CAVE.z - 0.5 } });
  t.deepEqual(await waits(crowd, {}), Array(4).fill('waiting: zombie 2 blocks away'));
  // a new mob each time is no mob waited on: the count starts again
  resetBreakOut();
  const fresh = livePocket(CAVE);
  for (let i = 0; i < 3; i++) {
    fresh.entities[0].id = 20 + i;
    await t.throwsAsync(breakOut.run(ctxIn(fresh, { boxedIn: wallOf(CAVE) }).ctx), { message: 'waiting: zombie 2 blocks away' });
  }
  // iron armour and health 14 will do
  resetBreakOut();
  const iron = livePocket(CAVE);
  iron.onDig = () => { iron.entities = []; };
  const ironed = { health: 14, items: [...HAUL.filter(i => i.slot < 36), ...IRON] };
  for (let i = 0; i < 2; i++) await t.throwsAsync(breakOut.run(ctxIn(iron, { boxedIn: wallOf(CAVE), ...ironed }).ctx));
  t.regex(await breakOut.run(ctxIn(iron, { boxedIn: wallOf(CAVE), ...ironed }).ctx), /^opened the wall toward the zombie \(health 14, iron armour\)/);
});

test.serial('break out waiting on a zombie that never despawns: three failures in a row hold it 10 min, not until the morning', async (t) => {
  resetBreakOut();
  let now = 0;
  const rock = livePocket(CAVE);
  const weak = HAUL.filter(i => i.slot < 36);
  const rt: ClientRuntime = {
    actions: { 'dig-block': async a => { const r = rock.dig({ x: Number(a.x), y: Number(a.y), z: Number(a.z) }); return reply(r.text, !r.ok); } },
    call: (async (method: string, p: Record<string, unknown> = {}) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      if (method === 'inventory') return { items: weak };
      if (method === 'world.entities') return { entities: rock.seen(Number(p.maxDistance ?? 32)) };
      return {};
    }) as ClientRuntime['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: rock.centre(), block: { ...rock.bot }, timeOfDay: 3000, hashedSeed: '1',
      dimension: 'overworld', sleeping: false, health: 20, food: 20, boxedIn: wallOf(CAVE) }),
    home: () => ({ ...HOME, dimension: 'overworld' }),
    lastDeath: () => undefined,
    setManualHook: () => undefined,
    builtNear: () => [],
    setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [breakOut], now: () => now });
  brain.setEnabled(true);
  for (let i = 0; i < 3; i++) { await brain.tick(); await settle(); now += 21_000; }
  t.regex(brain.status(), /failed break out: waiting: zombie 2 blocks away/);
  t.regex(brain.status(), /break out failed 3 times in a row: left for 10 min/);
  t.notRegex(brain.status(), /until the morning/);
  t.regex(brain.status(), /Retrying later: break out 579s\./);
  brain.setEnabled(false);
});

test.serial('break out says it opened the wall only when it did: a dig that does not go leaves it waiting, run after run', async (t) => {
  resetBreakOut();
  const rock = livePocket(CAVE);
  const east = [0, 1].map(dy => key({ x: CAVE.x + 1, y: CAVE.y + dy, z: CAVE.z }));
  const runs: string[] = [];
  const said: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = ctxIn(rock, { boxedIn: wallOf(CAVE) });
    const act = r.ctx.act;
    // (the bridge's dig timed out on the zombie's side)
    r.ctx.act = async (tool, a = {}) => (tool === 'dig-block' && east.includes(key(a as unknown as Pos)) ? { ok: false, text: `Could not dig dirt at (${a.x}, ${a.y}, ${a.z}) (timeout).` } : act(tool, a));
    runs.push(await breakOut.run(r.ctx).catch((e: Error) => e.message));
    said.push(...r.said);
  }
  // the wall whole: no "opened" said, and the failures go on (the 20-s retry, then its 10-min hold), not a success
  // every half minute
  t.deepEqual(runs, Array(4).fill('waiting: zombie 2 blocks away'));
  t.false(said.some(l => /opened/.test(l)));
  t.deepEqual(rock.dug, []);
});

test.serial('break out opens only the wall it built: a chest and the planks over it beside the bot are no wall; in a box it did not build it waits', async (t) => {
  resetBreakOut();
  // on the lawn by the storage house: a chest on the zombie's side, which the wall-in did not have to fill
  const rock = livePocket(CAVE);
  const chest = { x: CAVE.x + 1, y: CAVE.y, z: CAVE.z }, planks = { ...chest, y: CAVE.y + 1 };
  rock.set(chest, 'chest');
  rock.set(planks, 'oak_planks');
  const own = wallOf(CAVE).filter(p => key(p) !== key(chest) && key(p) !== key(planks));
  rock.onDig = p => { if (p.x === CAVE.x && p.z === CAVE.z + 1) rock.entities = []; };
  for (let i = 0; i < 2; i++) await t.throwsAsync(breakOut.run(ctxIn(rock, { boxedIn: own }).ctx), { message: 'waiting: zombie 2 blocks away' });
  t.is(await breakOut.run(ctxIn(rock, { boxedIn: own }).ctx), 'opened the wall toward the zombie (health 20, diamond armour); then dug out of the wall-in (5 more of 7 block(s))');
  // its own wall on the side nearest the zombie (south: it stands south-east of the bot, in the cave)
  t.deepEqual(rock.dug.slice(0, 2), [{ x: CAVE.x, y: CAVE.y, z: CAVE.z + 1 }, { x: CAVE.x, y: CAVE.y + 1, z: CAVE.z + 1 }]);
  t.is(rock.at(chest), 'chest');
  t.is(rock.at(planks), 'oak_planks');
  // a box it did not build has nothing of its own to open: it waits, however often
  resetBreakOut();
  const theirs = livePocket(CAVE);
  for (let i = 0; i < 4; i++) await t.throwsAsync(breakOut.run(ctxIn(theirs, { boxedIn: [] }).ctx), { message: 'waiting: zombie 2 blocks away' });
  t.deepEqual(theirs.dug, []);
});

test.serial('a night walled in under the yard: once out from under has dug it out and up past the fence, the shelter takes it home (it is holed up no more)', async (t) => {
  setOutFromUnderTiming(1, 100);
  const rock = livePocket();
  const world = liveWorld();
  const shelter = shelterGoal();
  const night = () => lookAt(HAUL, 15_000, { position: rock.centre(), distHome: across(rock.bot) });
  t.is(shelter.wants(night(), world), 'night: get home');
  // while out from under waits out its hold: the walk home stops in a second down here, and the night is spent in a box
  t.is(await shelter.run(ctxIn(rock, { timeOfDay: 15_000, activity: 'rest' }).ctx), 'could not get home at night (Stopped 57 blocks from home after 1s); Walled in at (-534, 8, 2182)');
  t.is(shelter.wants(night(), world), null, 'holed up where it walled in');
  // out from under digs through that wall by night as well, and comes up 9 past the fence
  t.regex(await outFromUnder.run(ctxIn(rock, { timeOfDay: 15_000, activity: 'rest' }).ctx), /climbed to \(-524, 69, 2182\)$/);
  // not left standing there among the mobs until the morning: home, and to bed
  t.is(shelter.wants(night(), world), 'night: get home');
  // by day the box is forgotten as before
  t.is(shelter.wants(lookAt(HAUL, 3000, { position: rock.centre(), distHome: across(rock.bot) }), world), null);
});
