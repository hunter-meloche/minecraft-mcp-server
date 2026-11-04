import test from 'ava';
import { AlertCollector, parsePlayerChat } from '../../src/client/alerts.js';

test('alerts: deaths first with respawn point, then hurts by cause, once', (t) => {
  const a = new AlertCollector();
  a.handle({ type: 'hurt', cause: 'arrow', source: 'skeleton', health: 14 });
  a.handle({ type: 'hurt', cause: 'mob_attack', source: 'zombie', health: 11 });
  a.handle({ type: 'hurt', cause: 'drown', health: 9 });
  a.handle({ type: 'death', message: 'Bot drowned', at: { x: 1, y: 60, z: 2 } });
  a.handle({ type: 'respawn', at: { x: 0, y: 70, z: 0 } });
  t.is(a.take(),
    'DIED: Bot drowned at (1, 60, 2). Respawned at (0, 70, 0). Everything carried was dropped at the death spot; ' +
    'it despawns after 5 minutes (explosions destroy it sooner); ' +
    'Took damage 3x (arrow from skeleton x1, zombie x1, drown x1); health 20/20');
  t.is(a.take(), null);
});

test('parsePlayerChat splits <name> messages and ignores system lines', (t) => {
  t.deepEqual(parsePlayerChat('<Hunter> hello there'), { username: 'Hunter', message: 'hello there' });
  t.is(parsePlayerChat('ClaudeBot joined the game'), null);
});
