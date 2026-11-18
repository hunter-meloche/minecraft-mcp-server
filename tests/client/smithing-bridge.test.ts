import test from 'ava';
import fs from 'fs';
import path from 'path';
import { NETHERITE_INGOT, NETHERITE_TEMPLATE, netheriteOf, smithingText, smithTableText, type SmithStatus } from '../../src/client/tools.js';

// The bridge's smithing table (client-mod Smithing.java, P6). The Java is checked in scratch against the 26.3 jar
// (SmithingCheck: the slot numbers are SmithingMenu's own TEMPLATE_SLOT, BASE_SLOT, ADDITIONAL_SLOT and RESULT_SLOT;
// the four netherite_<piece>_smithing recipes take the upgrade template, the diamond piece and #netherite_tool_materials,
// which holds netherite_ingot alone; SmithingTransformRecipe.assemble keeps the base's components, so the enchantments
// carry over; the put's wait, the refusals and the take's expect case by case); here, that the calls the brain makes
// are registered and the rules the milestone leans on stay put.

const mod = path.join(process.cwd(), 'client-mod', 'src', 'claudebridge');
const read = (f: string): string => fs.readFileSync(path.join(mod, f), 'utf8');
const body = (java: string, call: string): string => {
  const at = java.indexOf(`s.register("${call}"`);
  const next = java.indexOf('s.register("', at + 10);
  return java.slice(at, next < 0 ? undefined : next);
};
const num = (java: string, name: string): number => Number(new RegExp(`\\b${name} = (\\d+)`).exec(java)?.[1]);

test('the bridge registers every smithing call, and the mod starts them', (t) => {
  const java = read('Smithing.java');
  for (const m of ['smith.open', 'smith.status', 'smith.put', 'smith.take', 'smith.close']) t.true(java.includes(`s.register("${m}"`), m);
  t.regex(read('ClaudeBridge.java'), /Smithing\.register\(server\);/);
});

test('the table\'s slots are the 26.3 menu\'s: the template 0, the base 1, the addition 2, the result 3, the pockets after them', (t) => {
  const java = read('Smithing.java');
  t.regex(java, /TEMPLATE = 0, BASE = 1, ADDITION = 2, RESULT = 3, OWN_SLOTS = 4;/);
  // the pockets in the menu: the player's slots after the table's four
  t.regex(body(java, 'smith.put'), /Interact\.containerMenuSlot\(OWN_SLOTS, i\)/);
  // a put names its slot as the brain does: template, base, addition (not the anvil's input and additional)
  t.regex(java, /case "template" -> TEMPLATE;\s+case "base" -> BASE;\s+case "addition" -> ADDITION;/);
  t.is(num(java, 'RESULT_TICKS'), 20);
});

test('a put checks the table\'s own rule before any click, picks the piece by its slot, and waits for the server\'s result', (t) => {
  const put = body(read('Smithing.java'), 'smith.put');
  const refused = put.indexOf('if (why != null) throw');
  t.true(refused > 0 && refused < put.indexOf('click('), 'refused before anything moves');
  // the menu's slot rule (the recipe property sets the server synced), not a list of names of our own
  t.regex(put, /refusal\(target, name, menu\.getSlot\(target\)\.mayPlace\(inv\.getItem\(i\)\)\)/);
  // of several by the name, the one at `slot` (the piece armor.unequip took off, not a spare), before and after the
  // clearing; that slot and no other: a piece the Guardian wore again leaves the slot empty, and a spare of its name
  // (a fire-protection one, a cursed one) must not take its place (SlotCheck in scratch: source case by case)
  t.is(put.match(/source\(k -> Interact\.nameOf\(inv\.getItem\(k\)\), name, asked\)/g)?.length, 2);
  t.false(put.includes('Interact.pick('), 'no fall back to another of the name');
  const java = read('Smithing.java');
  t.regex(java, /if \(asked >= 0 && asked < 36\) return name\.equals\(nameAt\.apply\(asked\)\) \? asked : -1;/);
  // (still "no <name> in inventory": the milestone reads it as the piece gone back on)
  t.regex(java, /return "no " \+ name \+ " in inventory" \+ \(asked >= 0 && asked < 36 \? " slot " \+ asked : ""\);/);
  // whatever the slot held goes back first
  t.true(put.indexOf('ContainerInput.QUICK_MOVE') > refused);
  // the game client's menu has no recipes: the result (or the server's "no recipe") is waited for once all three are in
  t.regex(put, /answered\(age, stable, all, !r\.isEmpty\(\) \|\| mm\.hasRecipeError\(\)\)/);
  t.regex(read('Smithing.java'), /if \(!all\) return \(age >= 3 && stable >= 2\) \|\| age >= 10;\s+return \(age >= MIN_FULL_TICKS && stable >= 2 && shown\) \|\| age >= RESULT_TICKS;/);
});

