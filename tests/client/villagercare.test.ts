import test, { type ExecutionContext } from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolFactory } from '../../src/tool-factory.js';
import { Brain } from '../../src/client/brain/brain.js';
import { registerBrainTools } from '../../src/client/brain/brain-tools.js';
import { brainRun, type ClientRuntime } from '../../src/client/tools.js';
import { noteHall } from '../../src/client/brain/hallchores.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { Seen } from '../../src/client/brain/village.js';
import { CARE_WAITS, careNotes, careOwed, lockSeen, noteLock, outOfHallGoal, outOfHallWants, villagerCareGoal } from '../../src/client/brain/villagercare.js';
import { fetchLine, fetchOf, journal, peekFetch, type Trip, type Ward } from '../../src/client/brain/fetch.js';
import { out as afield } from '../../src/client/brain/pockets.js';
import { HALL_WAITS } from '../../src/client/brain/hallchores.js';
import { lockOf } from '../../src/client/brain/villagerwalk.js';
import { strictSet } from '../../src/client/brain/yardgates.js';
import { H, HOME, P, YARD_GATES, isOpen, key, yard, type Pasture, type Villager } from '../helpers/pasture.js';

// The care goal and `out of the hall` (src/client/brain/villagercare.ts), S0's half: care's rows 1, 2, 4 and 5 (a
// gate left open, the lock's socket and the build's plug, a villager shut in the lock, the hall's gate open behind the
// lock's shut one), the row order, and the bot found inside the hall taken out through the lock. On the pasture
// (tests/helpers/pasture.ts: the live yard with its lock, the bridge's closer, holds, pair and guard ported from the
// Java, villagers that walk out of any open way). The rows are section 7's "C" rows of the design (idle-plan V), named
// in the titles.
//
// Serial: the waits are the modules' (CARE_WAITS, HALL_WAITS) and run on the pasture's own clock, and a critical
// section (pockets.ts `out`) is one for the process.

const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
/** In the yard, south of the lock: where a run of care starts from. */
const START = at(-550, 63, 2145);
const INSIDE = at(-556, 63, 2130);
const POST = at(-553, 63, 2136), SOCKET = at(-554, 63, 2135);
/** A cell inside the lock, the one beside the hall's gate (the plug's lower cell), and the hall's lectern's place. */
const IN_LOCK = at(-557, 63, 2136), PLUG = [at(-556, 63, 2135), at(-556, 64, 2135)], BLOCK = at(-553, 63, 2129);
const WEST = YARD_GATES.west;

/** The waits on the pasture's clock (the one `at()` names). */
function onPasture(t: ExecutionContext, at: () => Pasture): void {
  HALL_WAITS.pollMs = 1000;
  HALL_WAITS.sleep = ms => at().clock.sleep(ms);
  CARE_WAITS.sleep = ms => at().clock.sleep(ms);
  t.teardown(() => { HALL_WAITS.pollMs = 0; delete HALL_WAITS.sleep; delete CARE_WAITS.sleep; delete afield.critical; });
}
/** The yard with its lock, the strict set, the pair and the guard in the bridge (as the brain sends them at its start). */
async function lockYard(o: Parameters<typeof yard>[0] = {}): Promise<Pasture> {
  const p = yard({ at: START, ...o });
  await p.ctx.call('gates.strict', strictSet(p.world) as unknown as Record<string, unknown>);
  return p;
}
type Row = { x: number; y: number; z: number; open: boolean; loaded: boolean; leftOpen: boolean };
/**
 * What the brain's gate watch writes (brain.ts gateWatch): the bridge's gates.status into fetch.gates on the
 * pasture's clock, the loaded rows only; and, `look`, a look into the lock for the care goal's gate.
 */
async function watched(p: Pasture, look = true): Promise<void> {
  const st = await p.ctx.call<{ strict: Row[] }>('gates.status', {});
  const rows = st.strict.filter(r => r.loaded !== false), cell = (r: Row) => at(r.x, r.y, r.z);
  fetchOf(p.world).gates = { at: p.now(), open: rows.filter(r => r.open).map(cell), leftOpen: rows.filter(r => r.leftOpen).map(cell) };
  if (look) noteLock(p.world, (await p.ctx.call<{ entities: Seen[] }>('world.entities', { maxDistance: 128 })).entities, p.now());
}
const owed = (p: Pasture) => { const o = careOwed(p.look(), p.world); return 'none' in o ? o.none : o.row; };
const run = (p: Pasture) => villagerCareGoal.run(p.ctx);
/** what happened to a gate, in order: opened or shut, and by what */
const swings = (p: Pasture, g: Pos) => p.changed.filter(c => key(c.at) === key(g)).map(c => `${isOpen(c.to) ? 'open' : 'shut'}: ${c.how}`);
const cellAt = (q: Pos): Pos => ({ x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z) });
/**
 * The lock's rule watched tick by tick: every instant both gates stood open, every instant the lock's gate stood open
 * with a villager in the lock or in a doorway; and every villager out by the lock's gate.
 */
