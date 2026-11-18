import test from 'ava';
import fs from 'fs';
import path from 'path';
import { BREW_TICKS, BREWS_PER_POWDER, brewStandText, type BrewStatus } from '../../src/client/tools.js';
import { isHazard, unsafeInHand } from '../../src/client/brain/fluidpick.js';

// The bridge's brewing stand (client-mod Brewing.java, P4) and the glass bottle filled at water (Interact.java useOn,
// ServerWord.bottleVerdict). The Java is checked in scratch against the 26.3 jar (BrewingCheck: the slot numbers and
// the fuel and brew numbers are the jar's own BrewingStandBlockEntity and BrewingStandMenu constants, the seven
// recipes of the three long potions are in its data, BottleItem acts only through use(); the put, take and verdict
// rules case by case); here, that the calls the brain makes are registered and the rules the batches lean on stay put.

const mod = path.join(process.cwd(), 'client-mod', 'src', 'claudebridge');
const read = (f: string): string => fs.readFileSync(path.join(mod, f), 'utf8');
const body = (java: string, call: string): string => {
  const at = java.indexOf(`s.register("${call}"`);
  const next = java.indexOf('s.register("', at + 10);
  return java.slice(at, next < 0 ? undefined : next);
};
const num = (java: string, name: string): number => Number(new RegExp(`\\b${name} = (\\d+)`).exec(java)?.[1]);

test('the bridge registers every brewing call, and the mod starts them', (t) => {
  const java = read('Brewing.java');
  for (const m of ['brew.open', 'brew.status', 'brew.put', 'brew.take', 'brew.close']) t.true(java.includes(`s.register("${m}"`), m);
  t.regex(read('ClaudeBridge.java'), /Brewing\.register\(server\);/);
});

test('the stand\'s slots are the 26.3 menu\'s: bottles 0-2, the ingredient 3, the fuel 4, the pockets after them', (t) => {
  const java = read('Brewing.java');
  t.is(num(java, 'BOTTLES'), 3);
  t.is(num(java, 'INGREDIENT'), 3);
  t.is(num(java, 'FUEL'), 4);
  t.is(num(java, 'OWN_SLOTS'), 5);
  // the TS side's numbers are the bridge's (and the jar's, checked in scratch)
  t.is(num(java, 'BREW_TICKS'), BREW_TICKS);
  t.is(num(java, 'USES_PER_POWDER'), BREWS_PER_POWDER);
  // the pockets in the menu: the player's slots after the stand's five
  t.regex(body(java, 'brew.put'), /Interact\.containerMenuSlot\(OWN_SLOTS, i\)/);
});

test('a put checks the stand\'s own rule and the brew before any click, and picks a potion by its contents', (t) => {
  const put = body(read('Brewing.java'), 'brew.put');
  const refused = put.indexOf('if (why != null) throw');
  t.true(refused > 0 && refused < put.indexOf('click('), 'refused before anything moves');
  // the menu's slot rule (the recipes the server synced), not a list of names of our own
  t.regex(put, /menu\.getSlot\(target\)\.mayPlace\(source\)/);
  // with `potion`, a stack of the name with other contents is not taken (four kinds share 'potion')
  t.regex(put, /return want == null \|\| want\.equals\(contents\(st\)\) \? name : null;/);
  // a bottle slot takes one
  t.regex(put, /int count = target < BOTTLES \? 1 :/);
  // whatever else the slot held goes back first, never under a brew (refusal: "brewing: the ... slot holds")
  t.true(put.indexOf('ContainerInput.QUICK_MOVE') > refused);
  t.regex(read('Brewing.java'), /if \(brewing && !same\) return "brewing: the "/);
});

