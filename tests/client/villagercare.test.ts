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
import { fetchLine, fetchOf, journal, peekFetch, wardOut, type FetchMemory, type Trip, type Ward } from '../../src/client/brain/fetch.js';
import { out as afield } from '../../src/client/brain/pockets.js';
import { HALL_WAITS } from '../../src/client/brain/hallchores.js';
import { lockOf } from '../../src/client/brain/villagerwalk.js';
import { strictSet } from '../../src/client/brain/yardgates.js';
import { H, HOME, P, YARD, YARD_GATES, idOf, isOpen, key, yard, type Pasture, type Villager } from '../helpers/pasture.js';

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
  // in the Nether: no restart (the bot would come back up there and find its portal home on its own)
  const atHall = p.bot.at;
  p.bot.at = { ...START };
  const plain = p.on.call.status;
  p.on.call.status = () => ({ ...(p.answer('status', {}) as Record<string, unknown>), dimension: 'the_nether' });
  t.is(await tool('fetch-safe'), 'not safe: the bot is in the_nether (a restart there leaves it to find its portal home on its own; it is back by dusk)');
  if (plain) p.on.call.status = plain; else delete p.on.call.status;
  t.regex(await tool('fetch-safe'), /^safe: /);
  p.bot.at = atHall;
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

// ================================================================================================ S1: the trip's rows

// Care's S1 half (rows 3 and 6-10: a trip nobody drives resumed, the armed rescue, a lure left outside the fence
// fetched, RESTORE, the lead's word, PREP) on the pasture with the game's own villagers (mind 'game'), the lure's acts
// (lure.ts) under them. The rows are section 7's C rows; the kill rows are tests/client/fetch-kill.test.ts's.

const SMITHING_AT = at(-541, 63, 2153);
const NORTH = YARD_GATES.north;
const NORTH_WAY = { at: { ...NORTH }, side: 'north' as const, inner: at(-549, 63, 2121), outer: at(-549, 63, 2117), yard: 18 };
const V_BELL = at(-720, 63, 2128), V_AREA = { x1: -750, z1: 2098, x2: -690, z2: 2158 };
const HALL_AREA = { x1: -561, z1: 2126, x2: -551, z2: 2134 };
const flat = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const inArea = (b: { x1: number; z1: number; x2: number; z2: number }, c: { x: number; z: number }) => Math.floor(c.x) >= b.x1 && Math.floor(c.x) <= b.x2 && Math.floor(c.z) >= b.z1 && Math.floor(c.z) <= b.z2;

/** The care's waits and its lead's on the pasture's clock (the lure's waits run on CARE_WAITS through the care's clock). */
function onTrip(t: ExecutionContext, at: () => Pasture): void {
  onPasture(t, at);
  CARE_WAITS.now = () => at().now();
  t.teardown(() => { delete CARE_WAITS.now; delete afield.ledBy; });
}

/**
 * The pasture as a trip finds it (lure.test.ts's homestead): moves on, the lure, armed once; a free village on the lawn
 * to the west, counted whole; the hall's resident fletcher at its table and the lectern by it free.
 */
function homestead(o: Parameters<typeof yard>[0] & { candidates?: number; resident?: boolean } = {}): Pasture {
  const p = yard({ crossings: false, tod: 10_000, ...o });
  const now = p.now();
  p.world.villagerMoves = true;
  p.world.fetch = { v: 1, method: 'lure', armed: 1, journal: [], wards: [], nextId: 1 } as FetchMemory;
  p.world.villages = {
    sites: [{
      x: V_BELL.x, y: V_BELL.y, z: V_BELL.z, bells: 1, beds: 7, jobs: 3, villagers: 7, seenAt: now, area: { ...V_AREA },
      judged: { at: now, kind: 'free', why: '7 villagers, 3 unemployed adult(s) to take', v: 4 }, whole: { at: now, villagers: 7, takes: 1 }
    }], players: []
  } as unknown as WorldMemory['villages'];
  p.set(V_BELL, 'bell[attachment=floor,facing=north,powered=false]');
  p.set(BLOCK, 'lectern[facing=south,has_book=false,powered=false]');
  p.mine(BLOCK);
  if (o.resident !== false) p.villager({ at: at(-552, 63, 2128), mind: 'still', profession: 'fletcher', level: 4, id: 100 });
  for (let i = 0; i < (o.candidates ?? 0); i++) p.villager({ at: at(V_BELL.x + 4 + 3 * i, 63, V_BELL.z + 2 * i), mind: 'game', id: 200 + i, bell: { ...V_BELL } });
  return p;
}

/**
 * A trip already under way, as a cut or a kill leaves the records (lure.test.ts's `led`): its ward a game villager
 * working at a lure of the bot's, the workshop's smithing table lifted. `beat`: how old the run's beat is (default:
 * a minute, nobody at it).
 */
function underWay(p: Pasture, o: { at: Pos; lure: Pos; state: Trip['state']; committed?: 'far' | 'drop'; bell?: boolean; toGate?: number; yard?: number; id?: number; cut?: string; mind?: Villager['mind'] }): { v: Villager; ward: Ward; trip: Trip } {
  const now = p.now(), f = fetchOf(p.world);
  p.set(o.lure, 'fletching_table', 'placed');
  p.mine(o.lure);
  // (the smithing table lifted by PREP and carried until it goes back)
  p.set(SMITHING_AT, 'air');
  p.give('smithing_table');
  const v = p.villager({ at: o.at, mind: o.mind ?? 'game', id: o.id ?? 300, profession: 'fletcher', job: { ...o.lure }, bell: { ...V_BELL } });
  const site = 'village -720,2128';
  const w: Ward = { key: v.uuid, uuid: v.uuid, id: v.id, from: { site, at: { ...V_BELL } }, since: now, bell: o.bell ?? true, where: 'led', last: { at: { ...v.position }, t: now, tod: p.tod, health: 20, profession: 'fletcher' }, health0: 20 };
  f.journal.push({ k: 'lift', id: 1, trip: 9, at: { ...SMITHING_AT }, block: 'smithing_table', item: 'smithing_table', st: 'done', why: 'job site', t: now },
    { k: 'lure', id: 2, trip: 9, at: { ...o.lure }, item: 'fletching_table', st: 'down', role: inArea(YARD, o.lure) ? 'yard' : 'hop', t: now });
  f.wards.push(w);
  const tr: Trip = {
    id: 9, kind: 'bring', site, state: o.state, beat: now - 60_000, entered: now, prep: { read: now, kit: now, lifts: now }, prepared: { at: now, day: 0 },
    gate: { ...NORTH_WAY }, spare: [], lure: 'fletching_table', hop: { n: 4, lure: { ...o.lure }, replaced: 0 }, ward: v.uuid, avoid: [], times: {},
    counts: { hops: 4, misses: 0, wedges: 0, pins: 0 }, path: { toGate: o.toGate ?? 0, yard: o.yard ?? 10 }, ...(o.committed ? { committed: o.committed } : {}), ...(o.cut ? { cut: { at: now, why: o.cut } } : {})
  };
  f.trip = tr;
  f.nextId = 10;
  p.saved = JSON.stringify(p.world);
  return { v, ward: w, trip: tr };
}

