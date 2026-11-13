import test from 'ava';
import { donateGoal, donationPlan, missionGoal, owedItems, ownItems, sourceOf, syncReserve, DONATE_EVERY, type Mission } from '../../src/client/brain/community.js';
import { freeChestTotals, reservedCount } from '../../src/client/brain/chests.js';
import { diamondsWanted } from '../../src/client/brain/deep.js';
import { structureGoal } from '../../src/client/structures/job.js';
import { pens } from '../../src/client/brain/pens.js';
import { StructureStore } from '../../src/client/structures/store.js';
import type { Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';
import { KEPT, T0, WORN, liveWorld, lookAt } from '../helpers/homestead.js';

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

test('donations: only the surplus beyond what the bot keeps and what the work queue keeps of its family, a lot at a time; diamonds once its kit is done', (t) => {
  // at tier 0 the queue keeps 96 iron, 32 gold and 16 diamonds, over the bot's own 48 ingots, 16 ingots and 8: the
  // old floors alone gave 70 iron, 20 gold and 20 diamonds of these
  t.deepEqual(donationPlan({ iron_ingot: 118, gold_ingot: 36, diamond: 28, emerald: 2 }, 0, 0), { iron_ingot: 22, diamond: 12 });
  t.deepEqual(donationPlan({ iron_ingot: 118, diamond: 28 }, 5, 0), { iron_ingot: 22 });
  t.deepEqual(donationPlan({ iron_ingot: 98, gold_ingot: 32 }, 0, 0), {});
  // the family counts raw and smelted together, as the queue does; the ingots the bot keeps stay kept all the same
  t.deepEqual(donationPlan({ raw_gold: 30, gold_ingot: 26 }, 0, 0), { gold_ingot: 10 });
  t.deepEqual(donationPlan({ raw_gold: 400, gold_ingot: 20, raw_iron: 1000, iron_ingot: 60 }, 0, 0), {});
  t.deepEqual(donationPlan({ raw_iron: 20, iron_ingot: 100 }, 0, 0), { iron_ingot: 24 });
  // emeralds no rung mines: what the bot keeps of them is all there is to it
  t.deepEqual(donationPlan({ emerald: 4 }, 0, 4), { emerald: 4 });
});

test('the donation round: now and then, by day at home, with a community chest', (t) => {
  // (the queue keeps 96 iron at tier 0: 32 over it)
  const w = world({ chestItems: { '1,64,1': { iron_ingot: 128 } } });
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

/**
 * The live chests at 01:35 EST on Nov 13 (brain.json): the deep rung at tier 4, its targets diamond 256, iron 1536, gold
 * 512, redstone 1024, lapis 512, and the stock it mined for them in the ore chest. At 05:57Z the donate goal set out
 * with `spare for the community: 230 diamond, 8 gold_ingot`: the floor of 8 diamonds and 16 gold ingots, and every
 * diamond a trip brought home over it went up for the community.
 */
function tierFour(ores: Record<string, number> = {}): WorldMemory {
  const w = liveWorld();
  Object.assign(w.chestItems!['-547,63,2180'], { diamond: 238, raw_iron: 1179, raw_gold: 414, gold_ingot: 24, redstone: 1027, lapis_lazuli: 514 }, ores);
  w.work = { dry: {}, next: {}, sites: {}, pen: {}, tier: 4, deep: { starts: [], clean: 3, deaths: [] } };
  return w;
}
/** At home by day with the live kept kit, the diamond tools and armour (no diamond still wanted for the kit). */
const atHome = () => lookAt([...KEPT.map(([name, count], slot) => ({ slot, name, count })), ...WORN.map(i => ({ ...i }))], 3000);

test('the donate goal keeps what the work queue mined for the bot: at tier 4 with 238 diamonds stored nothing goes; over a target, the surplus still does', (t) => {
  t.is(diamondsWanted(atHome(), tierFour()), 0, 'the diamond kit is whole: diamonds would go, by the old rule');
  // the live morning: 238 of the 256 the queue keeps, 438 gold of 512, 1203 iron of 1536
  t.is(donateGoal.wants(atHome(), tierFour()), null);
  t.deepEqual(donateGoal.declines!(atHome(), tierFour()), { cause: 'unneeded', text: 'nothing spare to give' });
  // over the targets: what is over goes, now and then as ever, and no more (the ingots the bot keeps stay too)
  const over = tierFour({ diamond: 270, raw_gold: 500, gold_ingot: 40, iron_ingot: 400 });
  t.is(donateGoal.wants(atHome(), over), 'spare for the community: 14 diamond, 24 gold_ingot, 43 iron_ingot');
  // the tier steps up when every family is at its target: the floor only rises with it, so nothing over the old
  // targets swings back out
  over.work!.tier = 5;
  t.is(donateGoal.wants(atHome(), over), null);
  // and not again before its three hours
  const soon = tierFour({ diamond: 270 });
  soon.community!.lastDonation = T0 - DONATE_EVERY / 2;
  t.is(donateGoal.wants(atHome(), soon), null);
});

test('missions are the user\'s asks, untouched by the floor: one owed is delivered and one short is gathered, below the work target or not', (t) => {
  // 40 of 238 diamonds gathered for a mission: held apart, not the bot's, and none of its own over the 256 kept
  const w = tierFour();
  w.community!.missions.push({ id: 2, item: 'diamond', count: 64, chest: 'community1', gathered: 40, delivered: 0, status: 'active', createdAt: T0, updatedAt: T0 });
  syncReserve(w);
  t.is(donateGoal.wants(atHome(), w), null);
  t.is(missionGoal.wants(atHome(), w), '#2: 40 diamond to take to community1');
  // all of it delivered, 24 still to gather: the mission goes on gathering, the queue's 256 or not
  w.community!.missions[1].delivered = 40;
  syncReserve(w);
  t.regex(missionGoal.wants(atHome(), w) ?? '', /^#2: 24 diamond still to gather for community1$/);
});
