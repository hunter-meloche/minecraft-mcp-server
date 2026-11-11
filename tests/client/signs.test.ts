import test from 'ava';
import { signSpot, signsGoal } from '../../src/client/brain/signs.js';
import { categoryOfLabel, chestLabels } from '../../src/client/brain/storage.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';

const MINUTE = 60_000;
const k = (p: Pos) => `${p.x},${p.y},${p.z}`;
const permutations = <T>(xs: T[]): T[][] => (xs.length < 2 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(rest => [x, ...rest])));

test('chestLabels: numbered per category, a double chest sharing one number', (t) => {
  const chests = [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 0, y: 64, z: 3 }, { x: 5, y: 64, z: 0 }];
  const assign = { '0,64,0': 'food', '1,64,0': 'food', '0,64,3': 'food', '5,64,0': 'gear' };
  t.deepEqual(chestLabels(chests, assign), { '0,64,0': 'food1', '1,64,0': 'food1', '0,64,3': 'food2', '5,64,0': 'tools1' });
});

// a storage house on three layers, a double chest listed with both its halves on the top one
const A = { x: 0, y: 63, z: 0 }, B = { x: 4, y: 63, z: 0 }, C = { x: 0, y: 64, z: 0 }, D = { x: 4, y: 64, z: 0 }, E = { x: 0, y: 65, z: 3 }, F = { x: 1, y: 65, z: 3 };
const HOUSE = [A, B, C, D, E, F];
const KINDS = { [k(A)]: 'stone', [k(B)]: 'stone', [k(C)]: 'gear', [k(D)]: 'gear', [k(E)]: 'stone', [k(F)]: 'stone' };
// the labels as the other order of the list once numbered them
const WORN = { [k(A)]: 'stone2', [k(B)]: 'stone1', [k(C)]: 'tools2', [k(D)]: 'tools1', [k(E)]: 'stone5', [k(F)]: 'stone5' };

test('chestLabels: the same labels whatever the order of the chest list (by y, then x, then z)', (t) => {
  const want = { [k(A)]: 'stone1', [k(B)]: 'stone2', [k(C)]: 'tools1', [k(D)]: 'tools2', [k(E)]: 'stone3', [k(F)]: 'stone3' };
  for (const order of permutations(HOUSE)) t.deepEqual(chestLabels(order, KINDS), want, order.map(k).join(' '));
});

test('chestLabels: a chest keeps the number on its sign, however the list is ordered', (t) => {
  // nearest home first one time, the storage house's own order the next: "tools1" and "tools2" swapped every 20 minutes
  for (const order of permutations(HOUSE)) t.deepEqual(chestLabels(order, KINDS, WORN), WORN, order.map(k).join(' '));
  // a label written another way still holds its number
  t.is(chestLabels(HOUSE, KINDS, { ...WORN, [k(D)]: 'Tools 1' })[k(D)], 'tools1');
});

test('chestLabels: a new chest takes the lowest number nobody holds, and no other label changes', (t) => {
  const G = { x: 2, y: 63, z: 0 }; // between A and B in the order
  for (const order of [[G, ...HOUSE], [...HOUSE, G], [A, G, B, C, D, E, F]]) {
    t.deepEqual(chestLabels(order, { ...KINDS, [k(G)]: 'stone' }, WORN), { ...WORN, [k(G)]: 'stone3' });
  }
});

test('chestLabels: a chest that changes category takes a number in the new one and frees its old one', (t) => {
  const G = { x: 2, y: 63, z: 0 };
  // B holds tools now (it wears "stone1"); the new stone chest G gets the number B gave up
  const labels = chestLabels([...HOUSE, G], { ...KINDS, [k(B)]: 'gear', [k(G)]: 'stone' }, WORN);
  t.deepEqual(labels, { ...WORN, [k(B)]: 'tools3', [k(G)]: 'stone1' });
});

