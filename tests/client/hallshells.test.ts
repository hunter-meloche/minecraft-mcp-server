import test from 'ava';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import { hall, hallLock, portalRing, type Side } from '../../src/client/brain/blueprints.js';
import { inHallOrLock, peekFetch } from '../../src/client/brain/fetch.js';
import { out } from '../../src/client/brain/pockets.js';
import { lockFaults, lockOf, lockPlan, lockReady, ringPlanOf, ringReady } from '../../src/client/brain/villagerwalk.js';
import { LOOK_EVERY, NOT_AGAIN, PLUG_MAX, SHELL_WAITS, readShells, shellsGoal, shellsOwed, shellsText } from '../../src/client/brain/hallshells.js';
import { strictSet } from '../../src/client/brain/yardgates.js';
import { outOfHallWants } from '../../src/client/brain/villagercare.js';
import { keptSites } from '../../src/client/structures/site.js';
import { H, HALL, Killed, P, Pasture, YARD_GATES, idOf, isOpen, key, yard, type Entry } from '../helpers/pasture.js';

// The shells goal (src/client/brain/hallshells.ts) on the pasture (tests/helpers/pasture.ts: the live yard, its hall
// with the gate H at (-556, 63, 2134), the lit portal, and the bridge's own rules of reach and sight ported from the
// Java): the lock built in front of a hall that has somebody in it, the plug first; then the portal's ring; the zones
// each build writes and when; a kill at every call of the build; and what the goal does about a shell found wrong.
// The rows are section 7's "M" rows of the design (idle-plan V), named in each title.
//
// Serial: the plug's way out is a critical section (pockets.ts `out`, one for the process), and a build's watch on
// the hall's gate runs on a timer the tests shorten.
SHELL_WAITS.watchMs = 5;

const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
const up = (p: Pos): Pos => ({ ...p, y: p.y + 1 });
const blocks = (p: Pasture) => ({ state: (x: number, y: number, z: number) => p.get({ x, y, z }) });
/** The yard with a hall and a lit portal and neither shell, the makings of both in the pockets (the kit has the planks, the dirt and the rail). */
function bare(opts: Parameters<typeof yard>[0] = {}): Pasture {
  const p = yard({ lock: false, ring: false, crossings: false, ...opts });
  p.give('oak_fence_gate', 2);
  p.give('torch');
  p.give('oak_fence', 25);
  return p;
}
const run = (p: Pasture) => shellsGoal.run(p.ctx);
const saved = (e: Entry): WorldMemory => JSON.parse(e.saved) as WorldMemory;
const INSIDE = at(-556, 63, 2130);
/** The plug's cells (the cell outside H and the one over it), the cell the bot works them from, and the lock's cells of the plain layout. */
const PLUG = [at(-556, 63, 2135), at(-556, 64, 2135)], STAND = at(-556, 63, 2136);
const PLAIN = { p: P, h: H, socket: at(-554, 63, 2135), sill: at(-553, 63, 2135), post: at(-553, 63, 2136), sOut: at(-554, 63, 2139) };
const fletcher = (p: Pasture) => p.villager({ at: INSIDE, profession: 'fletcher', level: 4, health: 17 });
const inHall = (c: Pos) => c.x >= HALL.x && c.x < HALL.x + HALL.width && c.z >= HALL.z && c.z < HALL.z + HALL.length;
const acts = (p: Pasture, name: string) => p.log.filter(e => e.name === name);
const kindOf = (p: Pasture) => { const o = shellsOwed(p.world, p.now()); return 'none' in o ? 'none' : o.kind; };

// ------------------------------------------------------------------------------------------------ the builds

