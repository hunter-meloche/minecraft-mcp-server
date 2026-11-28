import test from 'ava';
import fs from 'fs';
import path from 'path';
import { checkBuild, layoutSpec } from '../../src/client/schematic.js';
import { RING_GATE_ASIDE, hall, hallLock, portal, portalRing, type Blueprint, type Side } from '../../src/client/brain/blueprints.js';
import { Ground } from '../../src/client/brain/boatroute.js';
import { ringOf } from '../../src/client/brain/portal.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import {
  REACH, footprintFree, inLock, lockAt, lockFaults, lockOf, lockPlan, lockPlanOf, lockReady, reach, ringAt, ringPlan, ringPlanOf, ringReady, seesFace,
  sight, spanOf, withBlock, type Blocks, type LockPlan, type Placed, type RingPlan,
  BOT_WALK, FIRST_PATH, GAME_PATH, HOP_MAX, HOP_MIN, HOP_PATH, RETRACE_DROP, REUSE_MS, RIVAL_R, TRAP_R, botStand, corridor, firstSpot, gateLane, hopSpot, isStand,
  pathFor, reachCells, sameWay, stand, step, trapNear, wayText, yardWay, type HopOpts, type HopSpot, type NoWay, type Stand
} from '../../src/client/brain/villagerwalk.js';
import type { Zone } from '../../src/client/brain/courtesy.js';

// The lock and the portal's ring on paper (acquiring villagers, S0): the two blueprints, where they go, what the bot
// reaches and sees from the post, and the three questions asked of the blocks as read (is the ground free, is the lock
// ready, is the ring ready). The worlds here are a lawn at the live yard's level with the real hall() built on it.

/** The live hall's gate H and the portal's site (brain.json, Nov 24: the frame's inside corner at (-560, 64, 2147)). */
const H: Pos = { x: -556, y: 63, z: 2134 };
const PORTAL = { x: -562, y: 62, z: 2146, width: 6, length: 3 };
const SIDES: Side[] = ['south', 'west', 'north', 'east'];
const STEP: Record<Side, { x: number; z: number }> = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } };
/** The side on the left hand of someone walking out by a gate on `out`: where the plain layout has its socket. */
const LEFT: Record<Side, Side> = { south: 'east', east: 'north', north: 'west', west: 'south' };
const LAYOUTS = SIDES.flatMap(side => [false, true].map(mirror => ({ side, mirror, name: `${side}${mirror ? ', mirrored' : ''}` })));

const add = (a: Pos, b: Pos): Pos => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const key = (p: Pos) => `${p.x},${p.y},${p.z}`;
/** `n` steps out of a gate on `out` and `l` to the left of that walk, from `p`. */
const off = (p: Pos, out: Side, n: number, l = 0, up = 0): Pos =>
  ({ x: p.x + n * STEP[out].x + l * STEP[LEFT[out]].x, y: p.y + up, z: p.z + n * STEP[out].z + l * STEP[LEFT[out]].z });

/** A lawn round `c` (its y: feet level), read whole: dirt, grass on top, air over it. */
function lawn(c: Pos, r = 16): Ground {
  const g = new Ground(c.y - 3, 9);
  for (let x = c.x - r; x <= c.x + r; x++) for (let z = c.z - r; z <= c.z + r; z++) for (let y = c.y - 3; y < c.y + 6; y++) {
    g.set(x, y, z, y < c.y - 1 ? 'dirt' : y === c.y - 1 ? 'grass_block[snowy=false]' : 'air');
  }
  return g;
}

/** A blueprint's blocks stood in the world as the game has them: gates shut, fences joined. */
function build(g: Ground, pl: Placed): void {
  pl.bp.spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
    if (ch === ' ') return;
    const s = ch === '.' ? 'air' : pl.bp.spec.palette[ch];
    const state = /_fence_gate\[/.test(s) ? s.replace(']', ',in_wall=false,open=false,powered=false]')
      : /_fence$/.test(s) ? `${s}[east=true,north=false,south=false,waterlogged=false,west=true]` : s;
    g.set(pl.origin.x + x, pl.origin.y + y, pl.origin.z + z, state);
  })));
}

/** The hall whose gate is `h` on `side`, as its own blueprint puts it. */
function hallAt(h: Pos, side: Side): Placed {
  const bp = hall({ gateSide: side });
  const gate = bp.landmarks.find(l => l.kind === 'gate')!.at;
  return { bp, origin: { x: h.x - gate.x, y: h.y - gate.y, z: h.z - gate.z } };
}

/** Zones as a build writes them from a blueprint's landmarks (milestones.ts buildStep: `${kind}:${landmark}`). */
function zonesOf(kind: string, pl: Placed, into: NonNullable<WorldMemory['zones']> = {}): NonNullable<WorldMemory['zones']> {
  for (const l of pl.bp.landmarks) (into[`${kind}:${l.kind}`] ??= []).push(add(pl.origin, l.at));
  return into;
}
const worldOf = (zones: WorldMemory['zones']) => ({ landmarks: { chests: [], farmland: [] }, leash: 96, zones }) as unknown as WorldMemory;

/** A hall with nothing before its gate yet: the lawn, the hall, its zones. */
function yard(h: Pos, side: Side): { g: Ground; world: WorldMemory } {
  const g = lawn(h);
  const hl = hallAt(h, side);
  build(g, hl);
  const zones = zonesOf('hall', hl);
  zones.hall = [{ x: hl.origin.x, y: hl.origin.y, z: hl.origin.z, width: hl.bp.size.width, length: hl.bp.size.length }];
  return { g, world: worldOf(zones) };
}

/** The same with the lock built in one of its layouts, the sill down and the lock's zones written. */
function locked(h: Pos, side: Side, mirror: boolean): { g: Ground; world: WorldMemory; lock: LockPlan } {
  const { g, world } = yard(h, side);
  const lock = lockAt(h, side, mirror);
  build(g, lock);
  g.set(lock.sill.x, lock.sill.y, lock.sill.z, 'rail[shape=north_south,waterlogged=false]');
  world.zones!.lock = [lock.zone];
  zonesOf('lock', lock, world.zones!);
  return { g, world, lock };
}

/** The live yard round the portal: its frame built, the yard's west fence at x -565 with a torch on a post. */
function portalYard(): { g: Ground; world: WorldMemory } {
  const g = lawn({ x: -560, y: 63, z: 2147 });
  build(g, { bp: portal({ axis: 'x' }), origin: { x: PORTAL.x, y: PORTAL.y, z: PORTAL.z } });
  for (let z = 2132; z <= 2162; z++) g.set(-565, 63, z, 'oak_fence[east=false,north=true,south=true,waterlogged=false,west=false]');
  g.set(-565, 64, 2146, 'torch');
  return { g, world: worldOf({ portal: [{ ...PORTAL }], 'portal:frame': [{ x: -560, y: 64, z: 2147 }] }) };
}

/** The same with the ring built and its zones written. */
function ringed(side: Side = 'south'): { g: Ground; world: WorldMemory; ring: RingPlan } {
  const { g, world } = portalYard();
  const ring = ringAt(PORTAL, side);
  build(g, ring);
  world.zones!.ring = [ring.zone];
  world.zones!['ring:gate'] = [ring.gate];
  return { g, world, ring };
}

const set = (g: Ground, p: Pos, state: string) => g.set(p.x, p.y, p.z, state);
const cellsOf = (bp: Blueprint, ch: string): Pos[] => {
  const out: Pos[] = [];
  bp.spec.layers.forEach((l, y) => l.forEach((r, z) => [...r].forEach((c, x) => { if (c === ch) out.push({ x, y, z }); })));
  return out;
};

// ------------------------------------------------------------------------------------------------ the blueprints

test('hallLock: a roofed plank cell 3 x 2 inside, drawn out south: 31 planks, a gate, a torch, the sill\'s rail', (t) => {
  const bp = hallLock();
  t.deepEqual(bp.size, { width: 5, height: 4, length: 3 });
  t.is(bp.groundOffset, 0);
  t.deepEqual(bp.bill, { oak_planks: 31, oak_fence_gate: 1, torch: 1, rail: 1 });
  t.deepEqual(bp.spec.layers, [
    ['     ', '     ', '     '],   // the ground: left as it is
    ['P   P', 'P   P', 'PPGPP'],   // the six inside cells left as they are: the builder replaces only air
    ['PT  P', 'P   P', 'PP.PP'],   // the cell over P open; the light at head height
    ['PPPPP', 'PPPPP', 'PPPPP']    // the roof over the whole footprint
  ]);
  t.deepEqual(bp.spec.palette, { P: 'oak_planks', G: 'oak_fence_gate[facing=south]', T: 'wall_torch[facing=east]' });
  t.deepEqual(bp.entrances, [{ x: 2, y: 1, z: 2, facing: 'south' }]);
  t.deepEqual(hallLock(true).spec.layers[2], ['P  TP', 'P   P', 'PP.PP']);
  t.is(hallLock(true).spec.palette.T, 'wall_torch[facing=west]');
  t.deepEqual(hallLock(true).bill, bp.bill);
  t.throws(() => hallLock(false, 'up' as Side), { message: /side must be/ });
});

test('the lock at the live hall gate is the design\'s table, cell for cell; mirrored, the socket\'s side changes', (t) => {
  const l = lockAt(H, 'south');
  t.deepEqual(l.origin, { x: -558, y: 62, z: 2135 });
  t.deepEqual(l.p, { x: -556, y: 63, z: 2137 });
  t.deepEqual(l.h, H);
  t.deepEqual(l.socket, { x: -554, y: 63, z: 2135 });
  t.deepEqual(l.sill, { x: -553, y: 63, z: 2135 });
  t.deepEqual(l.post, { x: -553, y: 63, z: 2136 });
  t.deepEqual(l.sOut, { x: -554, y: 63, z: 2139 });
  t.deepEqual(l.inside.map(key).sort(), ['-555,63,2135', '-555,63,2136', '-556,63,2135', '-556,63,2136', '-557,63,2135', '-557,63,2136']);
  t.deepEqual(l.box, { x1: -557, y1: 63, z1: 2135, x2: -555, y2: 64, z2: 2136 });
  // the footprint grown by 1: the zone `lock`, at the ground's level
  t.deepEqual(l.zone, { x: -559, y: 62, z: 2134, width: 7, length: 5 });
  // walls on x -558 and -554 and along z 2137 (P and the cell over it in their middle), the roof at y 65, the torch on
  // the west wall
  const planks = cellsOf(l.bp, 'P').map(c => add(l.origin, c));
  t.deepEqual([...new Set(planks.filter(c => c.y < 65).map(c => c.x))].sort(), [-554, -555, -557, -558]);
  t.is(planks.filter(c => c.y < 65 && c.z === 2137).length, 8);
  t.true(planks.filter(c => c.y < 65 && c.z < 2137).every(c => c.x === -558 || c.x === -554));
  t.is(planks.filter(c => c.y === 65).length, 15);
  t.deepEqual(cellsOf(l.bp, 'T').map(c => add(l.origin, c)), [{ x: -557, y: 64, z: 2135 }]);

  const m = lockAt(H, 'south', true);
  t.deepEqual([m.p, m.h, m.box, m.zone, m.origin], [l.p, l.h, l.box, l.zone, l.origin]);
  t.deepEqual(m.socket, { x: -558, y: 63, z: 2135 });
  t.deepEqual(m.sill, { x: -559, y: 63, z: 2135 });
  t.deepEqual(m.post, { x: -559, y: 63, z: 2136 });
  t.deepEqual(m.sOut, { x: -558, y: 63, z: 2139 });
  t.deepEqual(cellsOf(m.bp, 'T').map(c => add(m.origin, c)), [{ x: -555, y: 64, z: 2135 }]);
});

test('both layouts on all four sides are one lock turned: every cell by the way out and the socket\'s hand', (t) => {
  for (const { side, mirror, name } of LAYOUTS) {
    const l = lockAt(H, side, mirror), hand = mirror ? -1 : 1;
    t.deepEqual(l.p, off(H, side, 3), name);
    t.deepEqual(l.socket, off(H, side, 1, 2 * hand), name);
    t.deepEqual(l.sill, off(H, side, 1, 3 * hand), name);
    t.deepEqual(l.post, off(H, side, 2, 3 * hand), name);
    t.deepEqual(l.sOut, off(H, side, 5, 2 * hand), name);
    t.deepEqual(l.inside.map(key).sort(), [1, 2].flatMap(n => [-1, 0, 1].map(i => key(off(H, side, n, i)))).sort(), name);
    t.deepEqual(l.bp.entrances.map(e => e.facing), [side], name);
    t.is(l.bp.spec.palette.G, `oak_fence_gate[facing=${side}]`, name);
    // the torch hangs on the side wall away from the socket, facing into the cell
    const torch = add(l.origin, cellsOf(l.bp, 'T')[0]);
    t.deepEqual(torch, off(H, side, 1, -hand, 1), name);
    t.is(l.bp.spec.palette.T, `wall_torch[facing=${mirror ? LEFT[LEFT[LEFT[side]]] : LEFT[side]}]`, name);
    // built, the spec verifies as build-structure checks it
    const { g } = locked(H, side, mirror);
    const s = l.bp.size, blocks: (string | null)[] = [];
    for (let y = 0; y < s.height; y++) for (let z = 0; z < s.length; z++) for (let x = 0; x < s.width; x++) blocks.push(g.state(l.origin.x + x, l.origin.y + y, l.origin.z + z) ?? null);
    const check = checkBuild(layoutSpec(l.bp.spec), blocks);
    t.is(check.placed, check.total, name);
    t.is(check.total, 33, name);
  }
});