test('chestLabels: two chests wearing the same label: the first in the order keeps it', (t) => {
  const worn = { [k(A)]: 'stone1', [k(B)]: 'stone1', [k(C)]: 'tools1', [k(D)]: 'tools1' };
  const want = { [k(A)]: 'stone1', [k(B)]: 'stone2', [k(C)]: 'tools1', [k(D)]: 'tools2', [k(E)]: 'stone3', [k(F)]: 'stone3' };
  for (const order of [HOUSE, [...HOUSE].reverse()]) t.deepEqual(chestLabels(order, KINDS, worn), want);
});

test('categoryOfLabel: the user\'s ways of writing them', (t) => {
  t.is(categoryOfLabel('food2'), 'food');
  t.is(categoryOfLabel('Tools 1'), 'gear');
  t.is(categoryOfLabel('miscBlocks2'), 'misc');
  t.is(categoryOfLabel('ore1'), 'ores');
  t.is(categoryOfLabel('seeds1'), 'farming');
  t.is(categoryOfLabel('Hello'), undefined);
});

test('signSpot: on the wall behind the chest, another wall, or standing on it', (t) => {
  const sides = (o: Record<string, string>) => ({ north: 'air', south: 'air', east: 'air', west: 'air', ...o });
  // a chest facing south (into the room) against a north wall
  t.deepEqual(signSpot('chest[facing=south,type=single]', { above: 'air', sides: sides({ north: 'oak_planks' }) }), { face: 'north' });
  t.deepEqual(signSpot('chest[facing=south,type=single]', { above: 'air', sides: sides({ east: 'stone' }) }), { face: 'east' });
  t.deepEqual(signSpot('chest[facing=south,type=single]', { above: 'air', sides: sides({}) }), { face: 'down' });
  t.is(signSpot('chest[facing=south]', { above: 'chest', sides: sides({}) }), undefined);
});

test('findLandmarks: a double chest is one chest (its left half)', async (t) => {
  const { findLandmarks } = await import('../../src/client/brain/memory.js');
  const box = { x: 0, y: 64, z: 0, width: 3, height: 1, length: 1 };
  const blocks = ['minecraft:chest[facing=south,type=left,waterlogged=false]', 'minecraft:chest[facing=south,type=right,waterlogged=false]', 'minecraft:chest[facing=south,type=single,waterlogged=false]'];
  t.deepEqual(findLandmarks(box, blocks, { x: 0, y: 64, z: 0 }).chests, [{ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }]);
});

const above = (p: Pos) => ({ ...p, y: p.y + 1 });

/**
 * A storage house for the signs round. `reach`: the chests whose sign the bot can hang (or take down) from where it
 * stands; `walk`: the ones it can after a careful walk up to them. Any other chest stays too far.
 * Taking a sign down needs it in sight as well, which hanging one does not. `sight`: for a sign cell, the columns
 * ("x,z") it is seen from, and from nowhere else (a sign cell not named goes by reach, as hanging does); the bot stands
 * in a column once a walk to that column (xz) took it there. `wall`: the signs that hang on a wall, and the way they face.
 */
