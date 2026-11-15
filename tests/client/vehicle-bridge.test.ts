import test from 'ava';
import fs from 'fs';
import path from 'path';

// The bridge's boats (client-mod Vehicle.java, P5c: the villager move). The Java itself is checked in scratch against the
// 26.3 jar's own boat code; here, that the calls the brain makes are registered and the rules the move leans on stay put.

const mod = path.join(process.cwd(), 'client-mod', 'src', 'claudebridge');
const read = (f: string): string => fs.readFileSync(path.join(mod, f), 'utf8');

test('the bridge registers every vehicle call, and the mod starts them', (t) => {
  const java = read('Vehicle.java');
  for (const m of ['vehicle.status', 'vehicle.place', 'vehicle.mount', 'vehicle.drive', 'vehicle.dismount', 'vehicle.take']) {
    t.true(java.includes(`s.register("${m}"`), m);
  }
  t.regex(read('ClaudeBridge.java'), /Vehicle\.register\(server\);/);
});

test('the boat is 1.375 wide, and the take never swings a sword (its sweep hurts the villager beside the boat)', (t) => {
  const java = read('Vehicle.java');
  t.regex(java, /BOAT_WIDTH = 1\.375, BOAT_HEIGHT = 0\.5625;/);
  t.regex(java, /item\.endsWith\("_sword"\)/);
  // the take's one attack, and the hand looked at again right before it (the Guardian may take a sword up meanwhile)
  const take = java.slice(java.indexOf('s.register("vehicle.take"'));
  t.is(take.split('gameMode.attack(').length - 1, 1);
  t.true(take.indexOf('if (weapon(held)') < take.indexOf('gameMode.attack('));
  // nothing else in the file attacks
  t.is(java.split('gameMode.attack(').length - 1, 1);
});

test('the bot rides and breaks only its own boats, and no boat goes down in a zone unless the village was judged free', (t) => {
  const java = read('Vehicle.java');
  for (const m of ['vehicle.mount', 'vehicle.take']) {
    const body = java.slice(java.indexOf(`s.register("${m}"`));
    t.regex(body.slice(0, body.indexOf('Ticker.add')), /if \(!ownOr\(v, strParam\(p, "uuid", null\)\)\) return obj\("ok", false/, m);
  }
  const place = java.slice(java.indexOf('s.register("vehicle.place"'), java.indexOf('s.register("vehicle.mount"'));
  t.regex(place, /boolean inVillage = flag\(p, "inVillage"\);/);
  t.regex(place, /Object first = mob != null \? beside\(level, me, mob, inVillage\) : onBlock\(level, me, at, inVillage\);/);
  // (the spot's own rules, on a block given and beside a mob, both: no boat in a zone without the judge's word)
  const fn = (name: string) => java.slice(java.indexOf(`static Object ${name}(`), java.indexOf('\n    }\n', java.indexOf(`static Object ${name}(`)));
  t.regex(fn('onBlock'), /if \(!inVillage && \(Foreign\.inZone\(at\) \|\| Foreign\.inZone\(at\.above\(\)\)\)\)/);
  t.regex(fn('besideAt'), /if \(!inVillage && \(Foreign\.inZone\(floor\) \|\| Foreign\.inZone\(floor\.above\(\)\)\)\) return "in someone's build/);
  // `for`: refused when the boat would take anyone but the villager it is for (a baby beside it)
  t.regex(fn('spotAt'), /for \(Entity e : takes\) if \(e != mob\) return "the boat would take the "/);
});

test('a boat for a villager goes down beside it, never on it: the game\'s boat item refuses a box any mob (or the bot) is in, and the bridge checks that as the game does', (t) => {
  const java = read('Vehicle.java');
  // just clear of the mob's box along one axis (boxes are square to the axes), halfway into the take's 0.2
  t.regex(java, /static double besideBy\(double mobWidth\) \{ return BOAT_WIDTH \/ 2 \+ mobWidth \/ 2 \+ TAKE_GROW \/ 2; \}/);
  t.regex(java, /new double\[\] \{ mx \+ d, mz \}, new double\[\] \{ mx - d, mz \}, new double\[\] \{ mx, mz \+ d \}, new double\[\] \{ mx, mz - d \}/);
  // the room: blocks, and what can be pushed or collided with (AbstractBoat.canVehicleCollide), the bot among them
  t.regex(java, /List<Entity> inRoom = level\.getEntities\(\(Entity\) null, box, x -> !x\.isSpectator\(\) && \(x\.isPushable\(\) \|\| x\.canBeCollidedWith\(me\)\)\);\n\s+if \(!inRoom\.isEmpty\(\)\) \{\n\s+Entity e = inRoom\.get\(0\);\n\s+return "the "/);
  // and picked again on the tick of the use, from where the mob is then
  const place = java.slice(java.indexOf('s.register("vehicle.place"'), java.indexOf('s.register("vehicle.mount"'));
  t.true(place.indexOf('Object now = beside(m.level, m.player, mob, inVillage);') > 0 && place.indexOf('Object now = beside(') < place.indexOf('m.gameMode.useItem('));
});

test('the drive ends on the brain\'s cancel, and a boat on a path or farmland goes on over its own floor (the 1/16 up onto grass still a step)', (t) => {
  const java = read('Vehicle.java');
  const drive = java.slice(java.indexOf('s.register("vehicle.drive"'), java.indexOf('s.register("vehicle.dismount"'));
  t.regex(drive, /final long cancels = Processes\.cancels;/);
  t.regex(drive, /if \(Processes\.cancels != cancels\) return end\(m, "cancelled", null\);/);
  // the counter the `cancel` call bumps, as Processes' own tickers read it
  t.regex(read('Handlers.java'), /Processes\.cancels\+\+;/);
  t.regex(java, /return p\.getY\(\) \+ shape\.max\(Direction\.Axis\.Y\) <= bottom \+ FLOOR_EPS \? Ground\.FLOOR : Ground\.SOLID;/);
  t.regex(java, /if \(at == Ground\.WATER \|\| at == Ground\.FLOOR\) return null;/);
  t.regex(drive, /decide\(b -> ground\(m\.level, b, bottom\)/);
});

test('riding, Baritone walks nowhere: its keys would steer the boat', (t) => {
  t.regex(read('DefendProcess.java'), /if \(p\.isPassenger\(\)\) \{ target = null; return false; \}/);
  // the Guardian's emergency cover gets out of the boat first (no wall goes up round a boat)
  t.regex(read('Guardian.java'), /if \(p\.isPassenger\(\)\) \{\s+Vehicle\.leave\(mc,/);
});
