import test from 'ava';
import type { ChestStack, InventoryItem, ItemEnchantment } from '../../src/client/tools.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import { key, remember, type SpareSet } from '../../src/client/brain/chests.js';
import { better, carriedKit, fireProtected, stashPlan } from '../../src/client/brain/kit.js';
import {
  FIRE_EPF, FIRE_EPF_NEEDED, NETHER_HELMET, NETHER_HELMET_WANTED, dressedFireGear, fireEpf, fireGear, homeSetGoal, homeSetWant, isNetherPiece, mainRank,
  netherGearLine, netherHelmetMissing, netherHelmetPiece, storedNetherHelmets, wearNetherHelmet, wornOver
} from '../../src/client/brain/netherset.js';
import {
  FIRE_OFFER_FROM, NETHER_BOOK_PILE, NETHER_REROLLS, enchantGoal, enchantPick, fireOffer, mainOffer, netherTableJob, plainLeft
} from '../../src/client/brain/enchant.js';
import { GOLD_KEPT, WANTED, anvilGoal, anvilPlan, bookOfUse, describe, wantedFor } from '../../src/client/brain/anvil.js';
import { GOLD_RESERVE } from '../../src/client/brain/netherbarter.js';
import { regearPieces } from '../../src/client/brain/regear.js';
import { NETHER, OVERWORLD, NETHER_STOCK, netherOf } from '../../src/client/brain/nether.js';
import { NETHER_TRIP } from '../../src/client/brain/mine.js';
import { fetchSetupKit } from '../../src/client/brain/nethersetup.js';
import { out as afield } from '../../src/client/brain/pockets.js';
import { kit } from '../../src/client/brain/chores.js';
import { T0, lookAt } from '../helpers/homestead.js';
import { game, setupWorld } from '../helpers/netherworld.js';

// ------------------------------------------------------------------------------------------------ the pieces

const en = (s: string): ItemEnchantment[] => s.split(', ').map(x => { const [name, l] = x.split(' '); return { name, level: Number(l) }; });
const piece = (slot: number, name: string, ench?: string, over: Partial<InventoryItem> = {}): InventoryItem =>
  ({ slot, name, count: 1, ...(ench ? { enchanted: true, enchantments: en(ench) } : {}), ...over });

/** The main set worn as it stood live on Nov 14 (all protection), and its tools. */
const MAIN = (): InventoryItem[] => [
  piece(0, 'diamond_sword', 'unbreaking 3'), piece(1, 'diamond_pickaxe', 'fortune 3, unbreaking 3'), { slot: 13, name: 'lapis_lazuli', count: 7 },
  piece(36, 'diamond_boots', 'protection 4, depth_strider 3, unbreaking 3'), piece(37, 'diamond_leggings', 'protection 3, unbreaking 3'),
  piece(38, 'diamond_chestplate', 'protection 3, unbreaking 3, thorns 2'), piece(39, 'diamond_helmet', 'protection 4, unbreaking 3')
];
/** The main set with protection 4 on every piece, as the anvil makes it. */
const MAIN4 = (): InventoryItem[] => MAIN().map(i => (i.slot >= 36 ? { ...i, enchantments: en('protection 4, unbreaking 3, mending 1') } : i));
/** The Nether helmet as the table and the anvil make it. */
const HELMET = (slot: number, ench = 'fire_protection 4, unbreaking 3') => piece(slot, 'golden_helmet', ench);
/** The old diamond Nether set's pieces (made until Nov 18), as they lie in the chests live. */
const OLD = {
  chestplate: (slot: number) => piece(slot, 'diamond_chestplate', 'fire_protection 3, unbreaking 3'),
  leggings: (slot: number) => piece(slot, 'diamond_leggings', 'fire_protection 1'),
  boots: (slot: number) => piece(slot, 'diamond_boots', 'fire_protection 4, feather_falling 4, unbreaking 3')
};
/** The worn pieces with the helmet in place of the one worn. */
const withHelmet = (items: InventoryItem[], h?: InventoryItem) => [...items.filter(i => i.slot !== 39), ...(h ? [{ ...h, slot: 39 }] : [])];

const GEAR: Pos = { x: -547, y: 64, z: 2182 };
const BOOKS: Pos = { x: -551, y: 65, z: 2179 };
const TABLE: Pos = { x: -547, y: 63, z: 2209 };
const ANVIL: Pos = { x: -544, y: 63, z: 2154 };

/** The spare set as the portal milestone stored it: plain, in slots 20 to 23 of the gear chest. */
const SPARES: ChestStack[] = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'].map((name, i) => ({ slot: 20 + i, name, count: 1 }));
const spareRecord = (): SpareSet => ({ pieces: SPARES.map(p => ({ name: p.name, chest: { ...GEAR }, slot: p.slot })), at: T0 - 60_000 });

function homeWorld(chests: Record<string, ChestStack[]>, over: Partial<WorldMemory> = {}): WorldMemory {
  const w = {
    landmarks: { chests: [GEAR, BOOKS], farmland: [] }, leash: 96, chestAssign: { [key(GEAR)]: 'gear', [key(BOOKS)]: 'misc' },
    zones: { 'enchanting:table': [TABLE], 'workshop:anvil': [ANVIL] }, nether: { trips: true },
    progress: { done: ['workshop', 'enchanting', 'nether-portal'], blocked: {} }, spareSet: spareRecord(), ...over
  } as unknown as WorldMemory;
  for (const c of w.landmarks.chests) {
    const stacks = chests[key(c)] ?? [];
    const totals: Record<string, number> = {};
    for (const st of stacks) totals[st.name] = (totals[st.name] ?? 0) + st.count;
    remember(w, c, totals, stacks.map(st => ({ ...st })), 27 - stacks.length, 27);
  }
  return w;
}

test('the Nether gear\'s pieces: the golden helmet the one swapped (plain or not), made by its fire protection; it wants fire protection 4, the main set keeps its protection 4; an old diamond fire protection piece below the main one of its tier at home', (t) => {
  t.is(NETHER_HELMET, 'golden_helmet');
  t.true(isNetherPiece(HELMET(4)));
  t.true(isNetherPiece(piece(4, 'golden_helmet')), 'a plain golden helmet is the one worn down there all the same');
  t.false(isNetherPiece(OLD.chestplate(4)), 'an old diamond Nether set piece is no Nether piece any more');
  t.false(isNetherPiece(MAIN()[3]));
  t.true(netherHelmetPiece(HELMET(4)));
  t.false(netherHelmetPiece(piece(4, 'golden_helmet')), 'plain: the table\'s still');
  t.false(netherHelmetPiece(piece(4, 'diamond_helmet', 'fire_protection 4')), 'a diamond helmet is never worn down there: the golden one is (Nether.helmetRank)');
  t.deepEqual({ ...NETHER_HELMET_WANTED }, { fire_protection: 4, unbreaking: 3, mending: 1 });
  t.false('protection' in NETHER_HELMET_WANTED, 'protection and fire protection exclude each other');
  t.false('respiration' in NETHER_HELMET_WANTED, 'no water down there');
  t.is(WANTED.chestplate.protection, 4, 'the main set keeps its protection 4');
  t.is(WANTED.boots.protection, 4);
  t.false('fire_protection' in WANTED.chestplate);
  // the kit at home: the main piece is the best of its kind, whatever the levels (the Guardian's Combat.setRank)
  const fp = piece(5, 'diamond_chestplate', 'fire_protection 4, unbreaking 3, mending 1, thorns 3');
  t.true(fireProtected(fp));
  t.true(better(MAIN()[5], fp) < 0, 'the main chestplate first');
  t.is(carriedKit([...MAIN(), fp]).best.chestplate?.slot, 38);
  t.true(better(fp, piece(6, 'iron_chestplate', 'protection 4')) < 0, 'still above a piece of the tier below');
  // and the stash at home puts the old piece away, by its slot, never the main one
  const plan = stashPlan([...MAIN(), fp]);
  t.deepEqual(plan.deposit.filter(d => /chestplate/.test(d.name)), [{ name: 'diamond_chestplate', count: 1, slot: 5 }]);
});

