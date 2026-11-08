import test from 'ava';
import { donateGoal, donationPlan, missionGoal, owedItems, ownItems, sourceOf, syncReserve, DONATE_EVERY, type Mission } from '../../src/client/brain/community.js';
import { freeChestTotals, reservedCount } from '../../src/client/brain/chests.js';
import { diamondsWanted } from '../../src/client/brain/deep.js';
import { structureGoal } from '../../src/client/structures/job.js';
import { pens } from '../../src/client/brain/pens.js';
import { StructureStore } from '../../src/client/structures/store.js';
import type { Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 5,
  home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over
});

const mission = (over: Partial<Mission> = {}): Mission => ({
  id: 1, item: 'diamond', count: 64, chest: 'community1', gathered: 0, delivered: 0, status: 'active', createdAt: 0, updatedAt: 0, ...over
});

const world = (over: Partial<WorldMemory> = {}): WorldMemory => ({
  landmarks: { chests: [{ x: 1, y: 64, z: 1 }], farmland: [] }, leash: 96,
  community: { chests: { community1: { x: -436, y: 67, z: 2135 } }, missions: [], nextId: 2 }, ...over
});

test('sources: ores under ground (ingots mined raw), blocks on the surface, made things refused', (t) => {
  t.like(sourceOf('diamond'), { mine: 'diamond_ore,deepslate_diamond_ore', gives: 'diamond', underground: true });
  t.like(sourceOf('iron_ingot'), { gives: 'raw_iron', underground: true });
  t.like(sourceOf('minecraft:oak_log'), { mine: 'oak_log', gives: 'oak_log', underground: false });
  t.like(sourceOf('cobblestone'), { mine: 'stone', underground: false });
  t.true('error' in sourceOf('netherite_ingot'));
  t.true('error' in sourceOf('oak_planks'));
  t.true('error' in sourceOf('white_wool'));
});

test("what's gathered for a mission is held apart: reserved in the chests, left out of the bot's own pockets", (t) => {
  const w = world({ chestItems: { '1,64,1': { diamond: 5, iron_ingot: 20 } } });
  w.community!.missions.push(mission({ gathered: 7, delivered: 4 }), mission({ id: 2, item: 'iron_ingot', count: 10, gathered: 6, delivered: 0 }));
  t.deepEqual(owedItems(w), { diamond: 3, iron_ingot: 6, raw_iron: 6 });
  syncReserve(w);
  t.is(reservedCount(w, 'diamond'), 3);
  t.is(reservedCount(w, 'diamond', 'community'), 0);
  t.is(freeChestTotals(w).diamond, 2);
  const own = ownItems([{ slot: 0, name: 'diamond_pickaxe', count: 1 }, { slot: 3, name: 'diamond', count: 2 }, { slot: 4, name: 'diamond', count: 9 }], w);
  t.is(own.filter(i => i.name === 'diamond').reduce((a, i) => a + i.count, 0), 8);
  t.true(own.some(i => i.name === 'diamond_pickaxe'));
  // all delivered: nothing held any more
  for (const m of w.community!.missions) m.delivered = m.gathered;
  syncReserve(w);
  t.is(w.reserved?.community, undefined);
});

test("the community's diamonds don't count toward the bot's own diamond kit", (t) => {
  const w = world({ chestItems: { '1,64,1': { diamond: 40 } } });
  const items = [{ slot: 0, name: 'iron_pickaxe', count: 1 }];
  t.is(diamondsWanted({ items }, w), 0);
  w.community!.missions.push(mission({ gathered: 40 }));
  syncReserve(w);
  t.true(diamondsWanted({ items }, w) > 0);
});

test('donations: only the surplus beyond what the bot keeps, a lot at a time; diamonds once its kit is done', (t) => {
  t.deepEqual(donationPlan({ iron_ingot: 70, gold_ingot: 20, diamond: 20, emerald: 2 }, 0), { iron_ingot: 22, diamond: 12 });
  t.deepEqual(donationPlan({ iron_ingot: 70, diamond: 20 }, 5), { iron_ingot: 22 });
  t.deepEqual(donationPlan({ iron_ingot: 50, gold_ingot: 16 }, 0), {});
});

test('the donation round: now and then, by day at home, with a community chest', (t) => {
  const w = world({ chestItems: { '1,64,1': { iron_ingot: 80 } } });
  t.regex(donateGoal.wants(snap(), w) ?? '', /32 iron_ingot/);
  w.community!.lastDonation = snap().now - DONATE_EVERY / 2;
  t.is(donateGoal.wants(snap(), w), null);
  w.community!.lastDonation = 0;
  t.is(donateGoal.wants(snap({ activity: 'rest' }), w), null);
  t.is(donateGoal.wants(snap(), world({ community: { chests: {}, missions: [], nextId: 1 }, chestItems: { '1,64,1': { iron_ingot: 80 } } })), null);
});

test('missions: deliver what is owed, gather the rest; trips under ground wait for the kit', (t) => {
  const w = world();
  t.is(missionGoal.wants(snap(), w), null);
  w.community!.missions.push(mission({ gathered: 3, delivered: 0 }));
  t.regex(missionGoal.wants(snap(), w) ?? '', /3 diamond to take to community1/);
  w.community!.missions[0].delivered = 3;
  // not kitted out for a trip under ground (no armour, food, torches): the kit and food goals first
  t.is(missionGoal.wants(snap(), w), null);
  w.community!.missions[0] = mission({ item: 'oak_log', count: 64 });
  t.regex(missionGoal.wants(snap(), w) ?? '', /64 oak_log still to gather/);
  // surface loads go over in batches of 32, or the last of it
  w.community!.missions[0].gathered = 20;
  t.regex(missionGoal.wants(snap(), w) ?? '', /still to gather/);
  w.community!.missions[0].gathered = 64;
  t.regex(missionGoal.wants(snap(), w) ?? '', /20|64 oak_log to take/);
  t.is(missionGoal.wants(snap({ activity: 'rest' }), w), null);
  t.is(missionGoal.wants(snap({ distHome: 40 }), w), null);
});

test('missions rank with the build jobs: under them, over the stock trips, under the food stockpile', (t) => {
  t.true(missionGoal.priority < structureGoal(new StructureStore(), () => undefined, () => []).priority);
  t.true(missionGoal.priority < pens.priority);
  t.true(missionGoal.priority > 33);
});