/** One turn of care as the brain gives it: the gate watch's read first, then care's run when it owes a row (its row and what it said). */
async function careTurn(p: Pasture): Promise<{ row: number; said: string } | undefined> {
  await watched(p);
  const o = careOwed(p.look(), p.world);
  if ('none' in o) return undefined;
  return { row: o.row, said: await villagerCareGoal.run(p.ctx) };
}
/** Care's turns until it owes nothing it can do now (or `n` turns), 5 s apart (its retry): the rows it ran. */
async function careTurns(p: Pasture, n = 12): Promise<{ row: number; said: string }[]> {
  const out: { row: number; said: string }[] = [];
  for (let i = 0; i < n; i++) {
    const r = await careTurn(p);
    if (!r) break;
    out.push(r);
    p.advance(100);
  }
  return out;
}
const rowsRun = (turns: { row: number }[]) => turns.map(x => x.row);
/** The row care owes now from where the bot stands, or undefined. */
const rowNow = (p: Pasture, over: Partial<ReturnType<Pasture['look']>> = {}) => { const o = careOwed(p.look(over), p.world); return 'row' in o ? o.row : undefined; };

test.serial('the trip\'s rows in the order and urgencies of 6.1: 3 at 75 and it cuts, 6-8 at 62, 9 and 10 at 35, none of them cut; the trip\'s rows from wherever the bot stands, the yard\'s from home', async (t) => {
  const p = homestead({ tod: 3_000, at: START });
  onTrip(t, () => p);
  const w = p.world, f = fetchOf(w), now = p.now();
  const { trip: tr, ward: wd } = underWay(p, { at: at(-551, 63, 2150), lure: at(-551, 63, 2149), state: 'yardhop', committed: 'far' });
  // 3: a trip nobody drives (its beat a minute old)
  t.like(careOwed(p.look(), w), { row: 3 });
  t.is(villagerCareGoal.urgency!(p.look(), w), 75);
  t.true(villagerCareGoal.cuts!(p.look(), w), 'a villager on a lure with nobody at it stops what runs');
  // not while a run of this process is at it (the work queue's run, a lead's hold), nor with its beat fresh
  afield.work = true;
  t.not(rowNow(p), 3);
  afield.work = false;
  // (a lead's hold of this process: its run is at it, fresh beat or not; a fresh beat with no run here is nobody's: a restart)
  afield.ledBy = new AbortController().signal;
  t.not(rowNow(p), 3, 'a lead holds it');
  delete afield.ledBy;
  tr.beat = now;
  t.is(rowNow(p), 3, 'its beat fresh, but no run of this process at it: a restart');
  tr.cut = { at: now, why: 'retreat is more urgent' };
  t.like(careOwed(p.look(), w), { row: 3 }, 'cut: the exit handler ran, nobody at it');
  // from 140 out across the ground (where a cut leaves the bot): the resume all the same; not at night
  t.like(careOwed(p.look({ position: at(-690, 63, 2150), distHome: 141 }), w), { row: 3 });
  t.like(careOwed(p.look({ timeOfDay: 13_000 }), w), { none: { cause: 'unneeded' } }, 'not at night');
  // cut before any lure: the record only, and it stops no run
  tr.state = 'out';
  t.like(careOwed(p.look(), w), { row: 3, quiet: true });
  t.false(villagerCareGoal.cuts!(p.look(), w));
  delete f.trip;
  // 6: a ward astray, armed, no halt, no trip
  wd.where = 'astray';
  t.like(careOwed(p.look(), w), { row: 6 });
  t.is(villagerCareGoal.urgency!(p.look(), w), 62);
  t.false(villagerCareGoal.cuts!(p.look(), w));
  f.halt = { at: now, why: 'stopped' };
  t.like(careOwed(p.look(), w), { row: 8 }, 'halt: no rescue; the trip\'s lure in the yard is RESTORE\'s (the lift held for the ward)');
  delete f.armed;
  delete f.halt;
  // 7: a lure left in the village (a cut's), whatever the switches; 62
  w.villagerMoves = false;
  f.journal.push({ k: 'lure', id: 3, trip: 8, at: at(-716, 63, 2131), item: 'fletching_table', st: 'down', role: 'village', inVillage: true, t: now });
  t.like(careOwed(p.look(), w), { row: 7 });
  t.is(villagerCareGoal.urgency!(p.look(), w), 62);
  // (not with the daylight short for the walk out and back)
  t.not(rowNow(p, { timeOfDay: 10_950 }), 7);
  f.journal.pop();
  // 8 at 62: the trip's lure in the yard, its trip gone (the lift held while the ward is out)
  t.like(careOwed(p.look(), w), { row: 8 });
  t.is(villagerCareGoal.urgency!(p.look(), w), 62);
  f.journal = f.journal.filter(e => e.k !== 'lure');
  // 9 at 35: what waits on the lead (the ward astray), once a game day
  t.like(careOwed(p.look(), w), { row: 9 });
  t.is(villagerCareGoal.urgency!(p.look(), w), 35);
  t.false(villagerCareGoal.cuts!(p.look(), w));
});