test('a take is refused under a brew unless forced, and needs a pocket for each bottle', (t) => {
  const take = body(read('Brewing.java'), 'brew.take');
  t.regex(take, /if \(left > 0 && !flag\(p, "force"\)\) throw/);
  t.regex(take, /if \(freePockets\(pl\) < Math\.max\(1, bottles\)\) throw/);
  t.true(take.indexOf('throw') < take.indexOf('ContainerInput.QUICK_MOVE'));
  // what came into the pockets is reported with its contents (withDetail: `potion`)
  t.regex(take, /Handlers\.withDetail\(obj\("name", Names\.item\(now\), "count", gained, "slot", k\), now\)/);
});

test('the close shuts only a brewing stand\'s menu and hands nothing back (the stand brews on)', (t) => {
  const close = body(read('Brewing.java'), 'brew.close');
  t.regex(close, /boolean was = pl\.containerMenu instanceof BrewingStandMenu;/);
  t.regex(close, /if \(was\) pl\.closeContainer\(\);/);
  t.notRegex(close, /QUICK_MOVE/);
});

test('useOn aims a glass bottle at the water as it aims an empty bucket, and judges it by the server\'s word', (t) => {
  const java = read('Interact.java');
  const useOn = body(java, 'useOn');
  // the steady pose and the aim of the bucket: the bottle's use traces from the server's eye the same way
  t.regex(useOn, /boolean isBucket = !toggle && ServerWord\.aimsAtFluid\(Names\.item\(m\.player\.getMainHandItem\(\)\)\);/);
  t.regex(useOn, /aimAt = held\.equals\("bucket"\) \|\| bottle \? new Vec3\(at\.getX\(\) \+ 0\.5, at\.getY\(\) \+ 0\.85, at\.getZ\(\) \+ 0\.5\) : hit;/);
  t.regex(useOn, /r\.addProperty\("bottle", ServerWord\.bottleVerdict\(/);
  const word = read('ServerWord.java');
  t.regex(word, /static boolean aimsAtFluid\(String item\) \{\s+return Hazards\.isBucket\(item\) \|\| isBottle\(item\);/);
  t.regex(word, /static boolean isBottle\(String item\) \{\s+return "glass_bottle"\.equals\(item\);/);
  // the water bottles counted are potions of water only, over the whole inventory (a fill from a stack lands elsewhere)
  t.regex(word, /pc\.is\(net\.minecraft\.world\.item\.alchemy\.Potions\.WATER\)/);
});

test('a glass bottle is no hazard: the guard lets it through and the walks may carry it in hand', (t) => {
  // Hazards.isHazard (Java) and fluidpick.isHazard (the brain) agree: full buckets and fire starters only
  t.false(isHazard('glass_bottle'));
  t.false(unsafeInHand('glass_bottle'));
  t.false(isHazard('potion'));
  t.notRegex(read('Hazards.java'), /glass_bottle/);
});

test('brewStandText says what a stand holds by contents, the powder left and the brew\'s seconds', (t) => {
  const st: BrewStatus = {
    open: true, at: { x: -545, y: 63, z: 2155 },
    bottles: [{ name: 'potion', count: 1, potion: 'water' }, { name: 'potion', count: 1, potion: 'awkward' }, null],
    ingredient: { name: 'magma_cream', count: 2 }, fuel: { name: 'blaze_powder', count: 5 },
    fuelUses: 19, brewing: true, brewTicks: 270, totalBrewTicks: 400, freePockets: 9
  };
  t.is(brewStandText(st), 'bottles: water potion, awkward potion, empty; ingredient: magma_cream x2; fuel: blaze_powder x5 (19 brews left in the burning powder); brewing, 14 s to go');
  t.is(brewStandText({ open: true, bottles: [null, null, null], ingredient: null, fuel: null, fuelUses: 0, brewing: false, brewTicks: 0 }),
    'bottles: empty, empty, empty; ingredient: empty; fuel: empty; not brewing');
  t.is(brewStandText({ open: true, bottles: [null, null, null], fuelUses: 1 }), 'bottles: empty, empty, empty; ingredient: empty; fuel: empty (1 brew left in the burning powder); not brewing');
  t.is(brewStandText({ open: false }), 'not open');
});
