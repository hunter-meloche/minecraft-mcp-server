import test from 'ava';
import fs from 'fs';
import path from 'path';

// Baritone's mob avoidance for hostile mobs only (client-mod AvoidanceMixin). Live Nov 18 animals stuck in a 2-deep hole
// at (-557, 61, 2199) walled storehouse2 off: Avoidance.create took every Mob, each multiplied the cost of the nodes
// within 8 by 1.5, and the stack priced the door (7.5 away) out of reach. Every cell tried split at 8 from the hole: 8.06
// away walkable, 7.3-7.5 "no path found" one step off. The Java was checked against the pinned Baritone jar (javap:
// baritone.fz is Avoidance, its `c(Entity)Z` the `instanceof Mob` filter lambda, bootstrap method #1); here, that the
// hook stays wired and keeps the hostile ones.

const mod = path.join(process.cwd(), 'client-mod');
const read = (f: string): string => fs.readFileSync(path.join(mod, f), 'utf8');

test('the avoidance mixin is registered on Baritone\'s Avoidance filter, never required', (t) => {
  const mixins = JSON.parse(read('resources/claudebridge.mixins.json')) as { client: string[] };
  t.true(mixins.client.includes('AvoidanceMixin'));
  const java = read('src/claudebridge/mixin/AvoidanceMixin.java');
  t.regex(java, /@Mixin\(targets = "baritone\.fz", remap = false\)/);
  t.regex(java, /method = "c\(Lnet\/minecraft\/world\/entity\/Entity;\)Z", at = @At\("HEAD"\), cancellable = true, require = 0/);
});

test('paths give room to hostile mobs only: an animal is no reason to go round', (t) => {
  const java = read('src/claudebridge/mixin/AvoidanceMixin.java');
  t.regex(java, /import net\.minecraft\.world\.entity\.monster\.Enemy;/);
  t.regex(java, /cir\.setReturnValue\(claudebridge\$avoided\(entity\)\);/);
  t.regex(java, /return entity instanceof Mob && entity instanceof Enemy;/);
  // avoidance itself stays on (the monsters' room is wanted): the mixin narrows it, the setting is not turned off
  t.regex(read('src/claudebridge/ClaudeBridge.java'), /s\.avoidance\.value = true;/);
});