test.serial('S1 follow-up R2: a trip in PREP (its reads and kit, or prepared) on a yard that is not whole, or whose gate is off the fence, is put back by row 8 before PREP goes on; no rescue is owed while the yard is not whole, and row 9 says why; a whole yard as before', async (t) => {
  const p = homestead({ tod: 7000, at: START });
  onTrip(t, () => p);
  const w = p.world, f = fetchOf(w), now = p.now(), y0 = { ...w.yard! };
  const want = () => { const o = careOwed(p.look(), w); return 'row' in o ? `${o.row}: ${o.want}` : `none: ${o.none.text}`; };
  const prepTrip = (over: Partial<Trip> = {}): Trip => ({
    id: 5, kind: 'bring', site: 'village -720,2128', state: 'prep', beat: now, prep: { read: now, kit: now }, gate: { ...NORTH_WAY }, spare: [],
    lure: 'fletching_table', avoid: [], times: {}, counts: { hops: 0, misses: 0, wedges: 0, pins: 0 }, ...over
  });
  const grow = () => { w.fenceMove = { side: 'north', old: { ...y0 } }; w.yard = { ...y0, z1: y0.z1 - 16 }; };
  const whole = () => { delete w.fenceMove; w.yard = { ...y0 }; };
  // the reads and the kit stamped, the yard whole: nothing put back (its lifts wait for 9000)
  f.trip = prepTrip();
  t.false(want().startsWith('8:'), want());
  // the growth's last run moved the box (P1: before PREP's lifts)
  grow();
  t.is(want(), '8: trip 5 in PREP put back: the yard is not whole: the fence is moving out to the north');
  // prepared (its lifts made) the same: it never sets out on the old stamps
  f.trip = prepTrip({ prep: { read: now, kit: now, lifts: now }, prepared: { at: now, day: 0 } });
  t.is(want(), '8: trip 5 in PREP put back: the yard is not whole: the fence is moving out to the north');
  // the old side taken down: the zones deleted
  const zones = structuredClone(w.zones!);
  delete w.zones!.fence;
  delete w.fenceMove;
  t.is(want(), '8: trip 5 in PREP put back: the yard is not whole: the fence is not up round the yard as it stands (being rebuilt)');
  w.zones = zones;
  whole();
  t.false(want().startsWith('8:'), 'whole again: not put back');
  // the trip's gate gone from the records (a gate moved by hand): put back
  w.zones!['fence:gate'] = w.zones!['fence:gate']!.filter(g => !(g.x === NORTH.x && g.z === NORTH.z));
  t.is(want(), '8: trip 5 in PREP put back: its north gate is no longer on the yard\'s fence');
  w.zones = structuredClone(zones);
  delete f.trip;
  // the armed rescue: owed by day on a whole yard; not while the yard is not whole, and the lead's word says why
  p.advance(((3000 - p.tod) % 24_000 + 24_000) % 24_000);
  const { ward: wd } = underWay(p, { at: at(-551, 63, 2150), lure: at(-551, 63, 2149), state: 'yardhop', committed: 'far' });
  delete f.trip;
  wd.where = 'astray';
  t.like(careOwed(p.look(), w), { row: 6 });
  f.journal = f.journal.filter(e => e.k !== 'lure');
  grow();
  t.is(want(), `9: waits on the lead: ward ${wd.key.slice(0, 8)} astray at (-551, 63, 2150): no rescue while the yard is not whole (the fence is moving out to the north)`);
  whole();
  t.like(careOwed(p.look(), w), { row: 6 });
});

/**
 * A lead cut by a survival goal (an abort, as the brain's stopRunning gives it) after its `n`th lure went down: the exit
 * handler ran (the ward astray at its tether, the trip cut). Where the bot stood when it was cut.
 */
async function cutLead(t: ExecutionContext, p: Pasture, n = 2): Promise<Pos> {
  const ac = new AbortController();
  let puts = 0;
  p.on.call.place = () => { if (++puts === n && !ac.signal.aborted) p.at(p.tick + 60, () => ac.abort()); return undefined; };
  const { leadOn } = await import('../../src/client/brain/lure.js');
  await t.throwsAsync(leadOn({ ...p.ctx, signal: ac.signal }, p.clock));
  delete p.on.call.place;
  return { ...p.bot.at };
}

test.serial('D20 cut at hop 4 by retreat: care is next (75, it cuts), from the same place (no walk home first), and leads it in; with the moves switched off too: committed, led on to the hall; not committed, let go by its village', async (t) => {
  // (beyond 96 of its village the first hop commits the trip; 70 off it, the next lure is still within reach of its bell)
  const far = { bot: at(-578, 63, 2101), ward: at(-580, 63, 2100), toGate: 40 }, near = { bot: at(-648, 63, 2111), ward: at(-650, 63, 2110), toGate: 110 };
  const cases: { moves: boolean; committed?: 'far'; bot: Pos; ward: Pos; toGate: number }[] = [{ moves: true, committed: 'far', ...far }, { moves: false, committed: 'far', ...far }, { moves: false, ...near }];
  for (const o of cases) {
    const name = `moves ${o.moves ? 'on' : 'off'}, ${o.committed ? 'committed' : 'not committed'}`;
    const p = homestead({ tod: 3_000, at: o.bot });
    onTrip(t, () => p);
    const { v } = underWay(p, { at: o.ward, lure: { ...o.ward, z: o.ward.z + 1 }, state: 'hop', committed: o.committed, toGate: o.toGate, yard: 18 });
    fetchOf(p.world).trip!.beat = p.now();
    const cutAt = await cutLead(t, p, o.committed ? 2 : 1);
    t.is(peekFetch(p.world).trip?.committed, o.committed, `${name}: as cut`);
    const f = peekFetch(p.world);
    t.truthy(f.trip?.cut, name);
    t.is(f.wards[0]?.where, 'astray', `${name}: astray at its tether`);
    p.world.villagerMoves = o.moves;
    t.is(rowNow(p), 3, name);
    t.is(villagerCareGoal.urgency!(p.look(), p.world), 75, name);
    t.true(villagerCareGoal.cuts!(p.look(), p.world), name);
    const walks = p.walks.length;
    const turns = await careTurns(p);
    t.log(name, turns.map(x => `${x.row}: ${x.said}`).join('\n'));
    const first = p.walks[walks];
    t.true(!first || flat(first.from, cutAt) <= 2, `${name}: the resume from where the bot was cut (${first && key(first.from)})`);
    t.is(turns[0]?.row, 3, name);
    const g = peekFetch(p.world);
    if (o.committed) {
      t.true(inArea(HALL_AREA, v.position), `${name}: in the hall (${key(cellAt(v.position))})`);
      t.deepEqual(g.wards, [], name);
    } else {
      t.regex(turns[0].said, /^released at .*: villager moves switched off/, name);
      t.deepEqual(g.wards, [], `${name}: off the record`);
      t.false(inArea(YARD, v.position), name);
      t.is(v.profession, 'none', `${name}: jobless, as found`);
    }
    t.is(g.trip, undefined, `${name}: the trip restored and off`);
    t.false(g.journal.some(e => e.k === 'lure'), `${name}: no lure of the bot's left out`);
    t.is(idOf(p.get(SMITHING_AT)), 'smithing_table', `${name}: the smithing table back`);
    t.false(isOpen(p.get(P)) || isOpen(p.get(H)) || isOpen(p.get(NORTH)), name);
  }
});

