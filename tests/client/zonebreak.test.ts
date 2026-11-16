import test from 'ava';
import fs from 'fs';
import path from 'path';
import { ZONE_MARGIN } from '../../src/client/brain/underyard.js';

// No path breaks ground under the yard (client-mod ZoneBreakMixin, Protection.zoneBreak). Live Nov 14 to 16 the deep trips
// from the mine start east of the yard stopped under its east edge a dozen times a day ("out from under", three iron trips
// in a row 107 below the lawn): a path searched from outside the column planned to tunnel through it, and once the bot
// stood in it Baritone could break nothing. The Java was checked against the pinned Baritone jar (javap: `b(IIIL..;)D` is
// breakCostMultiplierAt on both contexts, and its caller takes 1e6 as never); here, that the hook stays wired and its rule
// stays the one the brain digs out of.

const mod = path.join(process.cwd(), 'client-mod');
const read = (f: string): string => fs.readFileSync(path.join(mod, f), 'utf8');

test('the zone break mixin is registered and costs breaks in both of Baritone\'s contexts', (t) => {
  const mixins = JSON.parse(read('resources/claudebridge.mixins.json')) as { client: string[] };
  t.true(mixins.client.includes('ZoneBreakMixin'));
  const java = read('src/claudebridge/mixin/ZoneBreakMixin.java');
  t.regex(java, /@Mixin\(targets = \{ "baritone\.ca", "baritone\.dt\$a" \}, remap = false\)/);
  // at the head (the arguments as given), cancellable, and never required: another Baritone build leaves pathing as it was
  t.regex(java, /method = "b\(IIILnet\/minecraft\/world\/level\/block\/state\/BlockState;\)D", at = @At\("HEAD"\), cancellable = true,\s+require = 0/);
  t.regex(java, /if \(Protection\.zoneBreak\(x, y, z, current\)\) cir\.setReturnValue\(Protection\.COST_INF\);/);
});

test('a path breaks no ground in the column the brain digs out of, and the lifts still lift it', (t) => {
  const java = read('src/claudebridge/Protection.java');
  const fn = java.slice(java.indexOf('public static boolean zoneBreak('), java.indexOf('private static boolean zoneForbids('));
  t.true(fn.length > 0);
  // the same column at any depth: the place's x and z only, its margin the one underyard.ts tunnels past
  t.regex(fn, /!nearZone\(x, z\)/);
  t.regex(java, new RegExp(`private static final int ZONE_MARGIN = ${ZONE_MARGIN};`));
  // ground and ore only (the yard's trees and the bot's own blocks are the other rules'), not while suspended, not a narrow lift's kind
  t.regex(fn, /suspended > 0/);
  t.regex(fn, /GROUND\.contains\(b\) && !only\.contains\(b\)/);
  // the rectangle and the circle as the kind rule and the miner's filter read them
  t.regex(java, /static boolean nearZone\(BlockPos p\) \{ return nearZone\(p\.getX\(\), p\.getZ\(\)\); \}/);
});