test('the fire gear rule (26.3: protection 1 EPF a level, fire protection 2 against fire, a cap of 20): the fire protection 4 golden helmet over three protection 4 pieces is 20; fire protection 3 is 18, a plain golden helmet 12; every main piece worn, of diamond, sound', (t) => {
  t.deepEqual({ ...FIRE_EPF }, { protection: 1, fire_protection: 2 });
  t.is(FIRE_EPF_NEEDED, 20);
  t.is(fireEpf(HELMET(0)), 8);
  t.is(fireEpf(MAIN4()[3]), 4);
  t.is(fireEpf(OLD.chestplate(0)), 6);
  t.is(fireEpf(piece(0, 'diamond_sword', 'sharpness 5')), 0);
  t.is(fireEpf(undefined), 0);
  // the rule's cases
  t.deepEqual(fireGear(withHelmet(MAIN4(), HELMET(39))), { epf: 20, ok: true, missing: [] });
  t.deepEqual(fireGear(withHelmet(MAIN4(), HELMET(39, 'fire_protection 4, unbreaking 3, mending 1'))), { epf: 20, ok: true, missing: [] });
  t.deepEqual(fireGear(withHelmet(MAIN4(), HELMET(39, 'fire_protection 3, unbreaking 3'))),
    { epf: 18, ok: false, missing: ['fire EPF 18 < 20 (the golden_helmet has fire_protection 3 (4 wanted))'] });
  t.deepEqual(fireGear(withHelmet(MAIN4(), piece(39, 'golden_helmet'))),
    { epf: 12, ok: false, missing: ['fire EPF 12 < 20 (the golden_helmet has fire_protection 0 (4 wanted))'] });
  t.deepEqual(fireGear(MAIN4()), { epf: 16, ok: false, missing: ['fire EPF 16 < 20 (no golden_helmet (the diamond_helmet worn))'] });
  // the helmet given in place of the one worn (the look before the swap)
  t.deepEqual(fireGear(MAIN4(), HELMET(5)), { epf: 20, ok: true, missing: [] });
  // the main pieces short of protection 4 said
  t.deepEqual(fireGear(withHelmet(MAIN(), HELMET(39))).missing,
    ['fire EPF 18 < 20 (the diamond_chestplate has protection 3 (4 wanted); the diamond_leggings has protection 3 (4 wanted))']);
  // a main piece: worn out, below diamond, or none (EPF 20 or not)
  const worn = MAIN4().map(i => (i.slot === 38 ? { ...i, damage: 520, maxDamage: 528 } : i));
  t.deepEqual(fireGear(withHelmet(worn, HELMET(39))), { epf: 20, ok: false, missing: ['the diamond_chestplate worn is worn out'] });
  const iron = MAIN4().map(i => (i.slot === 37 ? { ...i, name: 'iron_leggings' } : i));
  t.deepEqual(fireGear(withHelmet(iron, HELMET(39))).missing, ['the iron_leggings worn is below diamond']);
  const bare = withHelmet(MAIN4().filter(i => i.slot !== 36), HELMET(39));
  t.deepEqual(fireGear(bare), { epf: 16, ok: false, missing: ['fire EPF 16 < 20', 'no boots worn'] });
  // an old diamond fire protection piece worn counts what it gives (fire protection 3: 6)
  t.deepEqual(fireGear(withHelmet(MAIN4().map(i => (i.slot === 38 ? OLD.chestplate(38) : i)), HELMET(39))), { epf: 22, ok: true, missing: [] });
});

test('the fire gear dressed for the Nether: the best golden helmet carried, worn or in the chests (not the spare set\'s) in place of the main helmet; brain-status says it', (t) => {
  const w = homeWorld({ [key(GEAR)]: [HELMET(5), ...SPARES] });
  t.like(dressedFireGear(MAIN4(), w), { epf: 20, ok: true });
  t.is(netherGearLine(MAIN4(), w), 'Nether gear: fire EPF 20 of 20 dressed for it (golden_helmet (fire_protection 4, unbreaking 3) over the main set); the fortress and the tunnel may go.');
  // a plain one carried (the kit's) and the made one in the chest: the made one counts
  t.like(dressedFireGear([...MAIN4(), piece(30, 'golden_helmet')], w), { epf: 20, ok: true });
  // fire protection 3 the best: 18, said
  const w3 = homeWorld({ [key(GEAR)]: [HELMET(5, 'fire_protection 3'), piece(6, 'golden_helmet'), ...SPARES] });
  t.like(dressedFireGear(MAIN4(), w3), { epf: 18, ok: false });
  t.is(netherGearLine(MAIN4(), w3), 'Nether gear: fire EPF 18 of 20 dressed for it (golden_helmet (fire_protection 3) over the main set); short: fire EPF 18 < 20 (the golden_helmet has fire_protection 3 (4 wanted)).');
  // no golden helmet at all: the main helmet worn counts (16)
  const none = homeWorld({ [key(GEAR)]: [...SPARES] });
  t.is(netherGearLine(MAIN4(), none), 'Nether gear: fire EPF 16 of 20 dressed for it (no golden_helmet over the main set); short: fire EPF 16 < 20 (no golden_helmet (the diamond_helmet worn)).');
  // the old diamond pieces in the chests count for nothing: the main set is what is worn
  const old = homeWorld({ [key(GEAR)]: [OLD.chestplate(2), OLD.leggings(3), OLD.boots(4), piece(6, 'golden_helmet'), ...SPARES] });
  t.like(dressedFireGear(MAIN4(), old), { epf: 12, ok: false });
});

test('the Nether helmet made and kept apart: the table\'s job is the plain golden helmet (carried, or in a chest outside the spare set\'s slots), only while none with fire protection is there; nothing made from diamonds, no diamond piece', (t) => {
  const w = homeWorld({ [key(GEAR)]: [OLD.chestplate(4), ...SPARES, { slot: 9, name: 'diamond', count: 300 }] });
  const s = lookAt([...MAIN(), piece(30, 'golden_helmet')], 1000, { xpLevel: 45 });
  t.true(netherHelmetMissing(s.items, w));
  t.deepEqual(storedNetherHelmets(w), [], 'the old diamond chestplate is no Nether helmet');
  t.deepEqual(netherTableJob(s, w), { kind: 'helmet', name: 'golden_helmet', from: 'carried', slot: 30 });
  // a plain one lying in the chest is taken instead
  const w2 = homeWorld({ [key(GEAR)]: [...SPARES, { slot: 11, name: 'golden_helmet', count: 1 }] });
  const bare = lookAt(MAIN(), 1000, { xpLevel: 45 });
  t.deepEqual(netherTableJob(bare, w2), { kind: 'helmet', name: 'golden_helmet', from: 'stored', slot: 11, chest: GEAR });
  // no golden helmet: nothing, whatever the diamonds (no diamond piece is made for the Nether)
  t.is(netherTableJob(bare, w), undefined);
  // one made already, carried or in the chests: nothing
  const made = homeWorld({ [key(GEAR)]: [HELMET(4, 'fire_protection 1'), ...SPARES] });
  t.false(netherHelmetMissing(s.items, made));
  t.deepEqual(storedNetherHelmets(made).map(f => `${f.stack.name} ${f.stack.slot}`), ['golden_helmet 4']);
  t.is(netherTableJob(s, made), undefined, 'the anvil raises it from there');
  t.is(netherTableJob(lookAt([...MAIN(), HELMET(30), piece(31, 'golden_helmet')], 1000, { xpLevel: 45 }), w), undefined);
  // only for the trips: switched off, or no portal yet, nothing; nor under level 30
  t.is(netherTableJob(s, homeWorld({}, { nether: { trips: false } } as never)), undefined);
  t.is(netherTableJob(s, homeWorld({}, { progress: { done: ['workshop'], blocked: {} } } as never)), undefined);
  t.is(netherTableJob({ ...s, xpLevel: 29 }, w), undefined);
  // the spare set's record is left as it was by all of it
  t.deepEqual(w.spareSet, spareRecord());
});

