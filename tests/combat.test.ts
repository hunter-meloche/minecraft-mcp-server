import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { fight, fleeAndEat, equipBestArmor, matchesTarget, hostilesNear } from '../src/combat.js';
import { arena, item, mob } from './helpers/arena.js';

const { goals } = pathfinderPkg;

test('fight counts landed hits separately from swings', async (t) => {
  const zombie = mob('zombie', 2);
  // the 1st and 3rd swing don't register on the server
  const { asBot } = arena({ mobs: [zombie], items: [item('iron_sword')], damage: 10, misses: s => s % 2 === 1 });
  const r = await fight(asBot, 'zombie');
  t.is(r.outcome, 'done');
  t.deepEqual(r.kills, ['zombie']);
  t.is(r.hits, 4);
  t.is(r.landed, 2);
  t.deepEqual([...r.swungWith], [['iron_sword', 4]]);
});

test("fight 'hostile' keeps going until no monster is left, and leaves animals and neutral mobs alone", async (t) => {
  const { asBot, entities } = arena({
    mobs: [mob('zombie', 2), mob('cow', 1, { type: 'animal' }), mob('spider', 3), mob('enderman', 2.5)],
    items: [item('stone_sword')]
  });
  const r = await fight(asBot, 'hostile');
  t.is(r.outcome, 'done');
  t.deepEqual(r.kills, ['zombie', 'spider']);
  t.deepEqual(Object.values(entities).map(e => e.name).sort(), ['cow', 'enderman']);
});

test('fight takes the weapon back when chasing put something else in hand', async (t) => {
  const { bot, asBot } = arena({ mobs: [mob('zombie', 2)], items: [item('dirt', 5), item('iron_sword')], damage: 7 });
  // pathfinder swaps in scaffolding between swings
  bot.attack = Object.assign(bot.attack, {});
  const original = bot.attack;
  bot.attack = ((target: never) => { original(target); bot.heldItem = item('dirt', 5); }) as typeof bot.attack;
  const r = await fight(asBot, 'zombie');
  t.deepEqual([...r.swungWith], [['iron_sword', 3]]);
});

test('fight puts on better armor and a shield, and raises the shield against skeletons', async (t) => {
  const { bot, asBot } = arena({
    mobs: [mob('skeleton', 2)],
    items: [item('wooden_sword'), item('iron_chestplate'), item('leather_helmet'), item('shield')],
    damage: 10
  });
  const r = await fight(asBot, 'skeleton');
  t.deepEqual(r.wore.sort(), ['iron_chestplate', 'leather_helmet']);
  t.is((bot.inventory.slots[45] as { name: string }).name, 'shield');
  t.true(bot.activateItem.calledWith(true)); // raised between the two swings
  t.true(bot.deactivateItem.called);
  t.false(bot.usingHeldItem);
});

test('equipBestArmor keeps better armor that is already worn', async (t) => {
  const { bot, asBot } = arena({ items: [item('iron_helmet'), item('golden_boots')] });
  bot.inventory.slots[5] = item('diamond_helmet');
  t.deepEqual(await equipBestArmor(asBot), ['golden_boots']);
});

test('fight backs off from a creeper after each hit', async (t) => {
  const { bot, asBot } = arena({ mobs: [mob('creeper', 2)], items: [item('stone_sword')], damage: 10 });
  await fight(asBot, 'creeper');
  const goalsSet = bot.pathfinder.setGoal.getCalls().map(c => c.args[0]);
  t.true(goalsSet.some(g => g instanceof goals.GoalInvert));
});

test('fight stops at low health, flees and eats', async (t) => {
  const skeleton = mob('skeleton', 2);
  const { bot, asBot } = arena({ mobs: [skeleton], items: [item('wooden_sword'), item('bread', 3)], health: 5, food: 14 });
  // fleeing works: the threat ends up far away
  bot.pathfinder.setGoal = Object.assign((g: unknown) => { if (g instanceof goals.GoalInvert) skeleton.position = new Vec3(30, 64, 0); }, { getCalls: () => [] }) as never;
  const r = await fight(asBot, 'skeleton');
  t.is(r.outcome, 'low_health');
  t.is(r.retreat, 'fled from skeleton, ate bread');
  t.true(bot.consume.calledOnce);
});

test('fleeAndEat says when it could not get away', async (t) => {
  const { asBot } = arena({ mobs: [mob('zombie', 3)], food: 20 });
  t.is(await fleeAndEat(asBot, { fleeMs: 300 }), 'fled but 1 hostile(s) still close');
});

