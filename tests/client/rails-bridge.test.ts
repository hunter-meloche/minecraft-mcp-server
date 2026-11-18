import test from 'ava';
import fs from 'fs';
import path from 'path';

// The bridge's rails and minecart (client-mod Rails.java, P5e: the rails home). The Java is checked in scratch against the
// 26.3 jar's own RailState, rail blocks and torch (RailsBridgeCheck: the port below matches the jar on 127k random
// placements, a planned line laid either way comes out as planned, torches light 9, taking up turns no rail); here, that
// the calls the brain makes are registered and the rules the line leans on stay put.

const mod = path.join(process.cwd(), 'client-mod', 'src', 'claudebridge');
const read = (f: string): string => fs.readFileSync(path.join(mod, f), 'utf8');
const body = (java: string, call: string): string => {
  const at = java.indexOf(`s.register("${call}"`);
  const next = java.indexOf('s.register("', at + 10);
  return java.slice(at, next < 0 ? undefined : next);
};

test('the bridge registers every rails call, and the mod starts them', (t) => {
  const java = read('Rails.java');
  for (const m of ['rail.place', 'rail.torch', 'cart.place', 'cart.status', 'cart.watch']) t.true(java.includes(`s.register("${m}"`), m);
  t.regex(read('ClaudeBridge.java'), /Rails\.register\(server\);/);
});

test('a rail is looked at on the port before it goes down, and refused when it would turn a rail the bot did not lay', (t) => {
  const place = body(read('Rails.java'), 'rail.place');
  const judged = place.indexOf('Judged j = judge(');
  t.true(judged > 0 && judged < place.indexOf('useThen('));
  t.regex(place, /if \(e\.getKey\(\) != at\.asLong\(\) && !Protection\.isOwn\(q\)\)/);
  // a slope with nothing to rise onto would drop
  t.regex(place, /!Block\.canSupportRigidBlock\(level, q\.offset\(up\[0\], 0, up\[1\]\)\)/);
  // nothing in someone's build but a village the judge found free
  t.regex(place, /if \(!inVillage && \(Foreign\.inZone\(at\) \|\| Foreign\.inZone\(below\)\)\)/);
  t.regex(body(read('Rails.java'), 'rail.torch'), /if \(!inVillage && \(Foreign\.inZone\(at\) \|\| Foreign\.inZone\(below\)\)\)/);
  t.regex(body(read('Rails.java'), 'cart.place'), /if \(!inVillage && Foreign\.inZone\(at\)\)/);
  // the dry run returns before anything is used
  t.true(place.indexOf('"dryRun"') < place.indexOf('useThen('));
});

test('the port is RailState\'s: the shapes a placement can take, and the order of its curve and slope checks', (t) => {
  const java = read('Rails.java');
  // the item's shape: east_west only while facing east or west
  t.regex(java, /static String placedShape\(boolean facingEastWest\) \{ return facingEastWest \? "east_west" : "north_south"; \}/);
  // a neighbour that has two connections already (and none to this) takes no third
  t.regex(java, /boolean canConnectTo\(State o\) \{ return connectsTo\(o\) \|\| conns\.size\(\) != 2; \}/);
  // a powered rail is straight only: no curve
  t.regex(java, /if \(!straight\) \{\s+if \(se && !n && !w\) to = "south_east";/);
  // RailState's own fallback when nothing turned it: the placement's shape (connectTo's: north_south)
  t.regex(java, /if \(to == null\) to = current;/);
  t.regex(java, /if \(to == null\) to = "north_south";/);
});

test('a torch stands on a block\'s top (never on a wall, which lights what the plan does not), and is checked lit', (t) => {
  const torch = body(read('Rails.java'), 'rail.torch');
  t.regex(torch, /Block\.canSupportCenter\(level, below, Direction\.UP\)/);
  t.regex(read('Rails.java'), /return new BlockHitResult\(hit, Direction\.UP, below, false\);/);
  t.regex(torch, /if \(reason == null && !powered\(m\.level\.getBlockState\(lights\)\)\) reason = "the rail at "/);
});

test('the cart: refused under the minecart_improvements experiment unless asked, never two on one rail, and the bot\'s own', (t) => {
  const java = read('Rails.java');
  const cart = body(java, 'cart.place');
  t.regex(java, /static boolean newMovement\(Level level\) \{ return AbstractMinecart\.useExperimentalMovement\(level\); \}/);
  t.regex(cart, /if \(fresh && !\(p\.has\("newMovement"\) && p\.get\("newMovement"\)\.getAsBoolean\(\)\)\)/);
  t.regex(cart, /a minecart on that rail already/);
  t.regex(cart, /Vehicle\.adopt\(cart\.getUUID\(\)\);/);
  t.regex(read('Vehicle.java'), /static void adopt\(UUID uuid\) \{ OWN\.add\(uuid\); \}/);
  // the take speed: 0.1 a tick on the old rules (OldMinecartBehavior: horizontalDistanceSqr >= 0.01)
  t.regex(java, /static final double TAKE_SPEED = 0\.1;/);
  // nothing in the rails file hits anything (a cart is broken back by vehicle.take, the one attack the bridge's vehicles make)
  t.is(java.split('gameMode.attack(').length - 1, 0);
});

test('the watch ends on the brain\'s cancel and on a death, and says who got in', (t) => {
  const watch = body(read('Rails.java'), 'cart.watch');
  t.regex(watch, /if \(Processes\.cancels != cancels\) return end\(m, "cancelled", null\);/);
  t.regex(watch, /if \(Events\.deaths\(\) != deaths\) return end\(m, "died", null\);/);
  t.regex(watch, /if \(!took\.isEmpty\(\) && !until\.equals\("rest"\)\) return end\(m, "took", took\);/);
});