test('the table: a plain chestplate beside the enchanted one worn is a spare, never enchanted with whatever the table shows; the Nether job is the golden helmet; the offer it takes shows fire protection, from the second on', (t) => {
  const items = [...MAIN(), piece(5, 'diamond_chestplate')];
  t.is(enchantPick(items, 20), undefined, 'the main chore leaves it');
  t.false(plainLeft(items), 'nor does it hold the anvil\'s levels for the table');
  // both plain: the main set's, as ever (the carried one first)
  t.is(enchantPick([piece(38, 'diamond_chestplate'), piece(5, 'diamond_chestplate')], 20)?.slot, 5);
  // a plain golden helmet is never the main chore's (gold is below diamond)
  t.is(enchantPick([...MAIN4(), piece(6, 'golden_helmet')], 20), undefined);
  const w = homeWorld({ [key(GEAR)]: [...SPARES] });
  t.not(enchantGoal.wants(lookAt(items, 1000, { xpLevel: 45 }), w) ?? '', 'level 45: enchant the diamond_chestplate', 'no Nether job on the chestplate');
  const s = lookAt([...items, piece(6, 'golden_helmet')], 1000, { xpLevel: 45 });
  t.is(enchantGoal.wants(s, w), 'level 45: enchant the nether golden_helmet (fire protection)');
  t.false(enchantGoal.cuts!(s, w), 'it waits for the hand-over, as a book does');
  // the offers
  const offers = [{ slot: 0, cost: 8, enchant: 'fire_protection', level: 1 }, { slot: 1, cost: 19, enchant: 'protection', level: 2 }, { slot: 2, cost: 30, enchant: 'unbreaking', level: 3 }];
  t.is(FIRE_OFFER_FROM, 1);
  t.is(fireOffer(offers, 45), undefined, 'the first offer\'s fire protection I is not taken');
  t.like(fireOffer([...offers.slice(0, 2), { slot: 2, cost: 30, enchant: 'fire_protection', level: 3 }], 45), { slot: 2 });
  t.is(fireOffer([...offers.slice(0, 2), { slot: 2, cost: 30, enchant: 'fire_protection', level: 3 }], 29), undefined, 'not with the level short');
  t.like(fireOffer([{ slot: 1, cost: 19, enchant: 'fire_protection', level: 2 }, { slot: 2, cost: 30, enchant: 'fire_protection', level: 3, available: false }], 45), { slot: 1 });
});

// ------------------------------------------------------------------------------------------------ the fake home

const ARMOR_TIER: Record<string, number> = { leather: 1, golden: 2, copper: 2, chainmail: 3, iron: 4, turtle: 4, diamond: 5, netherite: 6 };
const SLOTS: [number, string][] = [[36, 'boots'], [37, 'leggings'], [38, 'chestplate'], [39, 'helmet']];
/** Combat.wearRank as the mod's: tier and levels, the set's order (setRank), the golden helmet first dressed for the Nether. */
function rank(i: InventoryItem | undefined, dressed: boolean): number {
  if (!i) return 0;
  const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(i.name);
  const tier = m ? ARMOR_TIER[m[1]] ?? 0 : 0;
  if (!tier) return 0;
  let r = tier * 1000 + (i.enchantments ?? []).reduce((a, e) => a + (/curse/.test(e.name) ? -e.level : e.level), 0);
  if (i.enchantments?.some(e => e.name === 'fire_protection')) r = dressed ? r + 500_000 : r - 500;
  if (dressed && i.name === 'golden_helmet') r += 1_000_000;
  return r;
}

/**
 * The home as the mod would answer: the pockets, the chests by their stacks (open, withdraw and deposit by slot), the
 * gear check dressed for a set (armor.wearset, as Interact.java: the best of each armour slot by wearRank put on, piece
 * for piece, what came off into the pocket slot the new one left; `oldJar`: no such call, `{}`), the table (offers in
 * turn from `seeds`, the result the `results` in turn), the anvil (a book's enchantments added on, a repair mending).
 */