test('fight reports none when nothing matches', async (t) => {
  const { asBot } = arena({ mobs: [mob('cow', 2, { type: 'animal' })] });
  t.is((await fight(asBot, 'hostile')).outcome, 'none');
});

test('matchesTarget hostile skips neutral mobs and bosses, but they can be named', (t) => {
  t.false(matchesTarget({ type: 'hostile', name: 'enderman' }, 'hostile'));
  t.false(matchesTarget({ type: 'hostile', name: 'warden' }, 'hostile'));
  t.true(matchesTarget({ type: 'hostile', name: 'enderman' }, 'enderman'));
  t.true(matchesTarget({ type: 'hostile', name: 'parched' }, 'hostile'));
});

test('hostilesNear lists every hostile in range, nearest first', (t) => {
  const { asBot } = arena({ mobs: [mob('skeleton', 9), mob('zombie', 3), mob('cow', 1, { type: 'animal' }), mob('enderman', 5)] });
  t.deepEqual(hostilesNear(asBot, 8).map(e => e.name), ['zombie', 'enderman']);
});

test('fight counts only its own hits as landed, not arrows or blasts from others', async (t) => {
  const zombie = mob('zombie', 2);
  const skeleton = mob('skeleton', 15);
  const { bot, asBot } = arena({ mobs: [zombie, skeleton], items: [item('iron_sword')], damage: 10 });
  const swing = bot.attack;
  bot.attack = ((target: never) => { bot.emit('entityHurt', zombie, skeleton); swing(target); }) as typeof bot.attack;
  const r = await fight(asBot, 'zombie');
  t.is(r.hits, 2);
  t.is(r.landed, 2);
});

test('fight walks toward a far target with a fixed goal and follows it once close', async (t) => {
  const cow = mob('cow', 20, { type: 'animal' });
  const { bot, asBot } = arena({ mobs: [cow], items: [item('stone_sword')] });
  // walking: each new goal brings the bot up to 7 blocks closer
  bot.pathfinder.setGoal = sinon.spy(() => { bot.entity.position = bot.entity.position.offset(Math.max(0, Math.min(7, cow.position.x - bot.entity.position.x - 2)), 0, 0); });
  await fight(asBot, 'cow', { maxDistance: 64, timeoutMs: 10_000 });
  const kinds = (bot.pathfinder.setGoal as sinon.SinonSpy).getCalls().map(c => c.args[0]?.constructor?.name ?? 'null');
  t.is(kinds[0], 'GoalNear');
  t.true(kinds.includes('GoalFollow'));
  t.true(kinds.indexOf('GoalFollow') > kinds.indexOf('GoalNear'));
});

test("fight gives up on a target it can't get closer to, and moves on to the next one with 'hostile'", async (t) => {
  const across = mob('zombie', 10); // across a ravine: never gets closer
  const near = mob('spider', 3);
  const { asBot } = arena({ mobs: [across], items: [item('stone_sword')] });
  const lone = await fight(asBot, 'zombie', { stuckMs: 300 });
  t.is(lone.outcome, 'unreachable');
  t.deepEqual(lone.unreachable, ['zombie']);

  const ledge = mob('zombie', 1.5, { y: 70 }); // on a ledge 6 up: never in reach, and the nearest
  const two = arena({ mobs: [ledge, near], items: [item('stone_sword')] });
  const r = await fight(two.asBot, 'hostile', { stuckMs: 300 });
  t.deepEqual(r.unreachable, ['zombie']);
  t.true(r.kills.includes('spider'));
});

test('a creeper that explodes is not a kill, and the shield goes up toward it after each hit', async (t) => {
  const creeper = mob('creeper', 2);
  const { bot, asBot, entities } = arena({ mobs: [creeper], items: [item('stone_sword'), item('shield')], damage: 5 });
  // after the first hit it blows up: gone, no death event
  bot.attack = ((target: { id: number }) => { bot.emit('entityHurt', target, bot.entity); setTimeout(() => { delete entities[target.id]; creeper.isValid = false; }, 50); }) as unknown as typeof bot.attack;
  const r = await fight(asBot, 'creeper');
  t.deepEqual(r.kills, []);
  t.deepEqual(r.vanished, ['creeper (exploded)']);
  t.true(bot.activateItem.calledWith(true));
});