function guard(p: Pasture) {
  const bad: string[] = [];
  const advance = p.advance.bind(p);
  const lock = lockOf(p.world)!;
  const inLockOrDoor = (q: Pos) => {
    const c = cellAt(q);
    return (c.x >= lock.box.x1 && c.x <= lock.box.x2 && c.z >= lock.box.z1 && c.z <= lock.box.z2) || [lock.p, lock.h].some(g => g.x === c.x && g.z === c.z);
  };
  const note = (what: string) => { if (bad.at(-1)?.split(': ')[1] !== what) bad.push(`tick ${p.tick}: ${what}`); };
  p.advance = (ticks = 1) => {
    for (let i = 0; i < ticks; i++) {
      advance(1);
      const open = isOpen(p.get(P));
      if (open && isOpen(p.get(H))) note('both gates open');
      if (open && p.villagers.some(v => !v.dim && inLockOrDoor(v.position))) note('the lock\'s gate open onto a villager');
    }
  };
  return { bad, leaks: () => p.leaks.filter(l => key(l.gate) === key(P)).map(l => `tick ${l.t}: ${l.uuid} out by the lock's gate`) };
}
const ward = (k: string, where: Ward['where'], last: Pos): Ward => ({
  key: k, uuid: k, from: { site: 'v:-675,2249', at: at(-675, 71, 2249) }, since: 0, bell: true, where,
  last: { at: last, t: 0, tod: 1000, health: 17, profession: 'fletcher' }, health0: 17
});
const trip = (state: Trip['state'], beat: number): Trip => ({
  id: 7, kind: 'bring', site: 'v:-675,2249', state, beat, prep: {}, gate: { at: WEST, side: 'west', inner: at(-563, 63, 2183), outer: at(-567, 63, 2183), yard: 31 },
  spare: [], lure: 'fletching_table', hop: { n: 5, replaced: 0 }, avoid: [], times: {}, counts: { hops: 4, misses: 0, wedges: 0, pins: 0 }
});

// ------------------------------------------------------------------------------------------------ the gate (pure)

test.serial('the row order: a gate left open first, then the lock (its socket, the build\'s plug), then a villager shut in the lock, then the hall\'s gate behind it; owed with the moves off, from the yard only', async (t) => {
  const p = yard({ at: START });
  const w = p.world, now = p.now(), lock = lockOf(w)!;
  t.falsy(w.villagerMoves, 'the moves are off: care owns what stands all the same');
  t.like(careOwed(p.look(), w), { none: { cause: 'unneeded' } });
  // everything at once: the west gate left open, a plug left in the hall's doorway, a villager in the lock with both gates shut
  fetchOf(w).gates = { at: now, open: [{ ...WEST }], leftOpen: [{ ...WEST }] };
  for (const c of PLUG) journal({ world: w }, { k: 'cover', trip: 0, at: c, item: 'dirt', what: 'hall door', st: 'down', t: now });
  noteLock(w, [{ id: 1, name: 'villager', position: { ...IN_LOCK } }], now);
  t.is(owed(p), 1);
  t.is(villagerCareGoal.urgency!(p.look(), w), 75);
  t.true(villagerCareGoal.cuts!(p.look(), w), 'an open gate stops what runs');
  t.regex(villagerCareGoal.wants(p.look(), w)!, /^a gate left open at \(-565, 63, 2183\): shut it$/);
  fetchOf(w).gates = { at: now, open: [], leftOpen: [] };
  t.is(owed(p), 2);
  t.false(villagerCareGoal.cuts!(p.look(), w), 'the plug waits for what runs to end');
  t.is(villagerCareGoal.urgency!(p.look(), w), 75);
  // (the socket's wall block before the plug, both row 2)
  fetchOf(w).shells = { at: now, lock: [`the socket is no wall block: air at (${SOCKET.x}, ${SOCKET.y}, ${SOCKET.z})`], ring: [] };
  t.regex(villagerCareGoal.wants(p.look(), w)!, /socket .* stands open/);
  // not while the lock's build goes on (the plug is the build's), nor while a trip is at the lock (the socket is its)
  fetchOf(w).shells = { at: now, lock: [], ring: [], building: 'lock' };
  t.is(owed(p), 4);
  t.true(villagerCareGoal.cuts!(p.look(), w), 'a villager shut out stops what runs');
  delete fetchOf(w).shells;
  fetchOf(w).journal = [];
  // the hall's gate open by design (written down), the lock's shut, and the lock looked into empty: row 5
  journal({ world: w }, { k: 'gate', trip: 0, at: { ...lock.h }, which: 'hall', t: now });
  fetchOf(w).gates = { at: now, open: [{ ...lock.h }], leftOpen: [{ ...lock.h }] };
  noteLock(w, [], now);
  t.is(owed(p), 5, 'H open by design is not a gate left open (row 1)');
  t.false(villagerCareGoal.cuts!(p.look(), w));
  // and not from inside the hall or the lock (out of the hall's first), nor in the Nether, nor 120 out
  t.like(careOwed(p.look({ position: { ...INSIDE } }), w), { none: { cause: 'hold' } });
  t.like(careOwed(p.look({ dimension: 'the_nether' }), w), { none: { cause: 'away' } });
  t.like(careOwed(p.look({ position: at(HOME.x + 120, 63, HOME.z), distHome: 120 }), w), { none: { cause: 'away' } });
  // a stale read of the gates is no read: nothing owed by it
  fetchOf(w).gates = { at: now - 60_000, open: [{ ...WEST }], leftOpen: [{ ...WEST }] };
  t.like(careOwed(p.look(), w), { none: { cause: 'unneeded' } });
  // a world with no record and no lock: nothing asked at all
  t.like(careOwed(p.look(), { landmarks: { chests: [], farmland: [] }, leash: 96 } as WorldMemory), { none: { cause: 'unneeded', text: 'nothing of the villager fetch stands or is owed' } });
});