/** The lock and the ring as the shells goal last read them: ready. */
const shellsRead = (p: Pasture) => { fetchOf(p.world).shells = { at: p.now(), lock: [], ring: [] }; };
/** The clock on to the next time this time of day comes. */
const until = (p: Pasture, tod: number) => p.advance(((tod - p.tod) % 24_000 + 24_000) % 24_000);

test.serial('row 10 PREP from the yard in its hours (the reads and the kit from 6000, the lifts from 9000: not asked between); B12 a prepared trip not out by 2000 is put back (the lifts the bot\'s again for the day), and prepared anew in the evening', async (t) => {
  const p = homestead({ tod: 7_000, at: START, candidates: 1 });
  onTrip(t, () => p);
  shellsRead(p);
  t.is(rowNow(p), 10);
  t.is(villagerCareGoal.urgency!(p.look(), p.world), 35);
  t.false(villagerCareGoal.cuts!(p.look(), p.world));
  // not from outside the yard
  const outside = careOwed(p.look({ position: at(-570, 63, 2150), distHome: 40 }), p.world);
  t.like(outside, { none: { cause: 'away' } });
  t.regex('none' in outside ? outside.none.text : '', /^PREP is made from the yard/);
  const r = await careTurn(p);
  t.is(r?.row, 10);
  t.regex(r!.said, /^prep: read and kit done; the lifts from 9000$/);
  t.is(peekFetch(p.world).trip?.state, 'prep');
  t.is(idOf(p.get(SMITHING_AT)), 'smithing_table', 'nothing lifted before 9000');
  p.advance(20 * 30);
  t.is(rowNow(p), undefined, 'the reads and the kit fresh, the lifts not due: not asked');
  until(p, 9_100);
  t.is(rowNow(p), 10);
  const lifts = await careTurn(p);
  t.regex(lifts!.said, /^prepared for village -720,2128: out at dawn by the \w+ gate; 1 lifted$/);
  t.true(peekFetch(p.world).trip?.prepared !== undefined);
  t.is(idOf(p.get(SMITHING_AT)), 'air', 'the smithing table lifted');
  t.true(wardOut(p.world, p.now()), 'held: a trip whose lifts are done');
  t.is(rowNow(p), undefined, 'prepared: nothing owed');
  // the dawn passes with no bring (rain, a chore): at 2000 it is put back
  until(p, 1_900);
  t.is(rowNow(p), undefined);
  until(p, 2_050);
  t.is(rowNow(p), 8);
  const back = await careTurns(p);
  t.deepEqual(rowsRun(back), [8], back.map(x => x.said).join(' | '));
  t.regex(back[0].said, /^trip \d+ in PREP put back: prepared and not out by 2000; restored 1$/);
  const f = peekFetch(p.world);
  t.is(f.trip, undefined);
  t.deepEqual(f.journal, []);
  t.is(idOf(p.get(SMITHING_AT)), 'smithing_table', 'the smithing table back for the day');
  // and the evening after: prepared anew (PREP's own decline would hold it for the day)
  until(p, 6_100);
  shellsRead(p);
  t.is(rowNow(p), 10);
});

/** A ward astray as a STOP leaves it (its trip over, its lure up, the lifts held for it, halt): a game villager, jobless, where it was let be. */
function strayed(p: Pasture, o: { at: Pos; id?: number; halt?: boolean; mind?: Villager['mind']; tether?: Pos }): { v: Villager; ward: Ward } {
  const now = p.now(), f = fetchOf(p.world);
  p.set(SMITHING_AT, 'air');
  p.give('smithing_table');
  const v = p.villager({ at: o.at, mind: o.mind ?? 'game', id: o.id ?? 310, bell: { ...V_BELL } });
  const w: Ward = {
    key: v.uuid, uuid: v.uuid, id: v.id, from: { site: 'village -720,2128', at: { ...V_BELL } }, since: now, bell: true, where: 'astray',
    last: { at: { ...v.position }, t: now, tod: p.tod, health: 20, profession: 'none' }, health0: 20, note: 'stopped: stalled', ...(o.tether ? { tether: { ...o.tether } } : {})
  };
  f.journal.push({ k: 'lift', id: 1, trip: 9, at: { ...SMITHING_AT }, block: 'smithing_table', item: 'smithing_table', st: 'done', why: 'job site', t: now });
  f.wards.push(w);
  f.nextId = 10;
  if (o.halt !== false) f.halt = { at: now, why: `STOPPED at ${fmt(w.last.at)}: stalled (trip 9); villager-moves {halt:false, arm:1} leads it in by day` };
  p.saved = JSON.stringify(p.world);
  return { v, ward: w };
}
const fmt = (q: Pos) => `(${Math.floor(q.x)}, ${Math.floor(q.y)}, ${Math.floor(q.z)})`;

test.serial('E19 a ward astray by the hall: said once a game day (halt: the lead\'s), B8 no new trip prepared for it; the lead\'s go (halt off, armed 1): rescued, a trip of kind rescue from the yard\'s hops, into the hall, the lifts back', async (t) => {
  const p = homestead({ tod: 7_000, at: START });
  onTrip(t, () => p);
  shellsRead(p);
  const { v } = strayed(p, { at: at(-546, 63, 2160) });
  t.is(rowNow(p), 9);
  const said = await careTurn(p);
  t.regex(said!.said, /^waits on the lead: HALT: STOPPED at .*; ward 0000\w+ astray at \(-546, 63, 2160\) \(stopped: stalled\)$/);
  t.true(p.said.some(x => /^villagers: waits on the lead: HALT/.test(x)), 'one log line');
  t.is(rowNow(p), undefined, 'said for the day; B8: no PREP while a ward is out');
  p.advance(20 * 60 * 5);
  t.is(rowNow(p), undefined, 'not said again the same day');
  t.true(wardOut(p.world, p.now()), 'the lifts held for it');
  // the lead looks, then arms the rescue: villager-moves {halt:false, arm:1}
  until(p, 1_000);
  delete fetchOf(p.world).halt;
  fetchOf(p.world).armed = 1;
  t.is(rowNow(p), 6);
  const turns = await careTurns(p);
  t.log(turns.map(x => `${x.row}: ${x.said}`).join('\n'));
  t.is(turns[0].row, 6);
  t.regex(turns[0].said, /^the rescue of ward 0000\w+ from .* \(trip 10, by the \w+ gate\): hall/);
  t.true(p.log.some(e => (JSON.parse(e.saved) as { fetch?: FetchMemory }).fetch?.trip?.kind === 'rescue'), 'a trip of kind rescue');
  t.true(inArea(HALL_AREA, v.position), `in the hall: ${key(cellAt(v.position))}`);
  const f = peekFetch(p.world);
  t.deepEqual(f.wards, []);
  t.is(f.armed, 0, 'armed one less');
  t.is(f.trip, undefined);
  t.deepEqual(f.journal.filter(e => e.k !== 'drop'), []);
  t.is(idOf(p.get(SMITHING_AT)), 'smithing_table');
  t.false(isOpen(p.get(P)) || isOpen(p.get(H)));
});