test('a take checks the result is the one asked for before the click, and reports the piece with its enchantments', (t) => {
  const take = body(read('Smithing.java'), 'smith.take');
  const click = take.indexOf('click(menu, RESULT, 0, ContainerInput.QUICK_MOVE)');
  t.true(click > 0);
  for (const rule of ['if (wrong != null) throw', 'if (freePockets(pl) == 0) throw', 'if (result.isEmpty())']) {
    const k = take.indexOf(rule);
    t.true(k > 0 && k < click, rule);
  }
  // the server's word, half a second on: the piece in the pockets and the result slot empty
  t.regex(take, /boolean taken = slot >= 0 && !stillThere;/);
  t.regex(take, /if \(age < 10 \|\| \(!taken && age < 30\)\) return false;/);
  t.regex(take, /r\.add\("enchantments", Enchanting\.enchantments\(result\)\);/);
  t.regex(take, /r\.addProperty\("from", from\);/);
});

test('the close shift-clicks an untaken job back into the pockets, closes, then wears a piece taken off for it again', (t) => {
  const close = body(read('Smithing.java'), 'smith.close');
  const moved = close.search(/new int\[\] \{ TEMPLATE, BASE, ADDITION \}\) if \(!menu\.getSlot\(k\)\.getItem\(\)\.isEmpty\(\)\) click\(menu, k, 0, ContainerInput\.QUICK_MOVE\);/);
  t.true(moved > 0, 'the three inputs shift-clicked out');
  t.true(moved < close.indexOf('pl.closeContainer()') && close.indexOf('pl.closeContainer()') < close.indexOf('Guardian.wearHeldAgain(pl, "smithing table")'), 'out, then closed, then worn');
  // the smithing table's menu only: a late close must not shut the chest the next job has open
  t.regex(close, /if \(pl\.containerMenu instanceof SmithingMenu menu\)/);
});

test('the netherite piece outranks the diamond one, so the Guardian puts the smithed piece on', (t) => {
  const combat = read('Combat.java');
  const tier = (k: string) => Number(new RegExp(`"${k}", (\\d+)`).exec(combat.slice(combat.indexOf('ARMOR_TIER')))?.[1]);
  t.true(tier('netherite') > tier('diamond'));
});

test('netheriteOf: what the upgrade makes of a diamond piece, nothing of anything else', (t) => {
  t.is(netheriteOf('diamond_chestplate'), 'netherite_chestplate');
  t.is(netheriteOf('diamond_leggings'), 'netherite_leggings');
  t.is(netheriteOf('diamond_boots'), 'netherite_boots');
  t.is(netheriteOf('diamond_helmet'), 'netherite_helmet');
  t.is(netheriteOf('diamond_pickaxe'), 'netherite_pickaxe');
  // the golden Nether helmet stays gold (the piglins' rule), and a netherite piece is done
  t.is(netheriteOf('golden_helmet'), undefined);
  t.is(netheriteOf('netherite_chestplate'), undefined);
  t.is(netheriteOf('diamond'), undefined);
  t.is(NETHERITE_TEMPLATE, 'netherite_upgrade_smithing_template');
  t.is(NETHERITE_INGOT, 'netherite_ingot');
});

test('smithingText is the plan\'s log line: the pieces and the enchantments kept, a lost one named', (t) => {
  const kept = [{ name: 'protection', level: 4 }, { name: 'unbreaking', level: 3 }, { name: 'mending', level: 1 }];
  t.is(smithingText({ from: 'diamond_chestplate', item: 'netherite_chestplate', enchantments: kept }, kept),
    'diamond_chestplate -> netherite_chestplate (protection 4, unbreaking 3, mending kept)');
  t.is(smithingText({ from: 'diamond_boots', item: 'netherite_boots', enchantments: [] }), 'diamond_boots -> netherite_boots (no enchantments to keep)');
  t.is(smithingText({ from: 'diamond_leggings', item: 'netherite_leggings', enchantments: [{ name: 'protection', level: 4 }] }, [{ name: 'protection', level: 4 }, { name: 'thorns', level: 3 }]),
    'diamond_leggings -> netherite_leggings (protection 4 kept; lost thorns 3)');
});

test('smithTableText says what the table holds and why there is no result', (t) => {
  const st: SmithStatus = {
    open: true, template: { name: NETHERITE_TEMPLATE, count: 1 }, base: { name: 'diamond_chestplate', count: 1, enchantments: [{ name: 'protection', level: 4 }, { name: 'mending', level: 1 }] },
    addition: { name: 'netherite_ingot', count: 1 }, result: { name: 'netherite_chestplate', count: 1, enchantments: [{ name: 'protection', level: 4 }, { name: 'mending', level: 1 }] }, noRecipe: false
  };
  t.is(smithTableText(st), 'template: netherite_upgrade_smithing_template; base: diamond_chestplate (protection 4, mending); addition: netherite_ingot; result: netherite_chestplate (protection 4, mending)');
  t.is(smithTableText({ open: true, template: { name: 'diamond', count: 3 }, base: { name: 'diamond_chestplate', count: 1 }, addition: { name: 'netherite_ingot', count: 1 }, result: null, noRecipe: true }),
    'template: diamond x3; base: diamond_chestplate; addition: netherite_ingot; result: none (no recipe takes these)');
  t.is(smithTableText({ open: true }), 'template: empty; base: empty; addition: empty; result: none');
  t.is(smithTableText({ open: false }), 'not open');
});
