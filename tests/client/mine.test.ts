import test from 'ava';
import { chooseMineSite, deepTripReady, tripBudgetMs, type TripCheck } from '../../src/client/brain/mine.js';

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
