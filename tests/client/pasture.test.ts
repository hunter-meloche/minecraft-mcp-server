import test from 'ava';
import fs from 'fs';
import path from 'path';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import { Ground } from '../../src/client/brain/boatroute.js';
import { hallLock } from '../../src/client/brain/blueprints.js';
import { lockOf, lockReady, ringReady, seesFace } from '../../src/client/brain/villagerwalk.js';
import {
  ACTIVATABLE, ADOPT, CLEAR, CLICK_REACH, CLIENT_BACK_TICKS, EYE, GAME, GateHolds, H, HALL, HOME, HOSTILE, Killed, LEAK_R, P, PORTAL, PROFESSION_OF, Pasture, REACH, SMITHING, T0, TICK_MS,
  YARD, YARD_GATES, dumpBase, fmt, idOf, isOpen, key, shapeOf, villagerSchedule, yard, type Entry, type Villager
} from '../helpers/pasture.js';

// The pasture (tests/helpers/pasture.ts): the fake world the villager fetch is tested against, held to the game and the
// bridge here, before anything is tested ON it. The lock scenarios that failed live failed on what the bridge reaches
// and sees (the socket's one open face has the sill's rail before it; a gate opened from the post is nobody's), so the
// fake's rules are ports of the Java's own lines, and each port is pinned to those lines as rails-bridge.test.ts pins
// Rails.java: a line changed in the jar and not here fails this file, not a trip. Then the world itself: the yard as
// the design draws it, a careful walk that can fail, time that every call moves, the log with brain.json as saved, the
// protection store apart, a kill with the client or without, and the villager that leaves by any open way.

const mod = path.join(process.cwd(), 'client-mod', 'src', 'claudebridge');
const read = (f: string): string => fs.readFileSync(path.join(mod, f), 'utf8');
const body = (java: string, call: string): string => {
  const at = java.indexOf(`s.register("${call}"`);
  const next = java.indexOf('s.register("', at + 10);
  return at < 0 ? '' : java.slice(at, next < 0 ? undefined : next);
};
const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
type Any = Record<string, unknown>;
const call = <T = Any>(p: Pasture, m: string, params: Any = {}) => p.ctx.call<T>(m, params);
/** The lock's cells as the yard's zones hold them. */
const lock = (p: Pasture) => lockOf(p.world)!;
const blocks = (p: Pasture) => ({ state: (x: number, y: number, z: number) => p.get({ x, y, z }) });
/** The strict set as the brain sends it at a start: the yard's gates, P and H; the pair; the guard on P's box. */
const strict = (p: Pasture) => call(p, 'gates.strict', { gates: [...Object.values(YARD_GATES), P, H], pairs: [[P, H]], guard: [{ gate: P, box: lock(p).box }] });
const fletcher = (p: Pasture, where: Pos, over: Any = {}) => p.villager({ at: where, profession: 'fletcher', level: 4, health: 17, ...over });
const INSIDE = at(-556, 63, 2130);

// ------------------------------------------------------------------------------------------------ the yard

test('the yard: the hall, the lock as the design\'s table puts it, the ringed portal, the pens, the workshop, and the crossings', (t) => {
  const p = yard();
  const z = p.world.zones!;
  // the hall as live, its gate south
  t.deepEqual(z.hall, [HALL]);
  t.deepEqual(z['hall:gate'], [H]);
  t.deepEqual(z['hall:fletching'], [at(-552, 63, 2127)]);
  t.regex(p.get(H), /^oak_fence_gate\[facing=south,in_wall=false,open=false,powered=false\]$/);
  t.is(p.get(at(H.x, H.y + 1, H.z)), 'air', 'the cell over the gate open');
  // the lock (4.8), here H = (-556, 63, 2134): P three out, the socket in the east wall, the sill, the post, S_out
  const l = lock(p);
  t.deepEqual([l.p, l.h, l.socket, l.sill, l.post, l.sOut], [P, H, at(-554, 63, 2135), at(-553, 63, 2135), at(-553, 63, 2136), at(-554, 63, 2139)]);
  t.deepEqual(l.box, { x1: -557, y1: 63, z1: 2135, x2: -555, y2: 64, z2: 2136 });
  t.is(idOf(p.get(l.socket)), 'oak_planks');
  t.is(idOf(p.get(l.sill)), 'rail');
  t.is(idOf(p.get(at(-557, 64, 2135))), 'wall_torch');
  for (let x = -558; x <= -554; x++) for (let zz = 2135; zz <= 2137; zz++) t.is(p.get(at(x, 65, zz)), 'oak_planks', 'roofed');
  t.deepEqual(z.lock, [{ x: -559, y: 62, z: 2134, width: 7, length: 5 }], 'the footprint grown by 1');
  // what the home side's own readers say of it: the lock and the ring stand ready as built
  t.deepEqual(lockReady(p.world, blocks(p)), []);
  t.deepEqual(ringReady(p.world, blocks(p)), []);
  // the portal lit, the ring on the cells just outside its ground: x -564..-555, z 2145..2149, the gate toward home
  t.deepEqual(z.portal, [PORTAL]);
  for (const x of [-560, -559]) for (const y of [64, 65, 66]) t.is(p.get(at(x, y, 2147)), 'nether_portal[axis=x]');
  t.deepEqual(z.ring, [{ x: -564, y: 62, z: 2145, width: 10, length: 5 }]);
  t.deepEqual(z['ring:gate'], [at(-563, 63, 2149)], 'three along from the frame\'s inside, not in line with it');
  t.is(idOf(p.get(at(-564, 63, 2147))), 'oak_fence');
  // the yard's gates, the pens' and the workshop's smithing table where the live ones are
  t.deepEqual(z['fence:gate'], Object.values(YARD_GATES));
  t.deepEqual([z['pen:cow:gate'], z['pen:sheep:gate'], z['workshop:smithing']], [[at(-555, 63, 2171)], [at(-539, 63, 2196)], [SMITHING]]);
  t.is(p.get(SMITHING), 'smithing_table');
  t.deepEqual(p.animals.map(a => a.name), ['cow', 'cow', 'sheep', 'sheep']);
  // every build is the bot's own on both lists; the scaffold of the crossings is on neither (Baritone's is unrecorded)
  for (const c of [l.socket, l.sill, P, H, SMITHING, YARD_GATES.south]) t.true(p.protection.has(key(c)) && p.told.has(key(c)), key(c));
  t.is(p.get(at(-561, 66, 2183)), 'cobblestone', 'the staircase by the west gate, its top step');
  t.is(p.get(at(-545, 65, 2119)), 'cobblestone', 'the heap over the north fence');
  t.false(p.protection.has('-545,65,2119'));
  // a villager's way over the fence by the heap: the yard is no pen (the fake keeps the fault the design answers)
  t.truthy(p.villagerWay(at(-545, 63, 2125), c => c.z === 2114), 'out over the heap');
  t.falsy(yard({ crossings: false }).villagerWay(at(-545, 63, 2125), c => c.z === 2114));
  // not built yet, or the other way round
  const bare = yard({ lock: false, ring: false });
  t.is(lockOf(bare.world), undefined);
  t.is(bare.get(P), 'air');
  t.false('ring' in bare.world.zones! || 'lock' in bare.world.zones!);
  const m = lockOf(yard({ lock: 'mirror' }).world)!;
  t.deepEqual([m.socket, m.sill, m.post, m.sOut], [at(-558, 63, 2135), at(-559, 63, 2135), at(-559, 63, 2136), at(-558, 63, 2139)]);
  // one source of the geometry: the blueprint's landmarks, P's place the design's
  t.deepEqual(hallLock().landmarks.find(k => k.kind === 'gate')!.at, { x: 2, y: 1, z: 2 });
  t.deepEqual(JSON.parse(p.saved), p.world, 'brain.json starts as the world is');
});

test('from the post the numbers are the design\'s: the socket\'s face 1.6, P 3.35, H 3.78, S_out 3.2 (all inside 4.4)', (t) => {
  const p = yard();
  const l = lock(p), eye = p.eye(l.post);
  const to = (c: Pos) => Math.hypot(c.x + 0.5 - eye.x, c.y + 0.5 - eye.y, c.z + 0.5 - eye.z);
  t.is(EYE, 1.62);
  t.is(Math.round(to(P) * 100) / 100, 3.35);
  t.is(Math.round(to(H) * 100) / 100, 3.78);
  t.is(Math.round(p.digSight(l.socket, l.post)!.dist * 10) / 10, 1.6);
  p.set(l.sOut, 'fletching_table');
  t.is(Math.round(p.digSight(l.sOut, l.post)!.dist * 10) / 10, 3.2);
  t.true(to(P) < REACH && to(H) < REACH);
});

// ------------------------------------------------------------------------------------------------ the ports, pinned to the Java

