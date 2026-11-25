import test from 'ava';
import type { Pos } from '../../src/client/brain/memory.js';
import { closeDoors } from '../../src/client/brain/goals.js';
import { fetchOf, journal, peekFetch } from '../../src/client/brain/fetch.js';
import { strictSet } from '../../src/client/brain/yardgates.js';
import { H, HOME, P, YARD_GATES, isOpen, key, yard, type Pasture } from '../helpers/pasture.js';

// The shelter's dusk sweep (goals.ts closeDoors) over the live yard of the pasture (tests/helpers/pasture.ts): the
// gates no villager may find open (yardgates.ts strictGates: the yard's, the hall's, the lock's, the portal ring's) are
// shut by the bridge's own click after a careful walk, read back, never by the tool; the hall's gate is left open
// while a villager stands in the lock, and shut like any other once it is empty. The rows are section 7's "S" rows of
// the design (idle-plan V), named in the titles.

const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
const IN_LOCK = at(-557, 63, 2136);
const PEN_GATE = (p: Pasture) => p.world.zones!['pen:cow:gate']![0];
async function lockYard(): Promise<Pasture> {
  const p = yard({ at: HOME, tod: 12_000 });
  await p.ctx.call('gates.strict', strictSet(p.world) as unknown as Record<string, unknown>);
  return p;
}
const swings = (p: Pasture, g: Pos) => p.changed.filter(c => key(c.at) === key(g)).map(c => `${isOpen(c.to) ? 'open' : 'shut'}: ${c.how}`);

test('E27: the sweep leaves the hall\'s gate open for a villager in the lock and shuts the lock\'s gate, by the bridge\'s own click', async (t) => {
  const p = await lockYard();
  p.villager({ at: IN_LOCK, id: 9201, profession: 'fletcher', mind: 'still' });
  p.swing(P, true, 'a player');
  p.swing(H, true, 'a player');
  const n = p.log.length;
  t.is(await closeDoors(p.ctx, HOME), 1);
  t.false(isOpen(p.get(P)));
  t.true(isOpen(p.get(H)), 'with the lock\'s gate shut nothing in there reaches the yard');
  // never by the tool (its walk into reach is a plain one), every walk careful
  t.false(p.log.slice(n).some(e => e.kind === 'act'));
  t.true(p.walks.every(x => x.careful));
  t.true(p.villagers.every(v => Math.floor(v.position.z) >= H.z + 1 && Math.floor(v.position.z) <= P.z - 1), 'it is in the lock still');
});

test('E27: the lock empty, the sweep shuts the hall\'s gate too (care\'s row 5 at dusk), and its journal entry goes with it', async (t) => {
  const p = await lockYard();
  journal({ world: p.world, save: () => undefined }, { k: 'gate', trip: 0, at: { ...H }, which: 'hall', t: p.now() });
  p.swing(H, true, 'useOn');
  t.is(await closeDoors(p.ctx, HOME), 1);
  t.false(isOpen(p.get(H)));
  t.deepEqual(peekFetch(p.world).journal, []);
  t.regex(swings(p, H).at(-1)!, /^shut: (shut \((released|hold)\)|useOn)$/);
});

test('the strict gates by the bridge\'s click, read back; every other gate as before, by the tool\'s toggle; a look into the lock that fails keeps the hall\'s gate open', async (t) => {
  const p = await lockYard();
  for (const g of [YARD_GATES.west, YARD_GATES.north, PEN_GATE(p)]) p.swing(g, true, 'a player');
  const n = p.log.length;
  t.is(await closeDoors(p.ctx, HOME), 3);
  t.false([YARD_GATES.west, YARD_GATES.north, PEN_GATE(p)].some(g => isOpen(p.get(g))));
  const tools = p.log.slice(n).filter(e => e.kind === 'act');
  t.deepEqual(tools.map(e => `${e.name} ${key(e.params as unknown as Pos)}`), [`use-item-on-block ${key(PEN_GATE(p))}`], 'only the pen\'s gate by the tool');
  // (the bridge's shut-if-open: at once, or on the first tick it can click, as the hold's end)
  for (const g of [YARD_GATES.west, YARD_GATES.north]) t.regex(swings(p, g).join('; '), /^open: a player; shut: (shut \((released|hold)\)|useOn)$/);
  // the look fails: a villager may be in there, the hall's gate is left (the lock's gate, shut, holds whoever is)
  p.swing(H, true, 'a player');
  p.on.call['world.entities'] = () => { throw new Error('no answer'); };
  t.is(await closeDoors(p.ctx, HOME), 0);
  t.true(isOpen(p.get(H)));
  // no lock: the hall's gate is a strict gate like the yard's, shut by the bridge's click
  const q = yard({ at: HOME, lock: false });
  await q.ctx.call('gates.strict', strictSet(q.world) as unknown as Record<string, unknown>);
  q.swing(H, true, 'a player');
  t.is(await closeDoors(q.ctx, HOME), 1);
  t.false(isOpen(q.get(H)));
  t.false(q.log.some(e => e.kind === 'act'));
  t.is(fetchOf(q.world).journal.length, 0);
});