function home(items: InventoryItem[], world: WorldMemory, opts: { oldJar?: boolean; seeds?: { offers: object[]; book: object[] }[]; results?: ItemEnchantment[][]; dim?: string } = {}) {
  const inv = items.map(i => ({ ...i, ...(i.enchantments ? { enchantments: i.enchantments.map(e => ({ ...e })) } : {}) }));
  const chests = new Map<string, ChestStack[]>(world.landmarks.chests.map(c => [key(c), (world.chestStacks?.[key(c)] ?? []).map(st => ({ ...st }))]));
  const calls: string[] = [];
  const said: string[] = [];
  const state = { set: 'main', open: '', dim: opts.dim ?? OVERWORLD, seed: 0, inTable: undefined as InventoryItem | undefined, results: [...(opts.results ?? [])] };
  const freePocket = () => [...Array(36).keys()].find(k => !inv.some(i => i.slot === k));
  const reply = (k: string) => {
    const stacks = chests.get(k) ?? [];
    const totals: Record<string, number> = {};
    for (const st of stacks) totals[st.name] = (totals[st.name] ?? 0) + st.count;
    return { slots: 27, free: 27 - stacks.length, items: totals, stacks: stacks.map(st => ({ ...st })) };
  };
  const dress = () => {
    const dressed = state.dim === NETHER || state.set === 'nether';
    const wore: string[] = [];
    for (const [index, kind] of SLOTS) {
      const worn = inv.find(i => i.slot === index);
      const best = inv.filter(i => i.slot < 36 && i.name.endsWith(`_${kind}`)).sort((a, b) => rank(b, dressed) - rank(a, dressed))[0];
      if (!best || rank(best, dressed) <= rank(worn, dressed)) continue;
      const from = best.slot;
      best.slot = index;
      if (worn) worn.slot = from;
      wore.push(best.name);
    }
    return wore;
  };
  const ctx = {
    s: lookAt(inv, 1000, { xpLevel: 45, dimension: state.dim }), world, signal: new AbortController().signal, gain: () => undefined,
    progress: (x: string) => { said.push(x); },
    status: async () => ({ inWorld: true, username: 'claudebot', screen: null, dimension: state.dim }),
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      calls.push(`${tool} ${JSON.stringify(a)}`);
      if (tool === 'craft-item') {
        const d = inv.find(i => i.slot < 36 && i.name === 'diamond');
        const need = { diamond_chestplate: 8, diamond_leggings: 7, diamond_boots: 4 }[String(a.outputItem)] ?? 0;
        if (!d || d.count < need) return { ok: false, text: 'missing diamonds' };
        d.count -= need;
        inv.push({ slot: freePocket()!, name: String(a.outputItem), count: 1 });
        return { ok: true, text: `Crafted 1 ${String(a.outputItem)}` };
      }
      return { ok: true, text: 'ok' };
    },
    call: (async (m: string, a: Record<string, unknown> = {}) => {
      calls.push(`${m} ${JSON.stringify(a)}`);
      if (m === 'inventory') return { items: inv.map(i => ({ ...i })) };
      if (m === 'goto') return { arrived: true };
      if (m === 'container.close') { state.open = ''; return {}; }
      if (m === 'chest.open') { state.open = key(a as unknown as Pos); return reply(state.open); }
      if (m === 'chest.withdraw') {
        const list = chests.get(state.open)!;
        const st = list.find(x => x.slot === a.slot && x.name === a.name);
        if (!st) return { ...reply(state.open), moved: 0, from: -1 };
        list.splice(list.indexOf(st), 1);
        inv.push({ ...st, slot: freePocket()! });
        return { ...reply(state.open), moved: st.count, from: st.slot };
      }
      if (m === 'chest.deposit') {
        const list = chests.get(state.open)!;
        const i = inv.find(x => x.slot === a.slot && x.name === a.name);
        if (!i) return { ...reply(state.open), moved: 0 };
        const free = [...Array(27).keys()].find(k => !list.some(st => st.slot === k))!;
        inv.splice(inv.indexOf(i), 1);
        list.push({ ...i, slot: free });
        return { ...reply(state.open), moved: i.count };
      }
      if (m === 'armor.wearset') {
        if (opts.oldJar) return {};
        if (a.set) state.set = String(a.set);
        const wore = a.set ? dress() : [];
        return { set: state.set, wore, worn: inv.filter(i => i.slot >= 36 && i.slot <= 39).map(i => ({ ...i })) };
      }
      // the table: a put clears its slot (back into the pockets) and puts the named one in, from its slot
      if (m === 'enchant.open') return { open: true };
      if (m === 'enchant.put') {
        if (state.inTable) { state.inTable.slot = freePocket()!; inv.push(state.inTable); state.inTable = undefined; }
        const one = inv.find(i => i.slot === a.slot && i.name === a.name) ?? inv.find(i => i.slot < 36 && i.name === a.name);
        if (!one) throw new Error(`no ${String(a.name)} in inventory`);
        if (one.count > 1) { one.count -= 1; state.inTable = { ...one, count: 1 }; } else { inv.splice(inv.indexOf(one), 1); state.inTable = one; }
        const seed = opts.seeds?.[state.seed] ?? { offers: [], book: [] };
        return { put: one.name, enchantable: true, offers: one.name === 'book' ? seed.book : seed.offers };
      }
      if (m === 'enchant.choose') {
        const item = state.inTable!;
        const book = item.name === 'book';
        const enchantments = book ? [{ name: 'sharpness', level: 4 }] : state.results.shift() ?? [];
        Object.assign(item, { name: book ? 'enchanted_book' : item.name, enchantments, ...(book ? {} : { enchanted: true }) });
        item.slot = freePocket()!;
        inv.push(item);
        state.inTable = undefined;
        state.seed += 1;
        return { ok: true, enchantments };
      }
      if (m === 'enchant.close') { if (state.inTable) { state.inTable.slot = freePocket()!; inv.push(state.inTable); state.inTable = undefined; } return { ok: true }; }
      return {};
    }) as GoalContext['call']
  } as unknown as GoalContext;
  const worn = () => SLOTS.map(([index]) => inv.find(i => i.slot === index)).map(i => (i ? `${i.name}${isNetherPiece(i) ? ' (nether)' : ''}` : 'none'));
  return { ctx, inv, chests, calls, said, state, worn, look: (over: Partial<Snapshot> = {}) => lookAt(inv.map(i => ({ ...i })), 1000, { xpLevel: 45, ...over }) };
}


// ------------------------------------------------------------------------------------------------ the table's run

test('the table\'s run for the Nether helmet: the plain golden helmet carried, no fire protection shown, the seed turned with a book at its dearest offer, then fire protection taken; the helmet and the book into the chests; nothing crafted', async (t) => {
  const w = homeWorld({ [key(GEAR)]: [...SPARES] });
  const items = [...MAIN(), piece(14, 'golden_helmet'), { slot: 15, name: 'book', count: 2 }, { slot: 16, name: 'diamond', count: 64 }];
  // (the fake's seed turns at each choose: the book's at seed 0 gives seed 1)
  const book = [{ slot: 0, cost: 6, enchant: 'power' }, { slot: 1, cost: 17, enchant: 'sharpness' }, { slot: 2, cost: 30, enchant: 'sharpness' }];
  const seeds = [
    { offers: [{ slot: 0, cost: 8, enchant: 'fire_protection', level: 1 }, { slot: 1, cost: 19, enchant: 'protection', level: 2 }, { slot: 2, cost: 30, enchant: 'protection', level: 4 }], book },
    { offers: [{ slot: 0, cost: 6, enchant: 'unbreaking', level: 1 }, { slot: 1, cost: 18, enchant: 'fire_protection', level: 2 }, { slot: 2, cost: 30, enchant: 'fire_protection', level: 3 }], book }
  ];
  const f = home(items, w, { seeds, results: [en('fire_protection 3, unbreaking 2')] });
  f.ctx.s = f.look();
  t.is(enchantGoal.wants(f.ctx.s, w), 'level 45: enchant the nether golden_helmet (fire protection)');
  const text = await enchantGoal.run(f.ctx);
  t.regex(text, /^enchanted the nether golden_helmet: fire_protection 3, unbreaking 2; the seed turned with 1 book \(sharpness 4\); into the chest at \(-547, 64, 2182\)$/);
  t.false(f.calls.some(c => c.startsWith('craft-item')), 'nothing crafted');
  const puts = f.calls.filter(c => c.startsWith('enchant.put')).map(c => JSON.parse(c.slice('enchant.put '.length)).name);
  t.deepEqual(puts, ['golden_helmet', 'book', 'golden_helmet']);
  t.deepEqual(f.calls.filter(c => c.startsWith('enchant.choose')), ['enchant.choose {"slot":2}', 'enchant.choose {"slot":2}']);
  // in the gear chest now, by its stacks: the Nether helmet; the spare set where it was
  const gear = f.chests.get(key(GEAR))!;
  t.true(gear.some(st => netherHelmetPiece(st)));
  for (const sp of SPARES) t.true(gear.some(st => st.slot === sp.slot && st.name === sp.name && !st.enchantments), sp.name);
  t.deepEqual(w.spareSet, spareRecord());
  // the main set worn as it was, and the diamonds left alone
  t.deepEqual(f.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'diamond_helmet']);
  t.is(f.inv.find(i => i.name === 'diamond')?.count, 64);
  t.false(netherHelmetMissing(f.inv, w));
  t.is(netherTableJob(f.look(), w), undefined, 'done: nothing more for the table');
});

