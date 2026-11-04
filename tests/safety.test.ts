import test from 'ava';
import fs from 'fs';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';
import { applyMovementSafety, touchesLava } from '../src/movement-safety.js';
import { canSee, fight } from '../src/combat.js';
import { installAutoDefend, noteDeath, noteDeathMessage, noteRespawn, reflexTarget, takeAlerts } from '../src/auto-defend.js';
import { arena, item, mob } from './helpers/arena.js';
import type mineflayer from 'mineflayer';

const require = createRequire(import.meta.url);
const { patchSource, MARKER } = require('../scripts/patch-pathfinder.cjs') as { patchSource: (s: string) => { source: string; changed: boolean }; MARKER: string };

// ---- deaths

test('a death is reported first, with the server message, where it happened and where the bot came back', (t) => {
  const { bot, asBot } = arena({});
  Object.assign(bot, { username: 'ClaudeFresh' });
  bot.entity.position = new Vec3(-677.4, 62, -291.6);
  noteDeath(asBot);
  noteDeathMessage(asBot, { translate: 'death.attack.arrow', toString: () => 'ClaudeFresh was shot by Skeleton' });
  noteDeathMessage(asBot, { translate: 'death.attack.arrow', toString: () => 'SomeoneElse was shot by Skeleton' }); // not ours
  bot.entity.position = new Vec3(-604, 78, -313);
  noteRespawn(asBot);
  t.is(takeAlerts(asBot), 'DIED: ClaudeFresh was shot by Skeleton at (-678, 62, -292). Respawned at (-604, 78, -313). Everything carried was dropped at the death spot; it despawns after 5 minutes (explosions destroy it sooner)');
  t.is(takeAlerts(asBot), null);
});

test('installAutoDefend hooks death, death message and respawn', (t) => {
  const { bot, asBot } = arena({});
  Object.assign(bot, { username: 'ClaudeFresh', _client: new EventEmitter() });
  installAutoDefend(asBot);
  bot.emit('death');
  bot.emit('message', { translate: 'death.attack.drown', toString: () => 'ClaudeFresh drowned' });
  bot.emit('spawn');
  bot.emit('end');
  t.regex(takeAlerts(asBot) ?? '', /^DIED: ClaudeFresh drowned at \(0, 64, 0\)\. Respawned at \(0, 64, 0\)\./);
});

test('a death message without a death event (e.g. it arrived first) still gets reported', (t) => {
  const { bot, asBot } = arena({});
  Object.assign(bot, { username: 'ClaudeFresh' });
  noteDeathMessage(asBot, { translate: 'death.attack.explosion.player', toString: () => 'ClaudeFresh was blown up by Creeper' });
  t.regex(takeAlerts(asBot) ?? '', /^DIED: ClaudeFresh was blown up by Creeper at/);
});

// ---- movement safety

function fakeMovements (physical: (dx: number, dy: number, dz: number) => boolean) {
  const diagonal = { called: 0 };
  return {
    diagonal,
    m: {
      maxDropDown: 4, allowParkour: true, liquidCost: 1,
      exclusionAreasBreak: [] as ((b: { position: Vec3 }) => number)[],
      getBlock: (_n: unknown, dx: number, dy: number, dz: number) => ({ physical: physical(dx, dy, dz) }),
      getMoveDiagonal: (_node: unknown, _dir: unknown, _neighbors: unknown[]): unknown => { diagonal.called++; return 'move'; }
    }
  };
}

test('movement safety: short drops, no parkour, costly swimming, never break next to lava', (t) => {
  const lava = new Vec3(5, 60, 5);
  const bot = { blockAt: (p: Vec3) => ({ name: p.equals(lava) ? 'lava' : 'stone' }) } as unknown as mineflayer.Bot;
  const { m } = fakeMovements(() => false);
  applyMovementSafety(bot, m);
  t.like(m, { maxDropDown: 3, allowParkour: false, liquidCost: 5 });
  t.is(m.exclusionAreasBreak[0]({ position: new Vec3(5, 61, 5) }), 100); // right above the lava
  t.is(m.exclusionAreasBreak[0]({ position: new Vec3(7, 61, 5) }), 0);
  t.true(touchesLava(bot, new Vec3(4, 60, 5)));
});