test.serial('E5: a passage of 2 s wants nothing; a gate stood open by the bot past 5 s, or out of its reach, is left open, and is owed', async (t) => {
  const p = await lockYard({ at: at(-563, 63, 2183) });
  // the bot's own walk opened the west gate beside it: the second or two of a passage
  p.swing(WEST, true, 'the bot\'s walk');
  p.advance(40);
  await watched(p);
  t.deepEqual(peekFetch(p.world).gates!.open, [WEST]);
  t.deepEqual(peekFetch(p.world).gates!.leftOpen, []);
  t.like(careOwed(p.look(), p.world), { none: { cause: 'unneeded' } });
  t.is(villagerCareGoal.wants(p.look(), p.world), null);
  // still open 5 s on: the bridge calls it left open, and care owes it
  p.advance(80);
  await watched(p);
  t.deepEqual(peekFetch(p.world).gates!.leftOpen, [WEST]);
  t.is(owed(p), 1);
});

// ------------------------------------------------------------------------------------------------ row 1

test.serial('E4: an open gate (a player\'s click, out of the bot\'s reach): care cuts and shuts it, a careful walk and the bridge\'s own click, read back; not owed again', async (t) => {
  const p = await lockYard();
  onPasture(t, () => p);
  p.swing(WEST, true, 'a player');
  p.advance(5);
  await watched(p);
  t.is(owed(p), 1);
  t.true(villagerCareGoal.cuts!(p.look(), p.world));
  const n = p.log.length;
  t.is(await run(p), 'shut the yard\'s west gate at (-565, 63, 2183)');
  t.false(isOpen(p.get(WEST)));
  t.deepEqual(swings(p, WEST), ['open: a player', 'shut: shut (released)']);
  // careful walks only, the bridge's own calls only (no tool on a gate), and the world changed once
  t.true(p.walks.every(x => x.careful));
  t.false(p.log.slice(n).some(e => e.kind === 'act'));
  t.is(p.gained, 1);
  t.deepEqual(peekFetch(p.world).gates!.leftOpen, []);
  t.like(careOwed(p.look(), p.world), { none: { cause: 'unneeded' } });
});

test.serial('a gate that will not shut: said, never thrown (no hold of the brain\'s), and not asked again for half a minute', async (t) => {
  const p = await lockYard();
  onPasture(t, () => p);
  p.swing(WEST, true, 'a player');
  // (a click the server refuses: the gate reads open again at once)
  p.on.call['gates.release'] = () => ({ released: false, open: true });
  p.on.call.useOn = () => ({ used: true, changed: false });
  p.advance(5);
  await watched(p);
  t.is(await run(p), 'the yard\'s west gate at (-565, 63, 2183) does not read shut');
  t.true(isOpen(p.get(WEST)));
  t.like(careOwed(p.look(), p.world), { none: { cause: 'hold' } });
  p.advance(30 * 20 + 20);
  await watched(p);
  t.is(owed(p), 1, 'asked again after its half minute');
});