function house(chests: Pos[], assign: Record<string, string>, reach: Pos[], walk: Pos[] = [], opts: { sight?: Record<string, string[]>; wall?: Record<string, string> } = {}) {
  const world = { landmarks: { chests: [...chests], farmland: [] }, leash: 96, chestAssign: { ...assign } } as WorldMemory;
  const up = new Map<string, string>(); // the signs that hang: cell -> text
  const acts: string[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const hooks: { goto?: () => void } = {}; // called from inside a walk
  let now = 1_000_000_000;
  let near: string | undefined; // the chest the last walk got up to
  let stands: string | undefined; // the column the last walk to a column ended in
  let stop = new AbortController(); // the run's
  const inReach = (cell: Pos) => { const c = k({ ...cell, y: cell.y - 1 }); return reach.some(p => k(p) === c) || near === c; };
  const inSight = (cell: Pos) => (opts.sight?.[k(cell)] ? opts.sight[k(cell)].includes(stands ?? '') : inReach(cell));
  const sign = (cell: Pos) => (opts.wall?.[k(cell)] ? `minecraft:oak_wall_sign[facing=${opts.wall[k(cell)]},waterlogged=false]` : 'minecraft:oak_sign[rotation=0]');
  const s = () => ({ activity: 'work', sleeping: false, home: { x: 0, y: 63, z: 0 }, distHome: 0, now }) as unknown as Snapshot;
  const ctx = () => ({
    s: s(), world, signal: (stop = new AbortController()).signal,
    progress: () => undefined,
    act: async (tool: string) => { acts.push(tool); return { ok: true, text: '' }; },
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const p = { x: Number(params.x), y: Number(params.y), z: Number(params.z) };
      if (method === 'sign.read') return { sign: up.has(k(p)), lines: up.has(k(p)) ? [up.get(k(p))] : [] };
      if (method === 'world.region') return { blocks: [up.has(k(p)) ? sign(p) : world.landmarks.chests.some(c => k(c) === k(p)) ? 'minecraft:chest[facing=south,type=single]' : 'minecraft:air'] };
      if (method === 'inventory') return { items: [{ name: 'oak_sign', count: 16, slot: 0 }] };
      if (method === 'goto') {
        hooks.goto?.();
        if (params.xz) { stands = `${p.x},${p.z}`; return { arrived: true }; }
        if (walk.some(c => k(c) === k(p))) near = k(p);
        return { arrived: near === k(p) };
      }
      if (method === 'sign.place') {
        if (!inReach(p)) return { placed: false, reason: 'too far' };
        up.set(k(p), (params.lines as string[])[0]);
        return { placed: true, written: true };
      }
      if (method === 'dig.here') return inSight(p) ? { dug: up.delete(k(p)) } : { dug: false, reason: 'out of reach or out of sight' };
      throw new Error(`unexpected call ${method}`);
    }
  }) as unknown as GoalContext;
  return {
    world, up, acts, calls, hooks,
    run: () => signsGoal.run(ctx()),
    /** the run is cut short (a more urgent goal) */
    abort: () => stop.abort(),
    /** what the goal asks for once its 20 minutes are over */
    wants: () => { now += 21 * MINUTE; return signsGoal.wants(s(), world); },
    walks: () => calls.filter(c => c.method === 'goto').map(c => c.params)
  };
}

test('the signs round: hung from where the bot stands; too far, a walk that only walks; still too far, left without', async (t) => {
  // chests on the floor and two layers up round the home cell
  const a = { x: 2, y: 63, z: 0 }, b = { x: 6, y: 65, z: 0 }, c = { x: -6, y: 65, z: 0 }, d = { x: 0, y: 63, z: 5 };
  const h = house([a, b, c, d], { [k(a)]: 'food', [k(b)]: 'gear', [k(c)]: 'ores', [k(d)]: 'stone' }, [a, d], [b]);
  t.is(await h.run(), '3 sign(s) put up, 1 chest(s) left without');
  t.deepEqual(h.world.chestSigns, { [k(a)]: 'food1', [k(b)]: 'tools1', [k(d)]: 'stone1' });
  // no tool that gets there Baritone's own way (move-to-position pillared up to the sign over a top-layer chest)
  t.deepEqual(h.acts, []);
  // one walk for each chest out of reach: to within 3 of the chest, which the floor can meet, nothing broken or placed
  t.deepEqual(h.walks(), [{ ...b, range: 3, careful: true, timeoutMs: 30_000 }, { ...c, range: 3, careful: true, timeoutMs: 30_000 }]);
  t.deepEqual(h.world.signTries, { [k(c)]: { label: 'ore1', tries: 1 } });
});