test.serial('D8 a ward in a pit (a 1 x 1 hole 2 deep in the yard): the rescue says it needs steps cut, sets halt, and digs nothing', async (t) => {
  const p = homestead({ tod: 3_000, at: START });
  onTrip(t, () => p);
  for (const y of [62, 61]) p.set(at(-545, y, 2150), 'air');
  strayed(p, { at: at(-545, 61, 2150), halt: false, mind: 'still' });
  t.is(rowNow(p), 6);
  const n = p.log.length;
  const r = await careTurn(p);
  t.regex(r!.said, /^the rescue: ward 0000\w+ at \(-545, 61, 2150\) needs steps cut at \(-545, 61, 2150\) \(a rise on every side\): said, nothing dug, HALT$/);
  t.false(p.log.slice(n).some(e => e.name === 'dig.here' || e.name === 'place' || e.kind === 'act'), 'nothing dug, nothing put down');
  const f = peekFetch(p.world);
  t.regex(f.halt?.why ?? '', /needs steps cut/);
  t.is(f.wards[0].where, 'astray');
  t.is(f.trip, undefined);
  t.is(rowNow(p), 9, 'the lead\'s');
});

test.serial('C11 a lure left in a village is fetched first, whatever the switches (moves off, the boat, not armed): out by the gate that way, careful legs, taken up (the bot\'s own: dig.here), home; F1 an anchor left mid-way is fetched; one of a trip cut short is the resume\'s', async (t) => {
  const p = homestead({ tod: 3_000, at: START });
  onTrip(t, () => p);
  p.world.villagerMoves = false;
  const f = fetchOf(p.world);
  delete f.method;
  delete f.armed;
  const L0 = at(-716, 63, 2131), anchor = at(-610, 63, 2125);
  for (const [c, role] of [[L0, 'village'], [anchor, 'anchor']] as const) {
    p.set(c, 'fletching_table', 'placed');
    p.mine(c);
    f.journal.push({ k: 'lure', id: f.nextId++, trip: 8, at: { ...c }, item: 'fletching_table', st: 'down', role, ...(role === 'village' ? { inVillage: true as const } : {}), t: p.now() });
  }
  t.is(rowNow(p), 7);
  t.regex(villagerCareGoal.wants(p.look(), p.world)!, /^the anchor left at \(-610, 63, 2125\): fetched$/, 'the nearer first');
  const lures = p.count('fletching_table');
  const r = await careTurn(p);
  t.log(r?.said);
  t.is(r?.row, 7);
  t.regex(r!.said, /^fetched 2 lure\(s\) left outside the fence/);
  t.is(idOf(p.get(L0)), 'air');
  t.is(idOf(p.get(anchor)), 'air');
  t.is(p.count('fletching_table'), lures + 2, 'both picked up');
  t.deepEqual(peekFetch(p.world).journal, []);
  t.true(inArea({ x1: YARD.x1 + 1, z1: YARD.z1 + 1, x2: YARD.x2 - 1, z2: YARD.z2 - 1 }, p.bot.at), 'home in the yard');
  // (careful walks out to them and into reach; the walk home by a gate is every walk home's: yardgates.ts inByGate)
  const lastTake = p.log.filter(e => e.name === 'dig.here').at(-1)!;
  t.true(p.walks.filter(x => x.t <= lastTake.t).every(x => x.careful), 'careful walks out');
  t.true(p.log.filter(e => e.name === 'dig.here').every(e => !e.params.force));
  // an anchor of a trip cut short (its ward astray at it): row 3 goes on from it, not row 7
  const q = homestead({ tod: 3_000, at: START });
  onTrip(t, () => q);
  underWay(q, { at: at(-611, 63, 2126), lure: anchor, state: 'hop', committed: 'far', cut: 'retreat is more urgent', toGate: 40 });
  fetchOf(q.world).journal.find(e => e.k === 'lure')!.role = 'anchor';
  t.is(rowNow(q), 3, 'the cut trip\'s anchor is its resume\'s');
});

test.serial('E26 a ward that stays in the lock (H open behind the shut P, the trip at DOOR): contained, row 5 waits for it; after a game day the lead is asked (the log and the Fetch line); once it goes in, H shut, the trip done, the lifts back', async (t) => {
  const p = await lockYard({ tod: 3_000, at: START } as Parameters<typeof yard>[0]);
  onTrip(t, () => p);
  p.world.villagerMoves = true;
  p.world.fetch = { v: 1, method: 'lure', armed: 0, journal: [], wards: [], nextId: 1 } as FetchMemory;
  p.world.villages = { sites: [{ x: V_BELL.x, y: V_BELL.y, z: V_BELL.z, bells: 1, beds: 7, jobs: 3, villagers: 7, seenAt: p.now(), area: { ...V_AREA } }], players: [] } as unknown as WorldMemory['villages'];
  const { v, ward: wd, trip: tr } = underWay(p, { at: IN_LOCK, lure: at(-551, 63, 2149), state: 'door', committed: 'far', mind: 'still' });
  const f = fetchOf(p.world);
  // (DOOR's first acts done: the socket's lure out and its wall back, the lure at S_out up, H opened by design)
  f.journal = f.journal.filter(e => e.k !== 'lure');
  p.set(at(-551, 63, 2149), 'air');
  wd.where = 'lock';
  tr.path = { toGate: 0, yard: 0 };
  journal({ world: p.world }, { k: 'gate', trip: 9, at: { ...H }, which: 'hall', t: p.now() });
  p.swing(H, true, 'useOn');
  await watched(p);
  t.is(rowNow(p), undefined, 'contained: nothing owed, row 5 waits for an empty lock');
  t.deepEqual(careNotes(p.world, p.now()), []);
  p.advance(24_000 + 200);
  await watched(p);
  t.is(rowNow(p), 9);
  t.regex(careNotes(p.world, p.now()).join('; '), /the hall's gate open behind the lock's shut one since \d\d:\d\d \(over a game day\): the villager in the lock does not go in \(the lead\)/);
  const r = await careTurn(p);
  t.regex(r!.said, /the hall's gate open behind the lock's shut one since/);
  // it goes in at last: the lock empty on two looks, H shut, the ward the hall's, the trip done and restored
  Object.assign(v, { mind: 'home', home: BLOCK });
  p.advance(200);
  const turns = await careTurns(p);
  t.log(turns.map(x => `${x.row}: ${x.said}`).join('\n'));
  t.deepEqual(rowsRun(turns), [5, 8]);
  t.regex(turns[0].said, /trip 9 in the hall: on to RESTORE/);
  const g = peekFetch(p.world);
  t.deepEqual(g.wards, []);
  t.is(g.trip, undefined);
  t.is(g.last?.got, 1);
  t.false(isOpen(p.get(H)) || isOpen(p.get(P)));
  t.is(idOf(p.get(SMITHING_AT)), 'smithing_table');
});

