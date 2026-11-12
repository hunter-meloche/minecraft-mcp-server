import test from 'ava';
import { MINE_FROM_BUILDS, MINE_FROM_YARD, chooseMineSite, deepTripKit, deepTripReady, pickMineStart, tripBudgetMs, type TripCheck } from '../../src/client/brain/mine.js';

const home = { x: 0, z: 0 };
const col = (x: number, z: number, extra: Partial<{ ground: number; water: boolean; protected: boolean }> = {}) =>
  ({ x, z, ground: 70, water: false, protected: false, ...extra });

test('the nearest dry, solid, unprotected column in range is chosen', (t) => {
  const site = chooseMineSite(home, [col(30, 0), col(60, 0), col(45, 0), col(0, 50), col(100, 0)]);
  t.deepEqual(site, col(45, 0));
});

test('water, protection, missing ground and range rule columns out', (t) => {
  t.is(chooseMineSite(home, [col(41, 0, { water: true }), col(42, 0, { protected: true }), col(43, 0, { ground: NaN }), col(70, 0), col(10, 0)]), undefined);
  t.deepEqual(chooseMineSite(home, [col(41, 0, { water: true }), col(50, 0)]), col(50, 0));
  t.deepEqual(chooseMineSite({ x: 100, z: 100 }, [col(10, 10), col(130, 140)], 20, 64), col(130, 140));
});

const ready: TripCheck = { health: 20, food: 20, readyFoodPoints: 30, armorTier: 4, torches: 32, blocks: 64, timeOfDay: 1000, slotsFree: 15 };

test('a well-stocked bot in the morning is ready', (t) => {
  t.deepEqual(deepTripReady(ready), { ok: true });
  t.true(deepTripReady({ ...ready, health: 18, food: 14, readyFoodPoints: 20, torches: 16, blocks: 32, slotsFree: 10, timeOfDay: 6000 }).ok);
  t.true(deepTripReady({ ...ready, armorTier: 5, timeOfDay: 24000 * 3 + 500 }).ok);
});

test('each shortfall is named', (t) => {
  const cases: [Partial<TripCheck>, RegExp][] = [
    [{ health: 17 }, /health/], [{ food: 13 }, /food 13/], [{ readyFoodPoints: 19 }, /ready food/], [{ armorTier: 3.5 }, /armour/],
    [{ torches: 15 }, /torches/], [{ blocks: 31 }, /blocks/], [{ timeOfDay: 6001 }, /too late/], [{ timeOfDay: 23000 }, /too late/], [{ slotsFree: 9 }, /free slots/]
  ];
  for (const [change, why] of cases) {
    const r = deepTripReady({ ...ready, ...change });
    t.false(r.ok, JSON.stringify(change));
    t.regex(r.why!, why);
  }
  t.is(deepTripReady({ ...ready, health: 5, torches: 0 }).why!.split('; ').length, 2);
});

test('the trip budget gets the bot home by 11000', (t) => {
  t.is(tripBudgetMs(1000, 0), 10_000 * 50);
  t.is(tripBudgetMs(1000, 60_000), 500_000 - 60_000);
  t.is(tripBudgetMs(24000 + 1000, 60_000), 440_000);
  t.is(tripBudgetMs(10_000, 60_000), 0);
  t.is(tripBudgetMs(12_000, 0), 0);
});

test('pickMineStart: the remembered point while clear of builds, else the first clear side of the yard', t => {
  const home = { x: 0, y: 64, z: 0 };
  const yard = { x1: -10, z1: -20, x2: 30, z2: 5 };
  const none = () => Infinity;
  t.deepEqual(pickMineStart(home, yard, undefined, none), { x: 0, y: 64, z: -60 }, 'north of the yard by default');
  const kept = { x: 7, y: 64, z: -70 };
  t.is(pickMineStart(home, yard, kept, none), kept);
  // a friend's base north of the yard: the east side then
  const north = (p: { x: number; z: number }) => (p.z < -30 ? 10 : 100);
  t.deepEqual(pickMineStart(home, yard, kept, north), { x: 70, y: 64, z: 0 });
  t.deepEqual(pickMineStart(home, undefined, undefined, north), { x: 56, y: 64, z: 0 }, 'no yard: 16 round home');
  t.is(pickMineStart(home, yard, undefined, () => MINE_FROM_BUILDS - 1), undefined, 'builds on every side');
});