test('place is Interact.java\'s aimPlace: its lines, then the same rules in the fake', async (t) => {
  const java = read('Interact.java');
  const aim = java.slice(java.indexOf('static Aim aimPlace('), java.indexOf('static boolean replaceable('));
  t.regex(aim, /if \(!replaceable\(mc\.level\.getBlockState\(target\)\)\) return Aim\.no\("occupied by " \+ Names\.block\(mc\.level\.getBlockState\(target\)\)\);/);
  t.regex(aim, /if \(pl\.blockPosition\(\)\.equals\(target\) \|\| pl\.blockPosition\(\)\.above\(\)\.equals\(target\)\) return Aim\.no\("the bot is standing there"\);/);
  t.regex(aim, /List\.of\(Direction\.DOWN, Direction\.NORTH, Direction\.SOUTH, Direction\.EAST, Direction\.WEST, Direction\.UP\)/);
  t.regex(aim, /order\.remove\(Direction\.byName\(preferred\)\); order\.addFirst\(Direction\.byName\(preferred\)\);/);
  t.regex(aim, /if \(replaceable\(rs\) \|\| ACTIVATABLE\.matcher\(Names\.block\(rs\)\)\.matches\(\)\) continue;/);
  t.regex(aim, /Vec3 hit = faceCenter\(ref, face\)\.add\(0, face\.getAxis\(\)\.isHorizontal\(\) \? \(top \? 0\.25 : -0\.25\) : 0, 0\);/);
  // the first reference that will do is judged alone, from the eye to the point clicked, and no ray is cast
  t.regex(aim, /double d = pl\.getEyePosition\(\)\.distanceTo\(hit\);\s+if \(d > 4\.5\) return Aim\.no\("too far", d\);/);
  t.notRegex(aim, /\.clip\(/);
  t.regex(aim, /"nothing solid next to it to place against"/);
  t.regex(java, /static boolean replaceable\(BlockState s\) \{\s+return s\.isAir\(\) \|\| s\.canBeReplaced\(\);/);
  t.regex(body(java, 'place'), /c\.ok\(obj\("placed", !replaceable\(now\), "block", Names\.block\(now\), "face", aim\.face\)\);/);
  t.regex(body(java, 'place'), /return obj\("placed", false, "reason", aim\.reason, "distance", aim\.distance >= 0 \? round\(aim\.distance\) : null\);/);
  // the list of what a click uses, to the letter
  const pattern = [.../"([^"]+)"/g[Symbol.matchAll](java.slice(java.indexOf('static final Pattern ACTIVATABLE'), java.indexOf('static LocalPlayer player()')))].map(m => m[1]).join('');
  t.is(ACTIVATABLE.source, pattern);
  t.is(CLICK_REACH, 4.5);

  const p = yard({ at: at(-549, 63, 2160) });
  const target = at(-549, 63, 2162);
  // the ground first; the asked face first when it will do
  t.like(p.aim(target), { face: 'down', ref: at(-549, 62, 2162), hit: { x: -548.5, y: 63, z: 2162.5 } });
  p.set(at(-549, 63, 2163), 'cobblestone');
  t.like(p.aim(target, 'south'), { face: 'south', hit: { x: -548.5, y: 63.25, z: 2163 } }, 'a side face is clicked a quarter low');
  t.like(p.aim(target, 'north'), { face: 'down' }, 'air on the asked side: on down the order');
  // nothing to place against; a block a click uses is none; the target taken; the bot's own cells
  t.deepEqual(p.aim(at(-549, 66, 2162)), { reason: 'nothing solid next to it to place against' });
  p.set(at(-549, 65, 2161), 'fletching_table');
  t.deepEqual(p.aim(at(-549, 66, 2161)), { reason: 'nothing solid next to it to place against' }, 'nothing is placed against a fletching table');
  t.deepEqual(p.aim(at(-549, 63, 2163)), { reason: 'occupied by cobblestone' });
  t.deepEqual(p.aim(at(-549, 63, 2160)), { reason: 'the bot is standing there' });
  t.deepEqual(p.aim(at(-549, 64, 2160)), { reason: 'the bot is standing there' });
  t.like(p.aim(at(-549, 63, 2161), undefined), { face: 'down' }, 'short grass or air: replaceable');
  // too far is said of the first reference alone: 4.5 from the eye to the hit
  t.like(p.aim(at(-549, 63, 2164)), { face: 'down' });
  t.like(p.aim(at(-549, 63, 2165)), { reason: 'too far' });
  t.true((p.aim(at(-549, 63, 2165)) as { distance: number }).distance > 4.5);

  // the call: the held item goes down, in five ticks; nothing placeable held, or someone in the cell: the server takes no click
  await call(p, 'item.select', { name: 'fletching_table' });
  const before = p.tick;
  t.deepEqual(await call(p, 'place', { ...target, face: 'down' }), { placed: true, block: 'fletching_table', face: 'down' });
  t.is(p.tick - before, 5);
  t.is(p.count('fletching_table'), 3);
  t.deepEqual(await call(p, 'place', { ...target }), { placed: false, reason: 'occupied by fletching_table', distance: null });
  await call(p, 'item.select', { name: 'bread' });
  t.like(await call(p, 'place', { x: -550, y: 63, z: 2161 }), { placed: false, block: 'air' });
  await call(p, 'item.select', { name: 'oak_planks' });
  p.animal('cow', at(-550, 63, 2161));
  t.like(await call(p, 'place', { x: -550, y: 63, z: 2161 }), { placed: false, block: 'air' }, 'a cow in the cell: no block');
  // (a rail goes down under a standing mob, as seen live)
  await call(p, 'item.select', { name: 'rail' });
  t.like(await call(p, 'place', { x: -550, y: 63, z: 2161 }), { placed: true, block: 'rail' });
  await t.throwsAsync(() => call(p, 'item.select', { name: 'lectern' }), { message: 'no lectern in inventory' });
});

test('the fake\'s dig.here refuses a face behind a full cube and sees one over a rail: Interact.java\'s lines as bridge change B6 leaves them, the OUTLINE clip the judge', async (t) => {
  const dig = body(read('Interact.java'), 'dig.here');
  t.regex(dig, /if \(before\.isAir\(\)\) return obj\("dug", false, "reason", "air"\);/);
  t.regex(dig, /if \(Foreign\.guarded\(target, before\) && !flag\(p, "force"\)\) return obj\("dug", false, "reason", "someone else's build \(force: true to dig it anyway\)", "block", Names\.block\(before\)\);/);
  t.regex(dig, /double reach = pl\.blockInteractionRange\(\);/);
  t.regex(dig, /for \(Direction d : Direction\.values\(\)\) \{/);
  // B6: no longer "the neighbour is not replaceable" (a rail before the socket's one open face hid it)
  t.regex(dig, /if \(mc\.level\.getBlockState\(target\.relative\(d\)\)\.isCollisionShapeFullBlock\(mc\.level, target\.relative\(d\)\)\) continue; \/\/ covered: not seen/);
  t.notRegex(dig, /if \(!replaceable\(mc\.level\.getBlockState\(target\.relative\(d\)\)\)\) continue;/);
  t.regex(dig, /Vec3 fc = Vec3\.atCenterOf\(target\)\.add\(d\.getUnitVec3\(\)\.scale\(0\.49\)\);\s+if \(fc\.distanceTo\(eye\) > reach - 0\.1\) continue;/);
  t.regex(dig, /mc\.level\.clip\(new net\.minecraft\.world\.level\.ClipContext\(eye, fc, net\.minecraft\.world\.level\.ClipContext\.Block\.OUTLINE,/);
  t.regex(dig, /if \(hit\.getType\(\) != net\.minecraft\.world\.phys\.HitResult\.Type\.BLOCK \|\| !hit\.getBlockPos\(\)\.equals\(target\)\) continue;/);
  t.regex(dig, /if \(aim == null \|\| fc\.distanceTo\(eye\) < aim\.distanceTo\(eye\)\) \{ face = d; aim = fc; \}/);
  t.regex(dig, /if \(face == null && !before\.isCollisionShapeFullBlock\(mc\.level, target\)\) \{/);
  t.regex(dig, /if \(face == null\) return obj\("dug", false, "reason", "out of reach or out of sight", "block", Names\.block\(before\)\);/);
  // no walk and no Baritone in it: the bot digs from where it stands
  t.notRegex(dig, /getBuilderProcess|setGoalAndPath/);
  t.is(REACH, 4.4);

  const p = yard();
  const l = lock(p);
  p.bot.at = { ...l.post };
  // E29: from the post the socket's one open face (east) has the sill's rail before it: seen, 1.6 off
  t.like(p.digSight(l.socket), { face: 'east' });
  // ... and what the jar did before B6 is what a full cube there still does: covered
  p.set(l.sill, 'cobblestone');
  t.is(p.digSight(l.socket), undefined);
  t.deepEqual(await call(p, 'dig.here', { ...l.socket }), { dug: false, reason: 'out of reach or out of sight', block: 'oak_planks' });
  p.set(l.sill, 'rail');
  // a torch before a face hides nothing either: no cover, and the ray passes it by. A flower there is no cover, but it
  // stands in the ray (the fake takes a plant at the cell's whole width, as the game moves one about its cell): the
  // clip is the judge, and the planner's port says the same
  p.set(l.sill, 'torch');
  t.like(p.digSight(l.socket), { face: 'east' });
  t.true(seesFace(blocks(p), l.post, l.socket));
  p.set(l.sill, 'poppy');
  t.is(p.digSight(l.socket), undefined);
  t.false(seesFace(blocks(p), l.post, l.socket));
  p.set(l.sill, 'rail');
  t.true(shapeOf(p.get(at(l.socket.x, l.socket.y + 1, l.socket.z))).full);
  // S_out's east face is in sight, 3.2 from the eye; one cell nearer P's lane the ray passes through the lock's corner (decision 17)
  p.set(l.sOut, 'fletching_table');
  p.set(at(l.sOut.x - 1, l.sOut.y, l.sOut.z), 'fletching_table');
  t.like(p.digSight(l.sOut), { face: 'east' });
  t.is(p.digSight(at(l.sOut.x - 1, l.sOut.y, l.sOut.z)), undefined);
  // the fake's port and the planner's (villagerwalk.ts seesFace) say the same of every block round the lock from the post
  for (let x = -560; x <= -550; x++) for (let z = 2133; z <= 2141; z++) for (const y of [63, 64]) {
    const c = at(x, y, z);
    if (shapeOf(p.get(c)).full) t.is(!!p.digSight(c), seesFace(blocks(p), l.post, c), `${key(c)} ${p.get(c)}`);
  }
  // 4.4 from the eye to the face's middle: a block four out on the level is in reach, five out is not
  p.bot.at = at(-549, 63, 2160);
  p.set(at(-545, 63, 2160), 'cobblestone');
  p.set(at(-549, 63, 2165), 'cobblestone');
  t.truthy(p.digSight(at(-545, 63, 2160)));
  t.is(p.digSight(at(-549, 63, 2165)), undefined);
  // a small block has no face a ray to its middle hits: the middle of its own outline (the floor torch by P's lane)
  p.set(at(l.sOut.x - 1, l.sOut.y, l.sOut.z), 'air');
  p.bot.at = at(-555, 63, 2140);
  t.like(p.digSight(at(-555, 63, 2138)), { face: 'up' });
  // the call: the block gone, its drop lying in the cell, picked up half a second on by a bot that stands by it
  p.bot.at = at(-549, 63, 2160);
  t.deepEqual(await call(p, 'dig.here', { x: -549, y: 63, z: 2161 }), { dug: false, reason: 'air' });
  const dug = await call(p, 'dig.here', { x: -545, y: 63, z: 2160 });
  t.deepEqual(dug, { dug: true, block: 'cobblestone', tool: null });
  t.is(p.get(at(-545, 63, 2160)), 'air');
  t.like(p.drops[0], { item: 'cobblestone', position: { x: -544.5, y: 63, z: 2160.5 } });
  p.advance(40);
  t.is(p.drops.length, 1, 'four off: it lies there');
  t.like(await call(p, 'goto', { x: -546, y: 63, z: 2160, range: 0, careful: true }), { arrived: true });
  p.advance(10);
  t.is(p.drops.length, 0);
  t.is(p.count('cobblestone'), 1);
});

test('the fake\'s outlines are no smaller than the game\'s: a plant the cell\'s width at its own height, a double plant or a grown crop its whole cell, an open gate the bar it is shut', (t) => {
  // the clip is ported, and it is only as honest as the shapes it runs on: a kinder outline sees the lure through a
  // plant the bridge's clip stops on. The game's own (26.3 jar, javap): TallGrassBlock and DryVegetationBlock
  // column(12, 0, 13), FlowerBlock column(6, 0, 10) and SaplingBlock column(12, 0, 12), each moved about its cell by
  // its position; MushroomBlock column(6, 0, 6); BaseTorchBlock column(4, 0, 10); DoublePlantBlock no shape of its
  // own (a whole cube); CropBlock the cell's width, 16 high full grown; SugarCaneBlock column(12, 0, 16);
  // SnowLayerBlock two sixteenths a layer; and FenceGateBlock.getShape reads the facing's axis and in_wall, never OPEN
  const box = (state: string) => shapeOf(state).outline.map(b => b.map(n => Math.round(n * 16)));
  const CELL = [[0, 0, 0, 16, 16, 16]];
  t.deepEqual(box('short_grass'), [[0, 0, 0, 16, 13, 16]]);
  t.deepEqual(box('fern'), [[0, 0, 0, 16, 13, 16]]);
  t.deepEqual(box('dead_bush'), [[0, 0, 0, 16, 13, 16]]);
  t.deepEqual(box('poppy'), [[0, 0, 0, 16, 10, 16]]);
  t.deepEqual(box('brown_mushroom'), [[0, 0, 0, 16, 6, 16]]);
  t.deepEqual(box('oak_sapling[stage=0]'), [[0, 0, 0, 16, 12, 16]]);
  t.deepEqual(box('torch'), [[6, 0, 6, 10, 10, 10]]);
  t.deepEqual(shapeOf('wall_torch[facing=north]').outline.map(b => b.map(n => n * 16)), [[5.5, 3, 11, 10.5, 13, 16]]);
  t.deepEqual(shapeOf('wall_torch[facing=east]').outline.map(b => b.map(n => n * 16)), [[0, 3, 5.5, 5, 13, 10.5]]);
  t.deepEqual([box('rail[shape=north_south,waterlogged=false]')[0][4], box('rail[shape=ascending_east,waterlogged=false]')[0][4]], [2, 8]);
  for (const whole of ['tall_grass[half=lower]', 'large_fern[half=upper]', 'sunflower[half=lower]', 'lilac[half=lower]', 'peony[half=upper]', 'rose_bush[half=lower]', 'wheat[age=7]', 'carrots[age=3]',
    'sugar_cane[age=0]', 'vine[north=true]', 'seagrass']) t.deepEqual(box(whole), CELL, whole);
  t.deepEqual([1, 3, 8].map(n => box(`snow[layers=${n}]`)[0][4]), [2, 6, 16]);
  t.deepEqual(box('fire[age=0]'), [[0, 0, 0, 16, 1, 16]]);
  // what a block is put into as into air is another matter (the game's canBeReplaced): the grasses, a vine, fire,
  // snow one layer deep; never a flower, a sapling, a crop, or snow lying deeper
  t.deepEqual(['short_grass', 'tall_grass[half=lower]', 'fern', 'vine[north=true]', 'fire[age=0]', 'snow[layers=1]', 'snow', 'water[level=0]'].filter(b => !shapeOf(b).soft), []);
  t.deepEqual(['poppy', 'oak_sapling[stage=0]', 'sunflower[half=lower]', 'wheat[age=7]', 'brown_mushroom', 'snow[layers=2]', 'torch', 'rail'].filter(b => shapeOf(b).soft), []);
  // a gate: a way through for whoever walks when it is open, and to a ray the same bar open or shut
  const shut = 'oak_fence_gate[facing=south,in_wall=false,open=false,powered=false]', open = shut.replace('open=false', 'open=true');
  t.deepEqual(box(shut), [[0, 0, 6, 16, 16, 10]]);
  t.deepEqual(box(open), box(shut));
  t.deepEqual(box(open.replace('facing=south', 'facing=east')), [[6, 0, 0, 10, 16, 16]]);
  t.deepEqual(box(open.replace('in_wall=false', 'in_wall=true')), [[0, 0, 6, 16, 13, 10]]);
  t.deepEqual([shapeOf(shut).solid, shapeOf(open).solid], [true, false]);

  // one thing in the ray's cell: a block three south of the bot with only its north face open, and something in the
  // cell before that face. The ray comes down through that cell from 0.95 to 0.5 of its height
  const through = (state: string) => {
    const p = new Pasture({ at: at(0, 63, 0) });
    const target = at(0, 63, 3);
    p.set(target, 'fletching_table');
    for (const c of [at(0, 64, 3), at(1, 63, 3), at(-1, 63, 3), at(0, 63, 4)]) p.set(c, 'stone');
    p.set(at(0, 63, 2), state);
    return [!!p.digSight(target), seesFace(blocks(p), at(0, 63, 0), target)];
  };
  for (const clear of ['air', 'torch', 'snow[layers=1]', 'rail[shape=north_south,waterlogged=false]']) t.deepEqual(through(clear), [true, true], clear);
  // (seen past each of these by the fake as it was: 0.2 wide stalks, a 0.75 tuft, two posts for an open gate)
  for (const inTheWay of ['oak_sapling[stage=0]', 'sunflower[half=lower]', 'rose_bush[half=lower]', 'wheat[age=7]', 'sugar_cane[age=0]', 'poppy', 'short_grass', 'tall_grass[half=lower]',
    'snow[layers=6]', open, shut]) t.deepEqual(through(inTheWay), [false, false], inTheWay);
  // a mushroom is six sixteenths high and the ray passes over it: seen, as in the game. The planner's own port takes
  // every small plant 13 high and says no: its margin is the planner's, the fake's shapes are the game's
  t.deepEqual(through('brown_mushroom'), [true, false]);

  // and round the lock from the post, with targets set about it, plants grown up before them and P left open: the
  // fake's dig.here and the planner's port say the same of every block (a face the fake saw and the planner did not
  // would be a kinder fake, or a difference to name as the mushroom's is)
  const p = yard();
  const l = lock(p);
  p.bot.at = { ...l.post };
  p.set(l.sOut, 'fletching_table');
  const targets = [at(-551, 63, 2136), at(-553, 63, 2139), at(-551, 63, 2138), at(-550, 63, 2135), at(-550, 63, 2137), at(-553, 63, 2140), at(-551, 63, 2140)];
  for (const c of targets) p.set(c, 'cobblestone');
  const sees = () => {
    const seen: string[] = [];
    for (let x = -560; x <= -548; x++) for (let z = 2133; z <= 2142; z++) for (const y of [63, 64, 65]) {
      const c = at(x, y, z);
      if (!shapeOf(p.get(c)).full) continue;
      t.is(!!p.digSight(c), seesFace(blocks(p), l.post, c), `${key(c)} ${p.get(c)}`);
      if (p.digSight(c)) seen.push(key(c));
    }
    return seen;
  };
  const bare = sees();
  for (const c of [...targets, l.sOut, l.socket]) t.true(bare.includes(key(c)), key(c));
  const plants: [Pos, string][] = [
    [at(-552, 63, 2136), 'oak_sapling[stage=0]'], [at(-553, 63, 2138), 'poppy'], [at(-552, 63, 2137), 'sunflower[half=lower]'], [at(-552, 64, 2137), 'sunflower[half=upper]'],
    [at(-551, 63, 2135), 'wheat[age=7]'], [at(-551, 63, 2137), 'rose_bush[half=lower]'], [at(-551, 64, 2137), 'rose_bush[half=upper]'], [at(-553, 63, 2137), 'short_grass'],
    [at(-554, 63, 2140), 'brown_mushroom'], [at(-552, 63, 2139), 'fern'], [at(-552, 63, 2138), 'snow[layers=3]'], [at(-554, 63, 2138), 'dandelion'], [at(-552, 63, 2135), 'sugar_cane[age=0]']
  ];
  for (const [c, state] of plants) p.set(c, state);
  p.swing(P, true, 'a player');
  const grown = sees();
  t.true(grown.length < bare.length, `${bare.length} seen bare, ${grown.length} with the plants up`);
  // (the sunflower and the rose bush stand before the blocks south-east of the post, the fern before the one beyond
  // them, the tuft of grass before the lock's own corner; the block east of the post is still seen, by its top over
  // the sapling)
  for (const c of [at(-551, 63, 2138), at(-550, 63, 2137), at(-551, 63, 2140), at(-554, 63, 2137)]) t.false(grown.includes(key(c)), key(c));
  t.true(grown.includes(key(at(-551, 63, 2136))));
});

test('dig.here in someone\'s build takes only what the client mod\'s list holds; place there works (the lure in the village, live)', async (t) => {
  t.regex(read('Foreign.java'), /if \(Protection\.isOwn\(p\) \|\| Guardian\.WALL\.contains\(p\)\) return false;/);
  const p = new Pasture({ at: at(0, 63, 0) });
  p.zones.push({ x1: -8, y1: 60, z1: -8, x2: 8, y2: 80, z2: 8 });
  const cell = at(1, 63, 1);
  await call(p, 'item.select', { name: 'fletching_table' });
  t.like(await call(p, 'place', { ...cell }), { placed: true });
  t.like(await call(p, 'dig.here', { ...cell }), { dug: false, reason: 'someone else\'s build (force: true to dig it anyway)' });
  // own.put tells the mod before the block goes down: its own lure is its own to take, and nothing else there is
  t.like(await p.ctx.own!.take(cell, 'fletching_table', { adopt: true }), { ok: true, dug: true });
  t.like(await p.ctx.own!.put(cell, 'fletching_table'), { ok: true, placed: true });
  t.true(p.told.has(key(cell)));
  t.like(await call(p, 'dig.here', { x: 1, y: 62, z: 2 }), { dug: false, block: 'grass_block' });
  t.like(await p.ctx.own!.take(cell, 'fletching_table'), { ok: true, dug: true, pickedUp: true });
  t.false(p.protection.has(key(cell)) || p.told.has(key(cell)));
});

test('useOn: 4.5 from the eye to the face\'s middle and no sight asked; a gate is only ever toggled, as it stands when the click lands', async (t) => {
  const use = body(read('Interact.java'), 'useOn');
  t.regex(use, /Direction face = Direction\.byName\(strParam\(p, "face", "up"\)\);/);
  t.regex(use, /Vec3 hit = faceCenter\(at, face\);/);
  t.regex(use, /if \(pl\.getEyePosition\(\)\.distanceTo\(hit\) > 4\.5\) return obj\("used", false, "reason", "too far", "distance", round\(pl\.getEyePosition\(\)\.distanceTo\(hit\)\), "held", Names\.item\(pl\.getMainHandItem\(\)\)\);/);
  // no ray is cast before the click (only a bucket's own aim clips, after it)
  t.false(use.slice(0, use.indexOf('"too far"')).includes('.clip('));
  t.regex(use, /kind instanceof net\.minecraft\.world\.level\.block\.TrapDoorBlock \|\| kind instanceof net\.minecraft\.world\.level\.block\.FenceGateBlock/);
  t.regex(use, /JsonObject r = obj\("used", true, "before", before, "after", Names\.block\(now\), "changed", !now\.equals\(beforeState\), "properties", props, "held", held,/);

  const p = yard();
  const l = lock(p);
  p.bot.at = { ...l.post };
  // from the post P and H are both in a click's reach, H behind the lock's own walls
  const r = await call(p, 'useOn', { ...P });
  t.like(r, { used: true, before: 'oak_fence_gate', after: 'oak_fence_gate', changed: true, properties: { open: 'true', facing: 'south' }, answered: true });
  t.true(isOpen(p.get(P)));
  t.like(await call(p, 'useOn', { ...P }), { changed: true, properties: { open: 'false' } });
  t.like(await call(p, 'useOn', { ...H }), { used: true, changed: true, properties: { open: 'true' } });
  await call(p, 'useOn', { ...H });
  // a block a click does nothing to: used, nothing changed
  t.like(await call(p, 'useOn', { ...l.socket, face: 'east' }), { used: true, changed: false, result: 'Pass' });
  // five off: too far, nothing clicked
  p.bot.at = at(-556, 63, 2142);
  t.like(await call(p, 'useOn', { ...P }), { used: false, reason: 'too far', held: 'air' });
  t.false(isOpen(p.get(P)));

  // the block is read at the call, the click goes out two ticks on, and the game toggles the gate as it stands THEN.
  // One read open that the closer (the pair, the guard, a hold's end, a player) shut in between is opened again by
  // the click, and the answer says nothing changed: the blind toggle a shut that reads back is for
  t.regex(use, /final net\.minecraft\.world\.level\.block\.state\.BlockState beforeState = mc\.level\.getBlockState\(at\);/);
  t.regex(use, /if \(age < 2 \|\| \(isBucket && steady < 3 && age < 20\)\) return false;\s+use\(m, isBucket\);/);
  t.regex(use, /if \(age - usedAt < 3\) return false; \/\/ never sooner than it always replied/);
  const S = YARD_GATES.south;
  const q = yard({ at: at(S.x, 63, S.z - 3) });
  // out by the south gate with a bite in the mouth: the closer waits for the item, the gate stands open behind the bot
  q.bot.using = true;
  t.like(await call(q, 'goto', { x: S.x, y: 63, z: S.z + 3, range: 0, careful: true }), { arrived: true });
  t.true(isOpen(q.get(S)));
  t.deepEqual(q.adopted(), [S]);
  // a shut asked for now reads it open and clicks; the bite ends as the call is on its way and the closer's click is first
  q.at(q.tick + 2, () => { q.bot.using = false; });
  const began = q.tick;
  const blind = await call(q, 'useOn', { ...S });
  t.like(blind, { used: true, changed: false, result: 'Pass', properties: { open: 'true' } });
  t.is(q.tick - began, 1 + 2 + 3, 'a tick for the call, two to the click, three to the answer');
  const made = q.changed.filter(c => key(c.at) === key(S));
  t.deepEqual(made.map(c => c.how), ['the bot\'s walk', 'shut (closer)', 'useOn']);
  t.is(made[2].t - made[1].t, 1, 'shut by the closer the tick before the click landed');
  // open again, three off (over 2.5: nobody's), and it stands so until somebody reads it
  q.advance(400);
  t.true(isOpen(q.get(S)));
  t.deepEqual(q.adopted(), []);
  t.like(await call(q, 'useOn', { ...S }), { changed: true, properties: { open: 'false' } });
  // (a click on what was read shut, that something else opened in between, shuts it: the same toggle)
  q.at(q.tick + 2, () => q.swing(S, true, 'a player'));
  t.like(await call(q, 'useOn', { ...S }), { changed: false, properties: { open: 'false' } });
});

test('world.entities says every entity\'s uuid, and a sleeper only when it sleeps (B1); status and the pockets as the bridge gives them', async (t) => {
  const list = body(read('Handlers.java'), 'world.entities');
  t.regex(list, /JsonObject o = obj\("id", e\.getId\(\), "uuid", e\.getStringUUID\(\), "name", Names\.entity\(e\), "category", e\.getType\(\)\.getCategory\(\)\.getName\(\),\s+"position", pos\(e\.position\(\)\), "distance", round\(e\.distanceTo\(pl\)\), "height", round\(e\.getBbHeight\(\)\)\);/);
  t.regex(list, /if \(le\.isSleeping\(\)\) o\.addProperty\("sleeping", true\);/);
  t.regex(list, /list\.sort\(Comparator\.comparingDouble\(e -> e\.distanceTo\(pl\)\)\);/);
  t.regex(read('Merchant.java'), /o\.addProperty\("profession", Names\.strip\(d\.profession\(\)\.getRegisteredName\(\)\)\);\s+o\.addProperty\("level", d\.level\(\)\);/);

  const p = yard({ at: at(-556, 63, 2140) });
  const a = fletcher(p, INSIDE), b = p.villager({ at: at(-558, 63, 2129), sleeping: true });
  const { entities } = await call<{ entities: Any[] }>(p, 'world.entities', { maxDistance: 16 });
  t.deepEqual(entities.map(e => e.id), [a.id, b.id], 'the nearest first; the cows 30 off are not within 16');
  t.like(entities[0], { uuid: a.uuid, name: 'villager', category: 'misc', profession: 'fletcher', level: 4, health: 17, baby: false, merchant: true, position: { x: -555.5, y: 63, z: 2130.5 } });
  t.false('sleeping' in entities[0]);
  t.is(entities[1].sleeping, true);
  t.regex(a.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  t.not(a.uuid, b.uuid);
  t.deepEqual((await call<{ entities: Any[] }>(p, 'world.entities', { maxDistance: 64, type: 'cow' })).entities.map(e => e.name), ['cow', 'cow']);
  // an id dies with an unload, the uuid is the villager's own
  a.id = 77;
  t.like((await call<{ entities: Any[] }>(p, 'world.entities', { maxDistance: 16 })).entities[0], { id: 77, uuid: a.uuid });
  t.like(await p.ctx.status(), { inWorld: true, block: at(-556, 63, 2140), position: { x: -555.5, y: 63, z: 2140.5 }, health: 20, food: 20, dimension: 'overworld', screen: null });
  t.like(await call(p, 'inventory'), { items: [{ slot: 0, name: 'diamond_pickaxe', count: 1 }], held: null });
  t.like(await call(p, 'world.block', { ...H }), { loaded: true, name: 'oak_fence_gate', properties: { open: 'false' } });
  t.deepEqual(await call(p, 'world.region', { ...H, width: 2, height: 2, length: 1 }), { blocks: [p.get(H), 'oak_planks', 'air', 'oak_planks'] });
  // what the bridge has no call for is a caller's bug, not an empty answer
  await t.throwsAsync(() => call(p, 'gates.hodl', { ...H }), { message: 'unexpected bridge call gates.hodl' });
});

test('the gate rules are GateHolds.java\'s and Gates.java\'s: the lines the port stands on', (t) => {
  const holds = read('GateHolds.java'), gates = read('Gates.java');
  for (const [name, value] of [['TICK_MS', '50'], ['MAX_HOLD_MS', '30_000'], ['MAX_OFF_MS', '120_000'], ['LEFT_OPEN_TICKS', '100'], ['CLICK_GAP', '10']]) t.regex(holds, new RegExp(`static final int ${name} = ${value};`));
  t.regex(holds, /static final double REACH = 4\.4;/);
  t.is(TICK_MS, 50);
  // a hold: taken on a shut gate, never on one open out of reach; its end leaves an open gate owed a shut click
  t.regex(holds, /if \(g\.open && g\.eye > REACH\) \{ g\.until = -1; g\.owed = true; return 0; \}\s+g\.until = now \+ ticks\(Math\.min\(ms, MAX_HOLD_MS\)\);/);
  t.regex(holds, /if \(g\.until >= 0 && \(now >= g\.until \|\| \(g\.open && g\.eye > REACH\)\)\) \{ g\.until = -1; g\.owed = g\.open; \}\s+if \(g\.owed && g\.loaded && !g\.open\) g\.owed = false;/);
  t.regex(holds, /if \(shut\) g\.owed = g\.open;/);
  // a click: the four skips delay it, never in the gate's own cell, never beyond 4.4, once in ten ticks
  t.regex(holds, /if \(busy \|\| !g\.loaded \|\| g\.powered \|\| g\.inside \|\| g\.eye > REACH\) return false;\s+if \(g\.clickedAt >= 0 && now - g\.clickedAt < CLICK_GAP\) return false;/);
  // left open, the guard, the pair, the owed click
  t.regex(holds, /return g != null && g\.open && !held\(key, now\) && \(!g\.loaded \|\| g\.eye > REACH \|\| g\.openTicks >= LEFT_OPEN_TICKS\);/);
  t.regex(holds, /if \(g\.loaded && g\.open && g\.until < 0 && villagers\.contains\(gd\.gate\(\)\) && click\(g, now, busy\)\) out\.add\(made\(gd\.gate\(\), "guard"\)\);/);
  t.regex(holds, /if \(!\(a\.loaded && a\.open && a\.clickedAt != now\) \|\| !\(b\.loaded && b\.open && b\.clickedAt != now\)\) continue;\s+boolean second = b\.feet > a\.feet;\s+if \(click\(second \? b : a, now, busy\)\) out\.add\(made\(second \? p\[1\] : p\[0\], "pair"\)\);/);
  t.regex(holds, /if \(g\.owed && g\.open && click\(g, now, busy\)\) out\.add\(made\(e\.getKey\(\), "hold"\)\);/);
  t.regex(holds, /int ms = forMs <= 0 \|\| forMs > MAX_OFF_MS \? MAX_OFF_MS : forMs;/);

  // the closer: a gate that opens within 2.5 of the bot's feet is the bot's (seen shut the tick before, 3 round it)
  t.regex(gates, /private static final int R = 3;/);
  t.regex(gates, /for \(BlockPos q : BlockPos\.betweenClosed\(me\.offset\(-R, -1, -R\), me\.offset\(R, 2, R\)\)\) \{/);
  t.regex(gates, /if \(o && was != null && !was && !powered\(s\) && Vec3\.atCenterOf\(q\)\.distanceTo\(p\.position\(\)\) <= 2\.5\) opened\.putIfAbsent\(k, Ticker\.ticks\(\)\);/);
  // shut once the bot is clear of it by 2.2 and within 4.4 of the eye; a strict one is never forgotten, a held one left
  t.regex(gates, /boolean strict = HOLDS\.isStrict\(e\.getKey\(\)\);\s+if \(strict && !sees\(mc, q\)\) continue;/);
  t.regex(gates, /if \(HOLDS\.held\(e\.getKey\(\), tick\)\) continue;/);
  t.regex(gates, /if \(!strict && \(d > 6 \|\| Ticker\.ticks\(\) - e\.getValue\(\) > 20 \* 60\)\) \{ it\.remove\(\); continue; \}/);
  t.regex(gates, /boolean inside = q\.equals\(me\) \|\| q\.equals\(me\.above\(\)\) \|\| q\.equals\(me\.below\(\)\);\s+if \(inside \|\| d < 2\.2 \|\| eye\.distanceTo\(c\) > 4\.4\) continue;/);
  // the four skips: a screen, an item in use, a block being broken, sneak
  t.regex(gates, /if \(mc\.gui\.screen\(\) != null \|\| p\.isUsingItem\(\) \|\| mc\.gameMode\.isDestroying\(\)\) continue;/);
  t.regex(gates, /boolean sneaking = mc\.options\.keyShift\.isDown\(\);\s+if \(sneaking\) continue;/);
  t.regex(gates, /return mc\.gui\.screen\(\) != null \|\| p\.isUsingItem\(\) \|\| mc\.gameMode\.isDestroying\(\) \|\| mc\.options\.keyShift\.isDown\(\)/);
  t.regex(gates, /if \(HOLDS\.recent\(e\.getKey\(\), tick\)\) continue;/);
  t.regex(gates, /if \(strict\) HOLDS\.clicked\(e\.getKey\(\), tick\); else it\.remove\(\);/);
  t.regex(gates, /if \(!enabled\) \{ opened\.clear\(\); seen\.clear\(\); return; \}/);
  // a gate as the rules read it, and the villagers a guard counts: alive, by the block they stand in
  t.regex(gates, /return new GateHolds\.Sight\(q\.asLong\(\), loaded, gate && open\(s\), gate && powered\(s\), p\.getEyePosition\(\)\.distanceTo\(c\), c\.distanceTo\(p\.position\(\)\), inside\);/);
  t.regex(gates, /if \(!\(e instanceof AbstractVillager\) \|\| !e\.isAlive\(\)\) continue;\s+BlockPos at = e\.blockPosition\(\);\s+if \(g\.holds\(at\.getX\(\), at\.getY\(\), at\.getZ\(\)\)\) \{ villagers\.add\(g\.gate\(\)\); break; \}/);
  t.regex(gates, /for \(GateHolds\.Click k : HOLDS\.tick\(now, busy\(mc, p\), villagers\)\) \{/);
  // the calls of 5.3 and their replies
  for (const m of ['gates.auto', 'gates.hold', 'gates.release', 'gates.strict', 'gates.status']) t.true(gates.includes(`s.register("${m}", true,`), m);
  t.regex(body(gates, 'gates.hold'), /return obj\("held", true, "open", at\.open\(\), "leftMs", left\);/);
  t.regex(body(gates, 'gates.hold'), /if \(why != null\) return obj\("held", false, "open", false, "leftMs", 0, "reason", why\);/);
  t.regex(body(gates, 'gates.release'), /JsonObject r = obj\("released", released, "open", at\.loaded\(\) \? sight\(mc, pl, q\)\.open\(\) : last\);/);
  t.regex(body(gates, 'gates.release'), /else if \(!shut && at\.loaded\(\) && at\.open\(\) && HOLDS\.enabled\(now\)\) \{\s+opened\.putIfAbsent\(key, now\);/);
  t.regex(body(gates, 'gates.strict'), /return obj\("strict", HOLDS\.strict\(\)\.size\(\), "pairs", HOLDS\.pairs\(\), "guard", HOLDS\.guards\(\)\.size\(\)\);/);
  const status = body(gates, 'gates.status');
  for (const f of ['"open", HOLDS.open(k)', '"loaded", world && HOLDS.loaded(k)', '"heldMs", HOLDS.heldMs(k, now)', '"openTicks", HOLDS.openTicks(k)', '"leftOpen", HOLDS.leftOpen(k, now)']) t.true(status.includes(`o.addProperty(${f});`), f);
  t.regex(status, /obj\("enabled", HOLDS\.enabled\(now\), "strict", strict, "count", strict\.size\(\),/);
  t.regex(body(gates, 'gates.auto'), /if \(!enabled\) r\.addProperty\("autoOffLeftMs", HOLDS\.offLeftMs\(now\)\);/);
  t.deepEqual([ADOPT, CLEAR], [2.5, 2.2]);
});

const S = YARD_GATES.south;
const changes = (p: Pasture, gate: Pos) => p.changed.filter(c => key(c.at) === key(gate)).map(c => c.how);

test('the closer: the bot\'s walk opens a yard gate and it is shut behind it; a hold must come BEFORE the walk (a hold never opens a gate)', async (t) => {
  const p = yard({ at: at(-549, 63, 2210) });
  // out by the south gate: opened by the walk, the closer's from then, shut once the bot is 2.2 clear of it
  t.like(await call(p, 'goto', { x: S.x, y: 63, z: 2219, range: 0, careful: true }), { arrived: true, at: at(-549, 63, 2219) });
  t.deepEqual(changes(p, S), ['the bot\'s walk', 'shut (closer)']);
  const [opened, shut] = p.changed.filter(c => key(c.at) === key(S)).map(c => c.t);
  // open from the step into it to three cells past it (2 past is 2.06 from its middle: not yet clear)
  t.is(shut - opened, 2 + 3 * 5 + 1);
  t.false(isOpen(p.get(S)));
  t.deepEqual(p.adopted(), []);
  // a walk that ends 2 inside and 1 aside of the lane is 2.3 from it: the closer has shut it as the bot stops, and a
  // hold asked then holds a shut gate (F-32)
  await call(p, 'goto', { x: S.x + 1, y: 63, z: S.z - 2, range: 0, careful: true });
  p.advance(2);
  t.false(isOpen(p.get(S)));
  t.like(await call(p, 'gates.hold', { ...S, ms: 20_000 }), { held: true, open: false });
  p.advance(40);
  t.false(isOpen(p.get(S)), 'a hold never opens a gate');
  await call(p, 'gates.release', { ...S });

  // the hold first, on the shut gate; then the walk: it stays open as long as the hold is renewed
  await call(p, 'goto', { x: S.x, y: 63, z: 2219, range: 0, careful: true });
  t.deepEqual(await call(p, 'gates.hold', { ...S, ms: 20_000 }), { held: true, open: false, leftMs: 20_000 });
  await call(p, 'goto', { x: S.x + 1, y: 63, z: S.z - 2, range: 0, careful: true });
  p.advance(100);
  t.true(isOpen(p.get(S)));
  t.like(await call(p, 'gates.hold', { ...S, ms: 20_000 }), { held: true, open: true, leftMs: 20_000 });
  // released shut: the click is made at once, and the reply reads it shut
  t.deepEqual(await call(p, 'gates.release', { ...S, shut: true }), { released: true, open: false });
  t.is(changes(p, S).at(-1), 'shut (released)');
  // 30 s at most; no gate there, or no time: refused, with the reason
  t.like(await call(p, 'gates.hold', { ...S, ms: 99_000 }), { held: true, leftMs: 30_000 });
  await call(p, 'gates.release', { ...S });
  t.like(await call(p, 'gates.hold', { x: S.x + 1, y: S.y, z: S.z, ms: 1000 }), { held: false, reason: 'no gate or door at -548, 63, 2215: oak_fence' });
  t.like(await call(p, 'gates.hold', { ...S }), { held: false, leftMs: 0 });
});

test('the ring\'s gate is shut behind the bot on its way into the portal, and is shut while the bot is in the Nether', async (t) => {
  // the walk of nethersetup.ts intoNether: a careful one to within 2 of the portal's bottom cell nearest the bot, then
  // portal.enter's own to the cell before it and up into it, where the bot stands its 80 ticks. The closer shuts a
  // gate only once the bot's feet are 2.2 clear of its middle: with the gate three along from the frame's inside that
  // is on the row before the portal, for either cell of it
  const into = async (p: Pasture, ring: Pos, entry: number) => {
    await call(p, 'gates.strict', { gates: [...Object.values(YARD_GATES), P, H, ring], pairs: [[P, H]], guard: [{ gate: P, box: lock(p).box }] });
    t.like(await call(p, 'goto', { x: entry, y: 64, z: 2147, range: 2, careful: true }), { arrived: true });
    t.like(await call(p, 'goto', { x: entry, y: 63, z: 2148, range: 0, careful: true }), { arrived: true, at: at(entry, 63, 2148) });
    const onTheRow = isOpen(p.get(ring));
    p.bot.at = at(entry, 64, 2147);
    p.advance(80);
    const row = (await call<{ strict: (Pos & Any)[] }>(p, 'gates.status')).strict.find(g => key(g) === key(ring));
    return { onTheRow, row };
  };
  for (const entry of [-560, -559]) {
    const p = yard({ at: at(-552, 63, 2155) });
    const ring = p.world.zones!['ring:gate'][0];
    const r = await into(p, ring, entry);
    t.false(r.onTheRow, `${entry}: shut before the bot steps up into the portal`);
    t.deepEqual(changes(p, ring), ['the bot\'s walk', 'shut (closer)'], String(entry));
    t.like(r.row, { open: false, leftOpen: false, loaded: true }, String(entry));
    t.deepEqual(p.adopted(), [], String(entry));
  }
  // a gate in line with the frame's inside, as the ring was first drawn: from the portal's cell straight behind it the
  // bot is 2.06 from its middle, never clear of it: it stands its 80 ticks and is gone with the gate open
  const p = yard({ at: at(-552, 63, 2155) });
  const ring = p.world.zones!['ring:gate'][0], inLine = at(-560, 63, ring.z);
  p.set(ring, 'oak_fence');
  p.set(inLine, 'oak_fence_gate[facing=south]');
  const r = await into(p, inLine, -560);
  t.true(r.onTheRow);
  t.like(r.row, { open: true, loaded: true });
  t.deepEqual(changes(p, inLine), ['the bot\'s walk']);
  t.deepEqual(p.adopted(), [inLine]);
});

test('a hold outlives a silent brain: its time out, the bridge shuts the gate itself; out of reach it is left open and owed', async (t) => {
  const p = yard({ at: at(-549, 63, 2219) });
  await strict(p);
  await call(p, 'gates.hold', { ...S, ms: 20_000 });
  await call(p, 'goto', { x: S.x + 1, y: 63, z: S.z - 2, range: 0, careful: true });
  const held = p.tick;
  // nobody renews it: 20 s after the hold the gate is shut by the bridge, not before
  p.advance(20 * 20 - (p.tick - held) - 60);
  t.true(isOpen(p.get(S)));
  p.advance(70);
  t.false(isOpen(p.get(S)));
  t.is(changes(p, S).at(-1), 'shut (hold)');
  t.like(await call(p, 'gates.status'), { clicks: { hold: 1, pair: 0, guard: 0 } });

  // the closer's four skips delay the click, they never drop it: a screen open as the hold ends
  await call(p, 'gates.hold', { ...S, ms: 1000 });
  await call(p, 'useOn', { ...S });
  t.true(isOpen(p.get(S)));
  p.bot.screen = 'MerchantScreen';
  p.advance(200);
  t.true(isOpen(p.get(S)), 'the hold is long out, the screen still up');
  p.bot.screen = null;
  p.advance(1);
  t.false(isOpen(p.get(S)));
  for (const skip of ['using', 'sneaking', 'destroying'] as const) {
    await call(p, 'gates.hold', { ...S, ms: 500 });
    await call(p, 'useOn', { ...S });
    p.bot[skip] = true;
    p.advance(100);
    t.true(isOpen(p.get(S)), skip);
    p.bot[skip] = false;
    p.advance(1);
    t.false(isOpen(p.get(S)), skip);
  }

  // the bot walks off from a held, open gate: the hold ends at once (no click reaches it) and the gate is "left open"
  await call(p, 'gates.hold', { ...S, ms: 20_000 });
  await call(p, 'useOn', { ...S });
  await call(p, 'goto', { x: S.x, y: 63, z: S.z - 12, range: 0, careful: true });
  const st = await call<{ strict: Any[]; count: number }>(p, 'gates.status');
  t.is(st.count, 6);
  t.like(st.strict.find(g => g.z === S.z), { open: true, heldMs: 0, leftOpen: true, loaded: true });
  t.true(isOpen(p.get(S)));
  // a new hold on it from there is refused, and says why
  t.like(await call(p, 'gates.hold', { ...S, ms: 20_000 }), { held: false, open: true, leftMs: 0 });
  // back in reach: shut by the bridge, on the first tick it can
  await call(p, 'goto', { x: S.x, y: 63, z: S.z - 3, range: 0, careful: true });
  t.false(isOpen(p.get(S)));
});

test('strict: a gate the bot did not open is nobody\'s to the closer, and is reported by its block state; left open after 100 ticks', async (t) => {
  const p = yard({ at: at(-549, 63, 2212) });
  // not strict: opened from 3 off (over 2.5: not the closer's), it stands open for good and nothing says so
  t.like(await call(p, 'useOn', { ...S }), { changed: true });
  p.advance(400);
  t.true(isOpen(p.get(S)));
  t.like(await call(p, 'gates.status'), { count: 0, strict: [], enabled: true });
  await call(p, 'useOn', { ...S });
  // strict: the same click is seen at once, and is "left open" once it has stood so 100 ticks
  t.deepEqual(await strict(p), { strict: 6, pairs: 1, guard: 1 });
  await call(p, 'useOn', { ...S });
  const row = async () => (await call<{ strict: Any[] }>(p, 'gates.status')).strict.find(g => g.z === S.z)!;
  t.like(await row(), { x: S.x, y: S.y, z: S.z, open: true, loaded: true, leftOpen: false, heldMs: 0 });
  p.advance(100);
  t.like(await row(), { open: true, leftOpen: true });
  t.true((await row()).openTicks as number >= 100);
  t.true(isOpen(p.get(S)), 'reported, never clicked: the brain\'s care shuts it');
  // a player's click on a gate out of the bot's reach: left open at once
  await call(p, 'useOn', { ...S });
  await call(p, 'goto', { x: -549, y: 63, z: 2190, range: 0, careful: true });
  p.swing(YARD_GATES.west, true, 'a player');
  p.advance(2);
  t.like((await call<{ strict: Any[] }>(p, 'gates.status')).strict.find(g => g.x === YARD_GATES.west.x), { open: true, leftOpen: true });
  // one the closer took is never dropped for distance while strict: a screen up as the bot walks 20 off, then back
  p.swing(YARD_GATES.west, false, 'a player');
  await call(p, 'goto', { x: -562, y: 63, z: 2186, range: 0, careful: true });
  p.bot.screen = 'InventoryScreen';
  await call(p, 'goto', { x: -568, y: 63, z: 2183, range: 0, careful: true });
  await call(p, 'goto', { x: -588, y: 63, z: 2183, range: 0, careful: true });
  p.bot.screen = null;
  p.advance(20);
  t.true(isOpen(p.get(YARD_GATES.west)), '20 off: out of reach');
  t.deepEqual(p.adopted(), [YARD_GATES.west], 'still the closer\'s');
  await call(p, 'goto', { x: -568, y: 63, z: 2183, range: 0, careful: true });
  t.false(isOpen(p.get(YARD_GATES.west)));
  // gates.auto off runs out by itself (B4): two minutes at most
  t.deepEqual(await call(p, 'gates.auto', { enabled: false, forMs: 600_000 }), { enabled: false, autoOffLeftMs: 120_000 });
  await call(p, 'gates.auto', { enabled: false, forMs: 5000 });
  t.like(await call(p, 'gates.status'), { enabled: false });
  p.advance(100);
  t.like(await call(p, 'gates.status'), { enabled: true });
  t.deepEqual(await call(p, 'gates.auto', { enabled: true }), { enabled: true });
});

test('the pair and the guard on the lock: never P and H open together; never P open onto a villager in the lock unless held for it', async (t) => {
  const p = yard();
  const l = lock(p);
  p.bot.at = { ...l.post };
  await strict(p);
  // the pair: P open, then H: the one farther from the bot (H, from the post) is shut on the next tick
  await call(p, 'useOn', { ...P });
  await call(p, 'useOn', { ...H });
  t.deepEqual([isOpen(p.get(P)), isOpen(p.get(H))], [true, false]);
  t.deepEqual(changes(p, H), ['useOn', 'shut (pair)']);
  const [on, off] = p.changed.filter(c => key(c.at) === key(H)).map(c => c.t);
  t.is(off - on, 1, 'the same tick the bridge sees both open');
  await call(p, 'useOn', { ...P });
  // the guard: a villager in the lock's box, P opened with no hold on it: shut at once
  const v = fletcher(p, at(-556, 63, 2136), { mind: 'still' });
  await call(p, 'useOn', { ...P });
  t.false(isOpen(p.get(P)));
  t.is(changes(p, P).at(-1), 'shut (guard)');
  // held for the arriving ward: the hold exempts it (LOCK's step 3), and its end shuts it
  t.like(await call(p, 'gates.hold', { ...P, ms: 20_000 }), { held: true, open: false });
  await call(p, 'useOn', { ...P });
  p.advance(100);
  t.true(isOpen(p.get(P)));
  t.deepEqual(await call(p, 'gates.release', { ...P, shut: true }), { released: true, open: false });
  // nobody in the box: P opened from the post is nobody's and stays (H shut): reported, as strict gates are
  v.position = { x: -555.5, y: 63, z: 2130.5 };
  await call(p, 'useOn', { ...P });
  p.advance(30);
  t.true(isOpen(p.get(P)));
  // a villager in P's own cell is not in the box: the guard is for the lock's inside
  v.position = { x: P.x + 0.5, y: 63, z: P.z + 0.5 };
  p.advance(5);
  t.true(isOpen(p.get(P)));
  v.position = { x: -555.5, y: 63, z: 2135.5 };
  p.advance(1);
  t.false(isOpen(p.get(P)));
  t.like(await call(p, 'gates.status'), { clicks: { hold: 1, pair: 1, guard: 2 } });
  // the port itself, off the world: a guard waits while the bot stands in the gate's cell
  const g = new GateHolds();
  g.strict([P, H], [[P, H]], [{ gate: P, box: l.box }]);
  g.look({ key: key(P), loaded: true, open: true, powered: false, eye: 1.2, feet: 0.5, inside: true });
  t.deepEqual(g.tick(1, false, new Set([key(P)])), []);
  g.look({ key: key(P), loaded: true, open: true, powered: false, eye: 1.6, feet: 1.1, inside: false });
  t.deepEqual(g.tick(2, false, new Set([key(P)])), [{ key: key(P), why: 'guard' }]);
});

// ------------------------------------------------------------------------------------------------ walking, time, the log

test('a careful goto walks where a way on foot is and FAILS where none is; a plain one arrives all the same, and is counted', async (t) => {
  t.regex(body(read('Handlers.java'), 'goto'), /range <= 0 \? new GoalBlock\(target\) : new GoalNear\(target, range\)\);/);
  t.regex(body(read('Handlers.java'), 'goto'), /return obj\("arrived", awayFrom > 0 \? away >= awayFrom - 0\.01 : away <= Math\.max\(range, 0\) \+ 0\.01 \|\| \(range <= 0 && at\.equals\(target\)\),\s+"at", pos\(at\), "distance", round\(away\)\);/);
  const p = yard();
  // ten cells across the lawn: a tick for the call, five a cell
  const began = p.tick;
  t.deepEqual(await call(p, 'goto', { x: HOME.x, y: 63, z: HOME.z - 10, range: 0, careful: true }), { arrived: true, at: at(-549, 63, 2173), distance: 0 });
  t.is(p.tick - began, 1 + 10 * 5);
  // GoalNear: within its range will do
  t.like(await call(p, 'goto', { x: -549, y: 63, z: 2163, range: 2, careful: true }), { arrived: true, at: at(-549, 63, 2165), distance: 2 });
  // into the cow pen and out: its gate opened by the walk, shut behind it both times
  const gate = p.world.zones!['pen:cow:gate'][0];
  t.like(await call(p, 'goto', { x: -555, y: 63, z: 2168, range: 0, careful: true }), { arrived: true });
  t.like(await call(p, 'goto', { x: -549, y: 63, z: 2175, range: 0, careful: true }), { arrived: true });
  t.deepEqual(changes(p, gate), ['the bot\'s walk', 'shut (closer)', 'the bot\'s walk', 'shut (closer)']);
  // fire in the way is walked round (two cells more), never through
  p.set(at(-549, 63, 2177), 'fire');
  const round = p.tick;
  t.like(await call(p, 'goto', { x: -549, y: 63, z: 2179, range: 0, careful: true }), { arrived: true });
  t.is(p.tick - round, 1 + 6 * 5);
  // the hall's roof: no way on foot (a rise of four). The careful walk stops at the wall's foot and says so
  const roof = at(-556, 67, 2130);
  const tried = p.tick;
  const r = await call<{ arrived: boolean; at: Pos; distance: number }>(p, 'goto', { ...roof, range: 0, careful: true });
  t.false(r.arrived);
  t.true(r.distance > 3 && r.distance < 6, `stopped ${r.distance} off`);
  t.deepEqual(p.bot.at, r.at);
  t.true(p.tick - tried >= 100, 'and it took its time finding none');
  t.like(p.walks.at(-1), { careful: true, arrived: false, to: roof });
  t.deepEqual(p.broke, []);
  // a cell fenced in with no gate: the same
  for (const [dx, dz] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) p.set(at(-545 + dx, 63, 2180 + dz), 'oak_fence');
  t.like(await call(p, 'goto', { x: -545, y: 63, z: 2180, range: 0, careful: true }), { arrived: false });
  // a plain walk gets there (Baritone digs and pillars): the fake counts it, a trip's test asserts none
  t.like(await call(p, 'goto', { ...roof, range: 0 }), { arrived: true, at: roof });
  t.is(p.broke.length, 1);
  t.like(p.walks.at(-1), { careful: false, arrived: true });
  // a fall of three is walked, a fall of four is not (the staircase by the west gate, 63 -> 67)
  p.bot.at = at(-561, 66, 2182);
  t.like(await call(p, 'goto', { x: -558, y: 63, z: 2182, range: 0, careful: true }), { arrived: true }, 'off the third step by its side: three down');
  t.like(await call(p, 'goto', { x: -561, y: 67, z: 2183, range: 0, careful: true }), { arrived: true }, 'and up it, a block a step');
  for (const x of [-562, -561]) for (const y of [63, 64, 65]) p.set(at(x, y, 2182), 'air');
  t.like(await call(p, 'goto', { x: -558, y: 63, z: 2182, range: 0, careful: true }), { arrived: false, at: at(-561, 67, 2183) }, 'the step under the top dug away: four down on every side');
});

test('time: every call, walk, wait and poll moves the game on; the log keeps each call with brain.json as it was saved then', async (t) => {
  const p = yard({ tod: 8690 });
  t.is(p.now(), T0);
  t.is(p.tod, 8690);
  // a poll is a tick at the least, a wait is game time, and the time of day is the status's
  await call(p, 'world.entities', { maxDistance: 64 });
  await call(p, 'status');
  t.is(p.tick, 2);
  await p.clock.sleep(500);
  t.is(p.tick, 12);
  t.is(p.now(), T0 + 12 * 50);
  t.is((await p.ctx.status()).timeOfDay, 8703);
  t.is(p.look().timeOfDay, 8703);
  t.is(p.look().activity, 'work');
  // something a scenario lets happen at its tick
  let rang = 0;
  p.at(20, () => { rang = p.tick; });
  await p.clock.sleep(1000);
  t.is(rang, 20);
  // midnight wraps
  const late = yard({ tod: 23_990 });
  late.advance(20);
  t.is(late.tod, 10);

  // journal first, then the act: the log's entry holds brain.json as SAVED when the call was made (INV-1 reads this)
  const ctx = p.ctx;
  const cell = at(-549, 63, 2185);
  (ctx.world as WorldMemory & { fetch?: unknown }).fetch = { v: 1, journal: [{ k: 'lure', id: 1, trip: 0, at: cell, item: 'fletching_table', st: 'planned', role: 'hop', t: p.now() }], wards: [], nextId: 2 };
  t.is(JSON.parse(p.saved).fetch, undefined, 'not saved yet');
  ctx.save!();
  t.is(p.saves, 1);
  (ctx.world as WorldMemory & { fetch?: { halt?: unknown } }).fetch!.halt = { at: 1, why: 'not saved' };
  t.like(await ctx.own!.put(cell, 'fletching_table'), { ok: true, placed: true });
  const place = p.log.find(e => e.name === 'place')!;
  t.like(place, { kind: 'call', name: 'place', params: { ...cell, face: 'down' }, at: HOME, via: 'own.put', reply: { placed: true, block: 'fletching_table' } });
  t.is(place.tod, 8690 + place.t);
  const saved = JSON.parse(place.saved) as { fetch: { journal: { at: Pos; st: string }[]; halt?: unknown } };
  t.like(saved.fetch.journal[0], { at: cell, st: 'planned' });
  t.is(saved.fetch.halt, undefined, 'what was not saved is not in it');
  t.deepEqual(p.log.map(e => e.i), p.log.map((_, i) => i));
  // a tool is on the log too, and so are the calls it makes
  const before = p.log.length;
  t.like(await ctx.act('use-item-on-block', { ...YARD_GATES.east, face: 'up', toggle: true }), { ok: true });
  t.true(isOpen(p.get(YARD_GATES.east)));
  t.deepEqual(p.log.slice(before).map((e: Entry) => `${e.kind} ${e.name}`), ['act use-item-on-block', 'call useOn', 'call goto', 'call useOn']);
  t.like(p.walks.at(-1), { careful: false }, 'its walk into reach is a plain one: the fetch never uses the tool on a gate');
  t.like(await ctx.act('no-such-tool', {}), { ok: false, text: 'unexpected no-such-tool' });
  // a scenario's own answer to a call comes first
  p.on.call['world.entities'] = () => ({ entities: [] });
  t.deepEqual(await call(p, 'world.entities', { maxDistance: 64 }), { entities: [] });
  ctx.progress('said');
  ctx.dump!('fetch-first', { n: 1 });
  t.deepEqual([p.said, p.dumps], [['said'], [{ name: 'fetch-first', data: { n: 1 } }]]);
});

// ------------------------------------------------------------------------------------------------ the bot's own blocks, the protection store, a kill

test('own.put and own.take are tools.ts\'s over this bridge: the record before the place, never a block that is not the bot\'s', async (t) => {
  const tools = fs.readFileSync(path.join(process.cwd(), 'src', 'client', 'tools.ts'), 'utf8');
  const put = tools.slice(tools.indexOf('const putOwn = async'), tools.indexOf('const takeOwn = async'));
  const take = tools.slice(tools.indexOf('const takeOwn = async'), tools.indexOf('register(', tools.indexOf('const takeOwn = async')));
  t.regex(put, /protection\.add\(dim, \[p\]\);\s+await syncProtection\(dim, true\);/);
  t.true(put.indexOf('await syncProtection(dim, true)') < put.indexOf('call(\'item.select\'') && put.indexOf('call(\'item.select\'') < put.indexOf('\'place\', { ...p, face: o.face ?? \'down\' }'));
  t.regex(put, /if \(!r\.placed && !o\.stay && \/\^too far\/\.test\(r\.reason \?\? ''\)\) \{\s+await carefulNear\(p\);/);
  t.regex(tools, /const carefulNear = \(p: Pos\) => call\('goto', \{ \.\.\.p, range: 2, careful: true, timeoutMs: 30_000 \}/);
  t.regex(take, /'dig\.here', \{ \.\.\.p, timeoutMs: 15_000 \}/);
  t.notRegex(take, /call(<[^>]*>)?\('dig'/);
  t.regex(take, /if \(!r\.dug && !o\.stay && \/out of reach\|out of sight\/\.test\(r\.reason \?\? ''\)\) \{\s+await carefulNear\(p\);/);
  t.regex(tools, /const OWN_DROP_LOOKS = 4;\s+const OWN_DROP_WAIT_MS = 400;/);
  t.regex(take, /await call\('goto', \{ \.\.\.p, range: 0, careful: true, timeoutMs: 8000 \}/);
  // the take's first call is a look (status), and that look tells the client mod what is the bot's own when its list
  // is behind the record or it has none (a relaunched client); then the cell is read
  t.regex(take, /const dim = await dimension\(\);\s+const state = await stateAt\(p\);/);
  t.regex(tools, /const dimension = async \(\) => \(await status\(\)\)\.dimension \?\? 'overworld';/);
  t.regex(tools, /const relaunched = \(s\.protectedCount !== undefined && s\.protectedCount !== protection\.positions\(dim\)\.length\) \|\| s\.protectSynced === false;\s+await syncProtection\(dim, relaunched\);/);
  t.regex(tools, /if \(!force && syncedVersion === protection\.version && syncedDim === dim\) return;/);
  // what a block is put into as into air (grass, snow, water) is nothing there, with its name; any other block is someone's
  t.regex(take, /if \(isRoom\(state\)\) return \{ ok: true, dug: false, block: name, reason: 'nothing there' \};\s+return \{ ok: false, dug: false, block: name, reason: `the bot did not put that \$\{name\} there \(its \$\{want\} is gone\)` \};/);

  const p = yard({ at: at(-549, 63, 2160) });
  const ctx = p.ctx, own = ctx.own!;
  const cell = at(-549, 63, 2162), k = key(cell);
  const names = (from: number) => p.log.slice(from).map(e => e.name);
  // put: on both lists at the moment of the place
  let seen: boolean | undefined;
  p.on.call.place = () => { seen = p.protection.has(k) && p.told.has(k); return undefined; };
  let from = p.log.length;
  t.deepEqual(await own.put(cell, 'fletching_table'), { ok: true, placed: true, block: 'fletching_table' });
  t.true(seen);
  t.deepEqual(names(from), ['protect.set', 'item.select', 'place', 'world.block']);
  t.is(p.protection.get(k), 'fletching_table');
  delete p.on.call.place;
  // a refused place leaves no record, on either list
  t.deepEqual(await own.put(at(-549, 66, 2162), 'fletching_table'), { ok: false, placed: false, reason: 'nothing solid next to it to place against' });
  t.false(p.protection.has('-549,66,2162') || p.told.has('-549,66,2162'));
  t.like(await own.put(cell, 'oak_planks'), { ok: false, placed: false, reason: 'occupied by fletching_table' });
  t.is(p.protection.get(k), 'fletching_table', 'a cell that was the bot\'s before stays so');
  // too far: one careful walk into reach, then once more; `stay`: no walk at all
  const far = at(-549, 63, 2170);
  t.like(await own.put(far, 'fletching_table', { stay: true }), { ok: false, placed: false, reason: 'too far' });
  t.false(p.protection.has(key(far)));
  from = p.log.length;
  t.like(await own.put(far, 'fletching_table'), { ok: true, placed: true });
  t.deepEqual(names(from), ['protect.set', 'item.select', 'place', 'goto', 'item.select', 'place', 'world.block']);
  t.like(p.walks.at(-1), { careful: true, arrived: true });

  // take: dug from where the bot stands (2 off, after that walk), off both lists; the drop does not come in from
  // there: waited for 4 x 400 ms, then the cell is walked onto
  from = p.log.length;
  const t0 = p.tick;
  t.deepEqual(await own.take(far, 'fletching_table'), { ok: true, dug: true, pickedUp: true });
  // (the look first; the state the block went down in is news to the client mod's list, told on that look as tools.ts does)
  t.deepEqual(names(from).filter(n => n !== 'inventory'), ['status', 'protect.set', 'world.block', 'dig.here', 'protect.set', 'goto']);
  t.like(p.log.filter(e => e.name === 'goto').at(-1), { params: { ...far, range: 0, careful: true } });
  t.true(p.tick - t0 >= 32);
  t.deepEqual(p.bot.at, far);
  t.false(p.protection.has(key(far)) || p.told.has(key(far)));
  t.is(p.count('fletching_table'), 3);
  // from beside it the drop comes in by itself; told to leave it, it is left lying
  t.deepEqual(await own.take(cell, 'fletching_table', { stay: true }), { ok: false, dug: false, reason: 'out of reach or out of sight' });
  await call(p, 'goto', { x: -549, y: 63, z: 2163, range: 0, careful: true });
  from = p.log.length;
  t.deepEqual(await own.take(cell, 'fletching_table'), { ok: true, dug: true, pickedUp: true });
  t.false(names(from).includes('goto'));
  t.like(await own.put(at(-549, 63, 2165), 'fletching_table'), { ok: true });
  t.deepEqual(await own.take(at(-549, 63, 2165), 'fletching_table', { stay: true, pickup: false }), { ok: true, dug: true });
  t.is(p.drops.length, 1);
  // nothing there: off the record; someone's block in the cell: never dug; one the record does not name: refused, or adopted
  t.deepEqual(await own.take(at(-549, 63, 2165), 'fletching_table'), { ok: true, dug: false, reason: 'nothing there' });
  p.mine(at(-548, 63, 2163), 'fletching_table');
  p.set(at(-548, 63, 2163), 'cobblestone', 'a player');
  t.deepEqual(await own.take(at(-548, 63, 2163), 'fletching_table'), { ok: false, dug: false, block: 'cobblestone', reason: 'the bot did not put that cobblestone there (its fletching_table is gone)' });
  t.is(p.get(at(-548, 63, 2163)), 'cobblestone');
  t.false(p.protection.has('-548,63,2163'));
  // a tuft of grass, water or a layer of snow in the cell is nothing there (what the place itself goes into): off the
  // record, ok, and the same every time it is asked; snow lying deeper is a block, and a flower is
  for (const [room, name] of [['short_grass', 'short_grass'], ['water[level=0]', 'water'], ['snow[layers=1]', 'snow'], ['tall_grass[half=lower]', 'tall_grass']]) {
    const c = at(-546, 63, 2163);
    p.set(c, room);
    p.mine(c, '');
    from = p.log.length;
    t.deepEqual(await own.take(c, 'fletching_table'), { ok: true, dug: false, block: name, reason: 'nothing there' }, room);
    t.false(p.protection.has(key(c)) || p.told.has(key(c)), room);
    t.deepEqual(await own.take(c, 'fletching_table', { adopt: true }), { ok: true, dug: false, block: name, reason: 'nothing there' }, room);
    t.false(names(from).includes('dig.here'), room);
    t.is(p.get(c), room);
  }
  for (const [block, name] of [['snow[layers=3]', 'snow'], ['poppy', 'poppy']]) {
    p.set(at(-546, 63, 2163), block);
    p.mine(at(-546, 63, 2163), '');
    t.deepEqual(await own.take(at(-546, 63, 2163), 'fletching_table'), { ok: false, dug: false, block: name, reason: `the bot did not put that ${name} there (its fletching_table is gone)` }, block);
  }
  p.set(at(-546, 63, 2163), 'air');
  p.set(at(-547, 63, 2163), 'fletching_table', 'a player');
  t.deepEqual(await own.take(at(-547, 63, 2163), 'fletching_table'), { ok: false, dug: false, reason: 'the bot did not put that fletching_table there' });
  t.like(await own.take(at(-547, 63, 2163), 'fletching_table', { adopt: true }), { ok: true, dug: true });
  // a place whose reply is lost: the cell is read, and the block found down is the bot's (R-1's "unsure")
  p.on.call.place = (params, w) => { w.answer('place', params); throw new Error('bridge call place timed out after 15000 ms'); };
  await call(p, 'goto', { x: -549, y: 63, z: 2160, range: 0, careful: true });
  t.like(await own.put(at(-548, 63, 2161), 'fletching_table'), { ok: true, placed: true, block: 'fletching_table' });
  t.is(p.protection.get('-548,63,2161'), 'fletching_table');
  delete p.on.call.place;
  // out of sight (the socket from the yard's side of the lock's corner): `stay` walks nowhere, and nothing is dug
  const l = lock(p);
  p.bot.at = at(-553, 63, 2140);
  t.like(await own.take(l.socket, 'oak_planks', { stay: true }), { ok: false, dug: false, reason: 'out of reach or out of sight' });
  t.is(idOf(p.get(l.socket)), 'oak_planks');
});

test('a kill between any two calls: the protection store is its own (X2), brain.json is what was saved, and a dead brain reaches nothing', async (t) => {
  const p = yard({ at: at(-549, 63, 2160) });
  const old = p.ctx, clk = p.clock;
  const cell = at(-549, 63, 2162);
  // killed between protect.set and the place: a record with no block
  p.killAt(p.log.length + 2);
  (old.world as WorldMemory & { note?: string }).note = 'saved';
  old.save!();
  (old.world as WorldMemory & { note?: string }).note = 'lost';
  await t.throwsAsync(() => old.own!.put(cell, 'fletching_table'), { instanceOf: Killed });
  t.deepEqual(p.log.map(e => e.name), ['protect.set', 'item.select']);
  t.true(p.protection.has(key(cell)));
  t.is(p.get(cell), 'air');
  // the dead process: every call, tool, wait and save of it throws; its signal is aborted so its loops end
  await t.throwsAsync(() => old.call('status'), { instanceOf: Killed });
  await t.throwsAsync(() => old.act('place-block', { ...cell, item: 'dirt' }), { instanceOf: Killed });
  await t.throwsAsync(() => old.own!.take(cell, 'fletching_table'), { instanceOf: Killed });
  await t.throwsAsync(() => clk.sleep(500), { instanceOf: Killed });
  t.throws(() => old.save!(), { instanceOf: Killed });
  t.true(old.signal.aborted);
  t.is(p.log.length, 2, 'and nothing of it is on the log');
  // the next process reads what was saved, and the take's own read of the cell takes the record off
  const ctx = p.restart();
  t.is((ctx.world as WorldMemory & { note?: string }).note, 'saved');
  t.not(ctx.world, old.world);
  t.false(ctx.signal.aborted);
  t.deepEqual(await ctx.own!.take(cell, 'fletching_table'), { ok: true, dug: false, reason: 'nothing there' });
  t.false(p.protection.has(key(cell)));
  // the same kill over level grass, where a lure goes down in a village: the tuft still stands in the cell, and the
  // take's read of it is "nothing there", not someone's block, however often the undo asks (R-4 counts failed tries)
  const tuft = at(-548, 63, 2162);
  p.set(tuft, 'short_grass');
  p.killAt(p.log.length + 2);
  await t.throwsAsync(() => ctx.own!.put(tuft, 'fletching_table'), { instanceOf: Killed });
  t.deepEqual([p.protection.get(key(tuft)), p.get(tuft)], ['', 'short_grass']);
  const next = p.restart();
  for (const o of [{ adopt: true }, { adopt: true }, {}]) t.deepEqual(await next.own!.take(tuft, 'fletching_table', o), { ok: true, dug: false, block: 'short_grass', reason: 'nothing there' });
  t.false(p.protection.has(key(tuft)));
  t.is(p.get(tuft), 'short_grass');

  // restartAt: the kill and the new process at that call; the old context is dead, the pasture's is the new one
  const before = p.ctx;
  p.restartAt(p.log.length + 1, false, 40);
  await before.call('status');
  const tick = p.tick;
  await t.throwsAsync(() => before.call('status'), { instanceOf: Killed });
  t.is(p.tick, tick + 40);
  t.like(await p.ctx.call('status'), { inWorld: true });
});

test('killed with a gate held: the client alive, the dead-man shuts it within 20 s; the client dead too, it stands open until the bot is back', async (t) => {
  const held = async () => {
    const p = yard({ at: at(-549, 63, 2219) });
    await strict(p);
    await call(p, 'gates.hold', { ...S, ms: 20_000 });
    await call(p, 'goto', { x: S.x + 1, y: 63, z: S.z - 2, range: 0, careful: true });
    t.true(isOpen(p.get(S)));
    return p;
  };
  // the brain alone (kill -9): nobody renews, the bridge's own tick ends the hold and clicks
  const a = await held();
  a.kill();
  a.advance(20 * 20);
  t.false(isOpen(a.get(S)));
  t.is(changes(a, S).at(-1), 'shut (hold)');
  const ctx = a.restart();
  t.like(await ctx.call('gates.status'), { count: 6 }, 'the bridge kept its sets');

  // the unit restarted: the client is gone with the brain, its holds and sets are statics of it
  const b = await held();
  b.kill(true);
  b.advance(CLIENT_BACK_TICKS - 10);
  t.true(isOpen(b.get(S)), 'nobody is there to click');
  const back = b.restart({ after: 10 });
  t.true(isOpen(b.get(S)));
  // the new client knows no strict gate and no block of the bot's: the brain sends both again
  t.like(await back.call('gates.status'), { count: 0, strict: [] });
  t.like(await back.status(), { protectedCount: 0, protectSynced: false });
  // and for its first seconds it is blind: every read null, nobody listed (a look is whole only 20 s after a rejoin)
  t.deepEqual(await back.call('world.region', { ...H, width: 1, height: 1, length: 1 }), { blocks: [null] });
  t.deepEqual(await back.call('world.block', { ...H }), { loaded: false });
  fletcher(b, INSIDE, { mind: 'still' });
  t.deepEqual(await back.call('world.entities', { maxDistance: 128 }), { entities: [] });
  b.advance(100);
  t.deepEqual(await back.call<{ blocks: string[] }>('world.region', { ...H, width: 1, height: 1, length: 1 }), { blocks: [b.get(H)] });
  t.is((await back.call<{ entities: Any[] }>('world.entities', { maxDistance: 128, type: 'villager' })).entities.length, 1);
  // the strict set sent again, the open gate is seen, and care's shut click lands
  await back.call('gates.strict', { gates: [S, P, H], pairs: [[P, H]], guard: [] });
  t.like((await back.call<{ strict: Any[] }>('gates.status')).strict[0], { open: true, leftOpen: false });
  await back.call('useOn', { ...S });
  t.false(isOpen(b.get(S)));
  // with the client dead the yard only ticks where a player keeps it: a villager there walks on, alone it stands
  const c = yard({ lock: false });
  const v = c.villager({ at: INSIDE });
  c.swing(H, true, 'a player');
  c.kill(true);
  c.advance(200);
  t.is(c.leaks.length, 0);
  c.animal('player', at(-540, 63, 2150));
  c.advance(200);
  t.is(c.leaks.length, 1);
  t.true(v.position.z > H.z);
});

test('the unit restarted with the bot\'s own lure standing in a village: the take\'s first look tells the new client what is the bot\'s, and dig.here takes it', async (t) => {
  const p = new Pasture({ at: at(0, 63, 0) });
  p.zones.push({ x1: -8, y1: 60, z1: -8, x2: 8, y2: 80, z2: 8 });
  const cell = at(1, 63, 1);
  t.like(await p.ctx.own!.put(cell, 'fletching_table'), { ok: true, placed: true });
  // the client dies with the brain: its list of the bot's own blocks is a static of it, placed-blocks.json is not
  p.kill(true);
  const ctx = p.restart();
  p.advance(120);
  t.like(await ctx.status(), { protectedCount: 0, protectSynced: false });
  t.true(p.protection.has(key(cell)));
  t.true(p.guarded(cell), 'to the new client the lure is someone\'s build');
  t.like(await ctx.call('dig.here', { ...cell }), { dug: false, reason: 'someone else\'s build (force: true to dig it anyway)' });
  // own.take's first call is tools.ts's status(): a client that says it has no list (or another count) is sent it again
  const from = p.log.length;
  t.deepEqual(await ctx.own!.take(cell, 'fletching_table'), { ok: true, dug: true, pickedUp: true });
  t.deepEqual(p.log.slice(from, from + 5).map(e => e.name), ['status', 'protect.set', 'world.block', 'inventory', 'dig.here']);
  t.like(p.log[from + 1], { via: 'own.take', params: { positions: [[1, 63, 1]] } });
  t.is(p.get(cell), 'air');
  t.false(p.protection.has(key(cell)) || p.told.has(key(cell)));
  // a client that has its list is not told again on the look: the calls of a take whose record is in step
  t.like(await ctx.own!.put(cell, 'fletching_table'), { ok: true, placed: true });
  await ctx.status();
  await ctx.own!.take(cell, 'fletching_table', { stay: true, pickup: false });
  const calm = p.log.length;
  p.set(cell, 'fletching_table');
  p.mine(cell);
  await ctx.own!.take(cell, 'fletching_table', { stay: true, pickup: false });
  t.deepEqual(p.log.slice(calm).map(e => e.name), ['status', 'world.block', 'dig.here', 'protect.set']);
});

// ------------------------------------------------------------------------------------------------ the leak-seeking villager

/** The villagers that are neither in the hall's box nor in the lock's: out. */
const outside = (p: Pasture) => p.villagers.filter(v => {
  const c = { x: Math.floor(v.position.x), y: Math.floor(v.position.y), z: Math.floor(v.position.z) };
  const inHall = c.x >= HALL.x && c.x < HALL.x + HALL.width && c.z >= HALL.z && c.z < HALL.z + HALL.length;
  const l = lockOf(p.world);
  return !!v.dim || !(inHall || (l && ((c.x >= l.box.x1 && c.x <= l.box.x2 && c.z >= l.box.z1 && c.z <= l.box.z2) || key(c) === key(P))));
});

test('the leak-seeking villager leaves by any open way: awake and within 6 of an open gate with a way through it, it is out, every time', (t) => {
  t.is(LEAK_R, 6);
  // the hall with no lock, a player's click on its gate, the bot at home: out and walking on within two seconds
  const p = yard({ lock: false });
  const v = p.villager({ at: INSIDE });
  p.advance(100);
  t.deepEqual(outside(p), [], 'a shut gate, however near: it stays');
  p.swing(H, true, 'a player');
  p.advance(40);
  t.deepEqual(p.leaks.map(l => [l.uuid, l.gate]), [[v.uuid, H]]);
  t.deepEqual(outside(p), [v]);
  t.true(v.position.z >= H.z + 2, 'through it and on, the way it was going');
  // not one that sleeps, not one that stands still, not one more than 6 from the gate; the nearer of two is no luckier
  const q = yard({ lock: false });
  const abed = q.villager({ at: at(-556, 63, 2132), sleeping: true }), calm = q.villager({ at: at(-555, 63, 2132), mind: 'still' });
  const far = q.villager({ at: at(-560, 63, 2128) }), a = q.villager({ at: at(-557, 63, 2131) }), b = q.villager({ at: at(-554, 63, 2129) });
  q.swing(H, true, 'a player');
  q.advance(60);
  t.deepEqual(outside(q), [a, b]);
  // (woken, or come nearer, it goes too)
  abed.sleeping = false;
  far.position = { x: -556.5, y: 63, z: 2129.5 };
  q.advance(60);
  t.deepEqual(outside(q), [abed, far, a, b]);
  t.deepEqual(outside(q).includes(calm), false);
  // an open gate with no way through it is no leak: the build's plug, two dirt in H's outer cell (4.8)
  const plug = yard({ lock: false });
  plug.villager({ at: INSIDE });
  plug.set(at(H.x, 63, H.z + 1), 'dirt');
  plug.set(at(H.x, 64, H.z + 1), 'dirt');
  plug.swing(H, true, 'the builder\'s walk');
  plug.advance(200);
  t.deepEqual(outside(plug), []);
  t.deepEqual(plug.leaks, []);

  // the lock: H open behind a shut P, it comes as far as the lock and no farther (contained); P open too, it is in the yard
  const l = yard();
  const w = l.villager({ at: INSIDE });
  l.swing(H, true, 'a player');
  l.advance(200);
  t.deepEqual(l.leaks.map(e => e.gate), [H]);
  t.deepEqual(outside(l), []);
  l.swing(P, true, 'a player');
  l.advance(60);
  t.deepEqual(l.leaks.map(e => e.gate), [H, P]);
  t.deepEqual(outside(l), [w]);
  // and on through the next open gate it comes to: the ring's, were it left open. Inside the ring nothing stands
  // between it and the portal: into the portal's cells it is gone from this world
  const n = yard();
  const ring = n.world.zones!['ring:gate'][0];
  const lit = at(-560, 64, 2147);
  const lost = n.villager({ at: at(ring.x, 63, ring.z + 3) });
  t.falsy(n.villagerWay(at(ring.x, 63, ring.z + 3), c => key(c) === key(lit)), 'the ring shut: no way to the portal');
  t.truthy(yard({ ring: false }).villagerWay(at(ring.x, 63, ring.z + 3), c => key(c) === key(lit)), 'no ring: a way into it');
  n.swing(ring, true, 'a player');
  n.advance(60);
  t.deepEqual(n.leaks.map(e => e.gate), [ring]);
  t.true(lost.position.z < ring.z && !lost.dim, 'inside the ring');
  Object.assign(lost, { mind: 'home', home: lit });
  n.advance(120);
  t.is(lost.dim, 'nether');
});

test('it follows the bot through H: with no lock it is out behind the bot; with the lock, the pair and the guard it gets no farther than the lock', async (t) => {
  // the hall as it stood live: the bot walks out by its gate, the villager behind it
  const bare = yard({ lock: false, at: at(-556, 63, 2131) });
  const v = bare.villager({ at: at(-555, 63, 2130) });
  t.like(await call(bare, 'goto', { x: -556, y: 63, z: 2142, range: 0, careful: true }), { arrived: true });
  t.deepEqual(changes(bare, H), ['the bot\'s walk', 'shut (closer)'], 'the gate was shut behind the bot as always');
  t.deepEqual(outside(bare), [v], 'and the villager was through it by then');
  t.deepEqual(bare.leaks.map(l => l.gate), [H]);

  // the same walk with the lock standing and the bridge's strict set, pair and guard live
  const p = yard({ at: at(-556, 63, 2131) });
  await strict(p);
  const w = p.villager({ at: at(-555, 63, 2130) });
  t.like(await call(p, 'goto', { x: -556, y: 63, z: 2142, range: 0, careful: true }), { arrived: true });
  // H shut by the pair the tick P opened, P by the guard the tick the bot was out of its cell with the villager in the box
  t.deepEqual(changes(p, H), ['the bot\'s walk', 'shut (pair)']);
  t.deepEqual(changes(p, P), ['the bot\'s walk', 'shut (guard)']);
  p.advance(400);
  t.deepEqual(outside(p), []);
  t.like(lock(p).box, { x1: -557, x2: -555 });
  t.true(w.position.z > H.z && w.position.z < P.z, 'in the lock');
  // never an instant with both open, on any tick of it
  const open = new Map<string, boolean>();
  let both = 0;
  for (const c of p.changed.filter(e => [key(P), key(H)].includes(key(e.at)))) { open.set(key(c.at), isOpen(c.to)); if (open.get(key(P)) && open.get(key(H))) both += c.t; }
  t.is(both, p.changed.find(c => key(c.at) === key(P))!.t, 'but the tick P opened, shut in the same');
  // and now no walk of the bot's opens P onto it: the guard shuts it as often as Baritone clicks it open
  t.like(await call(p, 'goto', { x: -556, y: 63, z: 2131, range: 0, careful: true }), { arrived: false, at: at(-556, 63, 2138) });
  t.false(isOpen(p.get(P)));
  t.deepEqual(outside(p), []);
  t.true((await call<{ clicks: { guard: number } }>(p, 'gates.status')).clicks.guard >= 3);
  // H opened from the post lets a resident back in (care's row 4; P is never opened for it): one that goes home to its
  // block walks in at the game's pace, the lock empties, H is shut, and the way in is the bot's again
  p.bot.at = { ...lock(p).post };
  Object.assign(w, { mind: 'home', home: at(-553, 63, 2128) });
  await call(p, 'useOn', { ...H });
  p.advance(200);
  t.deepEqual({ x: Math.floor(w.position.x), y: 63, z: Math.floor(w.position.z) }, at(-553, 63, 2128));
  t.false(isOpen(p.get(P)));
  await call(p, 'useOn', { ...H });
  t.deepEqual([isOpen(p.get(H)), isOpen(p.get(P))], [false, false]);
  t.like(await call(p, 'goto', { x: -556, y: 63, z: 2136, range: 0, careful: true }), { arrived: true });
  t.deepEqual(outside(p), []);
});

test('the bot is no wall: a leak-seeker walks through the very cell the bot stands in; the bot standing in the lock\'s open gate lets a follower out past the guard', async (t) => {
  const cell = (v: { position: Pos }) => at(Math.floor(v.position.x), Math.floor(v.position.y), Math.floor(v.position.z));
  // a corridor one wide, the bot standing in it between a leak-seeker and an open gate. In the game entities push,
  // they do not block: it goes through the bot's cell and out. `yields` is the courtesy the game does not have (it
  // waits behind the bot for good), a scenario's own to ask for
  const corridor = (over: Any = {}) => {
    const p = new Pasture({ at: at(0, 63, 0) });
    for (let z = -3; z <= 3; z++) for (const x of [-1, 1]) for (const y of [63, 64]) p.set(at(x, y, z), 'oak_planks');
    const gate = at(0, 63, 2);
    p.set(gate, 'oak_fence_gate[facing=south,open=true]');
    const v = p.villager({ at: at(0, 63, -2), ...over });
    let shared = false;
    for (let i = 0; i < 100 && !p.leaks.length; i++) { p.advance(1); shared ||= key(cell(v)) === key(p.bot.at); }
    return { p, v, gate, shared };
  };
  const through = corridor();
  t.true(through.shared, 'it stood in the bot\'s own cell on the way');
  t.deepEqual(through.p.leaks.map(l => [l.uuid, l.gate]), [[through.v.uuid, through.gate]]);
  t.true(through.p.tick <= 30, 'and was through the gate in a second and a half');
  const polite = corridor({ yields: true });
  t.false(polite.shared);
  t.deepEqual(polite.p.leaks, []);
  t.deepEqual(cell(polite.v), at(0, 63, -1), 'behind the bot, for good');

  // the lock: a walk out of the hall that ENDS in P's cell (a goal that stops there, a call made from there), a
  // resident behind the bot, the strict set, the pair and the guard live. The follower in the lock as P opens: the
  // guard shuts P as often as the walk clicks it, and the bot stays in. The follower a cell behind: the bot stands in
  // the open gate, the guard waits until it is out of the gate's cell (B7's rule: Gates.java's `inside`), and the
  // villager walks out through the bot's cell. Which it is depends on nothing but the phase of its step, so all five
  // are run: at one of them at the least it is out. No walk through the lock may stop in P's cell with P open
  t.regex(read('GateHolds.java'), /if \(busy \|\| !g\.loaded \|\| g\.powered \|\| g\.inside \|\| g\.eye > REACH\) return false;/);
  const stand = async (id: number, yields: boolean) => {
    const p = yard({ at: at(-556, 63, 2131) });
    await strict(p);
    const w = p.villager({ at: at(-555, 63, 2130), id, ...(yields ? { yields } : {}) });
    const r = await call<{ arrived: boolean }>(p, 'goto', { ...P, range: 0, careful: true });
    p.advance(100);
    return { p, w, arrived: r.arrived };
  };
  const guard = (p: Pasture) => changes(p, P).filter(how => how === 'shut (guard)').length;
  let stood = 0;
  for (let id = 9000; id < 9005; id++) {
    const { p, w, arrived } = await stand(id, false);
    if (!arrived) {
      t.deepEqual([p.bot.at, guard(p), isOpen(p.get(P)), outside(p)], [at(-556, 63, 2136), 3, false, []], String(id));
      continue;
    }
    stood++;
    t.deepEqual(p.bot.at, P, String(id));
    t.deepEqual(p.leaks.map(l => l.gate), [H, P], String(id));
    t.deepEqual(outside(p), [w], String(id));
    t.deepEqual([guard(p), isOpen(p.get(P))], [0, true], `${id}: P never clicked: the bot is in its cell`);
  }
  t.true(stood >= 1, 'at one phase of its step at the least the follower is a cell behind as P opens');
  // with the courtesy it waits in the lock for as long as the bot stands in the gateway, and the guard shuts P on the
  // tick the bot steps on: contained at every phase. The rows written on that were tested against the courtesy
  let waited = 0;
  for (let id = 9000; id < 9005; id++) {
    const { p, arrived } = await stand(id, true);
    t.deepEqual(outside(p), [], String(id));
    if (!arrived) continue;
    waited++;
    t.deepEqual([guard(p), isOpen(p.get(P))], [0, true], String(id));
    t.like(await call(p, 'goto', { x: -556, y: 63, z: 2140, range: 0, careful: true }), { arrived: true });
    t.deepEqual([changes(p, P).at(-1), isOpen(p.get(P)), outside(p)], ['shut (guard)', false, []], String(id));
  }
  t.is(waited, stood);
});

// ------------------------------------------------------------------------------------------------ the builder, the real ground

test('build-structure puts down what is missing out of the pockets, says so, and its blocks are the bot\'s own; its walk opens what gate it will', async (t) => {
  const p = yard({ lock: false });
  const bp = hallLock(), gate = bp.landmarks.find(l => l.kind === 'gate')!.at;
  const origin = at(P.x - gate.x, YARD.y, P.z - gate.z);
  t.like(await p.ctx.act('build-structure', { ...origin, spec: bp.spec, name: bp.name }), { ok: false, text: 'Failed: Not enough blocks to build it. Missing: oak_fence_gate 0/1' });
  t.is(p.get(P), 'air');
  p.give('oak_fence_gate');
  p.give('torch');
  const planks = p.count('oak_planks');
  const r = await p.ctx.act('build-structure', { ...origin, spec: bp.spec, name: bp.name });
  t.true(r.ok);
  t.regex(r.text, /^Built hall-lock at \(-558, 62, 2135\) in \d+s: all (\d+) blocks in place\.$/);
  t.true(p.tick > 100, 'a build takes its minutes');
  // as the yard has it standing, but the sill and the zones: those are the shells goal's to lay and to write
  const stands = yard();
  for (let x = -558; x <= -554; x++) for (let z = 2135; z <= 2137; z++) for (let y = 63; y <= 65; y++) t.is(p.get(at(x, y, z)), stands.get(at(x, y, z)), key(at(x, y, z)));
  t.is(lockOf(p.world), undefined);
  t.true(p.protection.has(key(P)) && p.protection.has('-554,63,2135'));
  t.deepEqual([p.count('oak_fence_gate'), p.count('torch'), planks - p.count('oak_planks')], [0, 0, 31]);
  // again: nothing is missing, nothing is taken
  t.true((await p.ctx.act('build-structure', { ...origin, spec: bp.spec, name: bp.name })).ok);
  t.is(planks - p.count('oak_planks'), 31);
  // the builder is Baritone's: a gate in its way is opened and left to the closer. With a resident awake and no plug
  // in H's outer cell that is a way out for the minutes of the build (I-26)
  const q = yard({ lock: false });
  q.give('oak_fence_gate');
  q.give('torch');
  const v = q.villager({ at: INSIDE });
  q.builderOpens = [H];
  await q.ctx.act('build-structure', { ...origin, spec: bp.spec, name: bp.name });
  t.deepEqual(q.leaks.map(l => l.uuid), [v.uuid]);
});

test('the real ground: the west village as the bot read it (tests/fixtures/west-village.json), in the shape Ground.fromDump reads', (t) => {
  const f = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'west-village.json'), 'utf8')) as {
    box: { x1: number; z1: number; x2: number; z2: number; y1: number; y2: number }; unread: { x1: number; x2: number }; site: Pos; yard: typeof YARD;
    lures: { l0: Pos }; look: { bells: Pos[]; beds: Pos[]; jobs: { name: string; at: Pos }[]; villagers: { id: number; position: Pos; profession: string }[] };
    ground: { y0: number; height: number; cols: Record<string, (string | null)[]> };
  };
  // the trimmed copy of rails-debug/2026-11-23T13-40-18-751Z-extension.json: the dump's ground whole, x -786..-629, z 2186..2338
  t.deepEqual(f.box, { x1: -786, z1: 2186, x2: -629, z2: 2338, y1: 60, y2: 84 });
  t.is(Object.keys(f.ground.cols).length, (f.box.x2 - f.box.x1 + 1) * (f.box.z2 - f.box.z1 + 1));
  t.deepEqual([f.ground.y0, f.ground.height], [60, 25]);
  t.true(Object.values(f.ground.cols).every(col => col.length === 25));
  t.deepEqual(f.yard, YARD);
  t.is(YARD.x1 - f.box.x2, 64, 'it ends 64 short of the yard');
  // the village: its bell, nine beds, three composters, six villagers of whom four have no job
  t.deepEqual(f.look.bells, [f.site]);
  t.deepEqual([f.look.beds.length, f.look.jobs.map(j => j.name), f.look.villagers.filter(v => v.profession === 'none').length, f.look.villagers.length], [9, ['composter', 'composter', 'composter'], 4, 6]);
  const g = Ground.fromDump(f.ground);
  // L0, where the first table went down live: level grass under open sky
  const l0 = f.lures.l0;
  t.deepEqual(l0, at(-675, 71, 2249));
  t.is(g.state(l0.x, l0.y - 1, l0.z), 'grass_block[snowy=false]');
  for (let y = l0.y; y <= 84; y++) t.is(g.state(l0.x, y, l0.z), 'air');
  t.is(g.cell(l0.x, l0.y - 1, l0.z).kind, 'solid');
  // the twelve columns east of x -641 were not loaded: unread, a wall to every plan
  t.true(g.has(-641, 2250) && !g.has(-640, 2250) && !g.has(f.box.x2, f.box.z2));
  t.is(g.state(-640, 70, 2250), null);
  t.is(g.cell(-630, 70, 2250).kind, 'unknown');
  // and as a pasture's ground: the same blocks, null where it was not read, a villager's way over the grass by L0
  const p = new Pasture({ base: dumpBase(f.ground), at: l0 });
  t.is(p.get(at(l0.x, l0.y - 1, l0.z)), 'grass_block[snowy=false]');
  t.deepEqual(p.region(at(-641, 70, 2250), 2, 1, 1).map(b => b === null), [false, true]);
  t.truthy(p.villagerWay(l0, c => Math.hypot(c.x - l0.x, c.z - l0.z) >= 8));
  t.is(p.loaded(at(0, 63, 0)), false, 'nothing is read beyond the dump');
});

// ------------------------------------------------------------------------------------------------ the reference villagers (S1)

// The game's own villager (mind 'game'), written apart from villagerwalk.ts with the 26.3 jar's numbers, held to what
// the lead saw it do live (E-results): the hops of the leapfrog, the first lure on the west village's real ground,
// two tables and two villagers, the workshop's smithing table, the bell at 9000, the bed at 12000, the gate left open.
// What it does here is the game's rules as R3 read them; where the live record and the rules part, the row says so.

/** A lure down or up as the world's own change: the reference villager meets the block, and the bot's acts are the lure's tests'. */
const down = (p: Pasture, c: Pos, block = 'fletching_table') => p.set(c, block, 'placed');
const dug = (p: Pasture, c: Pos) => p.set(c, 'air', 'dug');
/** Ticks until `done`, at most `max` (undefined: not by then). */
const until = (p: Pasture, done: () => boolean, max: number): number | undefined => {
  for (let n = 0; n <= max; n++) { if (done()) return n; p.advance(1); }
  return undefined;
};
const cellAt = (v: { position: Pos }) => at(Math.floor(v.position.x), Math.floor(v.position.y), Math.floor(v.position.z));
const flat = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const game = (p: Pasture, where: Pos, over: Partial<Villager> = {}) => p.villager({ at: where, mind: 'game', ...over });
const mid = (c: Pos): Pos => ({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });
const seconds = (ticks: number | undefined) => (ticks === undefined ? Infinity : ticks / 20);
const WEST_BELL = at(-693, 69, 2262);
const WEST_BED = at(-699, 76, 2243);

test('the reference villagers\' numbers are the 26.3 jar\'s (R3: AcquirePoi, PathFinder, WalkNodeEvaluator, the schedule) and the walk seen live (E8: 2 b/s)', (t) => {
  t.like(GAME, {
    LOOK: 20, LOOK_JITTER: 20, SITES: 5, SITE_R: 48, PATH: 48, NODES: 768, RETRY: 40, RETRY_JITTER: 40, RETRY_MAX: 400, RETRY_FORGET: 400,
    REACH: 1, BELL_REACH: 6, FLIP: 2, VALIDATE: 16, GIVE_UP: 1200, RISE: 1.125, DROP: 3, HEIGHT: 1.95, WALK_BPS: 2, LEG: 15, LEG_UP: 7, STROLL: 10, SLEEP: 2
  });
  t.deepEqual([GAME.WORK, GAME.MEET, GAME.HOME], [{ close: 9, far: 100, lost: 1200 }, { close: 6, far: 100, lost: 200 }, { close: 1, far: 150, lost: 1200 }]);
  // villager_schedule.json: an adult idles from 10, works from 2000, meets from 9000, idles from 11000, rests from 12000
  const day = [0, 9, 10, 1999, 2000, 8999, 9000, 10_999, 11_000, 11_999, 12_000, 23_999].map(tod => villagerSchedule(tod));
  t.deepEqual(day, ['rest', 'rest', 'idle', 'idle', 'work', 'work', 'meet', 'meet', 'idle', 'idle', 'rest', 'rest']);
  t.deepEqual([2999, 3000, 6000, 10_000].map(tod => villagerSchedule(tod, true)), ['idle', 'play', 'idle', 'play']);
  // what makes it run, and from how near (VillagerHostilesSensor); the job blocks and what each makes of it
  t.like(HOSTILE, { zombie: 8, husk: 8, drowned: 8, zombie_villager: 8, vex: 8, vindicator: 10, zoglin: 10, evoker: 12, illusioner: 12, ravager: 12, pillager: 15 });
  t.deepEqual(['skeleton', 'creeper', 'spider', 'witch', 'player'].filter(n => n in HOSTILE), []);
  t.like(PROFESSION_OF, { fletching_table: 'fletcher', lectern: 'librarian', smithing_table: 'toolsmith', composter: 'farmer', brewing_stand: 'cleric', water_cauldron: 'leatherworker' });
  t.is(new Set(Object.values(PROFESSION_OF)).size, 13);
  // the walk: a site claimed 20 cells off on the lawn is reached in 10 s; the claim came within the 20 ticks of its first look
  const p = new Pasture({ tod: 1000, at: at(0, 63, 4) });
  const v = game(p, at(0, 63, 0), { id: 3 });
  const lure = at(21, 63, 0);
  down(p, lure);
  t.true(until(p, () => p.claims.length > 0, 20)! <= 20);
  const from = p.tick;
  t.true(until(p, () => v.profession === 'fletcher', 400)! > 0);
  const walked = (p.tick - from) / 20;
  t.true(walked >= 9.5 && walked <= 10.5, `${walked} s for 20 cells`);
  t.deepEqual(p.flips.map(f => [f.uuid, f.at, f.profession]), [[v.uuid, lure, 'fletcher']]);
  t.true(flat(v.position, { x: lure.x + 0.5, z: lure.z + 0.5 }) < GAME.FLIP, 'within 2.0 of its middle');
  t.is(p.tickets.get(key(lure)), v.uuid, 'its ticket');
});

test('the leapfrog on the lawn: hops of 22, 23 (3 up, single steps), 24 and 25 blocks arrive in 4-18 s (E8: 8.5, 6.1, 6.7, 10.9 s), jobless at once on the break', (t) => {
  const p = new Pasture({ tod: 64, at: at(0, 63, 4) });
  // three single steps up between the first and second hop's lures: a terrace 3 up from x 30 on
  for (let x = 26; x <= 130; x++) for (let z = -6; z <= 6; z++) for (let y = 63; y <= 62 + Math.min(3, Math.floor((x - 24) / 2)); y++) p.set(at(x, y, z), 'dirt');
  const v = game(p, at(0, 63, 0), { id: 7 });
  let lure = at(4, 63, 0);
  down(p, lure);
  t.truthy(until(p, () => v.profession === 'fletcher', 400));
  const hops: { len: number; s: number }[] = [];
  for (const [dx, y] of [[22, 63], [23, 66], [24, 66], [25, 66]]) {
    // the break with the ward by it (the lure is its job site): jobless on the very tick
    t.true(flat(v.position, lure) < GAME.VALIDATE);
    dug(p, lure);
    p.advance(1);
    t.deepEqual([v.profession, v.job], ['none', undefined]);
    // the next one down a second on, as the bot that already stands there does; the hop measured from where the ward is
    p.advance(20);
    const next = at(lure.x + dx, y, 0);
    down(p, next);
    hops.push({ len: Math.round(flat(v.position, next)), s: seconds(until(p, () => v.profession === 'fletcher', 600)) });
    lure = next;
  }
  t.log(hops.map(h => `${h.len} blocks: ${h.s} s`).join(', '));
  for (const h of hops) t.true(h.len >= 20 && h.len <= 27 && h.s >= 4 && h.s <= 18, `${h.len} blocks in ${h.s} s`);
  t.is(lure.y, 66, 'and up the three single steps');
  t.is(p.flips.length, 5);
});

test('the bot\'s cycle as live (5 s from the break to the place, the ward on its own meanwhile): never under 4 s, a median of 12-13 s, a stroll back makes the slowest', (t) => {
  // the game's idle villager strolls (legs of 10) and walks after the player it looks at; at the design's 2 b/s a ward
  // that strolled 6-10 back before the place walks 30 and more: what the live hops (4-18 s) never showed at 22-25.
  // The game's derived pace (R3: 2.7 b/s) would put every one of these inside 4-15 s
  const all: number[] = [];
  for (let id = 1; id <= 12; id++) {
    const p = new Pasture({ tod: 64, at: at(0, 63, 3) });
    const v = game(p, at(0, 63, 0), { id });
    let lure = at(4, 63, 0);
    down(p, lure);
    until(p, () => v.profession === 'fletcher', 400);
    for (const len of [22, 23, 24, 25]) {
      dug(p, lure);
      const next = at(lure.x + len, 63, 0);
      for (let i = 0; i < len - 2; i++) { p.bot.at = at(lure.x + i, 63, 3); p.advance(5); }
      down(p, next);
      all.push(seconds(until(p, () => v.profession === 'fletcher', 1000)));
      lure = next;
    }
  }
  all.sort((a, b) => a - b);
  const median = all[all.length >> 1], within = all.filter(s => s <= 18).length / all.length;
  t.log(`48 hops: ${all[0]} s at the quickest, ${median} s the median, ${all.at(-1)} s the slowest; ${Math.round(within * 100)} % within 18 s`);
  t.true(all[0] >= 4 && median >= 10 && median <= 15 && within >= 0.85 && all.at(-1)! <= 22);
});

/** The fixture's ground, read once for the file (its POI scan with it). */
let westBase: ReturnType<typeof dumpBase> | undefined;
const westVillage = () => {
  const f = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'west-village.json'), 'utf8')) as { site: Pos; lures: { l0: Pos }; look: { jobs: { at: Pos }[] }; ground: Parameters<typeof dumpBase>[0] };
  westBase ??= dumpBase(f.ground);
  return { f, base: westBase };
};

test('on the real ground (the fixture): E8\'s first lure, the house\'s villager 24 off and 5 up woken at dawn: a fletcher in 4-18 s (live 13.3 s); then a hop of 22 down the slope in 4-18 s; the farmers keep their composters', (t) => {
  const { f, base } = westVillage();
  const l0 = f.lures.l0;
  t.true(base.pois.some(q => key(q) === key(WEST_BED)) && base.pois.some(q => key(q) === key(f.site)), 'the dump\'s beds and bell are in the POI store');
  const p = new Pasture({ base, tod: 0, at: at(l0.x - 3, l0.y, l0.z + 3) });
  // the house's villager asleep in its bed, the three farmers at the three composters (Nov 24: 3 farmers, 4 unemployed)
  const ward = game(p, WEST_BED, { id: 3_464_482, bed: WEST_BED, bell: { ...f.site }, sleeping: true });
  const farmers = f.look.jobs.map((j, i) => game(p, at(j.at.x + 1, j.at.y, j.at.z), { id: 3_464_520 + i, profession: 'farmer', job: { ...j.at }, bell: { ...f.site } }));
  p.advance(64);
  t.false(ward.sleeping, 'awake from 10');
  const off = flat(ward.position, l0);
  t.true(off >= 18 && off <= 26 && ward.position.y - l0.y >= 3, `${fmt(cellAt(ward))}: ${off.toFixed(1)} off, ${ward.position.y - l0.y} up`);
  down(p, l0);
  const first = seconds(until(p, () => ward.profession === 'fletcher', 600));
  t.log(`the first lure: ${first} s from ${off.toFixed(1)} off (live 13.3 s from 23 off)`);
  t.true(first >= 4 && first <= 18, `${first} s (live 13.3 s)`);
  // the leapfrog's next hop, 22 east and 4 down the hillside
  const next = at(-653, 67, 2248);
  dug(p, l0);
  p.advance(20);
  t.is(ward.profession, 'none');
  down(p, next);
  const hop = seconds(until(p, () => ward.profession === 'fletcher', 600));
  t.true(hop >= 4 && hop <= 18, `${hop} s`);
  t.deepEqual(farmers.map(v => [v.profession, key(v.job!)]), f.look.jobs.map(j => ['farmer', key(j.at)]));
  t.deepEqual(p.claims.filter(c => c.kind === 'job').map(c => c.uuid), [ward.uuid, ward.uuid], 'nobody else claimed a lure');
});

test('two tables hold two villagers, one each (E8): the second taken by the second adult with the first standing; at work each keeps by its own, and a third takes neither', (t) => {
  const p = new Pasture({ tod: 1500, at: at(0, 63, 6) });
  const a = game(p, at(0, 63, 0), { id: 11 }), b = game(p, at(2, 63, 2), { id: 12 });
  const t1 = at(6, 63, 0), t2 = at(34, 63, 0);
  down(p, t1);
  t.truthy(until(p, () => a.profession === 'fletcher' || b.profession === 'fletcher', 400));
  const [first, second] = a.profession === 'fletcher' ? [a, b] : [b, a];
  p.advance(200);
  t.is(second.profession, 'none', 'the first table is not free: its ticket is held');
  down(p, t2);
  t.truthy(until(p, () => second.profession === 'fletcher', 600));
  t.deepEqual([key(first.job!), key(second.job!)], [key(t1), key(t2)]);
  t.deepEqual([p.tickets.get(key(t1)), p.tickets.get(key(t2))], [first.uuid, second.uuid]);
  const third = game(p, at(20, 63, 2), { id: 13 });
  // through the work hours: each walks back to within 9 (Manhattan) of its block and strolls round it (legs of 8 from
  // within 4: up to 12 off), and the third looks and finds no free site
  p.advance(3000 - p.tod);
  let far = 0;
  for (; p.tod < 8900; p.advance(20)) far = Math.max(far, flat(first.position, mid(t1)), flat(second.position, mid(t2)));
  t.true(far <= 12.5, `${far} off at the most`);
  t.deepEqual([first.profession, second.profession, third.profession], ['fletcher', 'fletcher', 'none']);
  t.deepEqual(p.claims.filter(c => c.uuid === third.uuid && c.kind === 'job'), []);
});

test('the workshop\'s smithing table takes the ward (E8, three times): jobless between hops it claims the free site within 48 before the next lure is down; lifted 27 off nothing changes, within 16 it is jobless at once and takes the lure', (t) => {
  const p = yard({ tod: 1200, at: at(-549, 63, 2188) });
  // the yard hop north along its path: the ward a fletcher at a lure 20 inside the south gate, the workshop's table 36 off
  const l1 = at(-549, 63, 2190), l2 = at(-549, 63, 2166);
  down(p, l1);
  const v = game(p, at(-549, 63, 2192), { id: 21, bell: { ...WEST_BELL }, bed: { ...WEST_BED } });
  t.truthy(until(p, () => v.profession === 'fletcher', 400));
  t.true(flat(v.position, SMITHING) < GAME.SITE_R);
  dug(p, l1);
  // the bot picks the drop up and walks the 24 on: five seconds, in which the jobless ward looks two or three times
  p.advance(100);
  down(p, l2);
  t.truthy(until(p, () => v.profession !== 'none', 1200));
  t.is(v.profession, 'toolsmith', 'the smithing table, not the lure');
  t.deepEqual(v.job, SMITHING);
  t.is(p.tickets.get(key(l2)), undefined, 'the lure free all along');
  // the lead lifted the table with the ward 27 off (it was before 2000: employed, it strolls): no effect
  p.advance(100);
  v.position = { x: SMITHING.x + 0.5, y: 63, z: SMITHING.z + 27.5 };
  v.ai!.walk = undefined;
  dug(p, SMITHING);
  p.advance(40);
  t.deepEqual([v.profession, key(v.job!)], ['toolsmith', key(SMITHING)], 'a job site gone 27 off is not noticed');
  // within 16 of the cell it is jobless at once, and the lure, free and within reach, is what it takes then
  v.position = { x: SMITHING.x + 0.5, y: 63, z: SMITHING.z + 10.5 };
  v.ai!.walk = undefined;
  p.advance(1);
  t.deepEqual([v.profession, v.job], ['none', undefined]);
  t.truthy(until(p, () => v.profession === 'fletcher', 800));
  t.deepEqual(v.job, l2);
  // at work the game walks a toolsmith whose table is gone back toward it: once within 16 it is jobless too. (E8 saw no
  // reset after the lift 27 off; the hour of the lift is not recorded, and before 2000 an employed villager strolls)
  const q = yard({ tod: 2100, at: at(-549, 63, 2188) });
  const w = game(q, at(SMITHING.x, 63, SMITHING.z + 27), { id: 22, profession: 'toolsmith', job: { ...SMITHING } });
  dug(q, SMITHING);
  t.truthy(until(q, () => w.profession === 'none', 600));
  t.true(flat(w.position, SMITHING) < GAME.VALIDATE);
  // two free sites at the same look: the nearer by the way wins (one search to the set)
  const r = yard({ tod: 1200, at: at(-549, 63, 2188) });
  const near = at(-544, 63, 2160);
  const u = game(r, at(-546, 63, 2162), { id: 23 });
  down(r, near);
  t.truthy(until(r, () => u.profession !== 'none', 400));
  t.deepEqual([u.profession, u.job], ['fletcher', near]);
});

test('the bell at 9000 pulls a villager fresh from its village (E8): it leaves its lure for the bell by any way its search allows; the shut yard holds it at the west fence; over the bot\'s stair and a bridge it is out', (t) => {
  // employed at a lure by the west side of the yard, the west village's bell 180 off
  const ward = (p: Pasture, lure: Pos, over: Partial<Villager> = {}) => {
    down(p, lure);
    return game(p, at(lure.x + 1, lure.y, lure.z), { id: 31, profession: 'fletcher', job: { ...lure }, bell: { ...WEST_BELL }, bed: { ...WEST_BED }, ...over });
  };
  const shut = yard({ tod: 8800, crossings: false, at: at(-550, 63, 2186) });
  const lure = at(-552, 63, 2186);
  const v = ward(shut, lure);
  let before = 0;
  for (; shut.tod < 9000; shut.advance(10)) before = Math.max(before, flat(v.position, mid(lure)));
  t.true(before <= 12.5, 'at work: by its block');
  let west = Infinity, gone = 0;
  for (; shut.tod < 10_900; shut.advance(10)) { west = Math.min(west, v.position.x); gone = Math.max(gone, flat(v.position, mid(lure))); }
  t.true(gone > 9, `left its lure (${gone.toFixed(1)} off)`);
  t.true(west < -561, `to the west fence (x ${west})`);
  t.true(v.position.x > YARD.x1 && !v.dim, 'held');
  t.log(`at 10900 its bell ${v.bell ? 'still pulls' : 'is forgotten'}`);
  t.deepEqual(shut.leaks, []);
  // the staircase by the west gate (63 -> 67, as live) and the five-block bridge over the gate it led to, with a way
  // down the bank outside: at 9000 it is over the fence
  const open = yard({ tod: 8900, at: at(-552, 63, 2186) });
  for (let x = -567; x <= -563; x++) open.set(at(x, 66, 2183), 'cobblestone');
  for (const [x, top] of [[-568, 65], [-569, 64], [-570, 63]]) for (let y = 63; y <= top; y++) open.set(at(x, y, 2183), 'cobblestone');
  const w = ward(open, at(-558, 63, 2185), { id: 32 });
  t.truthy(until(open, () => w.position.x < YARD.x1 - 1, 2400), 'out over the bridge');
  t.true(open.tod > 9000);
  // a villager days away from its village has no bell: 9000 is nothing to it, and at 9250 it walks to a lure (E8: 9253)
  const settled = yard({ tod: 9250, at: at(-550, 63, 2186) });
  const s = game(settled, at(-552, 63, 2190), { id: 33 });
  down(settled, at(-552, 63, 2172));
  t.truthy(until(settled, () => s.profession === 'fletcher', 600));
  // a fresh one at the same hour claims nothing it walks to: GoToPotentialJobSite starts only at idle, work or play
  const fresh = yard({ tod: 9250, at: at(-550, 63, 2186) });
  const u = game(fresh, at(-552, 63, 2190), { id: 34, bell: { ...WEST_BELL }, bed: { ...WEST_BED } });
  down(fresh, at(-552, 63, 2172));
  fresh.advance(600);
  t.is(u.profession, 'none');
  t.true(flat(u.position, at(-552, 63, 2172)) > 8);
});

test('in the lock at 9000 the bell pulls in vain: contained by its six cells; a bell within 100 is a target it cannot reach and is forgotten in 200 ticks (R3), one farther is walked toward in legs', (t) => {
  const p = yard({ tod: 8950, at: at(-553, 63, 2136) });
  const l = lock(p);
  // the ward in the lock, P and H shut (the lure in the socket's place)
  const near = at(-600, 63, 2150);
  p.set(near, 'bell');
  const v = game(p, at(-556, 63, 2136), { id: 41, bell: { ...near }, bed: { ...WEST_BED } });
  const w = game(p, at(-555, 63, 2135), { id: 42, bell: { ...WEST_BELL }, bed: { ...WEST_BED } });
  t.truthy(until(p, () => v.bell === undefined, 600), 'the near bell forgotten');
  t.true(p.tod > 9000 + 200 && p.tod < 9000 + 400, `at ${p.tod}`);
  p.advance(10_950 - p.tod);
  const inside = (u: Villager) => { const c = cellAt(u); return c.x >= l.box.x1 && c.x <= l.box.x2 && c.z >= l.box.z1 && c.z <= l.box.z2; };
  t.true(inside(v) && inside(w), 'both still in the lock at 10950');
  t.deepEqual(p.leaks, []);
});

test('out by an open gate in 4 s (E8, trip 2): at 9000 the bell takes a fresh ward out of the hall by the gate left open; with the lock it gets no farther than the lock; the leak at night (the table dug with the gate open) is the worst case\'s', (t) => {
  // the table the lead put in the hall from the gateway, the ward a fletcher at it, H standing open at 9000
  const table = at(-558, 63, 2131);
  const bare = yard({ lock: false, tod: 8990, at: at(-556, 63, 2138) });
  down(bare, table);
  const v = game(bare, at(-557, 63, 2131), { id: 51, profession: 'fletcher', job: { ...table }, bell: { ...WEST_BELL }, bed: { ...WEST_BED } });
  bare.swing(H, true, 'the lead');
  bare.advance(10);
  t.is(bare.tod, 9000);
  const out = until(bare, () => bare.leaks.some(e => e.uuid === v.uuid), 200);
  t.true(seconds(out) <= 4, `out by H in ${seconds(out)} s`);
  t.true(v.position.z > H.z);
  // the lock standing: H open behind a shut P, it comes as far as the lock
  const p = yard({ tod: 8990, at: at(-553, 63, 2140) });
  down(p, table);
  const w = game(p, at(-557, 63, 2131), { id: 52, profession: 'fletcher', job: { ...table }, bell: { ...WEST_BELL }, bed: { ...WEST_BED } });
  p.swing(H, true, 'the lead');
  let lockSeen = false;
  for (let n = 0; n < 60; n++) { p.advance(10); lockSeen ||= w.position.z > H.z && w.position.z < P.z; }
  t.true(lockSeen && p.leaks.some(e => e.uuid === w.uuid && key(e.gate) === key(H)), 'out of the hall by H, into the lock');
  t.false(p.leaks.some(e => key(e.gate) === key(P)));
  t.deepEqual(outside(p), [], 'never in the yard');
  // the night the second villager was lost: asleep in a hall bed, its table 3 off dug from the gateway with H open. The
  // game's rules put it back to bed; the live record has it awake and out in the 4 s (the worst case: `leaks`)
  const night = (leaks: boolean) => {
    const q = yard({ lock: false, tod: 14_000, at: H });
    const bed = at(-558, 63, 2127), its = at(-557, 63, 2129);
    down(q, its);
    const u = game(q, bed, { id: 53, profession: 'fletcher', job: { ...its }, bed: { ...bed }, sleeping: true, ...(leaks ? { leaks } : {}) });
    q.swing(H, true, 'the lead');
    dug(q, its);
    // in for the drop and back out, the gate standing open behind the lead
    const walk = [at(-556, 63, 2133), at(-556, 63, 2132), at(-557, 63, 2131), at(-557, 63, 2130), at(-557, 63, 2131), at(-556, 63, 2132), at(-556, 63, 2133), H, at(-556, 63, 2135), at(-556, 63, 2136), at(-556, 63, 2137)];
    const from = q.tick;
    for (const c of walk) { q.bot.at = c; q.advance(5); }
    const left = until(q, () => q.leaks.some(e => e.uuid === u.uuid), 200);
    return { u, left: left === undefined ? undefined : q.tick - from };
  };
  const game1 = night(false), worst = night(true);
  t.deepEqual([game1.u.profession, worst.u.profession], ['none', 'none'], 'jobless at once, within 16');
  t.is(game1.left, undefined, 'the game\'s own rules: back to its bed');
  t.true(seconds(worst.left) <= 4, `the worst case: out in ${seconds(worst.left)} s`);
});

test('the bed at 12000 (E8): fresh from its village it heads for its bed there, unreachable from the shut yard; 1200 ticks of no way and it takes the nearest free bed within 48 and sleeps (live: the bot\'s bed at 13620); from 12000 it walks to no lure, at dawn it does', (t) => {
  const p = yard({ tod: 11_950, crossings: false, at: at(-545, 63, 2188) });
  dug(p, SMITHING);
  const bot = at(-537, 63, 2193);
  p.set(bot, 'red_bed[facing=north,occupied=false,part=head]');
  p.set(at(-537, 63, 2194), 'red_bed[facing=north,occupied=false,part=foot]');
  const v = game(p, at(-556, 63, 2190), { id: 61, bell: { ...WEST_BELL }, bed: { ...WEST_BED } });
  p.advance(200);
  // a lure 8 off the bot's bed, down at night: claimed or not, not walked to
  const lure = at(-541, 63, 2187);
  down(p, lure);
  // (from the west fence a leg toward the bed that lands inside the yard is reached and starts the 1200 again: when it
  // gives up is the legs' luck; live it was 80 s into the night)
  t.truthy(until(p, () => v.sleeping, 11_800), 'asleep before dawn');
  t.log(`asleep at ${p.tod} (live 13620)`);
  t.true(p.tod >= 13_200 && p.tod < 23_990, `at ${p.tod}`);
  t.deepEqual(v.bed, bot);
  t.is(v.profession, 'none', 'no lure taken at night');
  t.deepEqual(p.claims.filter(c => c.kind === 'bed').map(c => key(c.at)), [key(bot)]);
  // dawn: awake at 10, and the lure taken
  p.advance(24_000 - p.tod + 5);
  t.true(v.sleeping);
  t.truthy(until(p, () => v.profession === 'fletcher', 800));
  t.true(p.tod > 10 && p.tod < 900);
});

test('the game\'s walker: single steps and never two, a fall of 3 and not 4, a fence top only from a block beside it; doors pass, shut gates, fences, lava and rails are walls (on a rail it crosses rails), water passes; 48 walked at the most', (t) => {
  const lawn = () => new Pasture({ tod: 1000, at: at(0, 63, 6) });
  const way = (p: Pasture, from: Pos, to: Pos, o: { onRail?: boolean } = {}) => p.gamePath(from, [to], GAME.REACH, o).reached;
  const wall = (p: Pasture, x: number, block: string, ys = [63, 64]) => { for (let z = -40; z <= 40; z++) for (const y of ys) p.set(at(x, y, z), block); };
  // a rise of one onto a block, of two never; a terrace with steps cut is a way
  const rise = lawn();
  for (let z = -12; z <= 12; z++) for (let x = 4; x <= 12; x++) { rise.set(at(x, 63, z), 'dirt'); rise.set(at(x, 64, z), 'dirt'); }
  t.false(way(rise, at(0, 63, 0), at(8, 65, 0)), 'a 2-high step');
  rise.set(at(3, 63, 0), 'dirt');
  t.true(way(rise, at(0, 63, 0), at(8, 65, 0)), 'cut to single steps');
  // falls: 3 down is a way (and no way back up), 4 is not
  for (const [h, ok] of [[3, true], [4, false]] as const) {
    const fall = lawn();
    for (let z = -12; z <= 12; z++) for (let x = -12; x <= 2; x++) for (let y = 63; y < 63 + h; y++) fall.set(at(x, y, z), 'dirt');
    t.is(way(fall, at(0, 63 + h, 0), at(8, 63, 0)), ok, `a fall of ${h}`);
    t.false(way(fall, at(8, 63, 0), at(0, 63 + h, 0)));
  }
  // a fence line: a wall; a block beside it is a way over its top (1.5: no rise from the ground, 0.5 from the block)
  const fence = lawn();
  wall(fence, 4, 'oak_fence', [63]);
  t.false(way(fence, at(0, 63, 0), at(8, 63, 0)));
  fence.set(at(3, 63, 0), 'cobblestone');
  t.true(way(fence, at(0, 63, 0), at(8, 63, 0)), 'over the fence by the block beside it');
  // a wall with a doorway: a wooden door passes (a villager opens it), an iron one, a shut gate, lava do not; an open gate does
  for (const [block, ok] of [['oak_door[half=lower,open=false]', true], ['iron_door[half=lower,open=false]', false], ['oak_fence_gate[open=false]', false], ['oak_fence_gate[open=true]', true], ['lava', false]] as const) {
    const door = lawn();
    wall(door, 4, 'stone', [63, 64, 65]);
    door.set(at(4, 63, 0), block);
    door.set(at(4, 64, 0), block.includes('door') ? block.replace('lower', 'upper') : 'air');
    t.is(way(door, at(0, 63, 0), at(8, 63, 0)), ok, block);
  }
  // a line of rails across the way: a wall to it from off the rails, none to one standing on one (UNPASSABLE_RAIL)
  const rails = lawn();
  for (let z = -40; z <= 40; z++) rails.set(at(4, 63, z), 'rail[shape=north_south]');
  t.false(way(rails, at(0, 63, 0), at(8, 63, 0)));
  t.true(way(rails, at(4, 63, 0), at(8, 63, 0), { onRail: true }));
  // water three wide passes (at its cost), as do the burning cells' neighbours; lava never
  const ford = lawn();
  for (let z = -12; z <= 12; z++) for (let x = 3; x <= 5; x++) { ford.set(at(x, 62, z), 'water'); ford.set(at(x, 61, z), 'water'); }
  t.true(way(ford, at(0, 63, 0), at(8, 63, 0)), 'water');
  // 48 walked at the most: a lure 6 straight off behind a wall whose way round is 50 is out of its reach
  const far = lawn();
  for (let z = -24; z <= 24; z++) for (const y of [63, 64]) far.set(at(3, y, z), 'stone');
  t.true(way(far, at(0, 63, 20), at(6, 63, 20)), 'round the wall\'s end, 4 + 3 + 4 + 3 + ...: under 48');
  t.false(way(far, at(0, 63, 0), at(6, 63, 0)), 'round from its middle: over 48');
  t.true(far.gamePath(at(0, 63, 0), [at(6, 63, 0)], GAME.REACH).visited <= GAME.NODES);
  // the lock's sill: from the yard no cell beside the socket stands (a rail in it), from inside the lock one does
  const p = yard({ tod: 1000, at: at(-553, 63, 2140) });
  const l = lock(p);
  p.set(l.socket, 'fletching_table');
  t.false(p.gamePath(at(-552, 63, 2138), [l.socket], GAME.REACH).reached, 'not from the yard');
  t.true(p.gamePath(at(-556, 63, 2136), [l.socket], GAME.REACH).reached, 'from inside the lock');
});

test('the retry backoff (JitteredLinearRetry): a lure it has no way to is tried again 40-79 ticks later each miss, to 400, and forgotten 400 after its last try; a way opened then is taken up to 400 late, a lure put down after the way is open within 39 (E35)', (t) => {
  const p = new Pasture({ tod: 1000, at: at(0, 63, 8) });
  // the lure ringed by a fence, the villager outside
  const lure = at(8, 63, 0);
  for (let x = 6; x <= 10; x++) for (let z = -2; z <= 2; z++) if (Math.abs(x - 8) === 2 || Math.abs(z) === 2) p.set(at(x, 63, z), 'oak_fence');
  down(p, lure);
  const v = game(p, at(0, 63, 0), { id: 71 });
  v.ai!.until = Infinity;
  const tries: { t: number; delay: number }[] = [];
  let last = -1;
  for (let n = 0; n < 3000; n++) {
    p.advance(1);
    const r = v.ai!.retry.job.get(key(lure));
    if (r && r.last !== last) { tries.push({ t: r.last, delay: r.delay }); last = r.last; }
  }
  t.is(v.profession, 'none');
  t.is(p.claims.length, 0);
  t.true(tries.length >= 6);
  // each miss 40-79 longer, to 400; at 400 it is forgotten (400 after its last try) and begins again at 40-79; never tried before it is due
  for (let i = 1; i < tries.length; i++) {
    const a = tries[i - 1], b = tries[i], step = b.delay - a.delay;
    if (b.t - a.t >= GAME.RETRY_FORGET) t.true(b.delay >= 40 && b.delay < 80, `forgotten, begun again at ${b.delay}`);
    else t.true((step >= 40 && step < 80) || (b.delay === GAME.RETRY_MAX && step >= 0), `${a.delay} -> ${b.delay}`);
    t.true(b.t - a.t >= a.delay, 'not before it was due');
  }
  t.true(tries.some(r => r.delay === GAME.RETRY_MAX), 'at the cap');
  // the way opened with the delay at its cap: the claim comes at the next try, not within the next look
  let n = 0;
  while (v.ai!.retry.job.get(key(lure))?.delay !== GAME.RETRY_MAX && n++ < 4000) p.advance(1);
  p.advance(5);
  dug(p, at(6, 63, 0));
  const late = until(p, () => p.claims.length > 0, 600)!;
  t.true(late > GAME.LOOK + GAME.LOOK_JITTER && late <= GAME.RETRY_MAX + GAME.LOOK + GAME.LOOK_JITTER, `claimed ${late} ticks after the way opened`);
  // a lure put down where the way is open already: claimed at its next look
  const q = new Pasture({ tod: 1000, at: at(0, 63, 8) });
  const w = game(q, at(0, 63, 0), { id: 72 });
  q.advance(60);
  down(q, lure);
  t.true(until(q, () => q.claims.some(c => c.uuid === w.uuid), 60)! <= 39);
});

test('jobless at once when its site goes within 16, never while farther off; a traded villager keeps its profession, as does one of level 2; employed it looks no more; before 2000 an employed one strolls, at work it keeps by its block', (t) => {
  const lawn = (tod = 1000) => new Pasture({ tod, at: at(0, 63, 8) });
  const site = at(0, 63, 0);
  // within 16: the next tick
  const p = lawn();
  down(p, site);
  const v = game(p, at(3, 63, 0), { id: 81, profession: 'fletcher', job: { ...site } });
  p.advance(2);
  dug(p, site);
  p.advance(1);
  t.deepEqual([v.profession, v.job, p.tickets.get(key(site))], ['none', undefined, undefined]);
  // 20 off: kept for as long as it stays off (walked there, it is noticed)
  const q = lawn();
  down(q, site);
  const w = game(q, at(20, 63, 0), { id: 82, profession: 'fletcher', job: { ...site } });
  w.ai!.until = Infinity;
  dug(q, site);
  q.advance(200);
  t.deepEqual([w.profession, key(w.job!)], ['fletcher', key(site)]);
  w.position = { x: 12.5, y: 63, z: 0.5 };
  q.advance(1);
  t.is(w.profession, 'none');
  // traded (xp > 0) or level 2: the profession stays; with no site it wants its own kind only
  const r = lawn();
  down(r, site);
  const traded = game(r, at(2, 63, 0), { id: 83, profession: 'fletcher', job: { ...site }, traded: true });
  const level2 = game(r, at(-2, 63, 0), { id: 84, profession: 'fletcher', level: 2, job: { ...site } });
  dug(r, site);
  r.advance(1);
  t.deepEqual([traded.profession, traded.job, level2.profession], ['fletcher', undefined, 'fletcher']);
  down(r, at(5, 63, 3), 'lectern');
  r.advance(200);
  t.deepEqual(r.claims, [], 'a lectern is no fletcher\'s');
  down(r, at(-5, 63, 3));
  t.truthy(until(r, () => r.claims.length > 0, 60));
  // employed: no look, a free site 3 off notwithstanding
  const e = lawn();
  down(e, site);
  game(e, at(1, 63, 0), { id: 85, profession: 'fletcher', job: { ...site } });
  down(e, at(3, 63, 0), 'composter');
  e.advance(400);
  t.deepEqual(e.claims, []);
  // before 2000 an employed villager strolls where it will (E-results D29: found again 20 off); from 2000 it walks
  // back within 9 of its block (Manhattan) and strolls round it, up to 12 off
  const d = lawn(100);
  down(d, site);
  const u = game(d, at(1, 63, 0), { id: 5, profession: 'fletcher', job: { ...site } });
  let idle = 0, work = 0;
  for (; d.tod < 1990; d.advance(10)) idle = Math.max(idle, flat(u.position, mid(site)));
  d.advance(3000 - d.tod);
  for (; d.tod < 8900; d.advance(10)) work = Math.max(work, flat(u.position, mid(site)));
  t.true(idle > 12, `${idle.toFixed(1)} off before 2000`);
  t.true(work <= 12.5, `${work.toFixed(1)} off at work`);
});

test('a snag holds it until its block is gone (the bench by the pavilion\'s fence, live: free in 3 s); a zombie within 8 makes it run; lava, fire and a cactus hurt it, and at 0 it is gone from world.entities; a portal cell takes it to the Nether', async (t) => {
  // wedged on the bot's bench against the fence rail (-544, 63, 2127..2128), the lure free 9 off
  const p = yard({ tod: 3000, at: at(-546, 63, 2132) });
  const bench = at(-544, 64, 2127), fence = at(-544, 63, 2128);
  const v = game(p, bench, { id: 91 });
  p.snag([bench, at(-544, 63, 2127)], [fence]);
  down(p, at(-547, 63, 2134));
  p.advance(400);
  t.is(v.profession, 'none');
  t.deepEqual(cellAt(v), bench, 'still on the bench');
  // the stair dug drops it against the fence: still stuck; the fence segment dug frees it
  dug(p, at(-544, 63, 2127));
  p.advance(100);
  t.deepEqual(cellAt(v), at(-544, 63, 2127));
  t.is(v.profession, 'none');
  dug(p, fence);
  t.true(seconds(until(p, () => v.profession === 'fletcher', 400)) <= 8);
  // a zombie 7 off: it runs at once, faster than it walks (modifier 0.75: 4.5 b/s), and keeps about 8 off it (calm
  // beyond, it walks back to its block and runs again); the zombie gone, it is back at its work
  const q = new Pasture({ tod: 3000, at: at(0, 63, 8) });
  down(q, at(0, 63, 0));
  const w = game(q, at(1, 63, 0), { id: 92, profession: 'fletcher', job: at(0, 63, 0) });
  const z = q.animal('zombie', at(-6, 63, 0));
  q.advance(2);
  t.like(w.ai!.walk, { act: 'flee', bps: 4.5 });
  t.truthy(until(q, () => flat(w.position, z.position) > HOSTILE.zombie, 60));
  let nearest = Infinity;
  for (let n = 0; n < 600; n++) { q.advance(1); nearest = Math.min(nearest, flat(w.position, z.position)); }
  t.true(nearest >= 7, `${nearest.toFixed(1)} off it at the nearest`);
  q.animals.splice(q.animals.indexOf(z), 1);
  q.advance(600);
  t.true(flat(w.position, at(0, 63, 0)) <= 12.5);
  // lava 4 a half second, fire 1 and burning after, a cactus beside it 1: at 0 it is gone from every list
  const r = new Pasture({ tod: 3000, at: at(0, 63, 8) });
  const burnt = game(r, at(0, 63, 0), { id: 93, health: 17 });
  const pricked = game(r, at(10, 63, 0), { id: 94, health: 17 });
  // (each held where it stands: hurt, it panics and would run out of the fire)
  r.snag([at(0, 63, 0), at(10, 63, 0)]);
  r.set(at(0, 63, 0), 'fire');
  r.set(at(11, 63, 0), 'cactus');
  r.advance(20);
  t.true(burnt.health < 17 && pricked.health < 17, `${burnt.health}, ${pricked.health}`);
  r.set(at(0, 63, 0), 'lava');
  r.advance(60);
  t.is(burnt.health, 0);
  t.true(burnt.dead);
  const listed = await r.ctx.call<{ entities: { uuid: string }[] }>('world.entities', { maxDistance: 64 });
  t.false(listed.entities.some(e => e.uuid === burnt.uuid));
  t.true(listed.entities.some(e => e.uuid === pricked.uuid));
  // the portal: the game's walker has a way into its cells from the yard (a mob paths through them) unless it is ringed;
  // in one, it is gone from this world, as villager 2 went
  const ringed = yard({ tod: 3000, at: at(-556, 63, 2152) }), bare = yard({ ring: false, tod: 3000, at: at(-556, 63, 2152) });
  const lit = at(-559, 64, 2147);
  t.false(ringed.gamePath(at(-556, 63, 2153), [lit], 0).reached);
  t.true(bare.gamePath(at(-556, 63, 2153), [lit], 0).reached);
  const lost = game(bare, at(-556, 63, 2153), { id: 95 });
  lost.position = { x: lit.x + 0.5, y: lit.y, z: lit.z + 0.5 };
  bare.advance(2);
  t.is(lost.dim, 'nether');
  t.false((await bare.ctx.call<{ entities: { uuid: string }[] }>('world.entities', { maxDistance: 64 })).entities.some(e => e.uuid === lost.uuid));
});

test('the uuid holds when unload() renumbers the ids; someone\'s villager says so on world.entities (Handlers.java marks: named, leashed, riding)', async (t) => {
  t.regex(fs.readFileSync(path.join(mod, 'Handlers.java'), 'utf8'), /if \(e\.hasCustomName\(\)\) \{\s*o\.addProperty\("named", true\);[\s\S]*?o\.addProperty\("leashed", true\);\s*o\.addProperty\("leashedTo", holder == self \? "me" : Names\.entity\(holder\)\);[\s\S]*?o\.addProperty\("vehicle", Names\.entity\(vehicle\)\);/);
  const p = new Pasture({ tod: 3000, at: at(0, 63, 4) });
  const v = game(p, at(0, 63, 0), { id: 101 });
  const named = game(p, at(3, 63, 0), { id: 102, customName: 'Bob' }), leashed = game(p, at(-3, 63, 0), { id: 103, leashedTo: 'Hunter3035' }), riding = game(p, at(0, 63, -3), { id: 104, vehicle: 'minecart' });
  const look = async () => (await p.ctx.call<{ entities: { id: number; uuid: string; named?: boolean; customName?: string; leashed?: boolean; leashedTo?: string; vehicle?: string }[] }>('world.entities', { maxDistance: 32 })).entities;
  const before = await look();
  t.like(before.find(e => e.uuid === named.uuid), { named: true, customName: 'Bob' });
  t.like(before.find(e => e.uuid === leashed.uuid), { leashed: true, leashedTo: 'Hunter3035' });
  t.like(before.find(e => e.uuid === riding.uuid), { vehicle: 'minecart' });
  t.is(before.find(e => e.uuid === v.uuid)!.named, undefined);
  p.unload();
  const after = await look();
  t.deepEqual(after.map(e => e.uuid).sort(), before.map(e => e.uuid).sort());
  t.true(after.every(e => before.find(b => b.uuid === e.uuid)!.id !== e.id), 'every id new, every uuid as it was');
});

test('world.findBlocks is Handlers.java\'s: the kind within maxDistance (128 at most) of the bot\'s position, the nearest first, count of them (256 at most), on cells the client holds; the POI store the villagers claim from', async (t) => {
  const java = fs.readFileSync(path.join(mod, 'Handlers.java'), 'utf8');
  const fb = body(java, 'world.findBlocks');
  t.regex(fb, /int maxDistance = Math\.min\(intParam\(p, "maxDistance", 32\), 128\);/);
  t.regex(fb, /int count = Math\.min\(intParam\(p, "count", 1\), 256\);/);
  t.regex(fb, /Vec3 eye = pl\.position\(\);/);
  t.regex(fb, /\.filter\(bp -> Vec3\.atCenterOf\(bp\)\.distanceTo\(eye\) <= maxDistance\)/);
  t.regex(fb, /\.sorted\(Comparator\.comparingDouble\(bp -> Vec3\.atCenterOf\(bp\)\.distanceTo\(eye\)\)\)/);
  t.regex(fb, /return obj\("block", name, "positions", out\);/);
  const p = yard({ at: at(-549, 63, 2160) });
  const find = (o: Any) => p.ctx.call<{ block: string; positions: Pos[] }>('world.findBlocks', o);
  t.deepEqual(await find({ block: 'smithing_table', maxDistance: 128, count: 4 }), { block: 'smithing_table', positions: [SMITHING] });
  t.deepEqual((await find({ block: 'minecraft:fletching_table', maxDistance: 64 })).positions, [at(-552, 63, 2127)]);
  // the nearest first, within maxDistance, count of them; a lure down is found, dug it is gone
  down(p, at(-549, 63, 2150));
  t.deepEqual((await find({ block: 'fletching_table', maxDistance: 64, count: 5 })).positions, [at(-549, 63, 2150), at(-552, 63, 2127)]);
  t.deepEqual((await find({ block: 'fletching_table', maxDistance: 20, count: 5 })).positions, [at(-549, 63, 2150)]);
  t.deepEqual((await find({ block: 'fletching_table', maxDistance: 64 })).positions, [at(-549, 63, 2150)], 'count 1 by default');
  dug(p, at(-549, 63, 2150));
  t.deepEqual((await find({ block: 'fletching_table', maxDistance: 64 })).positions, [at(-552, 63, 2127)]);
  t.is((await find({ block: 'white_bed', maxDistance: 64, count: 9 })).positions.length, 6, 'both halves of the three beds');
  // the cells the client holds: out of its sight nothing (the real ground's bell, from the yard)
  const { base } = westVillage();
  const far = new Pasture({ base, at: at(-560, 63, 2186) });
  t.deepEqual((await far.ctx.call<{ positions: Pos[] }>('world.findBlocks', { block: 'bell', maxDistance: 128 })).positions, []);
  const near = new Pasture({ base, at: at(-690, 69, 2262) });
  t.deepEqual((await near.ctx.call<{ positions: Pos[] }>('world.findBlocks', { block: 'bell', maxDistance: 128 })).positions, [WEST_BELL]);
  await t.throwsAsync(find({ block: 'stone' }), { message: /job sites, beds and bells only/ });
});