test('from the post every reach is under 4.4 and every sight is dig.here\'s, in both layouts on all four sides', (t) => {
  for (const { side, mirror, name } of LAYOUTS) {
    const { g, lock } = locked(H, side, mirror);
    // the gates by their middles, as the closer measures: P 3.35, H 3.78
    t.true(Math.abs(reach(lock.post, lock.p) - 3.355) < 0.005, name);
    t.true(Math.abs(reach(lock.post, lock.h) - 3.775) < 0.005, name);
    t.true(reach(lock.post, lock.p) < REACH && reach(lock.post, lock.h) < REACH, name);
    // the socket: its one open face is the outer one, past the sill's rail, 1.6 from the eye
    const socket = sight(g, lock.post, lock.socket);
    t.true(socket.seen && Math.abs(socket.dist - 1.586) < 0.005, name);
    t.is(socket.seen && socket.face, mirror ? LEFT[LEFT[LEFT[side]]] : LEFT[side], name);
    // with the lure in it, and with the hole open
    t.true(seesFace(withBlock(g, lock.socket, 'fletching_table'), lock.post, lock.socket), name);
    t.false(seesFace(withBlock(g, lock.socket, 'air'), lock.post, lock.socket), name);
    // a lure at S_out: the face toward the post's side, 3.2 from the eye
    const lure = sight(withBlock(g, lock.sOut, 'fletching_table'), lock.post, lock.sOut);
    t.true(lure.seen && Math.abs(lure.dist - 3.243) < 0.005, name);
    t.is(lure.seen && lure.face, mirror ? LEFT[LEFT[LEFT[side]]] : LEFT[side], name);
    t.false(seesFace(g, lock.post, lock.sOut), `${name}: nothing stands there yet`);
  }
});

test('decision 17: one cell nearer P\'s lane than S_out, the ray from the post passes through the lock\'s corner', (t) => {
  for (const { side, mirror, name } of LAYOUTS) {
    const { g, lock } = locked(H, side, mirror), hand = mirror ? -1 : 1;
    const nearer = off(H, side, 5, hand);
    const s = sight(withBlock(g, nearer, 'fletching_table'), lock.post, nearer);
    t.false(s.seen, name);
    // what is in the way is the front wall's corner block, at head height
    t.deepEqual(!s.seen && [s.why, s.by], ['blocked', off(H, side, 3, 2 * hand, 1)], name);
    // and S_out one further out is seen still, one further along its row too far round the corner
    t.true(seesFace(withBlock(g, off(H, side, 6, 2 * hand), 'fletching_table'), lock.post, off(H, side, 6, 2 * hand)), name);
  }
});

// ------------------------------------------------------------------------------------------------ the zones

test('lockOf only reads the zones the build wrote, in every layout; no lock until they are all there', (t) => {
  for (const { side, mirror, name } of LAYOUTS) {
    const { world, lock } = locked(H, side, mirror);
    const { p, h, socket, sill, post, sOut, inside, box } = lock;
    t.deepEqual(lockOf(world), { p, h, socket, sill, post, sOut, inside, box }, name);
    t.like(lockPlanOf(world), { side, mirror }, name);
    t.deepEqual(lockPlan(world, mirror)?.origin, lock.origin, name);
  }
  // the footprint zone alone (written before the build) is no lock, nor is the hall alone
  const { world } = yard(H, 'south');
  t.is(lockOf(world), undefined);
  t.deepEqual(lockReady(world, lawn(H)), ['no lock stands']);
  world.zones!.lock = [lockAt(H, 'south').zone];
  t.is(lockOf(world), undefined);
  t.deepEqual(lockPlan(world)?.zone, world.zones!.lock[0]);
  t.is(lockPlan(worldOf({})), undefined);

  for (const gone of ['lock:gate', 'lock:socket', 'lock:sill', 'lock:post', 'lock:sout', 'lock:inside', 'hall:gate']) {
    const w = locked(H, 'south', false).world;
    if (gone === 'lock:inside') w.zones![gone].pop(); else delete w.zones![gone];
    t.is(lockOf(w), undefined, gone);
  }
});

test('lockOf holds the zones to the blueprint: a lock of two layouts, or one at another hall gate, is none', (t) => {
  const plain = locked(H, 'south', false).world, mirrored = locked(H, 'south', true);
  plain.zones!['lock:socket'] = mirrored.world.zones!['lock:socket'];
  t.is(lockOf(plain), undefined);
  t.deepEqual(lockReady(plain, mirrored.g), ['the lock\'s zones are not its blueprint\'s']);
  const moved = locked(H, 'south', false).world;
  moved.zones!['hall:gate'] = [{ ...H, x: H.x + 1 }];
  t.is(lockOf(moved), undefined);
  // a lock built again the other way round: the zones written last are the lock
  const again = locked(H, 'south', false).world;
  zonesOf('lock', mirrored.lock, again.zones!);
  t.deepEqual(lockOf(again)?.socket, mirrored.lock.socket);
  t.like(lockPlanOf(again), { mirror: true });
});

test('inLock: the six cells at their level, not the gate\'s cell, not the roof', (t) => {
  const { lock } = locked(H, 'south', false);
  t.true(inLock(lock, { x: -556.5, y: 63, z: 2136.9 }));
  t.true(inLock(lock, { x: -554.01, y: 63.5, z: 2135.2 }));
  t.false(inLock(lock, { x: -555.5, y: 63, z: 2137.1 }), 'in P\'s cell');
  t.false(inLock(lock, { x: -555.5, y: 63, z: 2134.9 }), 'in H\'s cell');
  t.false(inLock(lock, { x: -553.9, y: 63, z: 2135.5 }), 'in the socket\'s wall');
  t.false(inLock(lock, { x: -556.5, y: 66, z: 2136 }), 'on the roof');
});

// ------------------------------------------------------------------------------------------------ dig.here's sight

/** A bot standing at (0, 64, 0) on a lawn, and a full block two cells east of it at its feet's level. */
const FEET: Pos = { x: 0, y: 64, z: 0 }, B: Pos = { x: 2, y: 64, z: 0 };
const field = (): Ground => { const g = lawn(FEET, 8); set(g, B, 'fletching_table'); return g; };

test('seesFace: the nearest open face whose middle a ray from the eye meets on this block first', (t) => {
  const g = field();
  const s = sight(g, FEET, B);
  // the face toward the bot, 1.88 from the eye (the top is seen too, 2.1 off: the nearer is the one worked)
  t.true(s.seen && s.face === 'west' && Math.abs(s.dist - Math.hypot(1.51, 1.12)) < 1e-9);
  t.true(seesFace(g, FEET, B));
  // nothing there: no outline to meet
  t.false(seesFace(g, FEET, { x: 2, y: 64, z: 2 }));
  // reach: the face's middle within 4.4 of the eye (4 cells off: 3.68; 5 cells off: 4.65)
  set(g, { x: 4, y: 64, z: 0 }, 'dirt');
  set(g, { x: -5, y: 64, z: 0 }, 'dirt');
  t.true(seesFace(g, FEET, { x: 4, y: 64, z: 0 }));
  t.deepEqual(sight(g, FEET, { x: -5, y: 64, z: 0 }), { seen: false, why: 'far' });
});

test('seesFace: a face is covered only by a full cube before it (B6): a rail, a torch or a flower leaves it open', (t) => {
  const before = { x: 1, y: 64, z: 0 };
  const faceWith = (state: string) => { const g = field(); set(g, before, state); const s = sight(g, FEET, B); return s.seen ? s.face : s.why; };
  // a full block before the west face: that face is not tried, the top is (the ray clears the block's edge)
  t.is(faceWith('cobblestone'), 'up');
  // the sill before the socket: the ray passes over the rail's two sixteenths
  t.is(faceWith('rail[shape=east_west,waterlogged=false]'), 'west');
  t.is(faceWith('torch'), 'west');
  // what the ray does meet on its way down to the face is in the way: a tuft of grass, a flower, a closed gate
  t.is(faceWith('short_grass'), 'up');
  t.is(faceWith('poppy'), 'up');
  t.is(faceWith('oak_fence_gate[facing=east,in_wall=false,open=false,powered=false]'), 'up');
  // every face covered
  const g = field();
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) set(g, { x: B.x + dx, y: B.y + dy, z: B.z + dz }, 'stone');
  t.deepEqual(sight(g, FEET, B), { seen: false, why: 'covered' });
});

test('seesFace: what stands in the ray is named; a cell not read is in the way; a slab or a path block is no cover', (t) => {
  // a wall 2 high between: every ray to an open face meets it first
  const g = field();
  for (const z of [-1, 0, 1]) for (const y of [64, 65, 66]) set(g, { x: 1, y, z }, 'oak_planks');
  const s = sight(g, FEET, B);
  t.false(s.seen);
  t.is(!s.seen && s.why, 'blocked');
  t.is(!s.seen && s.by?.x, 1);
  // a cell not read before the face: nothing is seen through it
  const f = field();
  const holed: Blocks = { state: (x, y, z) => (x === 1 && z === 0 ? null : f.state(x, y, z)) };
  t.deepEqual(sight(holed, FEET, B), { seen: false, why: 'blocked', by: { x: 1, y: 65, z: 0 } });
  // a bottom slab before the face does not cover it, and the ray clears its half block
  const h = field();
  set(h, { x: 1, y: 64, z: 0 }, 'oak_slab[type=bottom,waterlogged=false]');
  t.like(sight(h, FEET, B), { seen: true, face: 'west' });
  // the eye inside a block sees nothing
  const e = field();
  set(e, { x: 0, y: 65, z: 0 }, 'oak_leaves');
  t.like(sight(e, FEET, B), { seen: false, why: 'blocked', by: { x: 0, y: 65, z: 0 } });
});

const mod = path.join(process.cwd(), 'client-mod', 'src', 'claudebridge');
const java = (f: string) => (fs.existsSync(path.join(mod, f)) ? fs.readFileSync(path.join(mod, f), 'utf8') : '');
const body = (src: string, call: string): string => {
  const at = src.indexOf(`s.register("${call}"`);
  const next = src.indexOf('s.register("', at + 10);
  return src.slice(at, next < 0 ? undefined : next);
};