test('the table\'s run for the Nether helmet with no fire protection shown after its books: a failure (the retry time), the plain helmet back in the chests for the next try, nothing enchanted', async (t) => {
  const w = homeWorld({ [key(GEAR)]: [...SPARES, { slot: 11, name: 'golden_helmet', count: 1 }] });
  const protection = { offers: [{ slot: 1, cost: 19, enchant: 'protection', level: 2 }, { slot: 2, cost: 30, enchant: 'blast_protection', level: 4 }], book: [{ slot: 2, cost: 30, enchant: 'sharpness' }] };
  const items = [...MAIN(), { slot: 15, name: 'book', count: NETHER_REROLLS }];
  const f = home(items, w, { seeds: [protection, protection, protection, protection] });
  f.ctx.s = f.look();
  t.is(enchantGoal.wants(f.ctx.s, w), 'level 45: enchant the nether golden_helmet (fire protection)');
  await t.throwsAsync(enchantGoal.run(f.ctx), { message: /^no fire protection offer for the nether golden_helmet \(19: protection 2, 30: blast_protection 4 \| .*\); the seed turned with 2 books .*; into the chest at \(-547, 64, 2182\)$/ });
  t.is(f.calls.filter(c => c.startsWith('enchant.choose')).length, NETHER_REROLLS, 'only the books');
  t.true(f.chests.get(key(GEAR))!.some(st => st.name === 'golden_helmet' && !st.enchantments), 'plain, in the chests again');
  t.false(f.inv.some(i => i.name === 'golden_helmet' && i.slot < 36));
});

// ------------------------------------------------------------------------------------------------ the anvil's book choice

const bookStack = (slot: number, s: string): ChestStack => ({ slot, name: 'enchanted_book', count: 1, enchantments: en(s) });
const stored = (w: WorldMemory) => [
  ...Object.entries(w.chestStacks ?? {}).flatMap(([k, list]) => list.filter(st => st.name === 'enchanted_book' || st.name === 'diamond' || st.name === 'gold_ingot')
    .map(stack => ({ chest: w.landmarks.chests.find(c => key(c) === k)!, stack }))),
  ...storedNetherHelmets(w)
];

test('the anvil\'s book choice: fire protection onto the Nether helmet in its chest, never a main piece nor an old diamond fire protection piece; protection onto the main set, never the helmet; mending to the helmet first', (t) => {
  const items = MAIN();
  const w = homeWorld({ [key(GEAR)]: [HELMET(4, 'fire_protection 3, unbreaking 3'), OLD.chestplate(6), ...SPARES], [key(BOOKS)]: [bookStack(0, 'fire_protection 4'), bookStack(1, 'protection 4')] });
  const plan = anvilPlan(items, stored(w), 45, { now: T0 });
  t.like(plan, { job: 'book', at: GEAR, piece: { name: 'golden_helmet', slot: 4 }, add: { chest: BOOKS, slot: 0 }, for: [{ name: 'fire_protection', level: 4 }] });
  t.is(describe(plan!), 'fire_protection 4 onto the nether golden_helmet (in its chest)');
  // that pair tried: the protection book goes onto the main set (the chestplate's 3 raised), never the helmet
  const next = anvilPlan(items, stored(w), 45, { now: T0, tried: { [plan!.key]: { why: 'no result', at: T0 } } });
  t.like(next, { job: 'book', piece: { name: 'diamond_chestplate', slot: 38 }, add: { slot: 1 }, for: [{ name: 'protection', level: 4 }] });
  t.is(describe(next!), 'protection 4 onto the diamond_chestplate (worn)');
  // with no Nether helmet (the old diamond pieces alone): a fire protection book has no use at all
  const bare = homeWorld({ [key(GEAR)]: [OLD.chestplate(6), OLD.boots(7)], [key(BOOKS)]: [bookStack(0, 'fire_protection 4')] });
  t.is(anvilPlan(items, stored(bare), 45, { now: T0 }), undefined);
  t.false(bookOfUse(items, { enchantments: en('fire_protection 4') }, storedNetherHelmets(bare)));
  t.true(bookOfUse(items, { enchantments: en('fire_protection 4') }, storedNetherHelmets(w)));
  // nor onto a main piece with no protection yet (it would shut protection out for good)
  const unprot = MAIN4().map(i => (i.slot === 36 ? { ...i, enchantments: en('unbreaking 3') } : i));
  t.is(anvilPlan(unprot, stored(bare), 45, { now: T0 }), undefined);
  // only protection books and the main set at its best: no job on the helmet
  const prot = homeWorld({ [key(GEAR)]: [HELMET(4, 'fire_protection 3, unbreaking 3')], [key(BOOKS)]: [bookStack(0, 'protection 4')] });
  t.is(anvilPlan(MAIN4(), stored(prot), 45, { now: T0 }), undefined);
  t.false(bookOfUse(MAIN4(), { enchantments: en('protection 4') }, storedNetherHelmets(prot)));
  // mending: the helmet first (the user's priority), then the main set's
  const mend = homeWorld({ [key(GEAR)]: [HELMET(4)], [key(BOOKS)]: [bookStack(0, 'mending 1')] });
  t.like(anvilPlan(items, stored(mend), 45, { now: T0 }), { job: 'mending', at: GEAR, piece: { name: 'golden_helmet', slot: 4 } });
  // what each piece wants
  t.deepEqual({ ...wantedFor(HELMET(4)) }, { ...NETHER_HELMET_WANTED });
  t.deepEqual({ ...wantedFor(MAIN()[3]) }, { ...WANTED.boots });
  t.deepEqual({ ...wantedFor(OLD.boots(4)) }, { ...WANTED.boots }, 'an old piece is plain stock: the main set\'s wants');
});

test('the anvil mends the Nether helmet with gold ingots over the barter\'s reserve; an old diamond fire protection piece in the chests is no job', (t) => {
  t.is(GOLD_KEPT, GOLD_RESERVE);
  const worn = { ...HELMET(4), damage: 70, maxDamage: 77 };
  const w = homeWorld({ [key(GEAR)]: [worn, { slot: 9, name: 'gold_ingot', count: 30 }] });
  const plan = anvilPlan(MAIN4(), stored(w), 45, { now: T0, gold: 30 - GOLD_KEPT, diamonds: 0 });
  t.like(plan, { job: 'repair', at: GEAR, piece: { name: 'golden_helmet' }, add: { name: 'gold_ingot', count: 4 } });
  t.regex(describe(plan!), /^repair the nether golden_helmet \(in its chest\) \(9% left\) with 4 gold ingots$/);
  t.is(anvilPlan(MAIN4(), stored(w), 45, { now: T0, gold: 3, diamonds: 0 }), undefined, 'three over the reserve: not enough');
  const boots = { ...OLD.boots(5), damage: 400, maxDamage: 429 };
  const w2 = homeWorld({ [key(GEAR)]: [boots, { slot: 9, name: 'diamond', count: 30 }] });
  t.is(anvilPlan(MAIN4(), stored(w2), 45, { now: T0, diamonds: 30 }), undefined);
});

