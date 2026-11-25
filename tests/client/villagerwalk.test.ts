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
  sight, spanOf, withBlock, type Blocks, type LockPlan, type Placed, type RingPlan
} from '../../src/client/brain/villagerwalk.js';

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