test.serial('E37 two wards: the trip\'s is led on to the LOCK and the hall, the other (a pin beyond 96 made it a second ward, tethered there) is said for the lead, not rescued unarmed', async (t) => {
  const p = homestead({ tod: 3_000, at: at(-552, 63, 2146) });
  onTrip(t, () => p);
  const { v } = underWay(p, { at: at(-551, 63, 2150), lure: at(-551, 63, 2149), state: 'yardhop', committed: 'far', cut: 'retreat is more urgent' });
  const f = fetchOf(p.world);
  f.armed = 0;
  const pin = at(-600, 63, 2125);
  p.set(pin, 'fletching_table', 'placed');
  p.mine(pin);
  const other = p.villager({ at: at(-601, 63, 2126), mind: 'still', id: 320, profession: 'fletcher', job: { ...pin } });
  f.journal.push({ k: 'lure', id: 3, trip: 9, at: { ...pin }, item: 'fletching_table', st: 'down', role: 'pin', t: p.now() });
  f.wards.push({ key: other.uuid, uuid: other.uuid, id: other.id, from: { site: 'village -720,2128', at: { ...V_BELL } }, since: p.now(), bell: true, where: 'astray', tether: { ...pin }, note: 'pinned', last: { at: { ...other.position }, t: p.now(), tod: p.tod, health: 20, profession: 'fletcher' }, health0: 20 });
  p.saved = JSON.stringify(p.world);
  const turns = await careTurns(p);
  t.log(turns.map(x => `${x.row}: ${x.said}`).join('\n'));
  t.is(turns[0].row, 3);
  t.true(inArea(HALL_AREA, v.position), 'the trip\'s ward in the hall');
  t.true(turns.some(x => x.row === 9 && new RegExp(`ward ${other.uuid.slice(0, 8)} astray at .*pinned`).test(x.said)), 'the other said');
  t.false(turns.some(x => x.row === 6), 'no rescue unarmed');
  const g = peekFetch(p.world);
  t.deepEqual(g.wards.map(w => w.key), [other.uuid]);
  // (the pin itself: it tethers the second ward, beyond 96 of its village: taken up it would be jobless far from home,
  // 4.3; RESTORE holds it and row 7 leaves it, the lead's: INV-6's "a pin or a tether")
  t.is(idOf(p.get(pin)), 'fletching_table', 'the tether stands');
  t.true(g.journal.some(e => e.k === 'lure' && e.role === 'pin' && key(e.at) === key(pin)), 'on the journal, held');
  t.false(turns.some(x => x.row === 7), 'no walk out to fetch it');
  t.is(g.trip, undefined, 'the trip over all the same');
  t.is(other.profession, 'fletcher', 'the second ward still works at it');
});

test.serial('S1 review B1: the armed rescue of a second ward from its tether (a pin beyond 96): the pin is the rescue\'s own lure, broken with it by it at the first hop, and it is led in to the hall; nothing of the bot\'s left out', async (t) => {
  const p = homestead({ tod: 1_000, at: at(-598, 63, 2126) });
  onTrip(t, () => p);
  shellsRead(p);
  const f = fetchOf(p.world);
  const pin = at(-600, 63, 2125);
  p.set(pin, 'fletching_table', 'placed');
  p.mine(pin);
  p.set(SMITHING_AT, 'air');
  p.give('smithing_table');
  f.journal.push({ k: 'lift', id: 1, trip: 8, at: { ...SMITHING_AT }, block: 'smithing_table', item: 'smithing_table', st: 'done', why: 'job site', t: p.now() },
    { k: 'lure', id: 2, trip: 8, at: { ...pin }, item: 'fletching_table', st: 'down', role: 'pin', t: p.now() });
  const v = p.villager({ at: at(-601, 63, 2126), mind: 'game', id: 330, profession: 'fletcher', job: { ...pin }, bell: { ...V_BELL } });
  f.wards.push({ key: v.uuid, uuid: v.uuid, id: v.id, from: { site: 'village -720,2128', at: { ...V_BELL } }, since: p.now(), bell: true, where: 'astray', tether: { ...pin }, note: 'pinned', last: { at: { ...v.position }, t: p.now(), tod: p.tod, health: 20, profession: 'fletcher' }, health0: 20 });
  f.nextId = 10;
  p.saved = JSON.stringify(p.world);
  t.is(rowNow(p), 6);
  const turns = await careTurns(p);
  t.log(turns.map(x => `${x.row}: ${x.said}`).join('\n'));
  t.is(turns[0].row, 6);
  t.regex(turns[0].said, /^the rescue of ward 0000\w+ from .*: hall/);
  t.true(inArea(HALL_AREA, v.position), `in the hall: ${key(cellAt(v.position))}`);
  t.is(idOf(p.get(pin)), 'air', 'the tether broken with it by it');
  const g = peekFetch(p.world);
  t.deepEqual(g.wards, []);
  t.false(g.journal.some(e => e.k === 'lure'), 'nothing of the bot\'s left out');
  t.is(idOf(p.get(SMITHING_AT)), 'smithing_table');
});