test.serial('the two specs\' bills, and what the two builds take from the pockets (the plug\'s dirt comes back)', async (t) => {
  for (const mirror of [false, true]) t.deepEqual(hallLock(mirror).bill, { oak_planks: 31, oak_fence_gate: 1, torch: 1, rail: 1 });
  for (const axis of ['x', 'z'] as const) t.deepEqual(portalRing(axis, 'south').bill, { oak_fence: 25, oak_fence_gate: 1 });
  const p = bare();
  t.regex(await run(p), /^built the lock in front of the hall's gate \(31 oak_planks, 1 oak_fence_gate, 1 torch\); took the plug up \(2 dirt\); the lock is ready$/);
  t.regex(await run(p), /^fenced the Nether portal, its gate south at \(-563, 63, 2149\) \(25 oak_fence, 1 oak_fence_gate\); the ring is ready$/);
  t.deepEqual(['oak_planks', 'oak_fence_gate', 'torch', 'rail', 'oak_fence', 'dirt'].map(n => p.count(n)), [33, 0, 0, 1, 0, 16]);
  t.is(await run(p), 'looked over: the lock ready; the ring ready');
  t.is(kindOf(p), 'none');
});

test.serial('the lock: the footprint zone before the build, the landmark zones after; the plug down before build-structure and up only with P shut', async (t) => {
  const p = bare();
  const who = fletcher(p);
  /** P as it stood at each dig of the plug */
  const pAtDig: string[] = [];
  p.on.call['dig.here'] = () => { pAtDig.push(p.get(P)); return undefined; };
  await run(p);
  // the plug: both dirt placed before the builder is called, the lower first, each with its journal entry SAVED first
  const places = acts(p, 'place'), build = acts(p, 'build-structure')[0];
  t.deepEqual(places.slice(0, 2).map(e => [e.params.x, e.params.y, e.params.z]), PLUG.map(c => [c.x, c.y, c.z]));
  t.true(places[1].i < build.i);
  places.slice(0, 2).forEach((e, n) => {
    t.is(e.via, 'own.put');
    t.like(peekFetch(saved(e)).journal[n], { k: 'cover', trip: 0, at: PLUG[n], item: 'dirt', what: 'hall door', st: 'planned' }, 'written and saved before its place');
    t.is(peekFetch(saved(e)).shells?.building, 'lock');
  });
  // at the builder's call: the ground kept (the footprint grown by 1), no landmark zone yet, both dirt down
  const then = saved(build);
  t.deepEqual(then.zones!.lock, [{ x: -559, y: 62, z: 2134, width: 7, length: 5 }]);
  t.deepEqual(Object.keys(then.zones!).filter(k => /^lock:/.test(k)), []);
  t.deepEqual(peekFetch(then).journal.map(e => [e.k, 'st' in e ? e.st : '']), [['cover', 'down'], ['cover', 'down']]);
  t.like(build.params, { x: -558, y: 62, z: 2135, name: 'hall-lock' });
  // after: the landmark zones are the design's table, the lock stands and is ready, the sill is the bot's own rail
  const z = p.world.zones!;
  t.deepEqual([z['lock:gate'], z['lock:socket'], z['lock:sill'], z['lock:post'], z['lock:sout']].map(k => k[0]), [PLAIN.p, PLAIN.socket, PLAIN.sill, PLAIN.post, PLAIN.sOut]);
  t.is(z['lock:inside'].length, 6);
  t.like(lockOf(p.world), PLAIN);
  t.deepEqual(lockReady(p.world, blocks(p)), []);
  t.is(idOf(p.get(PLAIN.sill)), 'rail');
  t.true(p.protection.has(key(PLAIN.sill)));
  // the strict set sent again with P, the pair and the guard, before the plug came up
  const strict = acts(p, 'gates.strict').at(-1)!, digs = acts(p, 'dig.here');
  t.deepEqual(strict.params, { gates: [...Object.values(YARD_GATES), H, P], pairs: [[P, H]], guard: [{ gate: P, box: lockOf(p.world)!.box }] });
  t.true(strict.i < digs[0].i);
  // the plug up: the upper first, each with P read shut (and standing shut), and the hall's gate never opened
  t.deepEqual(digs.map(e => [e.params.x, e.params.y, e.params.z]), [...PLUG].reverse().map(c => [c.x, c.y, c.z]));
  t.deepEqual(pAtDig.map(isOpen), [false, false]);
  digs.forEach((e, n) => t.true(peekFetch(saved(e)).journal.some(c => c.k === 'cover' && key(c.at) === key(PLUG[1 - n])), 'in the journal until it is up'));
  t.true(digs.every(e => e.via === 'own.take' && e.at.x === STAND.x && e.at.z === STAND.z), 'from the cell before the plug, inside the lock');
  t.false(p.changed.some(c => key(c.at) === key(H)), 'H never opens');
  for (const c of PLUG) { t.is(p.get(c), 'air'); t.false(p.protection.has(key(c)), 'off the record'); }
  // the end: nothing owed, the record clean, the bot outside the lock with P shut behind it, the resident where it was
  t.deepEqual(peekFetch(p.world).journal, []);
  t.deepEqual(peekFetch(p.world).shells, { at: peekFetch(p.world).shells!.at, lock: [], ring: ['the portal has no ring'] });
  t.deepEqual(p.bot.at, at(-556, 63, 2139));
  t.false(isOpen(p.get(P)) || isOpen(p.get(H)));
  t.deepEqual(p.leaks, []);
  t.true(inHall(who.position));
  t.deepEqual(p.broke, [], 'every walk was a careful one');
  t.true(p.walks.every(w => w.careful));
  t.is(out.critical, undefined);
});

test.serial('M "the zones are footprints": the site search keeps off the lock\'s ground and the ring\'s, from before each build', async (t) => {
  const p = bare();
  await run(p);
  await run(p);
  const lockZone = { x: -559, z: 2134, width: 7, length: 5 }, ringZone = { x: -564, z: 2145, width: 10, length: 5 };
  const [lockBuild, ringBuild] = acts(p, 'build-structure');
  t.deepEqual(keptSites(saved(lockBuild)).filter(r => r.x === lockZone.x && r.z === lockZone.z), [lockZone], 'kept before the lock\'s first block');
  t.deepEqual(keptSites(saved(ringBuild)).filter(r => r.x === ringZone.x && r.z === ringZone.z), [ringZone], 'and the ring\'s');
  t.false('ring:gate' in saved(ringBuild).zones!, 'the ring\'s gate is a zone only once it stands');
  const kept = keptSites(p.world);
  t.true([lockZone, ringZone].every(want => kept.some(r => r.x === want.x && r.z === want.z && r.width === want.width && r.length === want.length)));
  // (the landmark zones are cells: no footprint of their own, and nothing of them is kept twice)
  t.is(kept.filter(r => r.x >= -560 && r.x <= -553 && r.z >= 2134 && r.z <= 2140).length, 1);
  t.deepEqual(p.world.zones!['ring:gate'], [at(-563, 63, 2149)]);
  t.truthy(ringPlanOf(p.world));
});

test.serial('M "nothing leaves the hall during the build": the builder\'s walk opens the hall\'s gate onto the plug', async (t) => {
  // without a plug, a gate opened with one awake inside is how a villager leaves (the fault the plug answers)
  const open = bare();
  const loose = fletcher(open);
  open.swing(H, true, 'the builder\'s walk');
  open.advance(60);
  t.true(open.leaks.some(l => l.uuid === loose.uuid && key(l.gate) === key(H)));

  const p = bare();
  const who = fletcher(p);
  p.builderOpens = [H];
  await run(p);
  t.true(p.changed.some(c => key(c.at) === key(H) && c.how === 'the builder\'s walk'), 'it did open');
  t.deepEqual(p.leaks, []);
  t.true(inHall(who.position));
  // and the plug came up only behind both gates read shut
  t.false(isOpen(p.get(H)) || isOpen(p.get(P)));
  t.deepEqual(lockReady(p.world, blocks(p), [{ name: 'villager', position: who.position, health: 17 }]), []);
  t.deepEqual(peekFetch(p.world).journal, []);

  // the builder leaves the bot out in the yard (the fake's leaves it where it stood, inside): the sill is laid from
  // the post, the bot goes in by P for the plug with P shut behind it, and still nobody leaves
  const o = bare();
  const res = fletcher(o);
  o.builderOpens = [H];
  o.on.act['build-structure'] = () => { o.at(o.tick + 20, () => { o.bot.at = at(-550, 63, 2141); }); return undefined; };
  const gates: string[] = [];
  o.on.call['dig.here'] = () => { gates.push(`${isOpen(o.get(P))} ${isOpen(o.get(H))}`); return undefined; };
  t.regex(await run(o), /took the plug up \(2 dirt\); the lock is ready$/);
  const rail = acts(o, 'place').at(-1)!;
  t.like(rail, { at: PLAIN.post, params: { x: PLAIN.sill.x, z: PLAIN.sill.z } });
  t.deepEqual(gates, ['false false', 'false false'], 'both gates shut at each dig');
  t.true(acts(o, 'dig.here').every(e => key(e.at) === key(STAND)));
  t.deepEqual(o.leaks, []);
  t.true(inHall(res.position));
  t.deepEqual(o.bot.at, at(-556, 63, 2139));
  t.false(isOpen(o.get(P)) || isOpen(o.get(H)));
  t.deepEqual(o.broke, []);
});

test.serial('M "the footprint zone alone does not switch the chores": no lock stands until every block is in place', async (t) => {
  const p = bare();
  await run(p);
  const build = acts(p, 'build-structure')[0], then = saved(build);
  // during the build: the ground is kept and `building` says so (the chores keep out by that), but no lock stands,
  // and the bot on that ground is not "in the lock"
  t.truthy(then.zones!.lock);
  t.is(lockOf(then), undefined);
  t.deepEqual(lockFaults(then, blocks(p)).map(f => f.kind), ['zones']);
  t.false(inHallOrLock(then, STAND));
  t.is(peekFetch(then).shells?.building, 'lock');
  t.like(shellsOwed(then, p.now()), { kind: 'lock', want: 'the lock\'s build goes on' });
  // after it: the lock stands, the bot in it would be in the lock, and nothing is being built
  t.truthy(lockOf(p.world));
  t.true(inHallOrLock(p.world, STAND));
  t.is(peekFetch(p.world).shells?.building, undefined);
  // a build that failed half way wrote no landmark zone either
  const q = bare();
  q.on.act['build-structure'] = () => ({ ok: false, text: 'Build of hall-lock ended after 41s with 20/33 blocks in place. Missing: oak_planks x13 (have 33).' });
  await t.throwsAsync(run(q), { message: /the lock is not whole yet: Build of hall-lock ended after 41s with 20\/33 blocks in place/ });
  t.is(lockOf(q.world), undefined);
  t.deepEqual(Object.keys(q.world.zones!).filter(k => /^lock/.test(k)), ['lock']);
});

test.serial('M "killed mid-build: the plug stands, the build goes on": a kill before every call of the build, the client alive or dead with it', async (t) => {
  const whole = bare();
  await run(whole);
  const calls = whole.log.length;
  t.true(calls > 40);
  let plugged = 0;
  for (let i = 0; i < calls; i++) {
    for (const client of i % 6 === 3 ? [false, true] : [false]) {
      const p = bare();
      const who = fletcher(p);
      // (Baritone's walk opens the hall's gate each time the builder is called: the worst a build does)
      p.builderOpens = [H];
      p.killAt(i, client);
      // (a dead process's calls all throw; which of them ends its run is not the world's business)
      const dead = await t.throwsAsync(run(p));
      t.true(dead instanceof Killed || dead?.message === 'aborted' || /stays in|not read|no strict gates|did not|no way|not whole/.test(dead?.message ?? ''), `kill ${i}: ${dead?.message}`);
      // what the kill left: a plug in the doorway is in the journal, whole or in part, and `building` holds
      const dirt = PLUG.filter(c => idOf(p.get(c)) === 'dirt');
      const left = peekFetch(JSON.parse(p.saved) as WorldMemory);
      if (dirt.length) {
        plugged++;
        t.is(left.shells?.building, 'lock', `kill ${i}`);
        t.true(dirt.every(c => left.journal.some(e => e.k === 'cover' && key(e.at) === key(c))), `kill ${i}: every dirt down is in the journal`);
      }
      p.restart();
      // the brain back: the goal goes on, run after run, until nothing of the lock is owed
      let said = '';
      for (let n = 0; n < 6 && ['lock', 'unplug'].includes(kindOf(p)); n++) {
        said = await run(p).catch((e: Error) => `threw: ${e.message}`);
        p.advance(200);
      }
      t.is(kindOf(p), 'ring', `kill ${i}${client ? ' (client too)' : ''}: ${said}`);
      t.deepEqual(lockReady(p.world, blocks(p)), [], `kill ${i}`);
      t.deepEqual(peekFetch(p.world).journal, [], `kill ${i}`);
      t.is(peekFetch(p.world).shells?.building, undefined);
      for (const c of PLUG) t.is(p.get(c), 'air', `kill ${i}: the plug is up`);
      t.false(isOpen(p.get(P)) || isOpen(p.get(H)));
      t.deepEqual(p.leaks, [], `kill ${i}: nobody left the hall`);
      t.true(inHall(who.position));
      // never plugged twice over, and the layout never chosen again: one lock, the plain one
      t.is(p.changed.filter(c => c.how === 'placed' && idOf(c.to) === 'dirt').length, p.changed.filter(c => c.how === 'dug' && idOf(c.from) === 'dirt').length);
      t.like(lockOf(p.world), PLAIN);
    }
  }
  t.true(plugged > 20, 'most kills fall with the plug in');
});

test.serial('M "a lamp post in the footprint: the mirror is built"', async (t) => {
  const p = bare();
  // on the plain layout's S_out (the footprint grown by 1 is the same both ways round: what differs is the worked side)
  p.set(PLAIN.sOut, 'oak_fence');
  p.set(up(PLAIN.sOut), 'lantern[hanging=false,waterlogged=false]');
  await run(p);
  t.is(peekFetch(p.world).shells?.mirror, true);
  t.like(lockOf(p.world), { p: P, h: H, socket: at(-558, 63, 2135), sill: at(-559, 63, 2135), post: at(-559, 63, 2136), sOut: at(-558, 63, 2139) });
  t.deepEqual(lockReady(p.world, blocks(p)), []);
  t.is(idOf(p.get(at(-559, 63, 2135))), 'rail');
  t.is(idOf(p.get(PLAIN.sOut)), 'oak_fence', 'the lamp post stands');
  // a build cut short goes on the same way round, never asked again
  const q = bare();
  q.set(PLAIN.sOut, 'oak_fence');
  q.killAt(acts(p, 'build-structure')[0].i);
  await t.throwsAsync(run(q), { instanceOf: Killed });
  q.restart();
  q.set(PLAIN.sOut, 'air');
  await run(q);
  t.is(lockOf(q.world)!.post.x, -559, 'mirrored still, though the plain ground is free now');
});

test.serial('M "no free layout: nothing built, said"', async (t) => {
  const p = bare();
  // within 1 of the footprint: in the way of both layouts
  p.set(at(-553, 63, 2138), 'oak_fence');
  const said = await run(p);
  t.is(said, 'nothing built: no free ground for the lock (the plain layout: oak_fence stands within 1 of the hall lock at (-553, 63, 2138); the other way round: oak_fence stands within 1 of the hall lock at (-553, 63, 2138))');
  t.deepEqual(p.log.filter(e => !/^(gates\.|world\.)/.test(e.name)), [], 'looked, and nothing else');
  t.false('lock' in p.world.zones!, 'no ground kept for a lock that cannot go there');
  t.deepEqual(peekFetch(p.world).journal, []);
  t.is(peekFetch(p.world).shells!.lock[0], 'no lock stands: no free ground for it (the plain layout: oak_fence stands within 1 of the hall lock at (-553, 63, 2138); the other way round: oak_fence stands within 1 of the hall lock at (-553, 63, 2138))');
  t.regex(await shellsText(p.ctx), /^No lock stands\. Its ground: the plain layout: oak_fence stands within 1 of the hall lock at \(-553, 63, 2138\); the other way round: /);
  // not begun again at once: the ring is next, and the lock's ground is read again later
  t.is(kindOf(p), 'ring');
  t.like(shellsOwed(p.world, p.now() + NOT_AGAIN), { kind: 'lock' });
  p.set(at(-553, 63, 2138), 'air');
  t.regex(await shellsText(p.ctx), /^No lock stands\. Its ground: the plain layout: free; the other way round: free\./);
});

// ------------------------------------------------------------------------------------------------ ready, as read

test.serial('M "each fault is named": every fault goes to fetch.shells and the plan\'s text, and what is gone of a shell is built again', async (t) => {
  const p = bare();
  await run(p);
  await run(p);
  const l = lockOf(p.world)!;
  const faults = async () => { const r = await readShells(p.ctx); return [r.lock.faults.map(f => f.text), r.ring.faults]; };
  t.deepEqual(await faults(), [[], []]);
  t.is(await shellsText(p.ctx), 'The lock stands at the hall\'s south gate: P (-556, 63, 2137), H (-556, 63, 2134), socket (-554, 63, 2135), sill (-553, 63, 2135), post (-553, 63, 2136), S_out (-554, 63, 2139): ready\n'
    + 'The portal\'s ring stands, its gate south at (-563, 63, 2149): ready');
  // a wall block, a roof block, the torch and the sill gone; a fence of the ring gone
  const wall = at(-558, 64, 2136), roof = at(-556, 65, 2136), torch = at(-557, 64, 2135), fence = at(-560, 63, 2145);
  for (const c of [wall, roof, torch, l.sill, fence]) p.set(c, 'air');
  t.deepEqual(await faults(), [
    ['a wall block gone at (-558, 64, 2136) (air)', 'a roof block gone at (-556, 65, 2136) (air)', 'the sill is gone at (-553, 63, 2135) (air)', 'a cell outside the lock reaches the socket: (-553, 63, 2135)'],
    ['a fence of the ring is gone at (-560, 63, 2145) (air)']
  ]);
  t.deepEqual(peekFetch(p.world).shells!.lock.length, 4);
  t.regex(await shellsText(p.ctx), /S_out \(-554, 63, 2139\): 4 fault\(s\)\n {2}- a wall block gone at \(-558, 64, 2136\) \(air\)\n[^]*its gate south at \(-563, 63, 2149\): 1 fault\(s\)\n {2}- a fence of the ring is gone at \(-560, 63, 2145\) \(air\)$/);
  // the look over builds both again: the lock the same way, the plug first
  p.give('torch');
  p.give('oak_fence');
  const from = p.log.length;
  t.like(shellsOwed(p.world, p.now() + LOOK_EVERY), { kind: 'look' });
  const said = await shellsGoal.run({ ...p.ctx, s: p.look({ now: p.now() + LOOK_EVERY }) });
  t.regex(said, /^built the lock in front of the hall's gate \(1 torch, 2 oak_planks\); took the plug up \(2 dirt\); the lock is ready; fenced the Nether portal, its gate south at \(-563, 63, 2149\) \(1 oak_fence\); the ring is ready$/);
  const again = p.log.slice(from);
  const firstBuild = again.find(e => e.name === 'build-structure')!;
  t.deepEqual(again.filter(e => e.name === 'place' && e.i < firstBuild.i).map(e => e.params.y), [63, 64], 'the plug before the builder');
  for (const c of [wall, roof, fence]) t.not(p.get(c), 'air');
  t.is(idOf(p.get(torch)), 'wall_torch');
  t.is(idOf(p.get(l.sill)), 'rail');
  t.deepEqual(await faults(), [[], []]);
  t.deepEqual(peekFetch(p.world).journal, []);
  t.is(p.world.zones!['lock:inside'].length, 6, 'the zones are not written twice');

  // what is open, in use or in the way is named and not the builder's: P open; somebody inside; the ring's gate open
  p.swing(P, true, 'a player');
  const cow = p.animal('cow', at(-556, 63, 2136));
  p.swing(at(-563, 63, 2149), true, 'a player');
  p.set(wall, 'air');
  const before = p.log.length;
  const text = await shellsGoal.run({ ...p.ctx, s: p.look({ now: p.now() + 2 * LOOK_EVERY }) });
  t.is(text, 'looked over: the lock: a wall block gone at (-558, 64, 2136) (air) (and 2 more); the ring: the ring\'s gate is open at (-563, 63, 2149)');
  t.deepEqual(peekFetch(p.world).shells!.lock, ['a wall block gone at (-558, 64, 2136) (air)', 'the lock\'s gate is open at (-556, 63, 2137)', 'a cow in the lock at (-556, 63, 2136)']);
  t.deepEqual(p.log.slice(before).filter(e => !/^world\./.test(e.name)), [], 'looked, and nothing else');
  t.is(p.get(wall), 'air');
  p.animals.splice(p.animals.indexOf(cow), 1);
});

test.serial('what is gone of the lock is not built again while a villager is on its way, nor with something of the fetch\'s in the socket', async (t) => {
  const p = bare();
  await run(p);
  await run(p);
  const l = lockOf(p.world)!, wall = at(-558, 64, 2136), f = p.world.fetch!;
  p.set(wall, 'air');
  const look = (n: number) => shellsGoal.run({ ...p.ctx, s: p.look({ now: p.now() + n * LOOK_EVERY }) });
  // a ward led home: no builder, no plug, no walk into the lock while it is out
  f.wards = [{ key: 'u-1', from: { site: 'west', at: at(-675, 71, 2249) }, since: p.now(), bell: true, where: 'led', last: { at: at(-600, 66, 2200), t: p.now(), tod: 3000, health: 17, profession: 'fletcher' }, health0: 17 }];
  const from = p.log.length;
  t.regex(await look(1), /^looked over: the lock: a wall block gone at \(-558, 64, 2136\)/);
  f.wards = [];
  // the socket's wall block lifted for a trip (its journal entry): the lock is in use, not broken
  f.journal.push({ k: 'lift', id: f.nextId++, trip: 7, at: l.socket, block: 'oak_planks', item: 'oak_planks', st: 'done', why: 'socket', t: p.now() });
  t.regex(await look(2), /^looked over: the lock: a wall block gone/);
  t.deepEqual(p.log.slice(from).filter(e => !/^world\./.test(e.name)), [], 'looked twice, and nothing else');
  t.is(p.get(wall), 'air');
  f.journal.length = 0;
  t.regex(await look(3), /^built the lock in front of the hall's gate \(1 oak_planks\); took the plug up \(2 dirt\); the lock is ready$/);
  t.not(p.get(wall), 'air');
});

test.serial('M "a doorway one high is not ready", and "a block beside the wall changes nothing: roofed"', async (t) => {
  const p = bare();
  await run(p);
  await run(p);
  const read = async () => (await readShells(p.ctx)).lock.faults;
  // beside the wall, outside: no step into a roofed cell, and no fault
  p.set(at(-559, 63, 2136), 'cobblestone');
  p.set(at(-557, 63, 2138), 'cobblestone');
  t.deepEqual(await read(), []);
  // over P, and over H (Nov 24: a cobblestone over H shut every chore out)
  p.set(up(P), 'cobblestone');
  t.deepEqual(await read(), [{ kind: 'structure', text: 'the lock\'s doorway is one high: cobblestone at (-556, 64, 2137)' }]);
  p.set(up(P), 'air');
  p.set(up(H), 'cobblestone');
  t.deepEqual(await read(), [{ kind: 'structure', text: 'the hall\'s doorway is one high: cobblestone at (-556, 64, 2134)' }]);
  // a stray in a doorway is the tidy round's to dig, never the builder's to break: with a wall block gone too,
  // nothing is built while it stands there
  p.set(up(H), 'air');
  p.set(up(P), 'cobblestone');
  p.set(at(-558, 64, 2136), 'air');
  const from = p.log.length;
  await shellsGoal.run({ ...p.ctx, s: p.look({ now: p.now() + LOOK_EVERY }) });
  t.deepEqual(acts(p, 'build-structure').filter(e => e.i >= from), []);
  t.is(p.get(up(P)), 'cobblestone');
});

test.serial('M "no reach cell outside with the sill": gone, the socket is worked from the yard, and the sill is laid again', async (t) => {
  const p = bare();
  await run(p);
  await run(p);
  const l = lockOf(p.world)!;
  const kinds = async () => (await readShells(p.ctx)).lock.faults.map(f => f.kind);
  t.deepEqual(await kinds(), []);
  p.set(l.sill, 'air');
  t.deepEqual((await readShells(p.ctx)).lock.faults, [
    { kind: 'structure', text: 'the sill is gone at (-553, 63, 2135) (air)' }, { kind: 'reach', text: 'a cell outside the lock reaches the socket: (-553, 63, 2135)' }
  ]);
  const from = p.log.length, changed = p.changed.length;
  t.regex(await shellsGoal.run({ ...p.ctx, s: p.look({ now: p.now() + LOOK_EVERY }) }), /^laid the lock's sill; the lock is ready$/);
  t.is(idOf(p.get(l.sill)), 'rail');
  t.deepEqual(await kinds(), []);
  // nothing of the walls was gone: no plug, no builder; laid from the post, standing still there, and no gate opened
  // (a walk "into reach" of the sill would have ended inside the lock, through P)
  const since = p.log.slice(from);
  t.deepEqual(since.filter(e => ['build-structure', 'dig.here'].includes(e.name)), []);
  t.deepEqual(since.filter(e => e.name === 'goto').map(e => [e.params.x, e.params.z, e.params.range]), [[l.post.x, l.post.z, 0]]);
  t.deepEqual(since.filter(e => e.name === 'place').map(e => [e.at, (e.reply as { placed: boolean }).placed]), [[at(-556, 63, 2139), false], [l.post, true]], 'too far from where it stood: from the post');
  t.deepEqual(p.changed.slice(changed).map(c => c.how), ['placed']);
});

/** A bare lawn with a hall whose gate is on `side` (its zones as its build wrote them), the bot's home beside it. */
function hallFacing(side: Side): Pasture {
  const p = new Pasture();
  const bp = hall({ gateSide: side }), o = at(-556, 62, 2160);
  p.stamp(bp.spec, o);
  bp.spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => { if (ch !== ' ' && ch !== '.') p.mine(at(o.x + x, o.y + y, o.z + z)); })));
  const gate = bp.landmarks.find(l => l.kind === 'gate')!.at;
  p.world.zones = { hall: [{ ...o, width: bp.size.width, length: bp.size.length }], 'hall:gate': [at(o.x + gate.x, o.y + gate.y, o.z + gate.z)] };
  p.give('oak_fence_gate');
  p.give('torch');
  return p;
}

test.serial('M "both layouts on all four sides: reaches and sights": the lock as built is worked from its post by the bridge\'s own rules', async (t) => {
  for (const side of ['south', 'west', 'north', 'east'] as const) {
    for (const mirror of [false, true]) {
      const p = hallFacing(side), name = `${side}${mirror ? ', mirrored' : ''}`;
      // (the plain layout's S_out taken: the other way round is built)
      if (mirror) p.set(lockPlan(p.world)!.sOut, 'oak_fence');
      await run(p);
      const l = lockOf(p.world)!;
      t.deepEqual({ ...l }, (({ p: gp, h, socket, sill, post, sOut, inside, box }) => ({ p: gp, h, socket, sill, post, sOut, inside, box }))(lockPlan(p.world, mirror)!), name);
      t.deepEqual(lockReady(p.world, blocks(p)), [], name);
      // from the post, standing still, P shut: the socket's wall block dug past the sill's rail, a lure set in and
      // dug, the wall block back (rollout step 2's hand check); a lure put at S_out and taken up; P and H clicked
      p.bot.at = { ...l.post };
      const own = p.ctx.own!;
      t.like(await own.take(l.socket, 'oak_planks', { stay: true, pickup: false }), { ok: true, dug: true }, `${name}: the wall block`);
      t.like(await own.put(l.socket, 'fletching_table', { stay: true }), { ok: true }, `${name}: the lure into the socket`);
      t.like(await own.take(l.socket, 'fletching_table', { stay: true, pickup: false }), { ok: true, dug: true }, `${name}: the lure out`);
      t.like(await own.put(l.socket, 'oak_planks', { stay: true }), { ok: true }, `${name}: the wall block back`);
      t.like(await own.put(l.sOut, 'fletching_table', { stay: true }), { ok: true }, `${name}: a lure at S_out`);
      t.like(await own.take(l.sOut, 'fletching_table', { stay: true, pickup: false }), { ok: true, dug: true }, `${name}: and up`);
      for (const gate of [l.p, l.h]) {
        t.like(await p.ctx.call('useOn', { ...gate, face: 'up' }), { used: true, changed: true }, `${name}: a gate opened from the post`);
        t.true(isOpen(p.get(gate)));
        t.like(await p.ctx.call('useOn', { ...gate, face: 'up' }), { used: true, changed: true });
        t.false(isOpen(p.get(gate)));
      }
      t.deepEqual(p.walks.filter(w => w.t > p.tick - 1), [], 'nothing walked');
      t.deepEqual(lockReady(p.world, blocks(p)), [], `${name}: as it stood`);
    }
  }
});

// ------------------------------------------------------------------------------------------------ the ring

test.serial('M "ringReady: a block beside the ring is a fault"; the ring\'s gate goes on the first side with free ground, the one toward home first', async (t) => {
  const p = bare();
  await run(p);
  // the zone `ring` before its build, `ring:gate` after, and the strict set sent again with the gate
  await run(p);
  const build = acts(p, 'build-structure')[1];
  t.deepEqual(saved(build).zones!.ring, [{ x: -564, y: 62, z: 2145, width: 10, length: 5 }]);
  t.is(peekFetch(saved(build)).shells?.building, 'ring');
  t.like(build.params, { x: -564, y: 63, z: 2145, name: 'portal-ring' });
  t.deepEqual(acts(p, 'gates.strict').at(-1)!.params.gates, [...Object.values(YARD_GATES), H, P, at(-563, 63, 2149)]);
  t.deepEqual(strictSet(p.world).gates.at(-1), at(-563, 63, 2149));
  t.deepEqual(ringReady(p.world, blocks(p)), []);
  t.is(peekFetch(p.world).shells?.building, undefined);
  // a block beside it, outside or inside, is a way over it
  p.set(at(-558, 63, 2150), 'cobblestone');
  p.set(at(-557, 63, 2146), 'dirt');
  t.deepEqual((await readShells(p.ctx)).ring.faults, ['dirt beside the ring at (-557, 63, 2146): a way over it', 'cobblestone beside the ring at (-558, 63, 2150): a way over it']);
  t.is(peekFetch(p.world).shells!.ring.length, 2);

  // the side toward home taken (a lamp post outside the south gate's cell): the next side, east
  const q = bare();
  await run(q);
  q.set(at(-563, 63, 2150), 'oak_fence');
  t.regex(await run(q), /^fenced the Nether portal, its gate east at \(-555, 63, 2147\)/);
  t.deepEqual(q.world.zones!['ring:gate'], [at(-555, 63, 2147)]);
  t.deepEqual(ringReady(q.world, blocks(q)).filter(f => !/-563, 63, 2150/.test(f)), []);

  // no side free: said, nothing built, and not tried again at once
  const r = bare();
  await run(r);
  for (const c of [at(-563, 63, 2150), at(-554, 63, 2147), at(-563, 63, 2144)]) r.set(c, 'oak_fence');
  const from = r.log.length;
  t.regex(await run(r), /^nothing built: no free ground for the portal's ring \(its gate south: oak_fence stands in the cell outside the gate of the portal ring at \(-563, 63, 2150\); its gate east: .*; its gate west: .*; its gate north: .*\)$/);
  t.deepEqual(r.log.slice(from).filter(e => !/^(gates\.|world\.)/.test(e.name)), []);
  t.false('ring' in r.world.zones!);
  t.regex(peekFetch(r.world).shells!.ring[0], /^the portal has no ring: no free ground for it \(its gate south: /);
  t.is(kindOf(r), 'look');
  t.like(shellsOwed(r.world, r.now() + NOT_AGAIN), { kind: 'ring' });
});

// ------------------------------------------------------------------------------------------------ what does not finish

test.serial('a build that does not finish leaves the plug in and says so; 2 game days on the plug is taken up and the chores go in the old way', async (t) => {
  const p = bare();
  const who = fletcher(p);
  p.on.act['build-structure'] = () => ({ ok: false, text: 'Build of hall-lock stalled after 97s with 12/33 blocks in place. Missing: oak_planks x21 (have 33).\nRun build-structure again to continue.' });
  await t.throwsAsync(run(p), { message: 'the lock is not whole yet: Build of hall-lock stalled after 97s with 12/33 blocks in place. Missing: oak_planks x21 (have 33).' });
  t.deepEqual(PLUG.map(c => idOf(p.get(c))), ['dirt', 'dirt']);
  t.regex(p.said.join('\n'), /Build of hall-lock stalled after 97s .* Run build-structure again to continue\./);
  t.is(peekFetch(p.world).shells?.building, 'lock');
  const t0 = peekFetch(p.world).journal[0].t;
  // it goes on, run after run, and the plug is put down once
  t.like(shellsOwed(p.world, t0 + PLUG_MAX - 1), { kind: 'lock', want: 'the lock\'s build goes on' });
  await t.throwsAsync(run(p));
  t.is(acts(p, 'place').length, 2);
  // 2 game days after the plug went in
  t.like(shellsOwed(p.world, t0 + PLUG_MAX), { kind: 'unplug' });
  const said = await shellsGoal.run({ ...p.ctx, s: p.look({ now: t0 + PLUG_MAX }) });
  t.is(said, 'the lock\'s build did not finish in 2 game days: took the plug up (2 dirt), and the chores go in the old way');
  for (const c of PLUG) t.is(p.get(c), 'air');
  t.deepEqual(peekFetch(p.world).journal, []);
  t.is(peekFetch(p.world).shells?.building, undefined, 'the chores are let in again');
  t.is(lockOf(p.world), undefined);
  t.false(isOpen(p.get(H)));
  t.deepEqual(p.leaks, []);
  t.true(inHall(who.position));
  // not begun again at once (the ring meanwhile), and tried again later
  t.like(shellsOwed(p.world, t0 + PLUG_MAX + 1000), { kind: 'ring' });
  t.like(shellsOwed(p.world, t0 + PLUG_MAX + NOT_AGAIN + 1000), { kind: 'lock', want: 'a lock in front of the villager hall\'s gate' });
});

test.serial('the build is stopped on the tick the gate watch shows the hall\'s gate open, and the plug stays in', async (t) => {
  const p = bare();
  const who = fletcher(p);
  p.on.act['build-structure'] = async () => {
    // Baritone's walk opens H; the brain's watch reads it into fetch.gates
    p.swing(H, true, 'the builder\'s walk');
    p.world.fetch!.gates = { at: p.now(), open: [H], leftOpen: [] };
    await new Promise(res => setTimeout(res, 80));
    return { ok: false, text: 'Build of hall-lock was stopped after 3s with 5/33 blocks in place.' };
  };
  await t.throwsAsync(run(p), { message: 'the lock\'s build was stopped: the hall\'s gate stood open' });
  t.is(acts(p, 'cancel').length, 1);
  t.deepEqual(PLUG.map(c => idOf(p.get(c))), ['dirt', 'dirt']);
  t.false(isOpen(p.get(H)), 'and shut again, read shut');
  t.deepEqual(p.leaks, []);
  t.true(inHall(who.position));
  t.is(kindOf(p), 'lock');
  // an old read of the watch (the gate open an hour before the build began) stops nothing
  const q = bare();
  q.world.fetch = { v: 1, journal: [], wards: [], nextId: 1, gates: { at: q.now() - 3_600_000, open: [H], leftOpen: [] } };
  q.on.act['build-structure'] = async () => { await new Promise(res => setTimeout(res, 40)); return undefined; };
  t.regex(await run(q), /^built the lock in front of the hall's gate/);
  t.deepEqual(acts(q, 'cancel'), []);
});

test.serial('the plug\'s way out: a critical section of the hall\'s kind from the landmark zones on; a villager in the lock, and it stays in', async (t) => {
  const p = bare();
  const seen: unknown[] = [];
  const note = () => { seen.push(out.critical && { why: out.critical.why, live: !out.critical.by.aborted, zones: !!lockOf(p.world) }); return undefined; };
  p.on.call['gates.strict'] = note;
  p.on.call['dig.here'] = note;
  await run(p);
  // (the first strict set is the run's own send before anything stands; the second is the build's, the zones written)
  t.deepEqual(seen, [undefined, { why: 'hall', live: true, zones: true }, { why: 'hall', live: true, zones: true }, { why: 'hall', live: true, zones: true }]);
  t.is(out.critical, undefined);
  // a villager from the yard that stood there as the walls closed: the lock does not stand with it inside (the guard
  // would shut the bot in with it), nothing opens the lock's gate, and the plug stays
  const q = bare();
  const stray = q.villager({ at: at(-557, 63, 2136), mind: 'still' });
  await t.throwsAsync(run(q), { message: 'a villager stands in the lock or in the hall\'s gateway: the lock does not stand until it is out (the plug stays in)' });
  t.deepEqual(PLUG.map(c => idOf(q.get(c))), ['dirt', 'dirt']);
  t.is(lockOf(q.world), undefined);
  t.is(q.get(PLAIN.sill), 'air', 'nor the sill laid yet');
  t.is(peekFetch(q.world).shells?.building, 'lock');
  t.deepEqual(acts(q, 'dig.here'), []);
  t.false(q.changed.some(c => key(c.at) === key(P) && isOpen(c.to)), 'P was never opened');
  t.is(out.critical, undefined);
  // gone, the next run writes the zones and takes the plug up
  q.villagers.splice(q.villagers.indexOf(stray), 1);
  t.regex(await run(q), /^laid the lock's sill; took the plug up \(2 dirt\); the lock is ready$/);
  t.deepEqual(q.walks.filter(w => key(w.to) === key(PLAIN.post)), [], 'the sill laid from where the bot stood, inside: no gate opened for it');
  t.deepEqual(peekFetch(q.world).journal, []);
  // with the lock standing and the plug still in (a kill before the first dirt came up), one that is in there since
  const k = bare();
  k.killAt(acts(p, 'dig.here')[0].i);
  await t.throwsAsync(run(k));
  k.restart();
  t.truthy(lockOf(k.world));
  const late = k.villager({ at: at(-555, 63, 2136), mind: 'still' });
  await t.throwsAsync(run(k), { message: 'a villager stands in the lock or in the hall\'s gateway: the plug stays in' });
  t.deepEqual(PLUG.map(c => idOf(k.get(c))), ['dirt', 'dirt']);
  k.villagers.splice(k.villagers.indexOf(late), 1);
  await run(k);
  t.deepEqual(peekFetch(k.world).journal, []);
  // an animal in there does not keep the hall plugged: the plug comes up, and the lock says who is in it
  const r = bare();
  r.animal('cow', at(-557, 63, 2136));
  t.regex(await run(r), /took the plug up \(2 dirt\); not ready yet: a cow in the lock at \(-557, 63, 2136\)$/);
  t.deepEqual(peekFetch(r.world).journal, []);
  t.is(peekFetch(r.world).shells?.building, undefined);
});

test.serial('the mend of a lock that stands is one critical section from the plug\'s walk in to the plug out (`out of the hall` leaves it be); gone into only with nobody in it and both gates read shut', async (t) => {
  const p = bare();
  await run(p);
  await run(p);
  const wall = at(-558, 64, 2136);
  p.set(wall, 'air');
  const seen: unknown[] = [];
  const note = (what: string) => () => {
    seen.push({ what, inLock: inHallOrLock(p.world, p.bot.at), why: out.critical?.why, live: !!out.critical && !out.critical.by.aborted && out.critical.until > p.now(), wants: outOfHallWants(p.look(), p.world) });
    return undefined;
  };
  p.on.act['build-structure'] = note('build-structure');
  p.on.call['place'] = note('place');
  const look = (n: number) => shellsGoal.run({ ...p.ctx, s: p.look({ now: p.now() + n * LOOK_EVERY }) });
  t.regex(await look(1), /^built the lock in front of the hall's gate \(1 oak_planks\); took the plug up \(2 dirt\); the lock is ready$/);
  t.deepEqual(seen, [
    { what: 'place', inLock: true, why: 'hall', live: true, wants: null }, { what: 'place', inLock: true, why: 'hall', live: true, wants: null },
    { what: 'build-structure', inLock: true, why: 'hall', live: true, wants: null }
  ]);
  t.is(out.critical, undefined, 'the section ended with the mend');
  t.not(p.get(wall), 'air');
  // the lock's gate opened (a player's), or a villager in the lock, after the look-over read it (as the makings are
  // got ready: here at the strict set's check): not gone into, nothing plugged
  delete p.on.act['build-structure'];
  delete p.on.call['place'];
  p.set(wall, 'air');
  let then: (() => void) | undefined = () => p.swing(P, true, 'a player');
  p.on.call['gates.status'] = () => { then?.(); then = undefined; return undefined; };
  const from = p.log.length;
  await t.throwsAsync(look(2), { message: 'the lock\'s gate at (-556, 63, 2137) does not read shut: the lock is not mended now' });
  p.swing(P, false, 'a player');
  let v: ReturnType<Pasture['villager']> | undefined;
  then = () => { v = p.villager({ at: at(-555, 63, 2136), mind: 'still' }); };
  await t.throwsAsync(look(3), { message: 'a villager stands in the lock or in the hall\'s gateway: the lock is not mended now' });
  t.deepEqual(p.log.slice(from).filter(e => ['place', 'goto', 'build-structure', 'useOn'].includes(e.name)), [], 'no walk, no plug, no builder');
  t.is(peekFetch(p.world).shells?.building, undefined, 'the chores not held');
  t.is(out.critical, undefined);
  p.villagers.splice(p.villagers.indexOf(v!), 1);
});

test.serial('a read that is not whole is written nowhere (what was last read whole stands), and is no look over', async (t) => {
  const p = bare();
  await run(p);
  await run(p);
  const before = structuredClone(peekFetch(p.world).shells);
  // the blind seconds after a rejoin: every cell reads null
  p.blind(400);
  const r = await readShells(p.ctx);
  t.false(r.whole);
  t.is(r.lock.faults[0].kind, 'unread');
  t.regex(r.ring.faults[0], /^the ring is not read: /);
  t.deepEqual(peekFetch(p.world).shells, before);
  await t.throwsAsync(shellsGoal.run({ ...p.ctx, s: p.look({ now: p.now() + LOOK_EVERY }) }), { message: /^the lock and the portal's ring are not read/ });
  t.like(shellsOwed(p.world, p.now() + LOOK_EVERY), { kind: 'look' }, 'still owed');
  // a world with no hall and no portal: nothing to read, said so
  const none = new Pasture();
  t.is(await shellsText(none.ctx), 'No lock: no villager hall stands.\nNo ring: the yard has no portal.');
  t.deepEqual(acts(none, 'world.region'), []);
});

// ------------------------------------------------------------------------------------------------ the gate

test.serial('short of the makings nothing is plugged; with no strict gates in the bridge nothing is built', async (t) => {
  const p = yard({ lock: false, ring: false, crossings: false });
  await t.throwsAsync(run(p), { message: /^the lock: short of .* \(nothing plugged yet\)$/ });
  t.deepEqual(acts(p, 'place'), []);
  t.deepEqual(peekFetch(p.world).journal, []);
  t.is(peekFetch(p.world).shells?.building, undefined, 'the chores go on');
  // an older jar: no gates.status
  const q = bare();
  q.on.call['gates.status'] = () => { throw new Error('unknown method gates.status'); };
  await t.throwsAsync(run(q), { message: /^the bridge keeps no strict gates/ });
  t.deepEqual(q.log.filter(e => !/^gates\./.test(e.name)), []);
  t.false('lock' in q.world.zones!);
});

test.serial('the gate: nothing without a hall (and nothing written); by day, from the yard, not from inside the hall, with room for the makings', (t) => {
  const none = new Pasture();
  t.is(shellsGoal.wants(none.look(), none.world), null);
  t.like(shellsGoal.declines!(none.look(), none.world), { cause: 'unneeded', text: 'no villager hall yet' });
  t.is(none.world.fetch, undefined);
  t.is(shellsGoal.priority, 31);
  t.false(shellsGoal.cuts!(none.look(), none.world));

  const p = bare();
  t.is(shellsGoal.wants(p.look(), p.world), 'a lock in front of the villager hall\'s gate');
  t.is(p.world.fetch, undefined, 'a look only');
  t.like(shellsGoal.declines!(p.look({ position: at(-520, 63, 2183), distHome: 29 }), p.world), { cause: 'away' });
  t.like(shellsGoal.declines!(p.look({ dimension: 'the_nether' }), p.world), { cause: 'away', text: 'in the_nether' });
  t.like(shellsGoal.declines!(p.look({ position: INSIDE }), p.world), { cause: 'hold', text: 'the bot stands in the villager hall or its lock' });
  t.like(shellsGoal.declines!(p.look({ slotsUsed: 34 }), p.world), { cause: 'pockets' });
  t.like(shellsGoal.declines!(p.look({ timeOfDay: 9000 }), p.world), { cause: 'late' });
  t.like(shellsGoal.declines!(yard({ lock: false, tod: 13_000 }).look(), p.world), { cause: 'late' });
  // with both standing: a look now and then, and that one needs no room and no long day
  const q = yard();
  t.is(shellsGoal.wants(q.look(), q.world), 'the lock and the portal\'s ring looked over');
  t.is(shellsGoal.wants(q.look({ slotsUsed: 36, timeOfDay: 9000 }), q.world), 'the lock and the portal\'s ring looked over');
  t.deepEqual(strictSet(q.world), { gates: [...Object.values(YARD_GATES), H, P, at(-563, 63, 2149)], pairs: [[P, H]], guard: [{ gate: P, box: lockOf(q.world)!.box }] });
  t.deepEqual(strictSet(p.world), { gates: [...Object.values(YARD_GATES), H], pairs: [], guard: [] });
  t.deepEqual(strictSet(none.world), { gates: [], pairs: [], guard: [] });
});