test.serial('a gate that will not stay shut (under redstone power, a click the server refuses): two rounds lost to it, then left alone 10 min and said in the Fetch line; after that its row stops no run', async (t) => {
  // a shut that does not hold: read shut by the round, open again within the minute
  const p = await lockYard();
  onPasture(t, () => p);
  // (5 s open: left open by the bridge's word with the bot beside it)
  const reopened = async () => { p.swing(WEST, true, 'redstone'); p.advance(5 * 20 + 10); await watched(p); };
  await reopened();
  for (let i = 0; i < 2; i++) {
    t.true(villagerCareGoal.cuts!(p.look(), p.world), `round ${i + 1} cuts`);
    t.is(await run(p), 'shut the yard\'s west gate at (-565, 63, 2183)');
    await reopened();
  }
  const clicks = swings(p, WEST).length;
  t.regex(await run(p), /^the yard's west gate at \(-565, 63, 2183\) will not stay shut: left alone till \d\d:\d\d$/);
  t.is(swings(p, WEST).length, clicks, 'not walked to, not clicked');
  t.like(careOwed(p.look(), p.world), { none: { cause: 'unneeded' } });
  t.regex(fetchLine(p.world, p.now(), careNotes(p.world, p.now())), /; the gate at \(-565, 63, 2183\) will not stay shut \(2 rounds lost to it: under redstone power, or its click refused\): left alone till \d\d:\d\d, and it stops no run;/);
  // its 10 minutes over: owed again, but it waits for the running goal's end
  p.advance(10 * 60 * 20 + 20);
  await watched(p);
  t.like(careOwed(p.look(), p.world), { row: 1, quiet: true });
  t.false(villagerCareGoal.cuts!(p.look(), p.world));
  t.is(await run(p), 'shut the yard\'s west gate at (-565, 63, 2183)');
  t.false(isOpen(p.get(WEST)));
  // a gate that never reads shut: lost at each round, a half minute apart; the second is the last for 10 min
  const q = await lockYard();
  onPasture(t, () => q);
  q.swing(WEST, true, 'a player');
  q.on.call['gates.release'] = () => ({ released: false, open: true });
  q.on.call.useOn = () => ({ used: true, changed: false });
  q.advance(5);
  await watched(q);
  t.is(await run(q), 'the yard\'s west gate at (-565, 63, 2183) does not read shut');
  q.advance(30 * 20 + 20);
  await watched(q);
  t.true(villagerCareGoal.cuts!(q.look(), q.world), 'one round lost: it still cuts');
  t.is(await run(q), 'the yard\'s west gate at (-565, 63, 2183) does not read shut');
  q.advance(30 * 20 + 20);
  await watched(q);
  t.like(careOwed(q.look(), q.world), { none: { cause: 'unneeded' } }, 'left alone');
  q.advance(10 * 60 * 20);
  await watched(q);
  t.like(careOwed(q.look(), q.world), { row: 1, quiet: true });
  t.false(villagerCareGoal.cuts!(q.look(), q.world));
  // a gate a player opens again after its shut held: counted afresh, and it cuts
  const r = await lockYard();
  onPasture(t, () => r);
  r.swing(WEST, true, 'a player');
  r.advance(5);
  await watched(r);
  t.is(await run(r), 'shut the yard\'s west gate at (-565, 63, 2183)');
  r.advance(2 * 60 * 20);
  r.swing(WEST, true, 'a player');
  r.advance(5 * 20 + 10);
  await watched(r);
  t.true(villagerCareGoal.cuts!(r.look(), r.world));
  t.is(await run(r), 'shut the yard\'s west gate at (-565, 63, 2183)');
  t.deepEqual(careNotes(r.world, r.now()), []);
});

test.serial('E32: after a gate stood open, the wards are looked for by uuid: a look of nulls changes nothing; one not seen on two whole looks is astray and HALT; one seen stays', async (t) => {
  const p = await lockYard();
  onPasture(t, () => p);
  const uuid = '00000000-0000-4000-8000-00000000abcd';
  fetchOf(p.world).wards = [ward(uuid, 'led', at(-570, 63, 2183))];
  // (a player's click with the bot back at its work across the yard)
  const open = async () => { p.bot.at = { ...START }; p.swing(WEST, true, 'a player'); p.advance(5); await watched(p); };
  // the client just rejoined as the look is made: the hall's floor reads null, the look sees nobody
  await open();
  p.on.call['world.region'] = (q: Record<string, unknown>) => { if (q.height === 1 && Number(q.width) >= 11) p.blind(200); return undefined; };
  t.regex(await run(p), /^shut the yard's west gate at \(-565, 63, 2183\); the wards not looked for: no whole look/);
  t.like(peekFetch(p.world).wards[0], { where: 'led' });
  t.is(peekFetch(p.world).halt, undefined);
  delete p.on.call['world.region'];
  p.advance(300);
  // seen: it stays as it is
  const v = p.villager({ at: at(-560, 63, 2180), id: 0xabcd, profession: 'fletcher', mind: 'still' });
  t.is(v.uuid, uuid);
  await open();
  t.regex(await run(p), /; the ward seen$/);
  t.like(peekFetch(p.world).wards[0], { where: 'led' });
  // gone: not seen on two whole looks 10 s apart
  p.villagers.splice(p.villagers.indexOf(v), 1);
  await open();
  const t0 = p.tick;
  t.regex(await run(p), /; 1 ward\(s\) not seen on two whole looks: astray, HALT$/);
  t.true(p.tick - t0 >= 200, 'the two looks 10 s apart');
  t.like(peekFetch(p.world).wards[0], { where: 'astray', note: 'not seen after the gate at (-565, 63, 2183) stood open' });
  t.regex(peekFetch(p.world).halt!.why, /^a gate stood open at \(-565, 63, 2183\) and ward 00000000 was not seen on two whole looks after/);
  t.regex(fetchLine(p.world, p.now()), /^Fetch: HALT: a gate stood open/);
});

// ------------------------------------------------------------------------------------------------ rows 4 and 5

test.serial('E25 and E27: a resident shut in the lock is let back in from the post (the journal first, never the lock\'s gate); the hall\'s gate open behind the shut lock is left alone while it is there, and shut once the lock is empty on two looks', async (t) => {
  const p = await lockYard();
  onPasture(t, () => p);
  const w = guard(p);
  const v = p.villager({ at: IN_LOCK, id: 9101, profession: 'fletcher', mind: 'still' });
  await watched(p);
  t.deepEqual(lockSeen(p.world)?.villagers, 1);
  t.is(owed(p), 4);
  const n = p.log.length;
  t.regex(await run(p), /^a villager shut in the lock: opened the hall's gate for it from the post \(the lock's gate shut\)/);
  // from the post (careful), the raw click on the hall's gate, written down and saved before it; the lock's gate never touched
  t.deepEqual(p.bot.at, POST);
  t.true(p.walks.every(x => x.careful));
  const click = p.log.slice(n).find(e => e.name === 'useOn')!;
  t.like(click.params, { x: H.x, y: H.y, z: H.z });
  t.like(peekFetch(JSON.parse(click.saved) as WorldMemory).journal[0], { k: 'gate', which: 'hall', trip: 0, at: H });
  t.deepEqual(swings(p, P), []);
  t.true(isOpen(p.get(H)));
  t.deepEqual(p.adopted(), [], 'from the post the hall\'s gate is nobody\'s: it stays open');
  t.is(p.gained, 1);
  // E27: open by design behind the lock's shut gate, a villager in the lock: nothing owed (row 1 leaves it, row 5 waits)
  p.advance(120);
  await watched(p);
  t.deepEqual(peekFetch(p.world).gates!.leftOpen, [H]);
  t.like(careOwed(p.look(), p.world), { none: { cause: 'unneeded' } });
  t.regex(fetchLine(p.world, p.now()), /H open \(it goes in when it will\)/);
  t.notRegex(fetchLine(p.world, p.now()), /left open/);
  // it walks back to its block; the lock is empty at the next look, and the hall's gate is shut behind it
  Object.assign(v, { mind: 'home', home: BLOCK });
  p.advance(200);
  t.true(v.position.z < H.z, 'back in the hall');
  await watched(p);
  t.is(owed(p), 5);
  const t0 = p.tick, m = p.log.length;
  t.regex(await run(p), /^nobody left in the lock: shut the hall's gate from the post; 1 in the hall$/);
  t.true(p.tick - t0 >= 200, 'two looks 10 s apart');
  t.is(p.log.slice(m).filter(e => e.name === 'world.entities').length, 3, 'two looks into the lock, then the count');
  t.false(isOpen(p.get(H)) || isOpen(p.get(P)));
  t.deepEqual(peekFetch(p.world).journal, []);
  t.like(careOwed(p.look(), p.world), { none: { cause: 'unneeded' } });
  t.deepEqual(w.bad, []);
  t.deepEqual(w.leaks(), []);
});

test.serial('row 5 with a villager back in the lock between the two looks: the hall\'s gate stays open, nothing is shut onto it, and row 5 waits for an empty look', async (t) => {
  const p = await lockYard();
  onPasture(t, () => p);
  const lock = lockOf(p.world)!;
  journal({ world: p.world }, { k: 'gate', trip: 0, at: { ...lock.h }, which: 'hall', t: p.now() });
  p.swing(H, true, 'useOn');
  await watched(p);
  t.is(owed(p), 5);
  // it steps into the lock as the bot looks
  p.at(p.tick + 60, () => { p.villager({ at: IN_LOCK, id: 9102, mind: 'still' }); });
  t.regex(await run(p), /^waiting: a villager in the lock, the hall's gate open for it behind the lock's shut one$/);
  t.true(isOpen(p.get(H)));
  t.is(peekFetch(p.world).journal.length, 1);
  t.like(careOwed(p.look(), p.world), { none: { cause: 'unneeded' } }, 'the look saw it: not owed until a look finds the lock empty');
  // and a hall's gate found shut with its entry left (a player's click): only the entry goes
  p.villagers.length = 0;
  p.swing(H, false, 'a player');
  await watched(p);
  t.is(owed(p), 5);
  t.is(await run(p), 'the hall\'s gate reads shut: its journal entry dropped');
  t.deepEqual(peekFetch(p.world).journal, []);
});

// ------------------------------------------------------------------------------------------------ row 2

test.serial('row 2: the lock\'s socket found open (a kill in a trip\'s DOOR step leaves it air): the wall block back from the post, the lock\'s gate read shut first, the bot\'s own', async (t) => {
  const p = await lockYard();
  onPasture(t, () => p);
  p.set(SOCKET, 'air');
  fetchOf(p.world).shells = { at: p.now(), lock: [`the socket is no wall block: air at (${SOCKET.x}, ${SOCKET.y}, ${SOCKET.z})`], ring: [] };
  t.is(owed(p), 2);
  const planks = p.count('oak_planks');
  t.is(await run(p), 'put the lock\'s wall block back in the socket at (-554, 63, 2135) (oak_planks)');
  t.is(p.get(SOCKET).replace(/\[.*$/, ''), 'oak_planks');
  t.is(p.count('oak_planks'), planks - 1);
  t.true(p.protection.has(key(SOCKET)), 'the bot\'s own, on the record');
  t.deepEqual(p.bot.at, POST);
  t.deepEqual(peekFetch(p.world).shells!.lock, []);
  t.like(careOwed(p.look(), p.world), { none: { cause: 'unneeded' } });
  t.deepEqual(swings(p, P), []);
  t.deepEqual(swings(p, H), []);
});

test.serial('X5: a plug left in the hall\'s doorway with the lock standing (a build killed after its last block): taken up through the lock\'s gate, the hall\'s never opened; with a villager in the gateway it stays, said, and waits', async (t) => {
  const p = await lockYard();
  onPasture(t, () => p);
  const w = guard(p);
  const resident = p.villager({ at: INSIDE, id: 9103, profession: 'fletcher', mind: 'still' });
  for (const c of PLUG) { p.set(c, 'dirt'); p.mine(c, 'dirt'); journal({ world: p.world }, { k: 'cover', trip: 0, at: c, item: 'dirt', what: 'hall door', st: 'down', t: p.now() }); }
  // the build still under way: the plug is the build's
  fetchOf(p.world).shells = { at: p.now(), lock: [], ring: [], building: 'lock' };
  t.like(careOwed(p.look(), p.world), { none: { cause: 'unneeded' } });
  delete fetchOf(p.world).shells!.building;
  // a villager standing in the hall's gateway: the dirt is not taken from before its feet
  const inGate = p.villager({ at: H, id: 9104, mind: 'still' });
  t.is(owed(p), 2);
  t.regex(await run(p), /^the plug stays in for now: a villager stands in the lock or in the hall's gateway: the plug stays in$/);
  t.like(careOwed(p.look(), p.world), { none: { cause: 'hold' } });
  p.villagers.splice(p.villagers.indexOf(inGate), 1);
  p.advance(30 * 20 + 20);
  t.is(owed(p), 2);
  t.is(await run(p), 'took up the plug left in the hall\'s doorway (2 dirt)');
  t.true(PLUG.every(c => p.get(c) === 'air'));
  t.deepEqual(peekFetch(p.world).journal, []);
  t.false(isOpen(p.get(P)) || isOpen(p.get(H)));
  t.deepEqual(swings(p, H), [], 'the hall\'s gate never opened');
  t.true(resident.position.z < H.z);
  t.deepEqual(w.bad, []);
  t.deepEqual(w.leaks(), []);
});

// ------------------------------------------------------------------------------------------------ out of the hall

test.serial('E17: a chores visit under way is not disturbed: no want while its critical section is live; one given up, run out or of another kind is no visit', (t) => {
  const p = yard({ at: INSIDE });
  t.teardown(() => { delete afield.critical; });
  const s = p.look();
  t.regex(outOfHallWants(s, p.world)!, /^the bot is in the villager hall or its lock with no chores visit under way: out through the lock$/);
  const visit = new AbortController();
  afield.critical = { by: visit.signal, until: s.now + 60_000, why: 'hall' };
  t.is(outOfHallWants(s, p.world), null);
  t.is(outOfHallGoal.wants(s, p.world), null);
  // run out, of another kind, or its run given up: wanted
  t.truthy(outOfHallWants({ ...s, now: s.now + 60_000 }, p.world));
  afield.critical = { by: visit.signal, until: s.now + 60_000, why: 'gate' };
  t.truthy(outOfHallWants(s, p.world));
  afield.critical = { by: visit.signal, until: s.now + 60_000, why: 'hall' };
  visit.abort();
  t.truthy(outOfHallWants(s, p.world));
  // never outside the hall, nor in another dimension, nor on the post
  t.is(outOfHallWants(p.look({ position: { ...START } }), p.world), null);
  t.is(outOfHallWants(p.look({ position: { ...POST } }), p.world), null);
  t.is(outOfHallWants(p.look({ dimension: 'the_nether' }), p.world), null);
  // no lock yet: out by the hall's own gate
  t.regex(outOfHallWants(yard({ at: INSIDE, lock: false }).look(), yard({ lock: false }).world)!, /out by its gate, shut behind/);
});

test.serial('E16: the bot found in the hall with no visit under way leaves through the lock; a resident shut out in the lock is waited out (the bot stays inside), then out; one that follows it into the lock never gets out', async (t) => {
  for (const follows of [false, true]) {
    const p = await lockYard({ at: INSIDE });
    onPasture(t, () => p);
    const w = guard(p);
    const name = follows ? 'a resident that follows the bot' : 'a resident shut out in the lock';
    const v: Villager = follows
      ? p.villager({ at: at(-556, 63, 2132), id: 9105, profession: 'fletcher' })
      : p.villager({ at: IN_LOCK, id: 9106, profession: 'fletcher', mind: 'still' });
    t.truthy(outOfHallWants(p.look(), p.world), name);
    const said: string[] = [];
    for (let i = 0; i < 6 && outOfHallWants(p.look(), p.world); i++) {
      said.push(await outOfHallGoal.run(p.ctx));
      // (after the first try it goes back to its block, as an employed one does in work hours)
      if (i === 0) Object.assign(v, { mind: 'home', home: BLOCK });
    }
    t.is(said.at(-1), 'out of the villager hall through the lock', `${name}: ${said.join(' | ')}`);
    if (!follows) t.regex(said[0], /^waiting: a villager is in the lock/, name);
    t.is(outOfHallWants(p.look(), p.world), null, name);
    t.false(isOpen(p.get(P)) || isOpen(p.get(H)), name);
    t.true(v.position.z < H.z, `${name}: in the hall at ${key(cellAt(v.position))}`);
    t.deepEqual(w.bad, [], name);
    t.deepEqual(w.leaks(), [], name);
    t.true(p.walks.every(x => x.careful), name);
    t.is(afield.critical, undefined, name);
  }
});

test.serial('out of the hall with no lock yet: out by the hall\'s own gate, a careful walk, the gate shut behind and read shut', async (t) => {
  const p = yard({ at: INSIDE, lock: false });
  onPasture(t, () => p);
  t.is(await outOfHallGoal.run(p.ctx), 'out of the villager hall by its gate; shut the hall\'s gate');
  t.false(isOpen(p.get(H)));
  t.true(p.bot.at.z > H.z);
  t.true(p.walks.every(x => x.careful));
});

// ------------------------------------------------------------------------------------------------ the tools

/**
 * A brain over the pasture with the brain's own tools (brain-tools.ts) registered on a stub server: its memory is the
 * pasture's world (as brain.json), its runtime the pasture's bridge and tools.
 */
function withTools(t: ExecutionContext, p: Pasture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-care-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memoryFile = path.join(dir, 'brain.json');
  fs.writeFileSync(memoryFile, JSON.stringify({ 'seed:1': p.world }));
  const reply = (r: { ok: boolean; text: string }) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) });
  const rt = {
    actions: new Proxy({}, { get: (_, tool: string) => async (a: Record<string, unknown>) => reply(await p.ctx.act(tool, a)) }),
    call: (async (m: string, q?: Record<string, unknown>) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      return p.ctx.call(m, q);
    }) as ClientRuntime['call'],
    status: async () => ({ ...(await p.ctx.status()), hashedSeed: '1' }),
    home: () => ({ ...HOME, dimension: 'overworld' }),
    lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => p.now(), goals: [], memoryFile });
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) };
  registerBrainTools(new ToolFactory(server, connection), brain, rt);
  const tools = (server.tool as sinon.SinonStub).getCalls();
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tools.find(c => c.args[0] === name)!.args[3](args);
    return (r.content as { text: string }[]).map(c => c.text).join('\n');
  };
  return { brain, tool, file: memoryFile };
}