test('the signs round: a chest it could not sign twice is left be, till its label changes or the chest is gone', async (t) => {
  // one chest under another (no room for a sign, ever) and one out of reach
  const a = { x: 2, y: 63, z: 0 }, low = { x: 0, y: 63, z: 5 }, top = { x: 0, y: 64, z: 5 }, far = { x: -6, y: 65, z: 0 };
  const h = house([a, low, top, far], { [k(a)]: 'food', [k(low)]: 'stone', [k(top)]: 'wood', [k(far)]: 'ores' }, [a, top]);
  t.is(h.wants(), '4 chest(s) without the right sign');
  t.is(await h.run(), '2 sign(s) put up, 2 chest(s) left without');
  t.is(h.wants(), '2 chest(s) without the right sign');
  t.is(await h.run(), '0 sign(s) put up, 2 chest(s) left without');
  t.deepEqual(h.world.signTries, { [k(low)]: { label: 'stone1', tries: 2 }, [k(far)]: { label: 'ore1', tries: 2 } });
  // twice is enough: the goal does not start for them (it did, every 20 minutes), and a run leaves them alone
  t.is(h.wants(), null);
  const before = h.calls.length;
  t.is(await h.run(), '0 sign(s) put up');
  // (the cell over each is still read, for a label someone else may have hung there: no walk, no try)
  t.deepEqual(h.calls.slice(before).map(call => call.method), ['sign.read', 'sign.read']);
  // another label to wear: tried again
  h.world.chestAssign![k(far)] = 'misc';
  t.is(h.wants(), '1 chest(s) without the right sign');
  t.is(await h.run(), '0 sign(s) put up, 1 chest(s) left without');
  t.deepEqual(h.world.signTries![k(far)], { label: 'misc1', tries: 1 });
  // and a chest that is gone is forgotten
  h.world.landmarks.chests = [a, low, top];
  await h.run();
  t.deepEqual(h.world.signTries, { [k(low)]: { label: 'stone1', tries: 2 } });
});

test('the signs round: an old label comes down by hand, not with a tool that walks its own way', async (t) => {
  const a = { x: 2, y: 63, z: 0 }, b = { x: 6, y: 65, z: 0 }, c = { x: 0, y: 63, z: 5 }, gone = { x: 9, y: 63, z: 9 };
  // a wore "food1" and holds tools now; a sign of the bot's is left where a chest was taken away, out of reach
  const h = house([a, b, c], { [k(a)]: 'gear', [k(b)]: 'ores', [k(c)]: 'stone' }, [a, c], [b, gone]);
  h.world.chestSigns = { [k(a)]: 'food1', [k(gone)]: 'misc1' };
  h.up.set(k(above(a)), 'food1');
  h.up.set(k(above(gone)), 'misc1');
  t.is(await h.run(), '3 sign(s) put up, 1 old one(s) taken down');
  t.deepEqual(h.world.chestSigns, { [k(a)]: 'tools1', [k(b)]: 'ore1', [k(c)]: 'stone1' });
  t.deepEqual(Object.fromEntries(h.up), { [k(above(a))]: 'tools1', [k(above(b))]: 'ore1', [k(above(c))]: 'stone1' });
  // dig-block lets Baritone get at the block its own way and walks onto the drop: neither here
  t.deepEqual(h.acts, []);
  t.true(h.walks().length > 0 && h.walks().every(w => w.careful === true));
});

test('the signs round: a chest left be is still read, and a label someone hangs over it is followed', async (t) => {
  const a = { x: 2, y: 63, z: 0 }, b = { x: 0, y: 63, z: 5 }, far = { x: -6, y: 65, z: 0 };
  const h = house([a, b, far], { [k(a)]: 'food', [k(b)]: 'stone', [k(far)]: 'ores' }, [a, b]);
  await h.run();
  await h.run();
  t.deepEqual(h.world.signTries, { [k(far)]: { label: 'ore1', tries: 2 } });
  t.is(h.wants(), null);
  // a player hangs a label of another category over it
  h.up.set(k(above(far)), 'wood3');
  t.is(await h.run(), '0 sign(s) put up, 1 label(s) someone else wrote followed');
  t.is(h.world.chestAssign![k(far)], 'wood');
  t.deepEqual(h.world.chestSigns, { [k(a)]: 'food1', [k(b)]: 'stone1', [k(far)]: 'wood3' });
  t.deepEqual(h.world.signTries, {});
  t.is(h.wants(), null);
  // and the label it was to wear, hung there by hand, is found the same way
  const g = house([a, b, far], { [k(a)]: 'food', [k(b)]: 'stone', [k(far)]: 'ores' }, [a, b]);
  await g.run();
  await g.run();
  g.up.set(k(above(far)), 'ore1');
  t.is(await g.run(), '0 sign(s) put up');
  t.is(g.world.chestSigns![k(far)], 'ore1');
  t.deepEqual(g.world.signTries, {});
});