test.serial('S1 review B1: the armed rescue carries its lures (a STOP\'s RESTORE stashed the kit): none carried and none made, it waits, the arm kept, the ward still astray on the records; with them, it goes', async (t) => {
  const p = homestead({ tod: 1_000, at: START });
  onTrip(t, () => p);
  shellsRead(p);
  const { v } = strayed(p, { at: at(-546, 63, 2160), halt: false });
  fetchOf(p.world).armed = 1;
  t.true(p.take('fletching_table', 4), 'the kit stashed');
  t.is(rowNow(p), 6);
  const r = await careTurn(p);
  t.regex(r!.said, /^the rescue of ward 0000\w+ waits: 0 of 4 fletching_table carried, and none made/);
  const f = peekFetch(p.world);
  t.is(f.trip, undefined, 'no trip set out');
  t.is(f.armed, 1, 'the arm kept');
  t.is(f.wards[0]?.where, 'astray', 'still on the records');
  t.is(f.halt, undefined);
  t.not(rowNow(p), 6, 'not asked again at once');
  p.give('fletching_table', 4);
  p.advance(20 * 150);
  t.is(rowNow(p), 6);
  const turns = await careTurns(p);
  t.log(turns.map(x => `${x.row}: ${x.said}`).join('\n'));
  t.regex(turns[0].said, /^the rescue of ward 0000\w+ from .*: hall/);
  t.true(inArea(HALL_AREA, v.position));
});

test.serial('S1 review B1: a rescue whose first spot fails (the ward fenced in in the yard: no hop spot it can walk to) is never let go by the bot\'s home: STOPPED, halt, the ward astray on the records, its lifts held', async (t) => {
  const p = homestead({ tod: 1_000, at: START });
  onTrip(t, () => p);
  shellsRead(p);
  const c = at(-546, 63, 2160);
  strayed(p, { at: c, halt: false });
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.set(at(c.x + dx, 63, c.z + dz), 'oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]');
  fetchOf(p.world).armed = 1;
  t.is(rowNow(p), 6);
  const r = await careTurn(p);
  t.log(r?.said);
  t.notRegex(r!.said, /released/, 'never let go in the yard');
  t.regex(r!.said, /STOPPED/);
  const f = peekFetch(p.world);
  t.is(f.wards.length, 1, 'still on the records');
  t.is(f.wards[0].where, 'astray');
  t.truthy(f.halt, 'halt: the lead\'s');
  t.true(wardOut(p.world, p.now()), 'its lifts held for it');
  t.is(idOf(p.get(SMITHING_AT)), 'air');
});

test.serial('S1 review B1 (the S1 follow-up\'s pin): a rescue of a ward outside the fence beyond 96 of its village whose first spot fails is committed from its first record: STOPPED, halt, never released there', async (t) => {
  const p = homestead({ tod: 1_000, at: at(-590, 63, 2160) });
  onTrip(t, () => p);
  shellsRead(p);
  // 25 out of the west fence, 120 from its village's bell: fenced in where it stands, no hop spot it can walk to
  const c = at(-600, 63, 2160);
  strayed(p, { at: c, halt: false });
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.set(at(c.x + dx, 63, c.z + dz), 'oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]');
  fetchOf(p.world).armed = 1;
  t.is(rowNow(p), 6);
  const r = await careTurn(p);
  t.log(r?.said);
  t.notRegex(r!.said, /released/, 'never let go 120 from its village');
  t.regex(r!.said, /STOPPED/);
  const f = peekFetch(p.world);
  t.is(f.wards.length, 1, 'still on the records');
  t.is(f.wards[0].where, 'astray');
  t.truthy(f.halt, 'halt: the lead\'s');
});

test.serial('S1 review B1: a rescue is never let go by the bot\'s home: a ward astray in the yard is led in committed, a player by it for 60 s holds the lead (the lure standing), it is not released off the records; then into the hall', async (t) => {
  const p = homestead({ tod: 1_000, at: START });
  onTrip(t, () => p);
  shellsRead(p);
  const { v } = strayed(p, { at: at(-546, 63, 2160), halt: false });
  fetchOf(p.world).armed = 1;
  // a player stands by the yard for 90 s
  const player = p.animal('player', at(-560, 63, 2165));
  p.at(p.tick + 20 * 90, () => { p.animals.splice(p.animals.indexOf(player), 1); });
  const turns = await careTurns(p);
  t.log(turns.map(x => `${x.row}: ${x.said}`).join('\n'));
  t.is(turns[0].row, 6);
  t.notRegex(turns[0].said, /released/, 'never let go in the yard');
  t.true(p.log.some(e => (JSON.parse(e.saved) as { fetch?: FetchMemory }).fetch?.trip?.committed === 'far'), 'committed from the start');
  t.true(inArea(HALL_AREA, v.position), `in the hall: ${key(cellAt(v.position))}`);
  t.deepEqual(peekFetch(p.world).wards, []);
});

test.serial('E40 no hold after a fruitless run: a lift that cannot go back (none carried, none made) is said, never thrown, waits its half minute; after three tries it is said by row 9 and tried again a game day on (R-4)', async (t) => {
  const p = homestead({ tod: 3_000, at: START, items: [] });
  onTrip(t, () => p);
  const f = fetchOf(p.world);
  p.set(SMITHING_AT, 'air');
  f.journal.push({ k: 'lift', id: 1, trip: 9, at: { ...SMITHING_AT }, block: 'smithing_table', item: 'smithing_table', st: 'done', why: 'job site', t: p.now() });
  const said: string[] = [];
  for (let i = 0; i < 3; i++) {
    t.is(rowNow(p), 8, `try ${i + 1}`);
    said.push((await careTurn(p))!.said);
    t.not(rowNow(p), 8, 'not asked again at once');
    p.advance(30 * 20 + 20);
  }
  t.regex(said[0], /^restored 0; not undone: lift smithing_table at \(-541, 63, 2153\): the smithing_table at \(-541, 63, 2153\) not put back: no smithing_table, and none made/);
  t.is(peekFetch(p.world).journal[0].tries, 3);
  t.is(rowNow(p), 9);
  t.regex((await careTurn(p))!.said, /lift smithing_table at \(-541, 63, 2153\) would not come undone in 3 tries/);
  t.is(rowNow(p), undefined, 'a game day before the next try');
  t.regex(fetchLine(p.world, p.now()), /stuck after 3 tries: lift smithing_table at \(-541, 63, 2153\) \(the lead\)/);
});