test('the anvil\'s run on the Nether helmet: out of its chest by its slot, the book on at the anvil, back into the chests with it; the main set worn throughout', async (t) => {
  const w = homeWorld({ [key(GEAR)]: [HELMET(4, 'fire_protection 4'), ...SPARES], [key(BOOKS)]: [bookStack(0, 'unbreaking 3')] });
  const f = home(MAIN4(), w);
  // the anvil as the mod's: the input and the book in, the result the book's enchantments on the piece
  const slots: Record<string, InventoryItem | undefined> = {};
  const inner = f.ctx.call;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, a: Record<string, unknown> = {}, ms?: number) => {
    if (m === 'world.region') return { blocks: ['minecraft:anvil'] };
    if (m === 'anvil.open' || m === 'anvil.status') return { open: true, xpLevel: 45 };
    if (m === 'anvil.put') {
      const one = f.inv.find(i => i.slot === a.slot && i.name === a.name)!;
      f.inv.splice(f.inv.indexOf(one), 1);
      slots[String(a.which)] = one;
      const input = slots.input, add = slots.additional;
      const result = input && add ? { ...input, enchantments: [...(input.enchantments ?? []), ...(add.enchantments ?? [])] } : null;
      return { open: true, input, additional: add, result, cost: result ? 6 : 0, xpLevel: 45, canTake: !!result };
    }
    if (m === 'anvil.take') {
      const input = slots.input!;
      input.enchantments = [...(input.enchantments ?? []), ...(slots.additional?.enchantments ?? [])];
      input.slot = [...Array(36).keys()].find(k => !f.inv.some(i => i.slot === k))!;
      f.inv.push(input);
      slots.input = slots.additional = undefined;
      return { ok: true, item: input.name, enchantments: input.enchantments, cost: 6, used: 1, levelBefore: 45, levelAfter: 39, anvil: 'anvil' };
    }
    if (m === 'anvil.close') return { wore: [] };
    return inner(m, a, ms);
  }) as GoalContext['call'];
  f.ctx.s = f.look();
  const text = await anvilGoal.run(f.ctx);
  t.is(text, 'unbreaking 3 onto the nether golden_helmet (cost 6, level 45 -> 39); back into the chests');
  const h = f.chests.get(key(GEAR))!.find(st => netherHelmetPiece(st));
  t.deepEqual(h?.enchantments, en('fire_protection 4, unbreaking 3'));
  t.false(f.inv.some(i => i.slot < 36 && i.name === 'golden_helmet'), 'not left carried');
  t.deepEqual(f.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'diamond_helmet']);
  for (const sp of SPARES) t.true(f.chests.get(key(GEAR))!.some(st => st.slot === sp.slot && st.name === sp.name), sp.name);
});

// ------------------------------------------------------------------------------------------------ the swap

/** The Nether helmet in the gear chest, the old diamond Nether set's pieces beside it, and the spare set. */
const setWorld = () => homeWorld({ [key(GEAR)]: [OLD.chestplate(2), OLD.leggings(3), OLD.boots(4), HELMET(5), ...SPARES] });

test.serial('the swap at home before the portal: the helmet alone, the golden one out of the chests and on, the main diamond helmet into the gear chests by its slot and remembered; the chestplate, leggings and boots stay on, the old diamond pieces in the chests; the spare set untouched', async (t) => {
  const w = setWorld();
  const f = home(MAIN4(), w);
  t.is(await wearNetherHelmet(f.ctx), undefined);
  t.deepEqual(f.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'golden_helmet (nether)']);
  t.deepEqual(f.inv.filter(i => i.slot >= 36 && i.slot <= 38).map(i => i.enchantments?.[0]?.name), ['protection', 'protection', 'protection'], 'the main set\'s, worn as they were');
  t.true(f.calls.includes('armor.wearset {"set":"nether"}'));
  t.like(fireGear(f.inv), { epf: 20, ok: true });
  // the main helmet in the chest, remembered by its chest and slot with its enchantments
  t.deepEqual(w.gearSwap?.stored.map(p => `${p.name} ${p.enchantments?.map(e => `${e.name} ${e.level}`).join('+')}`), ['diamond_helmet protection 4+unbreaking 3+mending 1']);
  t.like(w.gearSwap, { wearing: 'nether' });
  t.false(f.inv.some(i => i.slot < 36 && /_(helmet|chestplate|leggings|boots)$/.test(i.name)), 'no armour carried down there');
  t.true(f.said.includes('nether helmet: wearing golden_helmet (fire_protection 4, unbreaking 3); the main diamond_helmet into the chests; fire EPF 20'), f.said.join(' | '));
  // only the helmet's chest slots touched: the old pieces where they were
  const gear = f.chests.get(key(GEAR))!;
  for (const old of [OLD.chestplate(2), OLD.leggings(3), OLD.boots(4)]) t.true(gear.some(st => st.slot === old.slot && st.name === old.name && fireProtected(st)), old.name);
  t.deepEqual(f.calls.filter(c => c.startsWith('chest.withdraw')).map(c => JSON.parse(c.slice('chest.withdraw '.length)).name), ['golden_helmet']);
  for (const sp of SPARES) t.true(gear.some(st => st.slot === sp.slot && st.name === sp.name && !st.enchantments), sp.name);
  t.deepEqual(w.spareSet, spareRecord());
  // the kit took a plain golden helmet (by name) while the made one lies in the chest: the made one goes on, the plain
  // one back into the chest (the trip's 12 free slots were counted without it), and neither is remembered as main
  const gold = setWorld();
  const h = home([...MAIN4(), piece(30, 'golden_helmet')], gold);
  t.is(await wearNetherHelmet(h.ctx), undefined);
  t.is(h.worn()[3], 'golden_helmet (nether)');
  t.true(netherHelmetPiece(h.inv.find(i => i.slot === 39)!));
  t.false(h.inv.some(i => i.slot < 36 && i.name === 'golden_helmet'));
  t.true(h.chests.get(key(GEAR))!.some(st => st.name === 'golden_helmet' && !st.enchantments));
  t.deepEqual(gold.gearSwap!.stored.map(p => p.name), ['diamond_helmet']);
  // only a plain golden helmet there: it goes on all the same (fire EPF 12: the gates say no, the swap does not judge)
  const plain = homeWorld({ [key(GEAR)]: [...SPARES] });
  const g = home([...MAIN4(), piece(30, 'golden_helmet')], plain);
  t.is(await wearNetherHelmet(g.ctx), undefined);
  t.deepEqual(g.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'golden_helmet (nether)']);
  t.true(g.said.some(l => /^nether helmet: wearing golden_helmet; the main diamond_helmet into the chests; fire EPF 12$/.test(l)), g.said.join(' | '));
});

test.serial('the swap back at home: the main helmet out of the chests where the swap put it and on again, the golden one into the chests, the record let go; never in the Nether, never while a run is under way', async (t) => {
  const w = setWorld();
  const f = home(MAIN4(), w);
  await wearNetherHelmet(f.ctx);
  // the trip's own run walked to the portal: nothing swapped back meanwhile
  afield.work = true;
  t.is(homeSetWant(f.look(), w), null);
  afield.work = false;
  // down there: never
  f.state.dim = NETHER;
  t.is(homeSetWant(f.look({ dimension: NETHER, distHome: Infinity }), w), null);
  t.deepEqual(f.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'golden_helmet (nether)']);
  // home again
  f.state.dim = OVERWORLD;
  f.ctx.s = f.look();
  t.is(homeSetGoal.wants(f.ctx.s, w), 'home: the main helmet on again (the golden_helmet worn)');
  const text = await homeSetGoal.run(f.ctx);
  t.is(text, 'wore diamond_helmet again; the golden_helmet into the chests');
  t.deepEqual(f.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'diamond_helmet']);
  t.deepEqual(f.inv.filter(i => i.slot >= 36).map(i => i.enchantments?.[0]?.name), ['protection', 'protection', 'protection', 'protection']);
  t.is(w.gearSwap, undefined);
  t.true(f.calls.includes('armor.wearset {"set":"main"}'));
  t.is(storedNetherHelmets(w).length, 1, 'the Nether helmet in the chests again');
  t.false(f.inv.some(i => i.slot < 36 && isNetherPiece(i)));
  // the old diamond pieces never taken out
  t.false(f.calls.some(c => c.startsWith('chest.withdraw') && /diamond_(chestplate|leggings|boots)/.test(c)));
  for (const sp of SPARES) t.true(f.chests.get(key(GEAR))!.some(st => st.slot === sp.slot && st.name === sp.name && !st.enchantments), sp.name);
  t.deepEqual(w.spareSet, spareRecord());
  f.ctx.s = f.look();
  t.is(homeSetGoal.wants(f.ctx.s, w), null, 'done: nothing more');
});