// the start in the live bot's memory, (-549, 63, 2127), has the yard round it. A shaft sunk there is a hole in the
// homestead; the point is forgotten and one is chosen as when none was kept.
test('a kept mine start inside the yard is dropped', t => {
  const home = { x: 0, y: 64, z: 0 };
  const yard = { x1: -10, z1: -20, x2: 30, z2: 5 };
  const none = () => Infinity;
  const fresh = { x: 0, y: 64, z: -60 };
  t.deepEqual(pickMineStart(home, yard, { x: 7, y: 63, z: -3 }, none), fresh, 'inside the yard');
  t.deepEqual(pickMineStart(home, yard, { x: 30, y: 63, z: 5 }, none), fresh, 'on its corner');
  // under 30 outside is still the homestead's doorstep
  t.deepEqual(pickMineStart(home, yard, { x: 7, y: 63, z: -20 - (MINE_FROM_YARD - 1) }, none), fresh, '29 north of it');
  t.deepEqual(pickMineStart(home, yard, { x: 30 + 29, y: 63, z: 5 + 29 }, none), fresh, '29 off the corner, both ways');
  // 30 or more outside on any one side: kept, as before
  for (const kept of [{ x: 7, y: 63, z: -50 }, { x: 60, y: 63, z: 0 }, { x: -40, y: 63, z: 0 }, { x: 7, y: 63, z: 35 }, { x: 60, y: 63, z: -3 }]) {
    t.is(pickMineStart(home, yard, kept, none), kept, JSON.stringify(kept));
  }
  // a dropped start goes the same way as none kept: past a friend's base to the north, the east side
  const north = (p: { x: number; z: number }) => (p.z < -30 ? 10 : 100);
  t.deepEqual(pickMineStart(home, yard, { x: 7, y: 63, z: -3 }, north), { x: 70, y: 64, z: 0 });
  // with no yard known there is nothing to be inside of
  const near = { x: 3, y: 63, z: 3 };
  t.is(pickMineStart(home, undefined, near, none), near);
});

/** deepTripReady as it stood before the kit was split from it (commit 817d80b), word for word. */
function readyAtHead(s: TripCheck): { ok: boolean; why?: string } {
  const why: string[] = [];
  const t = ((s.timeOfDay % 24000) + 24000) % 24000;
  if (s.health < 18) why.push(`health ${s.health} < 18`);
  if (s.food < 14) why.push(`food ${s.food} < 14`);
  if (s.readyFoodPoints < 20) why.push(`ready food ${s.readyFoodPoints} < 20 points`);
  if (s.armorTier < 4) why.push('armour below iron');
  if (s.torches < 16) why.push(`${s.torches} torches < 16`);
  if (s.blocks < 32) why.push(`${s.blocks} blocks < 32`);
  if (t > 6000) why.push(`too late in the day (${t}; set out by 6000)`);
  if (s.slotsFree < 10) why.push(`${s.slotsFree} free slots < 10`);
  return why.length ? { ok: false, why: why.join('; ') } : { ok: true };
}

test('deepTripReady is deepTripKit plus time and slots', t => {
  // every field at, just under and well under its limit, alone and all together
  const fields: [keyof TripCheck, number[]][] = [
    ['health', [20, 18, 17, 5]], ['food', [20, 14, 13, 0]], ['readyFoodPoints', [30, 20, 19, 0]], ['armorTier', [5, 4, 3.5, 0]],
    ['torches', [64, 16, 15, 0]], ['blocks', [64, 32, 31, 0]], ['timeOfDay', [0, 6000, 6001, 23000, 24000 * 3 + 500, -1]], ['slotsFree', [26, 10, 9, 0]]
  ];
  const checks: TripCheck[] = [ready];
  for (const [field, values] of fields) for (const v of values) checks.push({ ...ready, [field]: v });
  // two and three short at once: the order of the words is HEAD's too
  for (const [a, as] of fields) for (const [b, bs] of fields) if (a !== b) checks.push({ ...ready, [a]: as[as.length - 1], [b]: bs[2] });
  checks.push({ health: 5, food: 0, readyFoodPoints: 0, armorTier: 0, torches: 0, blocks: 0, timeOfDay: 13000, slotsFree: 0 });
  for (const c of checks) {
    const now = deepTripReady(c);
    t.deepEqual(now, readyAtHead(c), JSON.stringify(c));
    // the kit is the same answer with the hour and the pockets taken out
    const kit = deepTripKit({ health: c.health, food: c.food, readyFoodPoints: c.readyFoodPoints, armorTier: c.armorTier, torches: c.torches, blocks: c.blocks });
    t.deepEqual(kit, readyAtHead({ ...c, timeOfDay: 1000, slotsFree: 36 }), `kit of ${JSON.stringify(c)}`);
    // ... and ready is the kit's words first, then the hour, then the slots
    const t24 = ((c.timeOfDay % 24000) + 24000) % 24000;
    const rest = [
      ...(t24 > 6000 ? [`too late in the day (${t24}; set out by 6000)`] : []),
      ...(c.slotsFree < 10 ? [`${c.slotsFree} free slots < 10`] : [])
    ];
    const all = [...(kit.why ? [kit.why] : []), ...rest];
    t.deepEqual(now, all.length ? { ok: false, why: all.join('; ') } : { ok: true });
  }
  t.is(checks.length, 92);
  // full pockets at dusk say nothing about the kit
  t.deepEqual(deepTripKit({ ...ready }), { ok: true });
  t.deepEqual(deepTripKit({ health: 17, food: 13, readyFoodPoints: 19, armorTier: 3, torches: 15, blocks: 31 }),
    { ok: false, why: 'health 17 < 18; food 13 < 14; ready food 19 < 20 points; armour below iron; 15 torches < 16; 31 blocks < 32' });
});
