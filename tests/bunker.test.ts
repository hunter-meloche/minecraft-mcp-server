import test from 'ava';
import { Vec3 } from 'vec3';
import { centerInCell, coverBlocks, shelterCells, wallIn, describeShelter } from '../src/bunker.js';
import { fight } from '../src/combat.js';
import { emergencyTick, noteHurt } from '../src/auto-defend.js';
import { arena, item, mob } from './helpers/arena.js';
import type { Item } from 'prismarine-item';

const key = (v: Vec3) => `${v.x},${v.y},${v.z}`;

test('wallIn closes all four sides at feet and head height and puts a roof on', async (t) => {
  const { asBot, placed } = arena({ items: [item('oak_planks', 20), item('dirt', 10)] });
  const r = await wallIn(asBot);
  t.is(r.placed, 10);
  t.deepEqual(r.gaps, []);
  t.deepEqual([...placed].sort(), shelterCells(new Vec3(0, 64, 0)).map(key).sort());
  t.is(asBot.inventory.items().find(i => i.name === 'dirt'), undefined); // dirt went first
  t.regex(describeShelter(r), /^Walled in at \(0, 64, 0\) \(10 block\(s\) placed\)/);
});

test('wallIn uses existing walls and reports cells it could not fill', async (t) => {
  const { asBot } = arena({ items: [item('cobblestone', 9)], solid: ['1,64,0', '1,65,0'], mobs: [mob('zombie', -1)] });
  const r = await wallIn(asBot);
  t.is(r.alreadySolid, 2);
  // the zombie stands in (-1,64,0)
  t.true(r.gaps.some(g => g.equals(new Vec3(-1, 64, 0))));
  t.regex(describeShelter(r), /gap\(s\) left at \(-1, 64, 0\)/);
});

test('coverBlocks prefers cheap blocks, takes planks last, never falling blocks', (t) => {
  const items = [item('sand', 10), item('birch_planks', 3), item('cobblestone', 2), item('dirt', 1)] as unknown as Item[];
  t.deepEqual(coverBlocks(items).map(i => i.name), ['dirt', 'cobblestone', 'birch_planks']);
});

test('fight at low health walls in when it has blocks instead of running', async (t) => {
  const { bot, asBot } = arena({ mobs: [mob('skeleton', 6)], items: [item('wooden_sword'), item('dirt', 12), item('bread', 2)], health: 5, food: 15 });
  const r = await fight(asBot, 'skeleton');
  t.is(r.outcome, 'low_health');
  t.regex(r.retreat ?? '', /^walled in at \(0, 64, 0\) \(10 block\(s\) placed\).*, ate bread$/);
  t.false(bot.pathfinder.setGoal.getCalls().some(c => c.args[0]?.constructor?.name === 'GoalInvert'));
});

test('fight stops earlier when outnumbered, and does not start on the next target when hurt', async (t) => {
  const outnumbered = arena({ mobs: [mob('zombie', 2), mob('skeleton', 9)], items: [item('stone_sword')], health: 9 });
  t.is((await fight(outnumbered.asBot, 'zombie', { retreat: false })).outcome, 'low_health'); // 9 <= 6 + 4

  const chain = arena({ mobs: [mob('zombie', 2), mob('zombie', 3)], items: [item('stone_sword')], health: 11 });
  const r = await fight(chain.asBot, 'hostile');
  t.deepEqual(r.kills, ['zombie']); // the second one is left: 11 < 12
});

test('emergencyTick walls in once when health is low and the bot is still being hurt', async (t) => {
  const zombie = mob('zombie', 3);
  const { asBot } = arena({ mobs: [zombie], items: [item('dirt', 12)], health: 5 });
  t.is(await emergencyTick(asBot), null); // not hurt recently
  noteHurt(asBot, asBot.entity, zombie as never);
  t.regex(await emergencyTick(asBot) ?? '', /^health 5 and under attack: Walled in at \(0, 64, 0\)/);
  noteHurt(asBot, asBot.entity, zombie as never);
  t.is(await emergencyTick(asBot), null); // already sheltered here
});

test('emergencyTick does nothing with enough health or too few blocks', async (t) => {
  const zombie = mob('zombie', 3);
  const healthy = arena({ mobs: [zombie], items: [item('dirt', 12)], health: 15 });
  noteHurt(healthy.asBot, healthy.asBot.entity, zombie as never);
  t.is(await emergencyTick(healthy.asBot), null);
  const poor = arena({ mobs: [zombie], items: [item('dirt', 3)], health: 4 });
  noteHurt(poor.asBot, poor.asBot.entity, zombie as never);
  t.is(await emergencyTick(poor.asBot), null);
});

test('wallIn still roofs over when the side it would normally build the roof support on is blocked', async (t) => {
  // a zombie stands at +x, so that side stays open; the support goes on another side
  const { asBot, placed } = arena({ items: [item('dirt', 12)], mobs: [mob('zombie', 1)] });
  const r = await wallIn(asBot);
  t.true(placed.has('0,66,0'));
  // the zombie's cell, and the head cell above it, which has nothing to be placed against
  t.deepEqual(r.gaps.map(g => `${g.x},${g.y},${g.z}`), ['1,64,0', '1,65,0']);
});

test('wallIn puts a block under a side whose ground was mined out, so nothing is left open', async (t) => {
  // under the +x side: two cells of air, so (1,64,0) has nothing below it and nothing beside it
  const { asBot, placed } = arena({ items: [item('cobblestone', 20)], air: ['1,63,0', '1,62,0', '2,63,0', '1,63,1', '1,63,-1'] });
  const r = await wallIn(asBot);
  t.deepEqual(r.gaps, []);
  t.true(placed.has('1,63,0')); // the support
  t.true(placed.has('1,64,0'));
});

test('wallIn never places against a crafting table (that would open it)', async (t) => {
  // the only block at roof height is a crafting table next to the roof cell
  const { asBot, placed } = arena({ items: [item('dirt', 12)], named: { '0,66,1': 'crafting_table' } });
  const r = await wallIn(asBot);
  t.deepEqual(r.gaps, []);
  t.true(placed.has('0,66,0'));
  t.true(placed.has('1,66,0')); // a real support was built instead
});

test('centerInCell steps to the middle of the cell before building', async (t) => {
  const { bot, asBot } = arena({});
  bot.entity.position = new Vec3(4.9, 64, 7.2); // hanging over the +x edge
  let facing = new Vec3(0, 0, 0);
  Object.assign(bot, {
    lookAt: async (v: Vec3) => { facing = v; },
    setControlState: (control: string, on: boolean) => {
      if (control !== 'forward' || !on) return;
      const p = bot.entity.position;
      const step = new Vec3(facing.x - p.x, 0, facing.z - p.z);
      const len = Math.hypot(step.x, step.z);
      bot.entity.position = p.plus(step.scaled(Math.min(1, 0.25 / len)));
    }
  });
  await centerInCell(asBot);
  t.true(Math.abs(bot.entity.position.x - 4.5) < 0.12);
  t.true(Math.abs(bot.entity.position.z - 7.5) < 0.12);
});