test('the signs round: an old label out of sight is walked round to, out in front of the sign, before the try counts', async (t) => {
  // a top-layer chest against the east wall that holds tools now and wears "stone1": a wall sign facing west, into the
  // room. Hanging the new one is in reach from anywhere near, but the hand that takes the old one down needs it in
  // sight, and from within 3 of the chest (under its lid, or in the yard behind the wall) it is not
  const a = { x: 4, y: 65, z: 0 }, b = { x: 0, y: 63, z: 5 }, c = { x: -4, y: 63, z: 0 };
  const kinds = { [k(a)]: 'gear', [k(b)]: 'wood', [k(c)]: 'food' };
  const start = (sight: string[], wall: Record<string, string> = { [k(above(a))]: 'west' }) => {
    const h = house([a, b, c], kinds, [a, b, c], [], { sight: { [k(above(a))]: sight }, wall });
    h.world.chestSigns = { [k(a)]: 'stone1', [k(b)]: 'wood1', [k(c)]: 'food1' };
    h.up.set(k(above(a)), 'stone1').set(k(above(b)), 'wood1').set(k(above(c)), 'food1');
    return h;
  };
  const front = (x: number, z: number) => ({ x, y: 66, z, xz: true, careful: true, timeoutMs: 30_000 });
  const upTo = { ...a, range: 3, careful: true, timeoutMs: 30_000 };

  // seen from three cells out in front of the sign (over the lid): the walk there only walks
  const h = start(['1,0']);
  t.is(await h.run(), '1 sign(s) put up');
  t.deepEqual(h.walks(), [upTo, front(1, 0)]);
  t.is(h.up.get(k(above(a))), 'tools1');
  t.is(h.world.chestSigns![k(a)], 'tools1');
  t.deepEqual(h.world.signTries, {});
  t.deepEqual(h.acts, []);

  // a room too narrow for that: from one cell out
  const narrow = start(['3,0']);
  t.is(await narrow.run(), '1 sign(s) put up');
  t.deepEqual(narrow.walks(), [upTo, front(1, 0), front(3, 0)]);

  // a sign standing on the chest faces nowhere: out in front of the chest then (the chests here face south)
  const standing = start(['4,3'], {});
  t.is(await standing.run(), '1 sign(s) put up');
  t.deepEqual(standing.walks(), [upTo, front(4, 3)]);

  // a sign of the bot's left where a chest was taken away comes down the same way
  const gone = { x: 9, y: 63, z: 9 };
  const stale = house([a, b, c], kinds, [a, b, c], [], { sight: { [k(above(gone))]: ['9,6'] }, wall: { [k(above(gone))]: 'north' } });
  stale.world.chestSigns = { [k(gone)]: 'misc1' };
  stale.up.set(k(above(gone)), 'misc1');
  t.is(await stale.run(), '3 sign(s) put up, 1 old one(s) taken down');
  t.false(stale.up.has(k(above(gone))));
  t.deepEqual(stale.walks(), [{ ...gone, range: 3, careful: true, timeoutMs: 30_000 }, { x: 9, y: 64, z: 6, xz: true, careful: true, timeoutMs: 30_000 }]);

  // in sight from nowhere: only then the try counts, and after two the chest is left be with its old label
  const blind = start([]);
  t.is(await blind.run(), '0 sign(s) put up, 1 chest(s) left without');
  t.deepEqual(blind.walks(), [upTo, front(1, 0), front(3, 0)]);
  t.deepEqual(blind.world.signTries, { [k(a)]: { label: 'tools1', tries: 1 } });
  t.is(blind.wants(), '1 chest(s) without the right sign');
  // (the chest holds stone again, as its sign says: nothing to do, and the try is forgotten)
  blind.world.chestAssign![k(a)] = 'stone';
  await blind.run();
  t.deepEqual(blind.world.signTries, {});
  blind.world.chestAssign![k(a)] = 'gear';
  await blind.run();
  await blind.run();
  t.deepEqual(blind.world.signTries, { [k(a)]: { label: 'tools1', tries: 2 } });
  t.is(blind.wants(), null);
  t.is(blind.up.get(k(above(a))), 'stone1');
  t.is(blind.world.chestSigns![k(a)], 'stone1');
});