test.serial('a record of the old diamond Nether set\'s swap (made before Nov 18): the swap back still puts its main pieces on again and the fire protection ones in the chests', async (t) => {
  const w = homeWorld({ [key(GEAR)]: [MAIN4()[5], MAIN4()[6]].map((p, i) => ({ ...p, slot: 10 + i })) });
  w.gearSwap = { wearing: 'nether', at: T0, stored: [MAIN4()[5], MAIN4()[6]].map((p, i) => ({ name: p.name, chest: { ...GEAR }, slot: 10 + i, enchantments: p.enchantments })) };
  const items = [...MAIN4().filter(i => i.slot < 38), OLD.chestplate(38), HELMET(39)];
  const f = home(items, w);
  f.ctx.s = f.look();
  t.truthy(homeSetGoal.wants(f.ctx.s, w));
  await homeSetGoal.run(f.ctx);
  t.deepEqual(f.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'diamond_helmet']);
  t.true(f.inv.filter(i => i.slot >= 36).every(i => i.enchantments?.[0]?.name === 'protection'));
  t.false(f.inv.some(i => i.slot < 36 && /_(helmet|chestplate)$/.test(i.name)), 'the old chestplate and the golden helmet in the chests');
  t.falsy(w.gearSwap, 'the record let go');
});

test.serial('a death down there loses the golden helmet and the main chestplate, leggings and boots: home, the main helmet comes out of the chests and on before the regear, which takes the spare set\'s other three', async (t) => {
  const w = setWorld();
  const f = home(MAIN4(), w);
  await wearNetherHelmet(f.ctx);
  // died in the Nether: the pockets and the armour gone with it, respawned at home's bed
  f.inv.splice(0, f.inv.length);
  netherOf(w).deaths = [{ at: T0 - 60_000, where: { x: -70, y: 70, z: 260 } }];
  f.ctx.s = f.look();
  t.is(homeSetGoal.wants(f.ctx.s, w), 'home: the main helmet on again');
  t.true(homeSetGoal.priority > 72, 'above the regear (72) and the kit (70)');
  await homeSetGoal.run(f.ctx);
  t.deepEqual(f.worn(), ['none', 'none', 'none', 'diamond_helmet']);
  t.is(w.gearSwap, undefined);
  // the regear's spare set: the three pieces the death took, never the old fire protection ones
  t.deepEqual(regearPieces(f.inv, w).map(p => p.name).sort(), ['diamond_boots', 'diamond_chestplate', 'diamond_leggings']);
  t.deepEqual(w.spareSet, spareRecord(), 'the spare set as it was');
});

test.serial('dressed for the Nether at home, the kit counts the main helmet the swap stored as carried: no diamond helmet "upgrade" over the golden one, which stopped the trip by home (the swap back, then the swap again); and it cuts no run dressed so', async (t) => {
  // (live: a plain diamond helmet besides the spare set's in the gear chest, as at -547,64,2182 slot 22)
  const w = homeWorld({ [key(GEAR)]: [HELMET(5), { slot: 8, name: 'diamond_helmet', count: 1 }, ...SPARES] });
  const f = home(MAIN4(), w);
  const before = f.look();
  afield.work = afield.trip = true;
  try {
    t.is(kit.wants(before, w), null, 'the main set worn: nothing');
    t.true(kit.cuts!(before, w), 'a trip run not dressed for the Nether: cut as ever (the brain rules on one out)');
    await wearNetherHelmet(f.ctx);
    t.like(w.gearSwap, { wearing: 'nether' });
    const after = f.look();
    t.is(f.worn()[3], 'golden_helmet (nether)');
    t.is(kit.wants(after, w), null, 'the main helmet in the chests is the swap\'s, not an upgrade to take');
    t.false(kit.cuts!(after, w), 'the Nether trip dressed for it: never cut by the kit');
  } finally {
    afield.work = afield.trip = false;
  }
  // the swap back done (the record let go): the kit as ever
  f.ctx.s = f.look();
  await homeSetGoal.run(f.ctx);
  t.is(w.gearSwap, undefined);
  t.is(kit.wants(f.look(), w), null);
});

test.serial('a jar with no armor.wearset (the old one kept for a rollback): nothing taken, nothing swapped, no record; the main set goes along as before', async (t) => {
  const w = setWorld();
  const f = home(MAIN4(), w, { oldJar: true });
  t.is(await wearNetherHelmet(f.ctx), undefined);
  t.deepEqual(f.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'diamond_helmet']);
  t.is(w.gearSwap, undefined);
  t.false(f.calls.some(c => c.startsWith('chest.')));
  t.true(f.said.includes('nether helmet: this jar cannot swap armour sets (no armor.wearset): the main set goes along'));
  t.is(homeSetWant(f.look(), w), null);
});

// ------------------------------------------------------------------------------------------------ fire resistance

test.serial('fire resistance first: the barter\'s target 12 (a day\'s use of 6 twice over), and every Nether trip\'s kit carries a potion of it for the Guardian\'s hook while the home has one', async (t) => {
  t.is(NETHER_STOCK.fire_resistance, 12);
  t.is(NETHER_TRIP.firePotions, 1);
  const w = setupWorld();
  const DROPS = '-547,65,2179';
  w.chestStacks = { ...(w.chestStacks ?? {}), [DROPS]: [{ slot: 0, name: 'potion', count: 1, potion: 'fire_resistance' }, { slot: 1, name: 'potion', count: 1, potion: 'long_fire_resistance' }] };
  w.chestItems![DROPS].potion = 2;
  const f = game(w);
  t.is(await fetchSetupKit(f.ctx), undefined);
  const potions = f.inv.filter(i => i.slot < 36 && i.name === 'potion');
  t.deepEqual(potions.map(p => p.potion), ['long_fire_resistance'], 'one, the long one');
  // none in stock: the trip still goes
  const bare = setupWorld();
  const g = game(bare);
  t.is(await fetchSetupKit(g.ctx), undefined);
  t.false(g.inv.some(i => i.name === 'potion'));
});


// ------------------------------------------------------------------------------------------------ the review's fixes