test.serial('3.3 resume at the first lure: a fletcher working at it (within 9) and the clock open is the ward, led home to the hall; nobody at it: the lure taken up (as found), the trip on to RESTORE, nothing left in the village', async (t) => {
  for (const worker of [true, false]) {
    const name = worker ? 'its worker' : 'nobody at it';
    const p = homestead({ tod: 2_000, at: at(-712, 63, 2131) });
    onTrip(t, () => p);
    const f = fetchOf(p.world), L0 = at(-716, 63, 2131), now = p.now();
    p.set(L0, 'fletching_table', 'placed');
    p.mine(L0);
    p.set(SMITHING_AT, 'air');
    p.give('smithing_table');
    const v = worker ? p.villager({ at: at(-716, 63, 2133), mind: 'game', id: 330, profession: 'fletcher', job: { ...L0 }, bell: { ...V_BELL } }) : undefined;
    f.journal.push({ k: 'lift', id: 1, trip: 9, at: { ...SMITHING_AT }, block: 'smithing_table', item: 'smithing_table', st: 'done', why: 'job site', t: now },
      { k: 'lure', id: 2, trip: 9, at: { ...L0 }, item: 'fletching_table', st: 'down', role: 'village', inVillage: true, t: now });
    f.trip = {
      id: 9, kind: 'bring', site: 'village -720,2128', state: 'first', beat: now - 60_000, entered: now, prep: { read: now, kit: now, lifts: now }, prepared: { at: now, day: 0 },
      gate: { ...NORTH_WAY }, spare: [], lure: 'fletching_table', avoid: [], times: {}, counts: { hops: 0, misses: 0, wedges: 0, pins: 0 }, cut: { at: now, why: 'food is more urgent' }
    };
    f.nextId = 10;
    t.is(rowNow(p), 3, name);
    const turns = await careTurns(p);
    t.log(name, turns.map(x => `${x.row}: ${x.said}`).join('\n'));
    const g = peekFetch(p.world);
    if (v) {
      t.regex(turns[0].said, /^trip 9 resumed at its first lure: ward 0000\w+ working at it at \(-716, 63, 2131\): hall/, name);
      t.true(inArea(HALL_AREA, v.position), `${name}: in the hall at ${key(cellAt(v.position))}`);
    } else t.regex(turns[0].said, /^trip 9 resumed at its first lure \(nobody working at it\): took up the fletching_table at \(-716, 63, 2131\); on to RESTORE/, name);
    t.deepEqual(g.wards, [], name);
    t.is(g.trip, undefined, name);
    t.is(idOf(p.get(L0)), 'air', `${name}: nothing of the bot's left in the village`);
    t.false(g.journal.some(e => e.k === 'lure'), name);
  }
});

test.serial('3.3 resume in LOCK: the ward found in the lock\'s box with P read shut is on to DOOR (never led back out): the socket\'s lure out and its wall back, H opened behind the shut P, in to the hall\'s lectern, H shut', async (t) => {
  const p = await lockYard({ tod: 3_000, at: POST } as Parameters<typeof yard>[0]);
  onTrip(t, () => p);
  p.world.villagerMoves = true;
  p.world.fetch = { v: 1, method: 'lure', armed: 0, journal: [], wards: [], nextId: 1 } as FetchMemory;
  p.world.villages = { sites: [{ x: V_BELL.x, y: V_BELL.y, z: V_BELL.z, bells: 1, beds: 7, jobs: 3, villagers: 7, seenAt: p.now(), area: { ...V_AREA } }], players: [] } as unknown as WorldMemory['villages'];
  p.set(BLOCK, 'lectern[facing=south,has_book=false,powered=false]');
  p.mine(BLOCK);
  p.villager({ at: at(-552, 63, 2128), mind: 'still', profession: 'fletcher', level: 4, id: 100 });
  const g = guard(p);
  const { v } = underWay(p, { at: IN_LOCK, lure: at(-554, 63, 2139), state: 'lock', committed: 'far' });
  const f = fetchOf(p.world);
  // (a kill after P shut on it: the lure at S_out up, the socket's lure in, its wall block lifted)
  f.journal = f.journal.filter(e => e.k !== 'lure');
  p.set(at(-554, 63, 2139), 'air');
  p.set(SOCKET, 'fletching_table', 'placed');
  p.mine(SOCKET);
  f.journal.push({ k: 'lift', id: 3, trip: 9, at: { ...SOCKET }, block: 'oak_planks', item: 'oak_planks', st: 'done', why: 'socket', t: p.now() },
    { k: 'lure', id: 4, trip: 9, at: { ...SOCKET }, item: 'fletching_table', st: 'down', role: 'lock', t: p.now() });
  Object.assign(v, { job: { ...SOCKET } });
  p.saved = JSON.stringify(p.world);
  t.is(rowNow(p), 3);
  const turns = await careTurns(p);
  t.log(turns.map(x => `${x.row}: ${x.said}`).join('\n'));
  t.regex(turns[0].said, /^resumed trip 9: hall/);
  t.true(inArea(HALL_AREA, v.position), `in the hall at ${key(cellAt(v.position))}`);
  t.is(idOf(p.get(SOCKET)), 'oak_planks', 'the wall block back');
  t.false(isOpen(p.get(P)) || isOpen(p.get(H)));
  t.deepEqual(g.bad, []);
  t.deepEqual(g.leaks(), []);
  t.false(p.log.some(e => e.name === 'gates.hold' && Number(e.params.z) === P.z), 'P never held open again');
  t.is(peekFetch(p.world).trip, undefined);
});

test.serial('inert by default: with the method absent (S0\'s records, the live setting) the trip\'s rows owe nothing and say nothing: a halt, the hall\'s gate open a day for a resident, the evening\'s PREP hours', async (t) => {
  const p = await lockYard({ tod: 7_000, at: START } as Parameters<typeof yard>[0]);
  onTrip(t, () => p);
  p.world.villagerMoves = true;
  const f = fetchOf(p.world);
  f.halt = { at: p.now(), why: 'brain.json: a halt that could not be read' };
  shellsRead(p);
  // (S0's row 4 opened the hall's gate for a resident shut in the lock a day ago; it is still in there)
  p.villager({ at: IN_LOCK, id: 9108, profession: 'fletcher', mind: 'still' });
  journal({ world: p.world }, { k: 'gate', trip: 0, at: { ...H }, which: 'hall', t: p.now() - 25 * 60_000 });
  p.swing(H, true, 'useOn');
  await watched(p);
  t.is(rowNow(p), undefined);
  t.deepEqual(careNotes(p.world, p.now()), []);
  t.notRegex(fetchLine(p.world, p.now()), /the hall's gate open behind/);
  // the same records under the lure: the lead is asked
  f.method = 'lure';
  t.is(rowNow(p), 9);
  t.regex(careNotes(p.world, p.now()).join('; '), /the hall's gate open behind the lock's shut one since/);
});