test('the signs round: a run cut short is not a try', async (t) => {
  const a = { x: 2, y: 63, z: 0 }, far = { x: -6, y: 65, z: 0 }, b = { x: 0, y: 63, z: 5 };
  const h = house([a, far, b], { [k(a)]: 'food', [k(far)]: 'ores', [k(b)]: 'stone' }, [a, b]);
  // a more urgent goal stops the run while it walks up to the chest out of reach
  h.hooks.goto = () => h.abort();
  t.is(await h.run(), '1 sign(s) put up');
  t.deepEqual(h.world.signTries, {});
  t.deepEqual(h.world.chestSigns, { [k(a)]: 'food1' });
  t.is(h.wants(), '2 chest(s) without the right sign');
});

test('the signs round: a chest it could not sign once and can the next time: the sign goes up and the try is forgotten', async (t) => {
  const a = { x: 2, y: 63, z: 0 }, b = { x: 0, y: 63, z: 5 }, far = { x: -6, y: 65, z: 0 };
  const walk: Pos[] = [];
  const h = house([a, b, far], { [k(a)]: 'food', [k(b)]: 'stone', [k(far)]: 'ores' }, [a, b], walk);
  t.is(await h.run(), '2 sign(s) put up, 1 chest(s) left without');
  t.deepEqual(h.world.signTries, { [k(far)]: { label: 'ore1', tries: 1 } });
  // the way up to it is free now
  walk.push(far);
  t.is(await h.run(), '1 sign(s) put up');
  t.is(h.up.get(k(above(far))), 'ore1');
  t.deepEqual(h.world.signTries, {});
  t.is(h.wants(), null);
});

test('the signs round: the numbers on the signs stay, however the chest list is ordered', async (t) => {
  const a = { x: 2, y: 63, z: 0 }, b = { x: 6, y: 63, z: 0 }, c = { x: 0, y: 63, z: 5 }, d = { x: 4, y: 63, z: 5 };
  const h = house([d, a, b, c], { [k(a)]: 'food', [k(b)]: 'gear', [k(c)]: 'stone', [k(d)]: 'wood' }, [a, b, c, d]);
  // numbered by another order of the list once, and a label someone else wrote over d
  h.world.chestSigns = { [k(a)]: 'food2', [k(b)]: 'tools3', [k(c)]: 'stone5' };
  h.up.set(k(above(a)), 'food2').set(k(above(b)), 'tools3').set(k(above(c)), 'stone5').set(k(above(d)), 'ore4');
  t.is(await h.run(), '0 sign(s) put up, 1 label(s) someone else wrote followed');
  const worn = { [k(a)]: 'food2', [k(b)]: 'tools3', [k(c)]: 'stone5', [k(d)]: 'ore4' };
  for (const order of permutations([a, b, c, d])) {
    h.world.landmarks.chests = order;
    t.is(h.wants(), null, order.map(k).join(' '));
    await h.run();
  }
  t.deepEqual(h.world.chestSigns, worn);
  t.false(h.calls.some(call => call.method === 'sign.place' || call.method === 'dig.here'));
});