test('movement safety: a flat diagonal step needs both sides clear', (t) => {
  const bot = { blockAt: () => ({ name: 'air' }) } as unknown as mineflayer.Bot;
  // a block on the +x side at feet height, the landing cell (1,0,1) is open
  const blocked = fakeMovements((dx, dy, dz) => dx === 1 && dz === 0 && dy === 0);
  applyMovementSafety(bot, blocked.m);
  t.is(blocked.m.getMoveDiagonal({}, { x: 1, z: 1 }, []), undefined);
  t.is(blocked.diagonal.called, 0);
  const open = fakeMovements(() => false);
  applyMovementSafety(bot, open.m);
  t.is(open.m.getMoveDiagonal({}, { x: 1, z: 1 }, []), 'move');
  // stepping up onto a block diagonally is left to pathfinder's own rules
  const stepUp = fakeMovements((dx, dy, dz) => dx === 1 && dz === 1 && dy === 0);
  applyMovementSafety(bot, stepUp.m);
  t.is(stepUp.m.getMoveDiagonal({}, { x: 1, z: 1 }, []), 'move');
});

// ---- pathfinder patch

test('the installed mineflayer-pathfinder is patched (postinstall ran)', (t) => {
  const source = fs.readFileSync(require.resolve('mineflayer-pathfinder/index.js'), 'utf8');
  t.true(source.includes(MARKER));
  t.true(source.includes('if (placementEpoch === navigationEpoch && bot.pathfinder.LOSWhenPlacingBlocks'));
  t.true(source.includes('never rewrite the player position or velocity'));
  t.is(patchSource(source).changed, false); // idempotent
});

test('patchSource refuses a pathfinder whose source changed', (t) => {
  t.throws(() => patchSource('  let returningPos = null\n'), { message: /pathfinder source changed/ });
});

// ---- line of sight

test('canSee: a block between the eyes and the mob blocks the swing', (t) => {
  const wall = new Vec3(1, 65, 0);
  const { bot, asBot } = arena({});
  Object.assign(bot, { world: { raycast: (from: Vec3, dir: Vec3, range: number) => {
    for (let d = 0; d <= range; d += 0.1) { if (from.plus(dir.scaled(d)).floored().equals(wall)) return { name: 'stone' }; }
    return null;
  } } });
  t.false(canSee(asBot, { position: new Vec3(2.5, 64, 0.5), height: 1.95 }));
  t.true(canSee(asBot, { position: new Vec3(0.5, 64, 2.5), height: 1.95 }));
});

test('the reflex ignores a zombie behind a wall; fight closes in instead of swinging at the wall', async (t) => {
  const zombie = mob('zombie', 2);
  const { bot, asBot } = arena({ mobs: [zombie], items: [item('stone_sword')], damage: 20 });
  let wallUp = true;
  Object.assign(bot, { world: { raycast: () => (wallUp ? { name: 'stone' } : null) } });
  t.is(reflexTarget(asBot), null);
  setTimeout(() => { wallUp = false; }, 300); // it walks around the corner
  const r = await fight(asBot, 'zombie');
  t.deepEqual(r.kills, ['zombie']);
  t.is(r.hits, 1); // no swings while it was behind the wall
});

test('a death message that arrives before the death event is one death, not two', (t) => {
  const { bot, asBot } = arena({});
  Object.assign(bot, { username: 'ClaudeFresh' });
  noteDeathMessage(asBot, { translate: 'death.attack.drown', toString: () => 'ClaudeFresh drowned' });
  noteDeath(asBot);
  noteRespawn(asBot);
  const alert = takeAlerts(asBot) ?? '';
  t.is(alert.match(/DIED/g)?.length, 1);
  t.regex(alert, /^DIED: ClaudeFresh drowned at \(0, 64, 0\)\. Respawned at/);
});