test('the port is dig.here\'s: the eye, the reach less 0.1, 0.49 to the face, an OUTLINE clip, the nearest face', (t) => {
  const dig = body(java('Interact.java'), 'dig.here');
  t.regex(dig, /Vec3 eye = pl\.getEyePosition\(\);/);
  t.regex(dig, /double reach = pl\.blockInteractionRange\(\);/);
  t.regex(dig, /for \(Direction d : Direction\.values\(\)\) \{/);
  t.regex(dig, /Vec3 fc = Vec3\.atCenterOf\(target\)\.add\(d\.getUnitVec3\(\)\.scale\(0\.49\)\);/);
  t.regex(dig, /if \(fc\.distanceTo\(eye\) > reach - 0\.1\) continue;/);
  t.regex(dig, /mc\.level\.clip\(new net\.minecraft\.world\.level\.ClipContext\(eye, fc, net\.minecraft\.world\.level\.ClipContext\.Block\.OUTLINE,\s+net\.minecraft\.world\.level\.ClipContext\.Fluid\.NONE, pl\)\)/);
  t.regex(dig, /if \(hit\.getType\(\) != net\.minecraft\.world\.phys\.HitResult\.Type\.BLOCK \|\| !hit\.getBlockPos\(\)\.equals\(target\)\) continue;/);
  t.regex(dig, /if \(aim == null \|\| fc\.distanceTo\(eye\) < aim\.distanceTo\(eye\)\) \{ face = d; aim = fc; \}/);
  // the gate closer's reach is the same 4.4, to the gate's middle (in Gates.java, or the constant its rules are held in)
  t.regex(java('Gates.java') + java('GateHolds.java'), /eye\.distanceTo\(\w+\) > 4\.4|double REACH = 4\.4;/);
  t.is(REACH, 4.4);
});

test('the port\'s cover rule is the jar\'s (B6): a face is left out only where its neighbour is a full collision cube', (t) => {
  const dig = body(java('Interact.java'), 'dig.here');
  const loop = dig.slice(dig.indexOf('for (Direction d : Direction.values()) {'), dig.indexOf('Vec3 fc = Vec3.atCenterOf(target)'));
  // as it stood, `!replaceable(neighbour)` called a face with a rail, a torch or a flower before it covered: the
  // socket's one open face has the sill's rail before it
  t.regex(loop, /isCollisionShapeFullBlock\([^;]*\)\s*continue;/);
  t.notRegex(loop, /replaceable\(/);
});

// ------------------------------------------------------------------------------------------------ free ground

test('footprintFree: a lawn before the hall\'s gate is free for both layouts on every side', (t) => {
  for (const { side, mirror, name } of LAYOUTS) {
    const { g } = yard(H, side);
    t.deepEqual(footprintFree(g, lockAt(H, side, mirror)), { ok: true }, name);
  }
});

test('footprintFree: the live site\'s own things are no fault (the walk under the floor, a torch by P\'s lane, plants)', (t) => {
  const { g } = yard(H, 'south');
  // paths-north's cobblestone at floor level under the lock's floor, east wall, socket and sill
  for (let x = -556; x <= -552; x++) g.set(x, 62, 2135, 'cobblestone');
  g.set(-555, 63, 2138, 'torch');
  g.set(-557, 63, 2136, 'short_grass');
  g.set(-553, 63, 2136, 'dandelion');
  g.set(-558, 63, 2135, 'tall_grass[half=lower]');
  t.deepEqual(footprintFree(g, lockAt(H, 'south')), { ok: true });
  t.deepEqual(footprintFree(g, lockAt(H, 'south', true)), { ok: true });
});

test('footprintFree: what is in the way is named with its cell; a lamp post on one side leaves the mirror', (t) => {
  const plain = lockAt(H, 'south'), mirrored = lockAt(H, 'south', true);
  const asked = (put: [Pos, string][], pl: Placed = plain) => { const { g } = yard(H, 'south'); for (const [p, s] of put) set(g, p, s); return footprintFree(g, pl); };
  // a block where a wall goes, where the roof goes, in the doorway
  t.deepEqual(asked([[{ x: -558, y: 64, z: 2136 }, 'oak_log[axis=y]']]),
    { ok: false, why: 'oak_log stands where the hall lock\'s oak_planks goes', at: { x: -558, y: 64, z: 2136 } });
  t.like(asked([[{ x: -556, y: 65, z: 2136 }, 'oak_leaves']]), { ok: false, at: { x: -556, y: 65, z: 2136 } });
  t.like(asked([[{ x: -556, y: 64, z: 2137 }, 'cobblestone']]), { ok: false, why: 'cobblestone stands where the hall lock\'s doorway goes' });
  // a block in a cell inside (at the feet, at the head)
  t.like(asked([[{ x: -556, y: 63, z: 2135 }, 'composter']]), { ok: false, why: 'composter stands in a cell inside of the hall lock' });
  t.like(asked([[{ x: -556, y: 64, z: 2135 }, 'cobblestone']]), { ok: false, why: 'cobblestone stands within 1 of the hall lock' });
  // a hole under the post, a path block under the sill (a rail lies on a full block), water under S_out
  t.deepEqual(asked([[{ x: -553, y: 62, z: 2136 }, 'air']]), { ok: false, why: 'no full floor under the post of the hall lock (air)', at: { x: -553, y: 62, z: 2136 } });
  t.like(asked([[{ x: -553, y: 62, z: 2135 }, 'dirt_path']]), { ok: false, why: 'no full floor under the sill of the hall lock (dirt_path)' });
  t.like(asked([[{ x: -554, y: 62, z: 2139 }, 'water[level=0]']]), { ok: false, why: 'no full floor under S_out of the hall lock (water)' });
  t.like(asked([[{ x: -556, y: 62, z: 2138 }, 'air']]), { ok: false, why: 'no full floor under the cell outside the gate of the hall lock (air)' });
  // a lamp post (a fence, a torch on it) on the plain layout's S_out, or on its post: the mirror is free
  const lamp = (p: Pos): [Pos, string][] => [[p, 'oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]'], [{ ...p, y: p.y + 1 }, 'torch']];
  t.deepEqual(asked(lamp(plain.sOut)), { ok: false, why: 'oak_fence stands in S_out of the hall lock', at: plain.sOut });
  t.deepEqual(asked(lamp(plain.sOut), mirrored), { ok: true });
  // one within 1 of the footprint is in the way of both: beside a wall it is a step to the roof
  t.like(asked(lamp({ x: -555, y: 63, z: 2138 })), { ok: false, why: 'oak_fence stands within 1 of the hall lock' });
  t.like(asked(lamp({ x: -555, y: 63, z: 2138 }), mirrored), { ok: false });
  t.like(asked([[{ x: -559, y: 65, z: 2138 }, 'oak_leaves']]), { ok: false, at: { x: -559, y: 65, z: 2138 } });
  // 2 from the footprint (and not a cell it works by): nothing asked
  t.deepEqual(asked(lamp({ x: -556, y: 63, z: 2139 })), { ok: true });
  // a cell not read
  const { g } = yard(H, 'south');
  const holed: Blocks = { state: (x, y, z) => (x === -559 && z === 2137 ? null : g.state(x, y, z)) };
  t.deepEqual(footprintFree(holed, plain), { ok: false, why: 'not read', at: { x: -559, y: 63, z: 2137 } });
});

test('footprintFree: the hall\'s own wall is not asked, and a build cut short is gone on with', (t) => {
  for (const { side, mirror, name } of LAYOUTS) {
    // (the hall stands in every one of these: its wall, windows and roof are within 1 of the footprint)
    const { g, lock } = locked(H, side, mirror);
    t.deepEqual(footprintFree(g, lock), { ok: true }, name);
  }
  // half built, in another wood
  const { g } = yard(H, 'south');
  g.set(-558, 63, 2135, 'spruce_planks');
  g.set(-556, 63, 2137, 'spruce_fence_gate[facing=north,in_wall=false,open=true,powered=false]');
  t.deepEqual(footprintFree(g, lockAt(H, 'south')), { ok: true });
});

test('portalRing: a fence on the cells just outside the ground the frame keeps, one gate, no torch', (t) => {
  for (const axis of ['x', 'z'] as const) {
    const site = axis === 'x' ? PORTAL : { ...PORTAL, width: 3, length: 6 };
    const r = ringOf(site, axis);
    for (const side of SIDES) {
      const ring = ringAt(site, side), name = `${axis} ${side}`;
      t.deepEqual(ring.zone, { x: r.x1 - 1, y: site.y, z: r.z1 - 1, width: r.x2 - r.x1 + 3, length: r.z2 - r.z1 + 3 }, name);
      t.is(ring.origin.y, site.y + 1, name);
      t.deepEqual(ring.bp.bill, { oak_fence: 25, oak_fence_gate: 1 }, name);
      t.is(ring.bp.size.height, 2, name);
      // every cell of the perimeter and no other
      const cells = [...cellsOf(ring.bp, 'F'), ...'nsew'.split('').flatMap(ch => cellsOf(ring.bp, ch))].map(c => add(ring.origin, c));
      t.is(cells.length, 26, name);
      t.true(cells.every(c => c.y === site.y + 1 && (c.x === r.x1 - 1 || c.x === r.x2 + 1 || c.z === r.z1 - 1 || c.z === r.z2 + 1)), name);
      t.deepEqual(ring.bp.entrances.map(e => e.facing), [side], name);
      t.deepEqual(ring.outside, { x: ring.gate.x + STEP[side].x, y: ring.gate.y, z: ring.gate.z + STEP[side].z }, name);
    }
  }
  // the live portal: the fence on x -564..-555, z 2145..2149; a gate on a long side three along from the frame's inside
  // (the lowest corner, x -560: where the bot walks in), away from both portal cells; on a short side in the plinth's row
  t.is(RING_GATE_ASIDE, 3);
  t.deepEqual(ringAt(PORTAL, 'south').zone, { x: -564, y: 62, z: 2145, width: 10, length: 5 });
  t.deepEqual(ringAt(PORTAL, 'south').gate, { x: -563, y: 63, z: 2149 });
  t.deepEqual(ringAt(PORTAL, 'north').gate, { x: -563, y: 63, z: 2145 });
  t.deepEqual(ringAt(PORTAL, 'west').gate, { x: -564, y: 63, z: 2147 });
  t.deepEqual(ringAt(PORTAL, 'east').gate, { x: -555, y: 63, z: 2147 });
  const turned = { x: 10, y: 70, z: 20, width: 3, length: 6 };
  t.deepEqual(ringAt(turned, 'east').gate, { x: 13, y: 71, z: 19 });
  t.deepEqual(ringAt(turned, 'west').gate, { x: 9, y: 71, z: 19 });
  t.deepEqual(ringAt(turned, 'south').gate, { x: 11, y: 71, z: 27 });
  t.deepEqual(portalRing('x', 'south').landmarks.map(l => l.kind), ['gate', 'portal']);
  t.throws(() => portalRing('y' as 'x', 'south'), { message: /axis is x or z/ });
});

test('the ring\'s gate is shut behind the bot on its way into the portal: the closer\'s rule is met in the cell before the frame\'s', (t) => {
  // Gates.java shuts a gate of the bot's only once its feet are 2.2 clear of the gate's middle and its eye within 4.4
  // of it. A gate in line with the frame's inside, two cells before the portal's plane, never meets it (the bot stands
  // its 80 ticks in the portal 2.06 off at most and is gone with the gate open: the ring open for the whole trip)
  const gates = java('Gates.java');
  t.regex(gates, /if \(inside \|\| d < 2\.2 \|\| eye\.distanceTo\(c\) > 4\.4\) continue;/);
  t.regex(gates, /double d = c\.distanceTo\(p\.position\(\)\);/);
  const CLEAR = 2.2, EYE = 1.62;
  const mid = (c: Pos) => ({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });
  const far = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  for (const axis of ['x', 'z'] as const) {
    const site = axis === 'x' ? PORTAL : { ...PORTAL, width: 3, length: 6 };
    const frame = add(site, portal({ axis }).landmarks.find(l => l.kind === 'frame')!.at);
    const along = axis === 'x' ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
    for (const side of (axis === 'x' ? ['south', 'north'] : ['east', 'west']) as Side[]) {
      const ring = ringAt(site, side), name = `${axis} ${side}`, gate = mid(ring.gate);
      // the frame's own cell is the lower of the portal's two; the gate is three from its line, four from the other's
      const line = (c: Pos) => (axis === 'x' ? Math.abs(c.x - ring.gate.x) : Math.abs(c.z - ring.gate.z));
      t.deepEqual([line(frame), line(add(frame, along))], [3, 4], name);
      // the cell before the frame's cell on the gate's side, a block down (the portal stands on the frame's bottom
      // row): every way in from the gate crosses it. Wherever the bot's feet are in it, the rule is met
      const before = { x: frame.x + STEP[side].x, y: frame.y - 1, z: frame.z + STEP[side].z };
      t.is(ring.gate.y, before.y, name);
      const feet = [0, 0.25, 0.5, 0.75, 1].flatMap(dx => [0, 0.25, 0.5, 0.75, 1].map(dz => ({ x: before.x + dx, y: before.y, z: before.z + dz })));
      const clear = feet.map(f => far(f, gate)), eye = feet.map(f => far({ ...f, y: f.y + EYE }, gate));
      t.true(Math.min(...clear) >= CLEAR + 0.3, `${name}: ${Math.min(...clear)} clear at the least`);
      t.true(Math.max(...eye) <= REACH - 0.3, `${name}: ${Math.max(...eye)} from the eye at the most`);
      // and from the middle of the frame's own cell, should the click not have been made on the way (an item in use)
      const stood = { x: frame.x + 0.5, y: frame.y, z: frame.z + 0.5 };
      t.true(far(stood, gate) >= CLEAR + 0.3 && far({ ...stood, y: stood.y + EYE }, gate) <= REACH - 0.2, name);
      // in line with the frame's inside, as it was drawn first, the middle of that cell is not clear of the gate
      const inLine = mid(axis === 'x' ? { ...ring.gate, x: frame.x } : { ...ring.gate, z: frame.z });
      t.true(far(stood, inLine) < CLEAR, name);
    }
  }
});

test('footprintFree for the ring: the yard\'s fence beside it joins it; the gate goes where its cell and the one outside are free', (t) => {
  const { g, world } = portalYard();
  // the portal's own frame stands inside the ring and is not asked; the yard's west fence (a torch on it) runs beside it
  t.deepEqual(footprintFree(g, ringAt(PORTAL, 'south')), { ok: true });
  t.deepEqual(footprintFree(g, ringAt(PORTAL, 'north')), { ok: true });
  t.deepEqual(footprintFree(g, ringAt(PORTAL, 'east')), { ok: true });
  // a west gate would open onto the yard's fence
  t.deepEqual(footprintFree(g, ringAt(PORTAL, 'west')), { ok: false, why: 'oak_fence stands in the cell outside the gate of the portal ring', at: { x: -565, y: 63, z: 2147 } });
  t.deepEqual(ringPlan(world, 'south')?.gate, { x: -563, y: 63, z: 2149 });
  t.is(ringPlan(worldOf({}), 'south'), undefined);
  // a block on the line, a block beside it (inside or outside, at the fence's level or one above), a hole before the gate
  const asked = (p: Pos, s: string, side: Side = 'south') => { const y = portalYard(); set(y.g, p, s); return footprintFree(y.g, ringAt(PORTAL, side)); };
  t.like(asked({ x: -558, y: 63, z: 2145 }, 'cobblestone'), { ok: false, why: 'cobblestone stands where the portal ring\'s oak_fence goes' });
  t.like(asked({ x: -558, y: 63, z: 2144 }, 'cobblestone'), { ok: false, why: 'cobblestone stands within 1 of the portal ring' });
  t.like(asked({ x: -558, y: 64, z: 2146 }, 'dirt'), { ok: false, at: { x: -558, y: 64, z: 2146 } });
  t.like(asked({ x: -563, y: 62, z: 2150 }, 'air'), { ok: false, why: 'no full floor under the cell outside the gate of the portal ring (air)' });
  t.deepEqual(asked({ x: -563, y: 62, z: 2150 }, 'air', 'north'), { ok: true });
  // a fence that joins none of the ring's (2 off its line) is a block like any other... but is not within 1: not asked
  t.deepEqual(asked({ x: -558, y: 63, z: 2143 }, 'oak_fence'), { ok: true });
});

// ------------------------------------------------------------------------------------------------ ready, as read

test('lockReady: the lock as built, shut and empty, is ready in both layouts on all four sides', (t) => {
  for (const { side, mirror, name } of LAYOUTS) {
    const { g, world, lock } = locked(H, side, mirror);
    // a villager in the hall, a cow in the yard, the bot on the post: none of them in the lock
    const seen = [{ name: 'villager', position: off(H, side, -3), health: 20 }, { name: 'cow', position: off(H, side, 6), health: 10 },
      { name: 'player', position: lock.inside[0], health: 20 }, { name: 'item', position: lock.inside[1] }];
    t.deepEqual(lockReady(world, g, seen), [], name);
  }
});

test('lockReady: each fault is named with its cell', (t) => {
  const faults = (change: (g: Ground, lock: LockPlan) => void, seen: { name: string; position?: Pos; health?: number }[] = []) => {
    const { g, world, lock } = locked(H, 'south', false);
    change(g, lock);
    return lockReady(world, g, seen);
  };
  // a wall block gone, a roof block gone
  t.deepEqual(faults(g => g.set(-558, 64, 2136, 'air')), ['a wall block gone at (-558, 64, 2136) (air)']);
  t.deepEqual(faults(g => g.set(-556, 65, 2136, 'air')), ['a roof block gone at (-556, 65, 2136) (air)']);
  // the lure still in the socket, or the hole open (one high): one fault each, the post's sight is asked of the wall block
  t.deepEqual(faults((g, l) => set(g, l.socket, 'fletching_table')), ['the socket is no wall block: fletching_table at (-554, 63, 2135)']);
  t.deepEqual(faults((g, l) => set(g, l.socket, 'air')), ['the socket is no wall block: air at (-554, 63, 2135)']);
  // the gates: open, gone, a doorway one high (a stray over H shut every chore out on Nov 24)
  t.deepEqual(faults((g, l) => set(g, l.p, 'oak_fence_gate[facing=south,in_wall=false,open=true,powered=false]')), ['the lock\'s gate is open at (-556, 63, 2137)']);
  t.deepEqual(faults((g, l) => set(g, l.h, 'oak_fence_gate[facing=south,in_wall=false,open=true,powered=false]')), ['the hall\'s gate is open at (-556, 63, 2134)']);
  t.deepEqual(faults((g, l) => set(g, l.p, 'air')), ['the lock\'s gate is gone at (-556, 63, 2137) (air)']);
  t.deepEqual(faults(g => g.set(-556, 64, 2134, 'cobblestone')), ['the hall\'s doorway is one high: cobblestone at (-556, 64, 2134)']);
  t.deepEqual(faults(g => g.set(-556, 64, 2137, 'dirt')), ['the lock\'s doorway is one high: dirt at (-556, 64, 2137)']);
  // the sill gone: the lure in the socket could be worked from the yard
  t.deepEqual(faults((g, l) => set(g, l.sill, 'air')),
    ['the sill is gone at (-553, 63, 2135) (air)', 'a cell outside the lock reaches the socket: (-553, 63, 2135)']);
  // the hall's wall open beside the socket (the panel dug out): a villager in the hall reaches it; so it does from a
  // slab or a bed in that cell (the game's node is the block's own cell), not from a cell one high
  t.deepEqual(faults(g => { g.set(-554, 63, 2134, 'air'); g.set(-554, 64, 2134, 'air'); }), ['a cell outside the lock reaches the socket: (-554, 63, 2134)']);
  t.deepEqual(faults(g => { g.set(-554, 63, 2134, 'oak_slab[type=bottom,waterlogged=false]'); g.set(-554, 64, 2134, 'air'); }),
    ['a cell outside the lock reaches the socket: (-554, 63, 2134)']);
  t.deepEqual(faults(g => { g.set(-554, 63, 2134, 'white_bed[facing=north,occupied=false,part=foot]'); g.set(-554, 64, 2134, 'air'); }),
    ['a cell outside the lock reaches the socket: (-554, 63, 2134)']);
  t.deepEqual(faults(g => g.set(-554, 63, 2134, 'air')), []);
  // something in a cell inside, at the feet or the head; plants and the light are nothing
  t.deepEqual(faults(g => g.set(-555, 63, 2136, 'cobblestone')), ['cobblestone in the lock at (-555, 63, 2136)']);
  t.deepEqual(faults(g => g.set(-555, 64, 2136, 'oak_planks')), ['oak_planks in the lock at (-555, 64, 2136)']);
  t.deepEqual(faults(g => { g.set(-555, 63, 2136, 'short_grass'); g.set(-557, 64, 2135, 'air'); }), []);
  // somebody in it
  t.deepEqual(faults(() => undefined, [{ name: 'villager', position: { x: -555.5, y: 63, z: 2135.5 } }]), ['a villager in the lock at (-556, 63, 2135)']);
  t.deepEqual(faults(() => undefined, [{ name: 'cow', position: { x: -556.3, y: 63, z: 2136.7 }, health: 10 }]), ['a cow in the lock at (-557, 63, 2136)']);
  t.deepEqual(faults(() => undefined, [{ name: 'zombie', position: { x: -556.3, y: 63, z: 2136.7 }, health: 20 }]), ['a zombie in the lock at (-557, 63, 2136)']);
  // the post: a block in it; the sight lines: tall grass grown up beside the post, in every ray to S_out (a body walks
  // through it, a ray does not), and a block before the socket's face
  t.deepEqual(faults((g, l) => set(g, l.post, 'cobblestone')), ['the post is no cell to stand in: cobblestone at (-553, 63, 2136)']);
  t.deepEqual(faults(g => { g.set(-553, 63, 2137, 'tall_grass[half=lower]'); g.set(-553, 64, 2137, 'tall_grass[half=upper]'); }),
    ['the post does not see a lure at S_out (-554, 63, 2139): tall_grass at (-553, 64, 2137) is in the way']);
  // (a tuft before S_out's face toward the post hides that face only: the ray to its far face meets the lure's near side)
  t.deepEqual(faults(g => g.set(-553, 63, 2139, 'short_grass')), []);
  t.deepEqual(faults(g => g.set(-553, 64, 2135, 'dirt')), ['the post does not see the socket at (-554, 63, 2135): dirt at (-553, 64, 2135) is in the way']);
  // S_out: a block on it, no floor under it
  t.deepEqual(faults((g, l) => set(g, l.sOut, 'dirt')), ['S_out is taken: dirt at (-554, 63, 2139)']);
  t.deepEqual(faults(g => g.set(-554, 62, 2139, 'dirt_path')), ['no full floor under S_out at (-554, 63, 2139) (dirt_path)']);
  // several at once, each said
  t.is(faults((g, l) => { set(g, l.p, 'air'); set(g, l.sill, 'air'); g.set(-558, 63, 2135, 'air'); }).length, 4);
});

test('lockFaults: every fault says what it is a fault of, so "broken" is told from "in use" by its kind and never by its words', (t) => {
  const open = 'oak_fence_gate[facing=south,in_wall=false,open=true,powered=false]';
  const kinds = (change: (g: Ground, lock: LockPlan) => void, seen: { name: string; position?: Pos; health?: number }[] = []) => {
    const { g, world, lock } = locked(H, 'south', false);
    change(g, lock);
    const f = lockFaults(world, g, seen);
    // the words are lockReady's, one for one and in its order
    t.deepEqual(f.map(x => x.text), lockReady(world, g, seen));
    return f.map(x => x.kind);
  };
  t.deepEqual(kinds(() => undefined), []);
  // the shell not as built: a wall or roof block gone, a gate gone, the sill gone (and with it the socket in reach
  // from the yard), a block where the shell has none
  t.deepEqual(kinds(g => g.set(-558, 64, 2136, 'air')), ['structure']);
  t.deepEqual(kinds(g => g.set(-556, 65, 2136, 'air')), ['structure']);
  t.deepEqual(kinds((g, l) => set(g, l.p, 'air')), ['structure']);
  t.deepEqual(kinds((g, l) => set(g, l.h, 'cobblestone')), ['structure']);
  t.deepEqual(kinds((g, l) => set(g, l.sill, 'air')), ['structure', 'reach']);
  t.deepEqual(kinds(g => g.set(-556, 64, 2134, 'cobblestone')), ['structure']);
  t.deepEqual(kinds(g => g.set(-555, 63, 2136, 'cobblestone')), ['structure']);
  // the socket: the one cell of the wall that changes by design (a trip's lure in it, or the hole of a second)
  t.deepEqual(kinds((g, l) => set(g, l.socket, 'fletching_table')), ['socket']);
  t.deepEqual(kinds((g, l) => set(g, l.socket, 'air')), ['socket']);
  // in use, or in the way just now: a gate open, somebody inside, a lure at S_out, a tuft in the post's sight, a
  // block on the post, a cell by the socket to stand in. None of these is a lock that does not stand
  t.deepEqual(kinds((g, l) => set(g, l.p, open)), ['gate-open']);
  t.deepEqual(kinds((g, l) => set(g, l.h, open)), ['gate-open']);
  t.deepEqual(kinds(() => undefined, [{ name: 'villager', position: { x: -555.5, y: 63, z: 2135.5 } }]), ['occupied']);
  t.deepEqual(kinds((g, l) => set(g, l.sOut, 'fletching_table')), ['occupied']);
  t.deepEqual(kinds(g => g.set(-554, 62, 2139, 'dirt_path')), ['post']);
  t.deepEqual(kinds((g, l) => set(g, l.post, 'cobblestone')), ['post']);
  t.deepEqual(kinds(g => { g.set(-553, 63, 2137, 'tall_grass[half=lower]'); g.set(-553, 64, 2137, 'tall_grass[half=upper]'); }), ['sight']);
  t.deepEqual(kinds(g => g.set(-553, 64, 2135, 'dirt')), ['sight']);
  t.deepEqual(kinds(g => { g.set(-554, 63, 2134, 'air'); g.set(-554, 64, 2134, 'air'); }), ['reach']);
  // the lock of a trip at its DOOR step: the lure in the socket, H open behind a shut P, the ward inside. Much is said,
  // nothing of it is "structure": the lock stands
  const door = kinds((g, l) => { set(g, l.socket, 'fletching_table'); set(g, l.h, open); }, [{ name: 'villager', position: { x: -555.5, y: 63, z: 2136.5 } }]);
  t.deepEqual(door, ['socket', 'gate-open', 'occupied']);
  t.false(door.some(k => k === 'zones' || k === 'structure'));
  // no lock, zones of two layouts, cells not read: each its own kind, the unread first
  const { g, world } = locked(H, 'south', false);
  t.deepEqual(lockFaults(worldOf(zonesOf('hall', hallAt(H, 'south'))), lawn(H)), [{ kind: 'zones', text: 'no lock stands' }]);
  t.deepEqual(lockFaults({ ...world, zones: { ...world.zones, 'lock:post': [{ x: 0, y: 63, z: 0 }] } } as WorldMemory, g), [{ kind: 'zones', text: 'the lock\'s zones are not its blueprint\'s' }]);
  g.set(-558, 64, 2136, 'air');
  const holed: Blocks = { state: (x, y, z) => (x === -557 ? null : g.state(x, y, z)) };
  t.deepEqual(lockFaults(world, holed).map(f => f.kind), ['unread', 'structure']);
});

test('lockReady: a block beside the wall changes nothing (the lock is roofed); cells not read are one fault', (t) => {
  const { g, world } = locked(H, 'south', false);
  // against the west wall, against the front, on the roof, a lamp post by P's lane
  g.set(-559, 63, 2136, 'cobblestone');
  g.set(-558, 63, 2138, 'dirt');
  g.set(-556, 66, 2136, 'cobblestone');
  g.set(-555, 63, 2138, 'oak_fence');
  g.set(-555, 64, 2138, 'torch');
  t.deepEqual(lockReady(world, g), []);
  const holed: Blocks = { state: (x, y, z) => (x === -557 ? null : g.state(x, y, z)) };
  const f = lockReady(world, holed);
  t.is(f.length, 1);
  t.regex(f[0], /^the lock is not read: \d+ cell\(s\), the first at \(-557, 6\d, 21\d\d\)$/);
});

test('spanOf: the box the questions read of a shell, and nothing outside it', (t) => {
  t.deepEqual(spanOf(lockAt(H, 'south')), { x1: -559, y1: 62, z1: 2133, x2: -552, y2: 65, z2: 2140 });
  t.deepEqual(spanOf(lockAt(H, 'south', true)), { x1: -560, y1: 62, z1: 2133, x2: -553, y2: 65, z2: 2140 });
  t.deepEqual(spanOf(ringAt(PORTAL, 'south')), { x1: -565, y1: 62, z1: 2144, x2: -554, y2: 64, z2: 2150 });
  // a world read over that box and no further answers all three as the whole world does
  const within = (g: Blocks, pl: Placed): Blocks => {
    const b = spanOf(pl);
    return { state: (x, y, z) => (x < b.x1 || x > b.x2 || y < b.y1 || y > b.y2 || z < b.z1 || z > b.z2 ? null : g.state(x, y, z)) };
  };
  for (const { side, mirror, name } of LAYOUTS) {
    const plan = lockAt(H, side, mirror);
    t.deepEqual(footprintFree(within(yard(H, side).g, plan), plan), { ok: true }, name);
    const { g, world, lock } = locked(H, side, mirror);
    t.deepEqual(lockReady(world, within(g, lock)), [], name);
    t.deepEqual(footprintFree(within(g, lock), lock), { ok: true }, name);
  }
  for (const side of ['south', 'north', 'east'] as const) {
    const bare = portalYard(), plan = ringAt(PORTAL, side);
    t.deepEqual(footprintFree(within(bare.g, plan), plan), { ok: true }, side);
    const { g, world, ring } = ringed(side);
    t.deepEqual(ringReady(world, within(g, ring)), [], side);
  }
});

test('ringReady: nothing to ring without a portal; no ring, a ring not built, a ring as built', (t) => {
  t.deepEqual(ringReady(worldOf({}), lawn(H)), []);
  const bare = portalYard();
  t.deepEqual(ringReady(bare.world, bare.g), ['the portal has no ring']);
  t.is(ringPlanOf(bare.world), undefined);
  // the footprint zone is written before the build, the gate's when every block is in place
  bare.world.zones!.ring = [ringAt(PORTAL, 'south').zone];
  t.deepEqual(ringReady(bare.world, bare.g), ['the portal\'s ring is not built']);
  for (const side of ['south', 'north', 'east'] as const) {
    const { g, world, ring } = ringed(side);
    t.deepEqual(ringReady(world, g), [], side);
    t.deepEqual(ringPlanOf(world)?.gate, ring.gate, side);
    t.is(ringPlanOf(world)?.side, side);
  }
  // zones that are not the blueprint's round this portal
  const off1 = ringed();
  off1.world.zones!['ring:gate'] = [{ x: -559, y: 63, z: 2149 }];
  t.deepEqual(ringReady(off1.world, off1.g), ['the ring\'s zones are not its blueprint\'s']);
});

test('ringReady: each fault is named: a fence gone, the gate open, a block beside the ring inside or out', (t) => {
  const faults = (change: (g: Ground, ring: RingPlan) => void) => { const { g, world, ring } = ringed(); change(g, ring); return ringReady(world, g); };
  t.deepEqual(faults(g => g.set(-558, 63, 2145, 'air')), ['a fence of the ring is gone at (-558, 63, 2145) (air)']);
  t.deepEqual(faults((g, r) => set(g, r.gate, 'air')), ['the ring\'s gate is gone at (-563, 63, 2149) (air)']);
  t.deepEqual(faults((g, r) => set(g, r.gate, 'oak_fence_gate[facing=south,in_wall=false,open=true,powered=false]')), ['the ring\'s gate is open at (-563, 63, 2149)']);
  // a block beside a fence is a way over it: outside, inside, and one above (an overhang)
  t.deepEqual(faults(g => g.set(-558, 63, 2150, 'cobblestone')), ['cobblestone beside the ring at (-558, 63, 2150): a way over it']);
  t.deepEqual(faults(g => g.set(-563, 63, 2146, 'dirt')), ['dirt beside the ring at (-563, 63, 2146): a way over it']);
  t.deepEqual(faults(g => g.set(-554, 64, 2147, 'oak_leaves')), ['oak_leaves beside the ring at (-554, 64, 2147): a way over it']);
  // a fence standing on the yard's fence beside it is one above: no fence joins there
  t.deepEqual(faults(g => g.set(-565, 64, 2148, 'oak_fence')), ['oak_fence beside the ring at (-565, 64, 2148): a way over it']);
  // plants, a torch, and a block 2 from the line are nothing
  t.deepEqual(faults(g => { g.set(-558, 63, 2150, 'short_grass'); g.set(-554, 63, 2147, 'torch'); g.set(-558, 63, 2151, 'cobblestone'); }), []);
  // not read
  const { g, world } = ringed();
  const holed: Blocks = { state: (x, y, z) => (z === 2149 && x === -558 ? null : g.state(x, y, z)) };
  t.deepEqual(ringReady(world, holed), ['the ring is not read: 1 cell(s), the first at (-558, 63, 2149)']);
});

// ================================================================================================ the villager's ground (S1)
//
// The walk rules (section 4.2) on fields drawn as rows of letters, north to south, each letter a column from x 0
// eastward: a lawn whose grass is at y 63 (a villager's feet at 64). '.' the lawn, '1'-'9' the lawn raised that much,
// '?' a column not read; every other letter stands on the lawn or is its top (FIELD). Then the real ground of the west
// village (tests/fixtures/west-village.json) for the first lure and two hops.

const Y0 = 63;
const FENCE = 'oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]';
/** What a letter puts in its column: [height over the lawn's top block, state]. */
const FIELD: Record<string, [number, string][]> = {
  w: [[0, 'water[level=0]'], [-1, 'water[level=0]']],
  p: [[0, 'dirt_path']],
  F: [[0, 'farmland[moisture=7]']],
  o: [[0, 'soul_sand']],
  l: [[0, 'lava[level=0]']],
  T: [[0, 'oak_slab[type=top,waterlogged=false]']],
  x: [[0, 'air'], [-1, 'air']],
  f: [[1, FENCE]],
  n: [[1, 'glass_pane[east=false,north=false,south=false,waterlogged=false,west=false]']],
  g: [[1, 'oak_fence_gate[facing=north,in_wall=false,open=false,powered=false]']],
  G: [[1, 'oak_fence_gate[facing=north,in_wall=false,open=true,powered=false]']],
  d: [[1, 'oak_door[facing=north,half=lower,hinge=left,open=false,powered=false]'], [2, 'oak_door[facing=north,half=upper,hinge=left,open=false,powered=false]']],
  i: [[1, 'iron_door[facing=north,half=lower,hinge=left,open=false,powered=false]'], [2, 'iron_door[facing=north,half=upper,hinge=left,open=false,powered=false]']],
  I: [[1, 'iron_door[facing=north,half=lower,hinge=left,open=true,powered=false]'], [2, 'iron_door[facing=north,half=upper,hinge=left,open=true,powered=false]']],
  r: [[1, 'rail[shape=north_south,waterlogged=false]']],
  c: [[1, 'cactus[age=0]']],
  s: [[1, 'oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]']],
  S: [[1, 'oak_slab[type=bottom,waterlogged=false]']],
  k: [[1, 'chest[facing=north,type=single,waterlogged=false]']],
  h: [[1, 'red_bed[facing=north,occupied=false,part=foot]']],
  C: [[1, 'white_carpet']],
  e: [[1, 'oak_leaves[distance=1,persistent=true,waterlogged=false]']],
  b: [[1, 'cobblestone']],
  B: [[1, 'cobblestone'], [2, 'cobblestone']],
  L: [[1, FENCE], [2, 'lantern[hanging=false,waterlogged=false]']],
  P: [[1, 'nether_portal[axis=x]'], [2, 'nether_portal[axis=x]'], [3, 'nether_portal[axis=x]']],
  t: [[1, 'torch']],
  y: [[1, 'poppy']],
  j: [[1, 'smithing_table']]
};
function grid(rows: string[]): Ground {
  const g = new Ground(Y0 - 8, 26);
  rows.forEach((row, z) => [...row].forEach((ch, x) => {
    if (ch === '?') return;
    const h = /[0-9]/.test(ch) ? Number(ch) : 0;
    for (let y = Y0 - 8; y < Y0 + 18; y++) g.set(x, y, z, y < Y0 + h ? 'dirt' : y === Y0 + h ? 'grass_block[snowy=false]' : 'air');
    for (const [dy, s] of FIELD[ch] ?? []) g.set(x, Y0 + dy, z, s);
  }));
  return g;
}
/** A villager's feet on the lawn (or `h` up) in column (x, z). */
const feet = (x: number, z: number, h = 0): Pos => ({ x, y: Y0 + 1 + h, z });
/** A plain lawn `w` x `l`, with letters stood at cells (x, z). */
function lawnOf(w: number, l: number, put: [number, number, string][] = []): Ground {
  const rows = Array.from({ length: l }, () => [...'.'.repeat(w)]);
  for (const [x, z, ch] of put) rows[z][x] = ch;
  return grid(rows.map(r => r.join('')));
}
const why = (s: Stand | NoWay) => (isStand(s) ? 'ok' : s.why);

test('4.2\'s table, row by row, for both rule sets (D11)', (t) => {
  /** One step east from a cell on the lawn, by each set. */
  const both = (g: Ground, z: number) => (['lead', 'game'] as const).map(r => why(step(g, feet(0, z), 1, 0, r)));
  // rise, floor top to floor top: a block (1) and a path block up onto a full block (1 1/16) both; 1.125 only the game
  const rise = grid(['.1', 'p1', 'p2']);
  t.deepEqual(both(rise, 0), ['ok', 'ok']);
  t.deepEqual(both(rise, 1), ['ok', 'ok'], 'a path block up onto a full block: 1 1/16');
  t.like(step(rise, feet(0, 2), 1, 0, 'lead'), { why: 'rise', size: 2.0625 });
  const soul = grid(['o1']), sand = stand(soul, 0, Y0, 0, 'game') as Stand;
  t.is(sand.f, Y0 + 14 / 16);
  t.like(step(soul, sand, 1, 0, 'game'), { f: Y0 + 2 }, 'soul sand up onto a block: 1.125, the game\'s jump');
  t.like(step(soul, sand, 1, 0, 'lead'), { why: 'rise' });
  t.like(stand(soul, 0, Y0, 0, 'lead'), { why: 'floor' }, 'soul sand is no floor the lead rules count on');
  // drop: 2 the lead rules, 1 retracing, 3 the game
  const drop = grid(['31', '30']);
  t.like(step(drop, feet(0, 0, 3), 1, 0, 'lead'), { f: Y0 + 2 });
  t.like(step(drop, feet(0, 0, 3), 1, 0, 'lead', { retrace: true }), { why: 'drop', size: 2 });
  t.like(step(drop, feet(0, 1, 3), 1, 0, 'lead'), { why: 'drop', size: 3 });
  t.like(step(drop, feet(0, 1, 3), 1, 0, 'game'), { f: Y0 + 1 });
  // floors: the lead rules a full top (grass, a path block, farmland, a top slab); the game any collision top
  const floors = grid(['.pFTSskhCe']);
  const fl = (x: number, y: number) => [why(stand(floors, x, y, 0, 'lead')), why(stand(floors, x, y, 0, 'game'))];
  t.deepEqual([fl(0, 64), fl(1, 64), fl(2, 64), fl(3, 64)], [['ok', 'ok'], ['ok', 'ok'], ['ok', 'ok'], ['ok', 'ok']]);
  t.deepEqual([fl(4, 64), fl(5, 65), fl(6, 64), fl(7, 64), fl(8, 64), fl(9, 65)], [['floor', 'ok'], ['floor', 'ok'], ['floor', 'ok'], ['floor', 'ok'], ['floor', 'ok'], ['floor', 'ok']],
    'a bottom slab, a stair, a chest, a bed, a carpet, leaves: the game\'s floors only');
  t.is((stand(floors, 1, 64, 0, 'lead') as Stand).f, Y0 + 15 / 16);
  // a fence's top (1.5) is the game's from a block beside it, never from the lawn; the lead rules' never
  const top = grid(['bf', '.f']);
  t.like(step(top, feet(0, 0, 1), 1, 0, 'game'), { y: 65, f: Y0 + 2.5 });
  t.like(step(top, feet(0, 0, 1), 1, 0, 'lead'), { why: 'fence' });
  t.like(step(top, feet(0, 1), 1, 0, 'game'), { why: 'fence' });
  // fences, panes, gates shut, rails, an iron door: walls to both as cells; a wooden door passes both
  const cells = grid(['fngrdiI']);
  const cellWhy = (x: number) => [why(stand(cells, x, 64, 0, 'lead')), why(stand(cells, x, 64, 0, 'game'))];
  t.deepEqual([0, 1, 2, 3].map(cellWhy), [['fence', 'fence'], ['fence', 'fence'], ['fence', 'fence'], ['fence', 'fence']]);
  t.deepEqual(cellWhy(4), ['ok', 'ok'], 'a wooden door: both');
  t.deepEqual(cellWhy(5), ['fence', 'fence'], 'an iron door shut');
  t.deepEqual(cellWhy(6), ['fence', 'ok'], 'an iron door open: the game\'s only');
  // gates: the lead rules pass only those held open; the game those read open too
  const gates = grid(['G']);
  t.deepEqual([why(stand(gates, 0, 64, 0, 'lead')), why(stand(gates, 0, 64, 0, 'game'))], ['fence', 'ok']);
  t.is(why(stand(gates, 0, 64, 0, 'lead', { open: [feet(0, 0)] })), 'ok');
  t.is(why(stand(grid(['g']), 0, 64, 0, 'game', { open: [feet(0, 0)] })), 'ok', 'a gate held open passes the game too');
  // water: a wall to the lead rules, a way to the game
  const wet = grid(['.w.']);
  t.like(step(wet, feet(0, 0), 1, 0, 'lead'), { why: 'water' });
  t.like(step(wet, feet(0, 0), 1, 0, 'game'), { x: 1, y: Y0, f: Y0 });
  // what hurts: a wall to both, and to the lead rules the 8 cells round it; a portal every cell within 5
  const hurt = grid(['..c..', '.....']);
  t.deepEqual([why(stand(hurt, 2, 64, 0, 'lead')), why(stand(hurt, 2, 64, 0, 'game'))], ['hazard', 'hazard']);
  t.deepEqual([why(stand(hurt, 1, 64, 1, 'lead')), why(stand(hurt, 1, 64, 1, 'game'))], ['hazard', 'ok']);
  t.is(why(stand(hurt, 0, 64, 1, 'lead')), 'ok');
  const lava = grid(['.l.']);
  t.like(stand(lava, 0, 64, 0, 'lead'), { why: 'hazard', what: 'lava' });
  t.is(why(stand(lava, 0, 64, 0, 'game')), 'ok');
  const portal = grid(['P......']);
  t.like(stand(portal, 5, 64, 0, 'lead'), { why: 'hazard', what: 'a portal' });
  t.is(why(stand(portal, 6, 64, 0, 'lead')), 'ok');
  t.is(why(stand(portal, 1, 64, 0, 'game')), 'ok');
  t.deepEqual([why(stand(portal, 0, 64, 0, 'lead')), why(stand(portal, 0, 64, 0, 'game'))], ['hazard', 'hazard']);
  // unread: a wall to both
  const unread = grid(['.?']);
  t.deepEqual(both(unread, 0), ['unread', 'unread']);
  // a diagonal only on the level, both cells beside it standing at that level
  const diag = grid(['..', '.1', 'b.']);
  t.like(step(diag, feet(0, 0), 1, 1, 'game'), { why: 'rise' });
  t.like(step(diag, feet(0, 1), 1, 1, 'lead'), { why: 'rise' }, 'the corner beside it is a block');
  t.like(step(grid(['..', '..']), feet(0, 0), 1, 1, 'lead'), { x: 1, z: 1, f: Y0 + 1 });
});

test('pathFor: the lead rules\' 36 cells and 600 nodes, the game\'s 48; no limits for a corridor; the largest drop said', (t) => {
  const g = lawnOf(44, 3);
  const r = pathFor(g, feet(1, 1), feet(41, 1), 'lead');
  t.like(r, { ok: false, why: 'far' });
  t.regex(wayText(r as NoWay), /no way within 36 cells and 600 nodes from \(/);
  t.like(pathFor(g, feet(1, 1), feet(41, 1), 'game'), { ok: true, len: 40 });
  t.like(pathFor(g, feet(1, 1), feet(41, 1), 'lead', { limits: false }), { ok: true, len: 40, drop: 0 });
  t.like(pathFor(g, feet(1, 1), feet(41, 1), 'lead', { limits: { path: 100, nodes: 20 } }), { ok: false, why: 'far' });
  t.like(pathFor(g, feet(1, 1), feet(30, 1), 'lead'), { ok: true, len: 29 });
  t.is(HOP_PATH, 36);
  t.is(GAME_PATH, 48);
  // a test of a cell for a goal, and a way's cells from the first to the last
  const p = pathFor(g, feet(1, 1), c => c.x === 5, 'lead');
  t.true(p.ok);
  if (p.ok) { t.deepEqual(p.cells[0], feet(1, 1)); t.is(p.cells.at(-1)!.x, 5); }
});

test('drop 2 leads, drop 3 does not; retracing, 1 (D6, D7)', (t) => {
  const two = grid(['33333111', '33333111', '33333111']);
  t.like(pathFor(two, feet(1, 1, 3), feet(6, 1, 1), 'lead'), { ok: true, drop: 2 });
  t.like(pathFor(two, feet(1, 1, 3), feet(6, 1, 1), 'lead', { retrace: true }), { ok: false, why: 'drop', size: 2 });
  const three = grid(['33333000', '33333000', '33333000']);
  t.like(pathFor(three, feet(1, 1, 3), feet(6, 1), 'lead'), { ok: false, why: 'drop', size: 3 });
  t.like(pathFor(three, feet(1, 1, 3), feet(6, 1), 'game'), { ok: true, drop: 3 });
  t.regex(wayText(pathFor(three, feet(1, 1, 3), feet(6, 1), 'lead') as NoWay), /^a drop of 3 at \(5, 6\d, \d\)$/);
  // retracing, a stair of single steps aside is the way down; a block's rise back up from a path block too
  const stair = grid(['33333111', '33333111', '33332111']);
  t.like(pathFor(stair, feet(1, 0, 3), feet(6, 0, 1), 'lead', { retrace: true, limits: false }), { ok: true, drop: 1 });
});

test('water is a wall to the lead rules, a way to the game; 9 wide it is no way and says so (D9, A10)', (t) => {
  const pond = grid(['..........', '...www....', '...www....', '...www....', '..........']);
  const lead = pathFor(pond, feet(1, 2), feet(8, 2), 'lead');
  t.true(lead.ok);
  if (lead.ok) t.false(lead.cells.some(c => c.x >= 3 && c.x <= 5 && c.z >= 1 && c.z <= 3), 'round the pond');
  const river = grid(Array.from({ length: 5 }, () => '..........wwwwwwwww.........'));
  const no = corridor(river, feet(2, 2), feet(25, 2));
  t.like(no, { ok: false, why: 'water', size: 9 });
  t.regex((no as { text: string }).text, /^water 9 wide at \(10, 6\d, \d\)$/);
  t.like(pathFor(river, feet(2, 2), feet(25, 2), 'game', { limits: false }), { ok: true });
});

test('corridor: a rise of 4 is no way and names the place; the waypoints every 22 cells (A10)', (t) => {
  const cliff = grid(Array.from({ length: 5 }, () => `${'.'.repeat(30)}${'4'.repeat(10)}`));
  const no = corridor(cliff, feet(2, 2), feet(35, 2, 4));
  t.like(no, { ok: false, why: 'rise', size: 4, at: { x: 30, z: 2 } });
  t.regex((no as { text: string }).text, /^a rise of 4 at \(30, 6\d, 2\)$/);
  const plain = lawnOf(80, 3);
  const c = corridor(plain, feet(0, 1), feet(70, 1));
  t.true(c.ok);
  if (c.ok) {
    t.is(c.len, 70);
    t.deepEqual(c.waypoints.map(p => p.x), [22, 44, 70], 'the sample 4 short of the end is no hop of its own');
  }
});

test('unread is a wall to every plan, and names where the ground ends (A11)', (t) => {
  const wall = grid(Array.from({ length: 5 }, () => `${'.'.repeat(20)}?${'.'.repeat(20)}`));
  const no = corridor(wall, feet(2, 2), feet(35, 2));
  t.like(no, { ok: false, why: 'unread', at: { x: 20, z: 2 } });
  t.regex((no as { text: string }).text, /^ground not read at \(20, /);
  const gap = grid([...Array.from({ length: 4 }, () => `${'.'.repeat(20)}?${'.'.repeat(20)}`), '.'.repeat(41)]);
  t.like(corridor(gap, feet(2, 2), feet(35, 2)), { ok: true });
  t.like(stand(wall, 20, 64, 2, 'game'), { why: 'unread' });
});

test('a way keeps a cell off a cactus; a portal cell is a wall with every cell within 5 (D10)', (t) => {
  const cactus = grid(['.........', '.........', '....c....', '.........', '.........']);
  const p = pathFor(cactus, feet(0, 2), feet(8, 2), 'lead');
  t.true(p.ok);
  if (p.ok) t.true(p.cells.every(c => Math.max(Math.abs(c.x - 4), Math.abs(c.z - 2)) >= 2), 'a cell off the cactus all the way');
  const g = pathFor(cactus, feet(0, 2), feet(8, 2), 'game');
  t.true(g.ok && g.cells.some(c => Math.max(Math.abs(c.x - 4), Math.abs(c.z - 2)) === 1), 'the game walks by it');
  const rows = Array.from({ length: 13 }, (_, z) => (z === 6 ? `${'.'.repeat(10)}P${'.'.repeat(10)}` : '.'.repeat(21)));
  const portal = grid(rows);
  const q = pathFor(portal, feet(0, 6), feet(20, 6), 'lead', { limits: false });
  t.true(q.ok);
  if (q.ok) t.true(q.cells.every(c => Math.max(Math.abs(c.x - 10), Math.abs(c.z - 6)) > 5), 'no cell within 5 of it');
  const shut = grid(Array.from({ length: 11 }, (_, z) => (z === 5 ? `${'.'.repeat(10)}P${'.'.repeat(10)}` : '.'.repeat(21))));
  t.like(pathFor(shut, feet(0, 5), feet(20, 5), 'lead', { limits: false }), { ok: false, why: 'hazard', what: 'a portal' });
});

test('a 1 x 1 hole 2 deep is a trap; 1 deep is none; what lies past 10 is not asked (E7, trapNear)', (t) => {
  const hole = lawnOf(25, 25, [[16, 12, 'x']]);
  t.deepEqual(trapNear(hole, feet(12, 12)), { x: 16, y: Y0 - 1, z: 12 });
  t.is(trapNear(hole, feet(4, 12)), undefined, 'the hole 12 off');
  t.deepEqual(trapNear(hole, feet(4, 12), 12), { x: 16, y: Y0 - 1, z: 12 }, 'asked out to 12, it is one');
  const step = grid(Array.from({ length: 25 }, (_, z) => [...'.'.repeat(25)].map((c, x) => (x === 16 && z === 12 ? '?' : c)).join('')));
  t.is(trapNear(step, feet(12, 12)), undefined, 'a cell not read is no trap: nobody goes there');
  // a hollow behind a lip of 2 (the sinkhole): in by a drop of 2, no way out
  const lip = grid(['3333333333333', '3333333333333', '3333333.33333', '3333333333333', '3333333333333']);
  t.deepEqual(trapNear(lip, feet(3, 2, 3)), { x: 7, y: Y0 + 1, z: 2 });
  const shallow = grid(['3333333333333', '3333333333333', '33333332333333', '3333333333333', '3333333333333']);
  t.is(trapNear(shallow, feet(3, 2, 3)), undefined, 'a hollow one deep is walked out of');
  t.is(TRAP_R, 10);
});

test('sameWay: a bench beside the way refuses it; a lamp post or a lone fence post does not (D13)', (t) => {
  const way = (g: Ground) => (pathFor(g, feet(0, 2), feet(12, 2), 'lead') as { cells: Pos[] }).cells;
  const plain = lawnOf(13, 5);
  t.true(way(plain).every(c => c.z === 2));
  t.deepEqual(sameWay(plain, way(plain)), { ok: true });
  const bench = lawnOf(13, 5, [[6, 3, 's']]);
  const s = sameWay(bench, way(plain));
  t.like(s, { ok: false, at: { x: 6, y: Y0 + 2, z: 3 } });
  t.regex((s as { what: string }).what, /oak_stairs/);
  t.deepEqual(sameWay(lawnOf(13, 5, [[6, 3, 'L']]), way(plain)), { ok: true }, 'no game step onto a post\'s top without a block beside it');
  t.deepEqual(sameWay(lawnOf(13, 5, [[6, 3, 'f'], [6, 4, 'f']]), way(plain)), { ok: true });
  // the pavilion's bench against its fence rail (Nov 24): the block beside the fence is a step onto its top
  t.like(sameWay(lawnOf(13, 5, [[6, 3, 'f'], [7, 3, 'b']]), way(plain)), { ok: false, at: { x: 6, z: 3 } });
  t.deepEqual(sameWay(lawnOf(13, 5, [[6, 4, 'f'], [7, 4, 'b']]), way(plain)), { ok: true }, 'its top a third step off the way');
  // two away from the way it is still asked; three away it is not
  t.like(sameWay(lawnOf(13, 6, [[6, 4, 's']]), way(plain)), { ok: false });
  t.deepEqual(sameWay(lawnOf(13, 6, [[6, 5, 's']]), way(plain)), { ok: true });
  // water, a drop of 3 and a gate read open beside the way: the game's, not the lead's
  t.like(sameWay(lawnOf(13, 5, [[6, 3, 'w']]), way(plain)), { ok: false });
  const high = (pathFor(grid(Array(5).fill('3333333333333')), feet(0, 2, 3), feet(12, 2, 3), 'lead') as { cells: Pos[] }).cells;
  t.like(sameWay(grid(['3333333333333', '3333333333333', '3333333333333', '333333.333333', '3333333333333']), high), { ok: false, at: { x: 6, y: Y0 + 1, z: 3 } });
  t.like(sameWay(lawnOf(13, 5, [[6, 3, 'G']]), way(plain)), { ok: false });
  t.deepEqual(sameWay(lawnOf(13, 5, [[6, 3, 'G']]), way(plain), { open: [feet(6, 3)] }), { ok: true }, 'a gate held for the way: the lead rules pass it too');
  t.deepEqual(sameWay(bench, way(plain), { skip: c => c.x >= 4 && c.x <= 8 }), { ok: true });
});

test('botStand: 2-3 beyond the lure, off the ward\'s way, seeing its face and reaching its floor, within the bot\'s walk', (t) => {
  const g = lawnOf(20, 9);
  const at = feet(10, 4), lure = withBlock(g, at, 'fletching_table');
  const way = (pathFor(lure, feet(2, 4), feet(9, 4), 'lead') as { cells: Pos[] }).cells;
  const b = botStand(lure, at, way, feet(3, 6))!;
  t.truthy(b);
  t.true(Math.max(Math.abs(b.x - at.x), Math.abs(b.z - at.z)) >= 2 && Math.max(Math.abs(b.x - at.x), Math.abs(b.z - at.z)) <= 3);
  t.true(b.x > at.x, 'beyond it from where the ward comes');
  t.true(seesFace(lure, b, at));
  // a wall round the far side of the lure: no face seen from beyond it
  const walled = lawnOf(20, 9);
  for (let z = 1; z <= 7; z++) for (const y of [64, 65]) walled.set(11, y, z, 'cobblestone');
  t.is(botStand(withBlock(walled, at, 'fletching_table'), at, way, feet(3, 6)), undefined);
  // the bot too far to walk there by the lead rules
  const long = lawnOf(80, 9), far = withBlock(long, feet(60, 4), 'fletching_table');
  t.is(botStand(far, feet(60, 4), [feet(52, 4)], feet(2, 4)), undefined);
  t.truthy(botStand(far, feet(60, 4), [feet(52, 4)], feet(60 - BOT_WALK + 8, 4)));
});

/** The next hop east from a ward on the lawn, the bot by it (it stood 2-3 beyond the last lure). */
const hopEast = (g: Ground, ward: Pos, o: Partial<HopOpts> = {}, toward = { x: 80, z: ward.z }) =>
  hopSpot(g, ward, toward, { bot: { x: ward.x + 2, y: ward.y, z: ward.z + 2 }, ...o });
const spotOf = (r: HopSpot | { why: string }): HopSpot => { if ('why' in r) throw new Error(r.why); return r; };
const straightOf = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('hopSpot: about 22 on, 24 at most, 8 nearer at least; the ward\'s way to where it takes it, the bot beyond it', (t) => {
  const g = lawnOf(50, 9), ward = feet(2, 4);
  const h = spotOf(hopEast(g, ward));
  t.deepEqual(h.block, feet(24, 4));
  t.true(straightOf(h.block, ward) <= HOP_MAX);
  t.deepEqual(h.path[0], ward);
  t.deepEqual(h.path.at(-1), h.reach);
  t.true(reachCells(withBlock(g, h.block, 'fletching_table'), h.block).some(c => c.x === h.reach.x && c.y === h.reach.y && c.z === h.reach.z));
  t.true(h.botStand.x > h.block.x && Math.max(Math.abs(h.botStand.x - h.block.x), Math.abs(h.botStand.z - h.block.z)) >= 2);
  t.is(h.drop, 0);
  // the short hop after none, and a waypoint nearer than 8
  t.true(spotOf(hopEast(g, ward, { len: 11 })).block.x <= 2 + 13);
  t.regex((hopEast(g, ward, {}, { x: 8, z: 4 }) as { why: string }).why, /^no cell 8 nearer \(8, 4\)/);
  t.is(HOP_MIN, 8);
  // a lure goes into air or grass, never into a torch or a flower, and on a full block (not a top slab)
  t.notDeepEqual(spotOf(hopEast(lawnOf(50, 9, [[24, 4, 't']]), ward)).block, feet(24, 4));
  t.notDeepEqual(spotOf(hopEast(lawnOf(50, 9, [[24, 4, 'y']]), ward)).block, feet(24, 4));
  t.notDeepEqual(spotOf(hopEast(lawnOf(50, 9, [[24, 4, 'T']]), ward)).block, feet(24, 4));
  const tall = lawnOf(50, 9);
  tall.set(24, 64, 4, 'short_grass');
  t.deepEqual(spotOf(hopEast(tall, ward)).block, feet(24, 4), 'grass is put into as air');
  // the cell it takes the lure from has no thin block beside it: fences by the near side send it round to the far one
  const fences = lawnOf(50, 9, [[22, 3, 'f'], [22, 5, 'f'], [23, 3, 'f'], [23, 5, 'f']]), fenced = spotOf(hopEast(fences, ward));
  t.deepEqual(fenced.block, feet(24, 4));
  t.notDeepEqual(fenced.reach, feet(23, 4));
  const beside = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => fences.state(fenced.reach.x + dx, fenced.reach.y + dy, fenced.reach.z + dz) ?? '');
  t.false(beside.some(b => /fence/.test(b)), `${JSON.stringify(fenced.reach)}: ${beside}`);
  // fences by every side and no room on its top: no cell to take it from
  const boxed = lawnOf(50, 9, [[22, 3, 'f'], [23, 3, 'f'], [23, 5, 'f'], [24, 3, 'f'], [24, 5, 'f'], [25, 3, 'f'], [25, 5, 'f'], [26, 4, 'f']]);
  boxed.set(24, 66, 4, 'cobblestone');
  t.notDeepEqual(spotOf(hopEast(boxed, ward)).block, feet(24, 4));
});

test('never on a path block or farmland; a spot on a slope (C9, D5)', (t) => {
  const g = grid(['..........................................', 'pppppppppppppppppppppppppppppppppppppppppp', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', '..........................................']);
  const h = spotOf(hopEast(g, { x: 2, y: Y0 + 1, z: 1 }));
  t.is(g.state(h.block.x, h.block.y - 1, h.block.z), 'grass_block[snowy=false]');
  t.true(h.block.z === 0 || h.block.z === 3);
  const slope = grid(Array.from({ length: 7 }, () => '...111222333444555666777888999999999'));
  const s = spotOf(hopEast(slope, feet(1, 3)));
  const col = Number(slope.state(s.block.x, Y0, s.block.z) === 'dirt' ? 0 : 0);
  t.true(s.block.x >= 18, `the slope climbed: ${s.block.x}`);
  t.is(slope.state(s.block.x, s.block.y - 1, s.block.z), 'grass_block[snowy=false]');
  t.is(col, 0);
  t.is(s.drop, 0);
});

test('a spot keeps 16 off a build and 56 off a free job site, but for the exempt ones (A14, E13)', (t) => {
  const g = lawnOf(44, 40), ward = feet(2, 20);
  t.deepEqual(spotOf(hopEast(g, ward)).block, feet(24, 20));
  const zone: Zone = { x1: 22, y1: 60, z1: 34, x2: 24, y2: 70, z2: 36 };
  const off = (c: Pos) => Math.hypot(Math.max(0, zone.x1 - c.x - 0.5, c.x + 0.5 - zone.x2), Math.max(0, zone.y1 - c.y, c.y - zone.y2), Math.max(0, zone.z1 - c.z - 0.5, c.z + 0.5 - zone.z2));
  const z = spotOf(hopEast(g, ward, { zones: [zone] }));
  t.true([z.block, ...z.path].every(c => off(c) >= 16), 'the spot and its way 16 off');
  t.notDeepEqual(z.block, feet(24, 20));
  const site = { at: { x: 24, y: 64, z: 75 }, name: 'smithing_table' };
  const far = (c: Pos) => Math.hypot(c.x - site.at.x, c.z - site.at.z);
  const r = spotOf(hopEast(g, ward, { sites: [site] }));
  t.true([r.block, ...r.path].every(c => far(c) >= RIVAL_R), 'its way 56 off the smithing table');
  t.notDeepEqual(r.block, feet(24, 20));
  // the exempt: the origin village's own inside its area, those lifted, the hall's behind its shut gate, a lure of the trip
  const area = { x1: 0, z1: 60, x2: 50, z2: 90 }, box = { x1: 20, z1: 70, x2: 30, z2: 80 };
  for (const o of [{ home: area }, { lifted: [site.at] }, { hall: { box, shut: true } }, { lures: [site.at] }] as Partial<HopOpts>[]) {
    t.deepEqual(spotOf(hopEast(g, ward, { sites: [site], ...o })).block, feet(24, 20), JSON.stringify(o));
  }
  t.notDeepEqual(spotOf(hopEast(g, ward, { sites: [site], hall: { box, shut: false } })).block, feet(24, 20), 'the hall\'s gate open: its blocks are rivals');
  // a site by the ward itself: no way that keeps off it
  t.regex((hopEast(g, ward, { sites: [{ at: { x: 10, y: 64, z: 20 }, name: 'cauldron' }] }) as { why: string }).why, /a free cauldron/);
  t.regex((hopEast(g, ward, { avoid: [{ at: { x: 10, z: 20 }, r: 56, why: 'the cauldron of a witch hut' }] }) as { why: string }).why, /witch hut/);
  // the corridor names the site no way keeps off
  const across = corridor(lawnOf(44, 40), feet(2, 20), feet(42, 20), { sites: [{ at: { x: 22, y: 64, z: 70 }, name: 'cauldron' }, { at: { x: 22, y: 64, z: -30 }, name: 'cauldron' }] });
  t.like(across, { ok: false, why: 'rival' });
  t.regex((across as { text: string }).text, /^a free cauldron at \(22, 64, (70|-30)\) within 56 of every way$/);
});

test('reachCells: the cells sharing a face with a block at its level, and its top, that a villager stands in', (t) => {
  const g = lawnOf(9, 9, [[3, 4, 'b']]), at = feet(4, 4), lure = withBlock(g, at, 'fletching_table');
  t.deepEqual(reachCells(lure, at).map(key).sort(), [feet(5, 4), feet(4, 5), feet(4, 3), feet(4, 4, 1)].map(key).sort(), 'not the cell the cobblestone fills');
  t.deepEqual(reachCells(g, at), [feet(5, 4), feet(4, 5), feet(4, 3)], 'without the block: nothing to stand on over it');
});

test('no cell a lure stood in within the last 20 s (D36)', (t) => {
  const g = lawnOf(50, 9), ward = feet(2, 4);
  const first = spotOf(hopEast(g, ward)).block;
  t.notDeepEqual(spotOf(hopEast(g, ward, { used: [{ at: first, t: 100_000 }], now: 100_000 + REUSE_MS - 1 })).block, first);
  t.deepEqual(spotOf(hopEast(g, ward, { used: [{ at: first, t: 100_000 }], now: 100_000 + REUSE_MS })).block, first);
});

test('retracing, the stair is taken before the 2-drop; with no stair the 2-drop, and its drop says the trip is committed (D7)', (t) => {
  const rows = (stair: boolean) => Array.from({ length: 11 }, (_, z) => `${'3'.repeat(10)}${stair && z === 0 ? '2' : '1'}${'1'.repeat(30)}`);
  const ward = feet(2, 5, 3);
  const r = spotOf(hopEast(grid(rows(true)), ward, { retrace: true }));
  t.true(r.drop <= RETRACE_DROP, `drop ${r.drop}`);
  t.true(r.path.some(c => c.x === 10 && c.z === 0), 'down by the stair');
  const straight = spotOf(hopEast(grid(rows(true)), ward));
  t.is(straight.drop, 2, 'committed already: the straight way');
  const none = spotOf(hopEast(grid(rows(false)), ward, { retrace: true }));
  t.is(none.drop, 2);
  t.true(none.drop > RETRACE_DROP, 'below it the trip is committed');
});

test('no spot within 10 of a pit (D8)', (t) => {
  const pit = lawnOf(50, 21, [[30, 10, 'x']]);
  const h = spotOf(hopEast(pit, feet(2, 10), {}, { x: 60, z: 10 }));
  t.true(Math.hypot(h.block.x - 30, h.block.z - 10) > TRAP_R, `${JSON.stringify(h.block)}`);
  t.deepEqual(spotOf(hopEast(lawnOf(50, 21), feet(2, 10))).block, feet(24, 10), 'without the pit, straight on');
});

test('the first lure: the spot nearest the corridor\'s start within 24 of a candidate; where none has a way, an open spot (C2)', (t) => {
  const g = lawnOf(60, 21), start = { x: 50, z: 10 };
  const one = firstSpot(g, [feet(2, 10)], start, { bot: feet(4, 12) }) as HopSpot & { from: Pos };
  t.deepEqual(one.from, feet(2, 10));
  t.true(one.path.length - 1 <= FIRST_PATH && one.block.x - 2 <= FIRST_PATH);
  t.true(one.block.x >= 24, `as near the start as 24 allows: ${one.block.x}`);
  const two = firstSpot(g, [feet(2, 10), feet(12, 14)], start, { bot: feet(4, 12) }) as HopSpot & { from: Pos };
  t.deepEqual(two.from, feet(12, 14), 'whoever is nearer the start');
  // a candidate indoors, shut in: an open spot 12-32 from it on the start's side
  const house = lawnOf(60, 21);
  for (let x = 1; x <= 3; x++) for (let z = 9; z <= 11; z++) for (const y of [64, 65, 66]) if (x !== 2 || z !== 10 || y === 66) house.set(x, y, z, 'oak_planks');
  const open = firstSpot(house, [feet(2, 10)], start, { bot: feet(6, 12) }) as HopSpot & { open?: true };
  t.true(open.open);
  const d = Math.hypot(open.block.x - 2, open.block.z - 10);
  t.true(d >= 12 && d <= 32 && open.block.x > 2, `${d}`);
});

test('the first lure after nobody came (4.1): a spot nearer the nearest candidate, within 12 path cells of it on its own level (`path`, `level`), not the 24 that put the first one by the start', (t) => {
  const g = lawnOf(60, 21), start = { x: 50, z: 10 };
  const first = firstSpot(g, [feet(2, 10)], start, { bot: feet(4, 12) }) as HopSpot;
  t.true(first.block.x - 2 > 12, `the first, as near the start as 24 allows: ${first.block.x}`);
  const nearer = firstSpot(g, [feet(2, 10)], start, { bot: feet(4, 12), path: 12, level: true }) as HopSpot;
  t.true(nearer.path.length - 1 <= 12 && Math.hypot(nearer.block.x - 2, nearer.block.z - 10) <= 12, `nearer: ${JSON.stringify(nearer.block)}`);
  t.is(nearer.block.y, feet(2, 10).y, 'on its level');
  // (a rise by it: the cells up there are off its level)
  const hill = lawnOf(60, 21);
  for (let x = 4; x <= 20; x++) for (let z = 0; z <= 20; z++) hill.set(x, Y0 + 1, z, 'grass_block');
  const off = firstSpot(hill, [feet(2, 10)], start, { bot: feet(1, 12), path: 12, level: true });
  t.true('why' in off || (off as HopSpot).block.y === feet(2, 10).y, JSON.stringify(off));
});

test('the first lure keeps 3 off a village\'s marks, 1 where no cell has 3; never on its paths (C9)', (t) => {
  const rows = Array.from({ length: 21 }, (_, z) => (z >= 8 && z <= 12 ? 'p' : '.').repeat(60));
  const g = grid(rows), start = { x: 50, z: 10 };
  const sparse = [{ x: 26, y: 64, z: 3 }];
  const a = firstSpot(g, [feet(2, 10)], start, { bot: feet(4, 12), marks: sparse }) as HopSpot;
  t.false(a.block.z >= 8 && a.block.z <= 12, 'not on the path blocks');
  t.true(Math.max(Math.abs(a.block.x - 26), Math.abs(a.block.z - 3)) > 3);
  const dense: Pos[] = [];
  for (let x = 0; x < 60; x += 4) for (let z = 0; z < 21; z += 4) dense.push({ x, y: 64, z });
  const b = firstSpot(g, [feet(2, 10)], start, { bot: feet(4, 12), marks: dense }) as HopSpot;
  const near = Math.min(...dense.map(m => Math.max(Math.abs(m.x - b.block.x), Math.abs(m.z - b.block.z))));
  t.is(near, 2, 'a cell 2 off the nearest mark: none has 3');
});

/**
 * A yard on paper round the live hall gate H: a lawn (grass at 62), the hall with the lock before its gate and the sill
 * down, the cobblestone walk under the lock, the yard's south fence at z 2148 with its gate G at x -556, and outside it
 * a bank 3 lower (the west gate's drop, Nov 24). `yard` is its box for the walk.
 */
function yardOnPaper(): { g: Ground; lock: LockPlan; G: Pos; yard: { x1: number; z1: number; x2: number; z2: number; y: number } } {
  const g = new Ground(55, 20);
  for (let x = -572; x <= -540; x++) for (let z = 2118; z <= 2156; z++) {
    const top = z > 2148 ? 59 : 62;
    for (let y = 55; y < 75; y++) g.set(x, y, z, y < top ? 'dirt' : y === top ? 'grass_block[snowy=false]' : 'air');
  }
  build(g, hallAt(H, 'south'));
  const lock = lockAt(H, 'south');
  build(g, lock);
  set(g, lock.sill, 'rail[shape=north_south,waterlogged=false]');
  for (const x of [-556, -555, -554, -553, -552]) g.set(x, 62, 2135, 'cobblestone');
  const G = { x: -556, y: 63, z: 2148 };
  for (let x = -572; x <= -540; x++) g.set(x, 63, 2148, x === G.x ? 'oak_fence_gate[facing=south,in_wall=false,open=false,powered=false]' : 'oak_fence[east=true,north=false,south=false,waterlogged=false,west=true]');
  return { g, lock, G, yard: { x1: -572, z1: 2118, x2: -540, z2: 2148, y: 62 } };
}

test('gateLane: the feet and head cells from 3 outside a gate to 6 inside, outside first', (t) => {
  const lane = gateLane({ x: -556, y: 63, z: 2148 }, 'south');
  t.is(lane.length, 20);
  t.deepEqual(lane.slice(0, 2), [{ x: -556, y: 63, z: 2151 }, { x: -556, y: 64, z: 2151 }]);
  t.deepEqual(lane.at(-1), { x: -556, y: 64, z: 2142 });
  t.deepEqual(gateLane({ x: -565, y: 63, z: 2183 }, 'west')[0], { x: -568, y: 63, z: 2183 });
});

test('yardWay: from the gate\'s inner cell to S_out with the gate held, the lock\'s and hall\'s gates shut; the lane and the last cells not asked sameWay (E13)', (t) => {
  const { g, lock, G, yard } = yardOnPaper();
  const gate = { gate: G, side: 'south' as const, inner: { x: G.x, y: 63, z: G.z - 2 } };
  const way = yardWay(g, gate, lock.sOut, { yard });
  t.like(way, { ok: true, drop: 0 });
  if (!way.ok) return;
  t.deepEqual(way.cells[0], gate.inner);
  t.true(reachCells(withBlock(g, lock.sOut, 'fletching_table'), lock.sOut).some(c => key(c) === key(way.reach)));
  t.false(way.cells.some(c => key(c) === key(lock.p) || key(c) === key(lock.h)), 'P and H stay shut: no way through them');
  // the bank outside the gate is the game's (a drop of 3): from the gate's own lane sameWay says so; the yard's way does not ask it there
  t.deepEqual(sameWay(g, way.cells, { open: [G] }), { ok: true }, 'two inside, the bank is a third step off');
  const close = yardWay(g, { ...gate, inner: { x: G.x, y: 63, z: G.z - 1 } }, lock.sOut, { yard });
  t.like(close, { ok: true });
  if (close.ok) t.like(sameWay(g, close.cells, { open: [G] }), { ok: false, at: { z: G.z + 1 } });
  // a bench by the way refuses it; a lamp post does not
  const benched = yardOnPaper();
  benched.g.set(-555, 63, 2141, 'oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]');
  const b = yardWay(benched.g, gate, lock.sOut, { yard });
  t.true(!b.ok ? /oak_stairs/.test(b.text) : b.cells.every(c => Math.max(Math.abs(c.x + 555), Math.abs(c.z - 2141)) > 2));
  const lamp = yardOnPaper();
  lamp.g.set(-555, 63, 2141, FENCE);
  lamp.g.set(-555, 64, 2141, 'lantern[hanging=false,waterlogged=false]');
  t.like(yardWay(lamp.g, gate, lock.sOut, { yard }), { ok: true });
  // 5 off the portal's ring: a ring across the yard leaves no way
  const ringed = yardWay(g, gate, lock.sOut, { yard, ring: { x1: -572, z1: 2140, x2: -540, z2: 2142 } });
  t.like(ringed, { ok: false, why: 'zone' });
  t.regex((ringed as { text: string }).text, /5 off the portal's ring/);
});

test('the bot\'s scaffold in the yard is no floor to the lead rules, unless it is recorded; a yard spot goes on its lawn or walk', (t) => {
  const g = grid(['..........................', '..........................', '.........bbbbbb...........', '.........bbbbbb...........', '..........................']);
  const yard = { x1: 0, z1: 0, x2: 25, z2: 4, y: Y0 };
  t.like(stand(g, 10, 65, 2, 'lead', { yard }), { why: 'floor', what: 'cobblestone of the bot\'s scaffold' });
  t.is(why(stand(g, 10, 65, 2, 'game', { yard })), 'ok');
  t.is(why(stand(g, 10, 65, 2, 'lead', { yard: { ...yard, built: [{ x: 10, y: 64, z: 2 }] } })), 'ok', 'recorded: the bot\'s own build');
  t.is(why(stand(g, 10, 65, 2, 'lead')), 'ok', 'outside a yard it is ground like any');
  // a yard hop by the heap: the game climbs it, so no spot whose way passes within 2 of it
  t.regex((hopSpot(g, feet(1, 1), { x: 30, z: 1 }, { bot: feet(2, 3), yard, len: 16 }) as { why: string }).why, /scaffold/);
  // with room, the way keeps 3 off and the lure goes on the lawn
  const wide = grid(['..........................', '..........................', '..........................', '..........................',
    '..........................', '.........bbbbbb...........', '.........bbbbbb...........', '..........................']);
  const h = spotOf(hopSpot(wide, feet(1, 1), { x: 30, z: 1 }, { bot: feet(2, 3), yard: { ...yard, z2: 7 }, len: 16 }));
  t.is(wide.state(h.block.x, h.block.y - 1, h.block.z), 'grass_block[snowy=false]');
  t.true(h.path.every(c => c.y === Y0 + 1 && c.z <= 2), 'not over it, nor by it');
});

test('the west village as read (Nov 23): a lead way to L0 from every candidate, a first lure within 24 of one, and the first two hops toward the yard', (t) => {
  const f = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'west-village.json'), 'utf8')) as {
    ground: { y0: number; height: number; cols: Record<string, (string | null)[]> }; area: { x1: number; z1: number; x2: number; z2: number };
    lures: { l0: Pos }; look: { bells: Pos[]; beds: Pos[]; jobs: { name: string; at: Pos }[]; villagers: { position: Pos; profession: string }[] };
  };
  const g = Ground.fromDump(f.ground), L0 = f.lures.l0;
  // L0 as the lead set it down by hand on Nov 24 (E8: an adult 23 off and 6 up came in 13.3 s): a lure's cell by the rules
  t.like(stand(g, L0.x, L0.y, L0.z, 'lead'), { f: L0.y });
  t.is(g.state(L0.x, L0.y - 1, L0.z), 'grass_block[snowy=false]');
  const lure = withBlock(g, L0, 'fletching_table'), reach = reachCells(lure, L0);
  t.true(reach.length >= 4);
  const candidates = f.look.villagers.filter(v => v.profession === 'none').map(v => v.position);
  t.is(candidates.length, 4);
  for (const c of candidates) t.like(pathFor(lure, c, reach, 'lead', { limits: false }), { ok: true }, JSON.stringify(c));
  // the first lure by the model: within 24 lead cells of a candidate, 3 off the village's beds, bell and job sites
  const marks = [...f.look.beds, ...f.look.bells, ...f.look.jobs.map(j => j.at)];
  const first = firstSpot(g, candidates, { x: -640, z: 2240 }, { bot: { x: -665, y: 70, z: 2245 }, home: f.area, marks, retrace: true });
  t.false('why' in first, 'why' in first ? first.why : '');
  if (!('why' in first)) {
    t.true(first.path.length - 1 <= FIRST_PATH);
    t.true(marks.every(m => Math.max(Math.abs(m.x - first.block.x), Math.abs(m.y - first.block.y), Math.abs(m.z - first.block.z)) > 3));
    t.is(g.state(first.block.x, first.block.y - 1, first.block.z), 'grass_block[snowy=false]');
  }
  // the first two hops from L0 toward the yard's west gate: about 22 on each, a lead way, the game's way beside it the same
  const toward = { x: -567, z: 2183 };
  let ward: Pos = reach.find(c => c.x === L0.x + 1 && c.y === L0.y)!, bot: Pos = { x: L0.x + 2, y: L0.y, z: L0.z + 2 };
  const used = [{ at: L0, t: 0 }];
  for (const n of [1, 2]) {
    const h = spotOf(hopSpot(g, ward, toward, { bot, retrace: true, used, now: 60_000 }));
    const on = Math.hypot(ward.x - toward.x, ward.z - toward.z) - Math.hypot(h.block.x - toward.x, h.block.z - toward.z);
    t.true(straightOf(h.block, ward) <= HOP_MAX && on >= HOP_MIN && on > 15, `hop ${n}: ${JSON.stringify(h.block)}, ${on.toFixed(1)} on`);
    t.true(h.path.length - 1 <= HOP_PATH);
    t.true(h.drop <= RETRACE_DROP, `hop ${n}: a way it walks back`);
    t.deepEqual(sameWay(g, h.path), { ok: true });
    t.is(trapNear(withBlock(g, h.block, 'fletching_table'), h.block), undefined);
    t.true(seesFace(withBlock(g, h.block, 'fletching_table'), h.botStand, h.block));
    used.push({ at: h.block, t: 0 });
    ward = h.reach;
    bot = h.botStand;
  }
  t.true(ward.x > -650, `two hops took it from x ${L0.x} to ${ward.x}`);
});