test.serial('the swap back takes out only a main helmet the Guardian wears over the one on, and sees to no other kind: a fire protection diamond chestplate worn, a plain iron one in the chests, is no swap back (it came back every 5 minutes, the iron one in and out of its chest)', async (t) => {
  // (the main chore's dearest offer gave the worn chestplate fire protection: live on Nov 16, protection gone from it)
  const fp = piece(38, 'diamond_chestplate', 'fire_protection 3, unbreaking 3');
  const items = MAIN().map(i => (i.slot === 38 ? fp : i));
  const w = homeWorld({ [key(GEAR)]: [{ slot: 2, name: 'iron_chestplate', count: 1 }, ...SPARES] });
  const f = home(items, w);
  t.is(homeSetWant(f.look(), w), null);
  // with the swap's record: the run settles at once, the record let go, the iron chestplate left in its chest
  w.gearSwap = { wearing: 'nether', stored: [], at: T0 };
  f.ctx.s = f.look();
  t.truthy(homeSetGoal.wants(f.ctx.s, w));
  t.is(await homeSetGoal.run(f.ctx), 'the main set is on (nothing to swap back)');
  t.falsy(w.gearSwap, 'the record let go');
  t.false(f.calls.some(c => c.startsWith('chest.withdraw')));
  t.true(f.chests.get(key(GEAR))!.some(st => st.name === 'iron_chestplate'));
  t.is(homeSetWant(f.look(), w), null);
  // one of its tier, plain, or one above it: worn over it, as the Guardian does (its rank, Combat.armorRank and setRank)
  for (const [name, worn] of [['diamond_chestplate', true], ['netherite_chestplate', true], ['iron_chestplate', false], ['chainmail_chestplate', false]] as const) {
    t.is(wornOver({ name }, fp), worn, name);
    t.is(wornOver({ name }, fp), rank({ slot: 0, name, count: 1 }, false) > rank(fp, false), `${name}: as the mod ranks it`);
  }
  // a plain diamond chestplate in the chests: no swap back either (only the helmet is swapped now)
  const plainDiamond = homeWorld({ [key(GEAR)]: [{ slot: 2, name: 'diamond_chestplate', count: 1 }, ...SPARES] });
  t.is(homeSetWant(home(items, plainDiamond).look(), plainDiamond), null);
  // the golden helmet worn: an iron helmet goes on over it, a copper one (the same tier to the Guardian) does not
  const gold = piece(39, 'golden_helmet');
  t.true(wornOver({ name: 'iron_helmet' }, gold));
  t.false(wornOver({ name: 'copper_helmet' }, gold));
  t.false(wornOver({ name: 'leather_helmet', enchantments: en('protection 4, unbreaking 3') }, gold));
  t.false(wornOver({ name: 'diamond_helmet', enchantments: en('binding_curse 1') }), 'bound by its curse: the Guardian never puts it on');
  const ironHome = homeWorld({ [key(GEAR)]: [{ slot: 2, name: 'iron_helmet', count: 1 }, ...SPARES] });
  t.is(homeSetWant(home([...MAIN().filter(i => i.slot !== 39), gold], ironHome).look(), ironHome), 'home: the main helmet on again (the golden_helmet worn)');
  for (const i of [fp, gold, ...MAIN().filter(m => m.slot >= 36), HELMET(1)]) t.is(mainRank(i), rank(i, false), i.name);
});

test('the main table chore takes only an offer showing protection for an armour piece (protection excludes fire protection; an unbreaking or thorns clue may still bring fire protection along); a tool takes the dearest', (t) => {
  const offers = [{ slot: 0, cost: 5, enchant: 'protection' }, { slot: 1, cost: 18, enchant: 'unbreaking' }, { slot: 2, cost: 30, enchant: 'fire_protection' }];
  t.like(mainOffer(offers, 45, true), { slot: 0 });
  t.like(mainOffer(offers, 45, false), { slot: 2 });
  t.like(mainOffer([...offers, { slot: 2, cost: 30, enchant: 'protection' }], 45, true), { cost: 30, enchant: 'protection' }, 'the dearest protection it pays');
  t.is(mainOffer(offers.slice(1), 45, true), undefined, 'none shows protection: the seed turned with a book, or the retry');
  t.is(mainOffer(offers, 4, true), undefined);
});

test('the main table chore on a plain main-set chestplate (the one homeSet took out after a death): no protection shown, the seed turned with a book, then protection taken; none after its books: a failure, nothing enchanted, the books into the chests', async (t) => {
  const items = [...MAIN().filter(i => i.slot !== 38), piece(5, 'diamond_chestplate'), { slot: 15, name: 'book', count: NETHER_REROLLS }];
  const book = [{ slot: 2, cost: 30, enchant: 'sharpness' }];
  const none = { offers: [{ slot: 0, cost: 6, enchant: 'unbreaking', level: 1 }, { slot: 1, cost: 18, enchant: 'thorns', level: 2 }, { slot: 2, cost: 30, enchant: 'fire_protection', level: 3 }], book };
  const prot = { offers: [{ slot: 0, cost: 6, enchant: 'unbreaking', level: 1 }, { slot: 1, cost: 18, enchant: 'protection', level: 2 }, { slot: 2, cost: 30, enchant: 'unbreaking', level: 3 }], book };
  const w = homeWorld({ [key(GEAR)]: [...SPARES] });
  const f = home(items, w, { seeds: [none, prot], results: [en('protection 3, unbreaking 2')] });
  f.ctx.s = f.look();
  t.is(enchantGoal.wants(f.ctx.s, w), 'level 45: enchant the diamond_chestplate');
  const text = await enchantGoal.run(f.ctx);
  t.is(text, 'enchanted the diamond_chestplate: protection 3, unbreaking 2; the seed turned with 1 book (sharpness 4)');
  t.deepEqual(f.calls.filter(c => c.startsWith('enchant.choose')), ['enchant.choose {"slot":2}', 'enchant.choose {"slot":1}'], 'the book at its dearest, then the protection offer');
  t.false(f.inv.some(i => i.name === 'diamond_chestplate' && fireProtected(i)));
  // no protection shown after its books: a failure (the retry), the piece plain, no fire protection taken
  const w2 = homeWorld({ [key(GEAR)]: [...SPARES] });
  const g = home(items, w2, { seeds: [none, none, none, none] });
  g.ctx.s = g.look();
  const err = await t.throwsAsync(enchantGoal.run(g.ctx));
  t.regex(err!.message, /^no offer for the diamond_chestplate showing protection \(6: unbreaking 1, 18: thorns 2, 30: fire_protection 3 \| .*\); the seed turned with 2 books$/);
  t.is(g.calls.filter(c => c.startsWith('enchant.choose')).length, NETHER_REROLLS, 'only the books');
  t.true(g.inv.some(i => i.slot < 36 && i.name === 'diamond_chestplate' && !i.enchantments), 'plain still');
  t.false(g.inv.some(i => i.slot < 36 && i.name === 'enchanted_book'), 'the books put away');
});


test('the table\'s run for the Nether helmet with the book chore\'s pile in store (24 books): its books still turn the seed, up to twice that pile', async (t) => {
  const pile = (n: number) => Array.from({ length: n }, (_, i) => bookStack(i, 'bane_of_arthropods 2'));
  const book = [{ slot: 2, cost: 30, enchant: 'sharpness' }];
  const seeds = [
    { offers: [{ slot: 1, cost: 19, enchant: 'protection', level: 2 }, { slot: 2, cost: 30, enchant: 'protection', level: 4 }], book },
    { offers: [{ slot: 1, cost: 18, enchant: 'fire_protection', level: 2 }, { slot: 2, cost: 30, enchant: 'fire_protection', level: 3 }], book }
  ];
  t.is(NETHER_BOOK_PILE, 48);
  const w = homeWorld({ [key(GEAR)]: [...SPARES], [key(BOOKS)]: pile(24) });
  const f = home([...MAIN(), piece(14, 'golden_helmet'), { slot: 15, name: 'book', count: 2 }], w, { seeds, results: [en('fire_protection 3, unbreaking 2')] });
  f.ctx.s = f.look();
  t.regex(await enchantGoal.run(f.ctx), /^enchanted the nether golden_helmet: fire_protection 3, unbreaking 2; the seed turned with 1 book /);
  // at twice the pile: no more books, the run fails on the offers it sees (the retry time)
  const full = homeWorld({ [key(GEAR)]: [...SPARES], [key(BOOKS)]: pile(26) });
  full.chestStacks![key(BOOKS)].push(...pile(22).map((b, i) => ({ ...b, slot: 26 + i })));
  full.chestItems![key(BOOKS)].enchanted_book = 48;
  const g = home([...MAIN(), piece(14, 'golden_helmet'), { slot: 15, name: 'book', count: 2 }], full, { seeds });
  g.ctx.s = g.look();
  await t.throwsAsync(enchantGoal.run(g.ctx), { message: /^no fire protection offer for the nether golden_helmet \(19: protection 2, 30: protection 4\); into the chest/ });
});