test.serial('D22: fetch-safe says no while a villager is led, in a critical section, or with the bot in the hall; with stop it switches the autopilot off, stops what runs and saves', async (t) => {
  const p = yard({ at: START });
  t.teardown(() => { delete afield.critical; });
  const { brain, tool, file } = withTools(t, p);
  brain.setEnabled(true);
  await brain.tick();
  const world = brain.worldMemory()!;
  t.regex(await tool('fetch-safe'), /^safe: /);
  fetchOf(world).trip = trip('hop', p.now());
  t.is(await tool('fetch-safe'), 'not safe: a villager is being led (trip 7, hop 5)');
  // a trip nobody drives any more (its beat 90 s old) is no lead
  p.advance(91 * 20);
  t.regex(await tool('fetch-safe'), /^safe: /);
  delete fetchOf(world).trip;
  const run = new AbortController();
  afield.critical = { by: run.signal, until: p.now() + 60_000, why: 'gate' };
  t.is(await tool('fetch-safe'), 'not safe: a villager is at the yard gate');
  delete afield.critical;
  p.bot.at = { ...INSIDE };
  t.is(await tool('fetch-safe'), 'not safe: the bot stands in the villager hall or its lock');
  // with stop: off in this process, saved (what the harness's /stop does before it closes)
  t.true(brain.enabled);
  fetchOf(world).last = { at: p.now(), text: 'a mark to find in brain.json', got: 0 };
  t.regex(await tool('fetch-safe', { stop: true }), /^stopped: the autopilot is off in this process, its memory saved\. Before the stop it was not safe: the bot stands in the villager hall or its lock$/);
  t.false(brain.enabled);
  t.regex(fs.readFileSync(file, 'utf8'), /a mark to find in brain\.json/);
});

test.serial('villager-plan: the lock and the ring with their faults, every strict gate as it reads and as the bridge keeps it, the hall\'s job blocks with their holders and the free count; not read from another dimension', async (t) => {
  const p = await lockYard();
  const { brain, tool } = withTools(t, p);
  brain.setEnabled(true);
  await brain.tick();
  brain.setEnabled(false);
  const world = brain.worldMemory()!;
  // the resident seen by the hall's fletching table at work on five looks (the census's evidence: hallchores.ts noteHall)
  const table = p.world.zones!['hall:fletching']![0];
  for (let i = 0; i < 5; i++) noteHall(world, [{ id: 9107, uuid: '00000000-0000-4000-8000-00000000238b', name: 'villager', profession: 'fletcher', position: { x: table.x + 0.5, y: table.y, z: table.z + 1.5 } }], p.now(), true, 3000);
  const text = await tool('villager-plan');
  t.regex(text, /^The lock stands at the hall's south gate: P \(-556, 63, 2137\), H \(-556, 63, 2134\), socket \(-554, 63, 2135\), sill \(-553, 63, 2135\), post \(-553, 63, 2136\), S_out \(-554, 63, 2139\): ready$/m);
  t.regex(text, /^The portal's ring stands, its gate south at \(-563, 63, 2149\): ready$/m);
  t.regex(text, /^ {2}- the yard's west gate at \(-565, 63, 2183\): shut$/m);
  t.regex(text, /^ {2}- the lock's gate at \(-556, 63, 2137\): shut$/m);
  t.regex(text, /^The bridge keeps \d+ of them strict \(of \d+\): none left open; its own shut clicks since the client started: hold 0, pair 0, guard 0\.$/m);
  t.regex(text, new RegExp(`^ {2}- fletching_table at \\(${table.x}, ${table.y}, ${table.z}\\) \\(fletcher\\): held by 00000000 \\(seen by it at work 5 time\\(s\\)`, 'm'));
  t.regex(text, /^ {2}Free by kind: .*fletching_table 0/m);
  t.regex(text, /^The hall: in the hall 1 adult/m);
  // (what the read said is kept: fetch.shells, whole)
  t.deepEqual(peekFetch(world).shells?.lock, []);
  // from the Nether: not read, nothing written
  p.on.call.status = () => ({ ...(p.answer('status', {}) as Record<string, unknown>), dimension: 'the_nether' });
  t.is(await tool('villager-plan'), 'Not read: the bot is in the_nether (the lock, the ring and the hall are read from the overworld).');
});
