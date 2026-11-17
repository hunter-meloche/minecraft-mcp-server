import test from 'ava';
import type { ChestStack, InventoryItem, ItemEnchantment } from '../../src/client/tools.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import { key, remember, type SpareSet } from '../../src/client/brain/chests.js';
import { better, carriedKit, fireProtected, stashPlan } from '../../src/client/brain/kit.js';
import {
  NETHER_HELMET, NETHER_SET_KINDS, NETHER_WANTED, homeSetGoal, homeSetWant, isNetherPiece, mainRank, netherSetMissing, netherSetPiece, storedNetherPieces, wearNetherSet, wornOver
} from '../../src/client/brain/netherset.js';
import {
  FIRE_OFFER_FROM, NETHER_BOOK_PILE, NETHER_DIAMONDS_KEPT, NETHER_REROLLS, enchantGoal, enchantPick, fireOffer, mainOffer, netherTableJob, plainLeft
} from '../../src/client/brain/enchant.js';
import { GOLD_KEPT, WANTED, anvilGoal, anvilPlan, bookOfUse, describe, wantedFor } from '../../src/client/brain/anvil.js';
import { GOLD_RESERVE } from '../../src/client/brain/netherbarter.js';
import { DIAMONDS_KEPT, regearPieces } from '../../src/client/brain/regear.js';
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
/** The Nether set as the table and the anvil make it. */
const NSET = {
  chestplate: (slot: number) => piece(slot, 'diamond_chestplate', 'fire_protection 4, unbreaking 3, mending 1'),
  leggings: (slot: number) => piece(slot, 'diamond_leggings', 'fire_protection 3, unbreaking 3'),
  boots: (slot: number) => piece(slot, 'diamond_boots', 'fire_protection 4, feather_falling 4, unbreaking 3'),
  helmet: (slot: number) => piece(slot, 'golden_helmet', 'fire_protection 4, unbreaking 3')
};

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

test('the Nether set: its pieces told from the main set\'s by their fire protection (the two exclude each other), the golden helmet its helmet; a piece of fire protection below the main one of its tier at home', (t) => {
  t.true(isNetherPiece(NSET.chestplate(4)));
  t.true(isNetherPiece(piece(4, 'golden_helmet')), 'a plain golden helmet is the one worn down there all the same');
  t.false(isNetherPiece(MAIN()[3]));
  t.false(isNetherPiece(piece(3, 'diamond_sword', 'fire_aspect 2')));
  // what makes a kind of the set whole: diamond or better, the golden helmet, fire protection on it
  t.true(netherSetPiece(NSET.helmet(4)));
  t.false(netherSetPiece(piece(4, 'golden_helmet')), 'plain: the table\'s still');
  t.false(netherSetPiece(piece(4, 'diamond_helmet', 'fire_protection 4')), 'a diamond helmet is never worn down there: the golden one is (Nether.helmetRank)');
  t.false(netherSetPiece(piece(4, 'iron_boots', 'fire_protection 4')));
  t.deepEqual([...NETHER_SET_KINDS], ['chestplate', 'leggings', 'boots', 'helmet']);
  t.deepEqual({ ...NETHER_WANTED.chestplate }, { fire_protection: 4, unbreaking: 3, mending: 1 });
  t.deepEqual({ ...NETHER_WANTED.boots }, { fire_protection: 4, unbreaking: 3, mending: 1, feather_falling: 4 });
  t.false('respiration' in NETHER_WANTED.helmet, 'no water down there');
  t.is(WANTED.chestplate.protection, 4, 'the main set keeps its protection 4');
  // the kit at home: the main piece is the best of its kind, whatever the levels (the Guardian's Combat.setRank)
  const fp = piece(5, 'diamond_chestplate', 'fire_protection 4, unbreaking 3, mending 1, thorns 3');
  t.true(fireProtected(fp));
  t.true(better(MAIN()[5], fp) < 0, 'the main chestplate first');
  t.is(carriedKit([...MAIN(), fp]).best.chestplate?.slot, 38);
  t.true(better(fp, piece(6, 'iron_chestplate', 'protection 4')) < 0, 'still above a piece of the tier below');
  // and the stash at home puts the Nether piece away, by its slot, never the main one
  const plan = stashPlan([...MAIN(), fp]);
  t.deepEqual(plan.deposit.filter(d => /chestplate/.test(d.name)), [{ name: 'diamond_chestplate', count: 1, slot: 5 }]);
  t.is(NETHER_HELMET, 'golden_helmet');
});

test('the set made and kept apart: the kinds it lacks (carried, worn or in the chests), the spare set\'s plain pieces never one of them, never a blank for the table', (t) => {
  const w = homeWorld({ [key(GEAR)]: [NSET.chestplate(4), ...SPARES, { slot: 9, name: 'diamond', count: 300 }] });
  const items = [...MAIN(), NSET.helmet(30)];
  t.deepEqual(netherSetMissing(items, w), ['leggings', 'boots']);
  t.deepEqual(storedNetherPieces(w).map(f => `${f.stack.name} ${f.stack.slot}`), ['diamond_chestplate 4']);
  // the table's next job: the leggings, made from the diamonds (the spare set's plain leggings in slot 22 are the regear's)
  const s = lookAt(items, 1000, { xpLevel: 45 });
  t.deepEqual(netherTableJob(s, w), { kind: 'leggings', name: 'diamond_leggings', from: 'made' });
  // a plain pair lying in the chest outside the spare set's slots is taken instead
  const w2 = homeWorld({ [key(GEAR)]: [NSET.chestplate(4), ...SPARES, { slot: 9, name: 'diamond', count: 300 }, { slot: 11, name: 'diamond_leggings', count: 1 }] });
  t.deepEqual(netherTableJob(s, w2), { kind: 'leggings', name: 'diamond_leggings', from: 'stored', slot: 11, chest: GEAR });
  // the diamonds kept: the regear's and the anvil's and the netherite's
  t.is(NETHER_DIAMONDS_KEPT, DIAMONDS_KEPT.repairs + DIAMONDS_KEPT.netherite);
  const poor = homeWorld({ [key(GEAR)]: [NSET.chestplate(4), ...SPARES, { slot: 9, name: 'diamond', count: NETHER_DIAMONDS_KEPT + 6 }] });
  t.deepEqual(netherTableJob(s, poor), { kind: 'boots', name: 'diamond_boots', from: 'made' }, 'the leggings\' 7 not over the kept, the boots\' 4 are');
  // only for the trips: switched off, or no portal yet, nothing; nor under level 30
  t.is(netherTableJob(s, homeWorld({}, { nether: { trips: false } } as never)), undefined);
  t.is(netherTableJob(s, homeWorld({}, { progress: { done: ['workshop'], blocked: {} } } as never)), undefined);
  t.is(netherTableJob({ ...s, xpLevel: 29 }, w), undefined);
  // the spare set's record is left as it was by all of it
  t.deepEqual(w.spareSet, spareRecord());
});

test('the table: a plain chestplate beside the enchanted one worn is the Nether set\'s blank, never enchanted with whatever the table shows; the offer it takes shows fire protection, from the second on', (t) => {
  const items = [...MAIN(), piece(5, 'diamond_chestplate')];
  t.is(enchantPick(items, 20), undefined, 'the main chore leaves it');
  t.false(plainLeft(items), 'nor does it hold the anvil\'s levels for the table');
  // both plain: the main set's, as ever (the carried one first)
  t.is(enchantPick([piece(38, 'diamond_chestplate'), piece(5, 'diamond_chestplate')], 20)?.slot, 5);
  const w = homeWorld({ [key(GEAR)]: [...SPARES] });
  const s = lookAt(items, 1000, { xpLevel: 45 });
  t.is(enchantGoal.wants(s, w), 'level 45: enchant the nether set\'s diamond_chestplate (fire protection)');
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

test('the table\'s run for the Nether set: the plain chestplate made, no fire protection shown, the seed turned with a book at its dearest offer, then fire protection taken; the piece and the book into the chests', async (t) => {
  const w = homeWorld({ [key(GEAR)]: [...SPARES] });
  const items = [...MAIN(), { slot: 14, name: 'diamond', count: 64 }, { slot: 15, name: 'book', count: 2 }];
  // (the fake's seed turns at each choose: the book's at seed 0 gives seed 1)
  const book = [{ slot: 0, cost: 6, enchant: 'power' }, { slot: 1, cost: 17, enchant: 'sharpness' }, { slot: 2, cost: 30, enchant: 'sharpness' }];
  const seeds = [
    { offers: [{ slot: 0, cost: 8, enchant: 'fire_protection', level: 1 }, { slot: 1, cost: 19, enchant: 'protection', level: 2 }, { slot: 2, cost: 30, enchant: 'protection', level: 4 }], book },
    { offers: [{ slot: 0, cost: 6, enchant: 'unbreaking', level: 1 }, { slot: 1, cost: 18, enchant: 'fire_protection', level: 2 }, { slot: 2, cost: 30, enchant: 'fire_protection', level: 3 }], book }
  ];
  const f = home(items, w, { seeds, results: [en('fire_protection 3, unbreaking 2')] });
  f.ctx.s = f.look();
  t.is(enchantGoal.wants(f.ctx.s, w), 'level 45: enchant the nether set\'s diamond_chestplate (fire protection)');
  const text = await enchantGoal.run(f.ctx);
  t.regex(text, /^enchanted the nether set's diamond_chestplate: fire_protection 3, unbreaking 2; the seed turned with 1 book \(sharpness 4\); into the chest at \(-547, 64, 2182\)$/);
  t.true(f.calls.some(c => c.startsWith('craft-item {"outputItem":"diamond_chestplate"')));
  const puts = f.calls.filter(c => c.startsWith('enchant.put')).map(c => JSON.parse(c.slice('enchant.put '.length)).name);
  t.deepEqual(puts, ['diamond_chestplate', 'book', 'diamond_chestplate']);
  t.deepEqual(f.calls.filter(c => c.startsWith('enchant.choose')), ['enchant.choose {"slot":2}', 'enchant.choose {"slot":2}']);
  // in the gear chest now, by its stacks: the Nether set's chestplate; the spare set where it was
  const gear = f.chests.get(key(GEAR))!;
  t.true(gear.some(st => st.name === 'diamond_chestplate' && netherSetPiece(st)));
  for (const sp of SPARES) t.true(gear.some(st => st.slot === sp.slot && st.name === sp.name && !st.enchantments), sp.name);
  t.deepEqual(w.spareSet, spareRecord());
  t.true(f.chests.get(key(BOOKS))!.some(st => st.name === 'enchanted_book') || gear.some(st => st.name === 'enchanted_book'));
  // the main set worn as it was
  t.deepEqual(f.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'diamond_helmet']);
  t.is(netherSetMissing(f.inv, w).join(), 'leggings,boots,helmet');
});

test('the table\'s run for the Nether set with no fire protection shown after its books: a failure (the retry time), the plain piece back in the chests for the next try, nothing enchanted', async (t) => {
  const w = homeWorld({ [key(GEAR)]: [...SPARES, { slot: 11, name: 'diamond_leggings', count: 1 }] });
  const protection = { offers: [{ slot: 1, cost: 19, enchant: 'protection', level: 2 }, { slot: 2, cost: 30, enchant: 'blast_protection', level: 4 }], book: [{ slot: 2, cost: 30, enchant: 'sharpness' }] };
  const items = [...MAIN(), { slot: 15, name: 'book', count: NETHER_REROLLS }];
  const f = home(items, w, { seeds: [protection, protection, protection, protection] });
  w.chestItems![key(GEAR)].diamond_leggings = 1;
  f.ctx.s = f.look();
  // (the chestplate's is first: one stored already)
  f.chests.get(key(GEAR))!.push(NSET.chestplate(4));
  remember(w, GEAR, { ...w.chestItems![key(GEAR)], diamond_chestplate: 1 }, f.chests.get(key(GEAR))!.map(st => ({ ...st })));
  t.is(enchantGoal.wants(f.ctx.s, w), 'level 45: enchant the nether set\'s diamond_leggings (fire protection)');
  await t.throwsAsync(enchantGoal.run(f.ctx), { message: /^no fire protection offer for the nether set's diamond_leggings \(19: protection 2, 30: blast_protection 4 \| .*\); the seed turned with 2 books .*; into the chest at \(-547, 64, 2182\)$/ });
  t.is(f.calls.filter(c => c.startsWith('enchant.choose')).length, NETHER_REROLLS, 'only the books');
  t.true(f.chests.get(key(GEAR))!.some(st => st.name === 'diamond_leggings' && !st.enchantments), 'plain, in the chests again');
  t.false(f.inv.some(i => i.name === 'diamond_leggings' && i.slot < 36));
});

// ------------------------------------------------------------------------------------------------ the anvil's book choice

const bookStack = (slot: number, s: string): ChestStack => ({ slot, name: 'enchanted_book', count: 1, enchantments: en(s) });
const stored = (w: WorldMemory) => [
  ...Object.entries(w.chestStacks ?? {}).flatMap(([k, list]) => list.filter(st => st.name === 'enchanted_book' || st.name === 'diamond' || st.name === 'gold_ingot')
    .map(stack => ({ chest: w.landmarks.chests.find(c => key(c) === k)!, stack }))),
  ...storedNetherPieces(w)
];

test('the anvil\'s book choice per set: fire protection onto the Nether set\'s piece in its chest, never the main set; protection onto the main set, never the Nether set\'s; mending to the Nether set first', (t) => {
  const items = MAIN();
  const w = homeWorld({ [key(GEAR)]: [piece(4, 'diamond_chestplate', 'fire_protection 3, unbreaking 3'), ...SPARES], [key(BOOKS)]: [bookStack(0, 'fire_protection 4'), bookStack(1, 'protection 4')] });
  const plan = anvilPlan(items, stored(w), 45, { now: T0 });
  t.like(plan, { job: 'book', at: GEAR, piece: { name: 'diamond_chestplate', slot: 4 }, add: { chest: BOOKS, slot: 0 }, for: [{ name: 'fire_protection', level: 4 }] });
  t.is(describe(plan!), 'fire_protection 4 onto the nether set\'s diamond_chestplate (in its chest)');
  // that pair tried: the protection book goes onto the main set (the chestplate's 3 raised), never the Nether set's
  const next = anvilPlan(items, stored(w), 45, { now: T0, tried: { [plan!.key]: { why: 'no result', at: T0 } } });
  t.like(next, { job: 'book', piece: { name: 'diamond_chestplate', slot: 38 }, add: { slot: 1 }, for: [{ name: 'protection', level: 4 }] });
  t.is(describe(next!), 'protection 4 onto the diamond_chestplate (worn)');
  // with no Nether piece: a fire protection book has no use at all (it would shut protection out of the main set)
  const bare = homeWorld({ [key(BOOKS)]: [bookStack(0, 'fire_protection 4')] });
  t.is(anvilPlan(items, stored(bare), 45, { now: T0 }), undefined);
  t.false(bookOfUse(items, { enchantments: en('fire_protection 4') }));
  t.true(bookOfUse(items, { enchantments: en('fire_protection 4') }, storedNetherPieces(w)));
  // only protection books and the main set at its best: no job on the Nether set's piece
  const maxed = MAIN().map(i => (i.slot >= 36 ? { ...i, enchantments: en('protection 4, unbreaking 3, mending 1') } : i));
  const prot = homeWorld({ [key(GEAR)]: [piece(4, 'diamond_chestplate', 'fire_protection 3, unbreaking 3')], [key(BOOKS)]: [bookStack(0, 'protection 4')] });
  t.is(anvilPlan(maxed, stored(prot), 45, { now: T0 }), undefined);
  t.false(bookOfUse(maxed, { enchantments: en('protection 4') }, storedNetherPieces(prot)));
  // mending: the Nether set's chestplate first (the user's priority), then the main set's
  const mend = homeWorld({ [key(GEAR)]: [piece(4, 'diamond_chestplate', 'fire_protection 4, unbreaking 3')], [key(BOOKS)]: [bookStack(0, 'mending 1')] });
  t.like(anvilPlan(items, stored(mend), 45, { now: T0 }), { job: 'mending', at: GEAR, piece: { slot: 4 } });
  // what each piece wants
  t.deepEqual({ ...wantedFor(NSET.boots(4)) }, { ...NETHER_WANTED.boots });
  t.deepEqual({ ...wantedFor(MAIN()[3]) }, { ...WANTED.boots });
});

test('the anvil mends the Nether set\'s golden helmet with gold ingots over the barter\'s reserve; diamonds for its diamond pieces', (t) => {
  t.is(GOLD_KEPT, GOLD_RESERVE);
  const worn = { ...NSET.helmet(4), damage: 70, maxDamage: 77 };
  const items = MAIN().map(i => (i.slot >= 36 ? { ...i, enchantments: en('protection 4, unbreaking 3, mending 1') } : i));
  const w = homeWorld({ [key(GEAR)]: [worn, { slot: 9, name: 'gold_ingot', count: 30 }] });
  const plan = anvilPlan(items, stored(w), 45, { now: T0, gold: 30 - GOLD_KEPT, diamonds: 0 });
  t.like(plan, { job: 'repair', at: GEAR, piece: { name: 'golden_helmet' }, add: { name: 'gold_ingot', count: 4 } });
  t.regex(describe(plan!), /^repair the nether set's golden_helmet \(in its chest\) \(9% left\) with 4 gold ingots$/);
  t.is(anvilPlan(items, stored(w), 45, { now: T0, gold: 3, diamonds: 0 }), undefined, 'three over the reserve: not enough');
  const boots = { ...NSET.boots(5), damage: 400, maxDamage: 429 };
  const w2 = homeWorld({ [key(GEAR)]: [boots, { slot: 9, name: 'diamond', count: 30 }] });
  t.like(anvilPlan(items, stored(w2), 45, { now: T0, diamonds: 30 }), { job: 'repair', at: GEAR, piece: { name: 'diamond_boots' }, add: { name: 'diamond', count: 4 } });
});

test('the anvil\'s run on the Nether set\'s piece: out of its chest by its slot, the book on at the anvil, back into the chests with it; the main set worn throughout', async (t) => {
  const w = homeWorld({ [key(GEAR)]: [piece(4, 'diamond_boots', 'fire_protection 4, unbreaking 3'), ...SPARES], [key(BOOKS)]: [bookStack(0, 'feather_falling 4')] });
  const items = MAIN().map(i => (i.slot >= 36 ? { ...i, enchantments: en('protection 4, unbreaking 3, mending 1') } : i));
  const f = home(items, w);
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
  t.is(text, 'feather_falling 4 onto the nether set\'s diamond_boots (cost 6, level 45 -> 39); back into the chests');
  const boots = f.chests.get(key(GEAR))!.find(st => st.name === 'diamond_boots' && netherSetPiece(st));
  t.deepEqual(boots?.enchantments, en('fire_protection 4, unbreaking 3, feather_falling 4'));
  t.false(f.inv.some(i => i.slot < 36 && i.name === 'diamond_boots'), 'not left carried');
  t.deepEqual(f.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'diamond_helmet']);
  for (const sp of SPARES) t.true(f.chests.get(key(GEAR))!.some(st => st.slot === sp.slot && st.name === sp.name), sp.name);
});

// ------------------------------------------------------------------------------------------------ the swap

const setWorld = () => homeWorld({ [key(GEAR)]: [NSET.chestplate(2), NSET.leggings(3), NSET.boots(4), NSET.helmet(5), ...SPARES] });

test.serial('the swap at home before the portal: the Nether set out of the chests and on (the golden helmet its helmet), the main set into the gear chests by their slots and remembered; the spare set untouched', async (t) => {
  const w = setWorld();
  const f = home(MAIN(), w);
  t.is(await wearNetherSet(f.ctx), undefined);
  t.deepEqual(f.worn(), ['diamond_boots (nether)', 'diamond_leggings (nether)', 'diamond_chestplate (nether)', 'golden_helmet (nether)']);
  t.true(f.calls.includes('armor.wearset {"set":"nether"}'));
  // the main set in the chest, each remembered by its chest and slot with its enchantments
  t.deepEqual(w.gearSwap?.stored.map(p => `${p.name} ${p.enchantments?.map(e => `${e.name} ${e.level}`).join('+')}`).sort(), [
    'diamond_boots protection 4+depth_strider 3+unbreaking 3', 'diamond_chestplate protection 3+unbreaking 3+thorns 2', 'diamond_helmet protection 4+unbreaking 3', 'diamond_leggings protection 3+unbreaking 3'
  ]);
  t.like(w.gearSwap, { wearing: 'nether' });
  t.false(f.inv.some(i => i.slot < 36 && /_(helmet|chestplate|leggings|boots)$/.test(i.name)), 'nothing of the main set carried down there');
  t.true(f.said.some(l => l.startsWith('nether set: wearing golden_helmet, diamond_chestplate, diamond_leggings, diamond_boots; the main ')), f.said.join(' | '));
  for (const sp of SPARES) t.true(f.chests.get(key(GEAR))!.some(st => st.slot === sp.slot && st.name === sp.name && !st.enchantments), sp.name);
  t.deepEqual(w.spareSet, spareRecord());
  // the kit took a plain golden helmet (by name) while the set's lies in the chest: the set's goes on, the plain one
  // back into the chest (the trip's 12 free slots were counted without it), and neither is remembered as the main set's
  const gold = setWorld();
  const h = home([...MAIN(), piece(30, 'golden_helmet')], gold);
  t.is(await wearNetherSet(h.ctx), undefined);
  t.is(h.worn()[3], 'golden_helmet (nether)');
  t.true(netherSetPiece(h.inv.find(i => i.slot === 39)!));
  t.false(h.inv.some(i => i.slot < 36 && i.name === 'golden_helmet'));
  t.true(h.chests.get(key(GEAR))!.some(st => st.name === 'golden_helmet' && !st.enchantments));
  t.false(gold.gearSwap!.stored.some(p => p.name === 'golden_helmet'));
  // a part set: the kinds it has no piece of keep the main piece on, and go down as before
  const part = homeWorld({ [key(GEAR)]: [NSET.chestplate(2), ...SPARES] });
  const g = home(MAIN(), part);
  t.is(await wearNetherSet(g.ctx), undefined);
  t.deepEqual(g.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate (nether)', 'diamond_helmet']);
  t.deepEqual(part.gearSwap?.stored.map(p => p.name), ['diamond_chestplate']);
});

test.serial('the swap back at home: the main set out of the chests where the swap put it and on again, the Nether set into the chests, the record let go; never in the Nether, never while a run is under way', async (t) => {
  const w = setWorld();
  const f = home(MAIN(), w);
  await wearNetherSet(f.ctx);
  // the trip's own run walked to the portal: nothing swapped back meanwhile
  afield.work = true;
  t.is(homeSetWant(f.look(), w), null);
  afield.work = false;
  // down there: never
  f.state.dim = NETHER;
  t.is(homeSetWant(f.look({ dimension: NETHER, distHome: Infinity }), w), null);
  t.deepEqual(f.worn(), ['diamond_boots (nether)', 'diamond_leggings (nether)', 'diamond_chestplate (nether)', 'golden_helmet (nether)']);
  // home again
  f.state.dim = OVERWORLD;
  f.ctx.s = f.look();
  t.is(homeSetGoal.wants(f.ctx.s, w), 'home: the main set on again (the nether set\'s golden_helmet, diamond_chestplate, diamond_leggings, diamond_boots worn)');
  const text = await homeSetGoal.run(f.ctx);
  t.regex(text, /^wore .*diamond_chestplate.* again; the nether set's .* into the chests$/);
  t.deepEqual(f.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'diamond_helmet']);
  t.deepEqual(f.inv.filter(i => i.slot >= 36).map(i => i.enchantments?.[0]?.name), ['protection', 'protection', 'protection', 'protection']);
  t.is(w.gearSwap, undefined);
  t.true(f.calls.includes('armor.wearset {"set":"main"}'));
  t.is(storedNetherPieces(w).length, 4, 'the Nether set in the chests again');
  t.false(f.inv.some(i => i.slot < 36 && isNetherPiece(i)));
  for (const sp of SPARES) t.true(f.chests.get(key(GEAR))!.some(st => st.slot === sp.slot && st.name === sp.name && !st.enchantments), sp.name);
  t.deepEqual(w.spareSet, spareRecord());
  f.ctx.s = f.look();
  t.is(homeSetGoal.wants(f.ctx.s, w), null, 'done: nothing more');
});

test.serial('a death down there loses the Nether set only: home, the main set comes out of the chests and on before the regear, which then has no armour to take from the spare set', async (t) => {
  const w = setWorld();
  const f = home(MAIN(), w);
  await wearNetherSet(f.ctx);
  // died in the Nether: the pockets and the armour gone with it, respawned at home's bed
  f.inv.splice(0, f.inv.length);
  netherOf(w).deaths = [{ at: T0 - 60_000, where: { x: -70, y: 70, z: 260 } }];
  f.ctx.s = f.look();
  t.regex(homeSetGoal.wants(f.ctx.s, w) ?? '', /^home: the main set on again$/);
  t.true(homeSetGoal.priority > 72, 'above the regear (72) and the kit (70)');
  await homeSetGoal.run(f.ctx);
  t.deepEqual(f.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'diamond_helmet']);
  t.is(w.gearSwap, undefined);
  // the regear's spare set (its armour here): nothing of it taken, the main set is on
  t.deepEqual(regearPieces(f.inv, w).map(p => p.name), []);
  t.deepEqual(w.spareSet, spareRecord(), 'the spare set as it was');
});

test.serial('dressed for the Nether at home, the kit counts the main set the swap stored as carried: no diamond helmet "upgrade" over the golden one, which stopped the trip by home (the swap back, then the swap again); and it cuts no run dressed so', async (t) => {
  // (live: a plain diamond helmet besides the spare set's in the gear chest, as at -547,64,2182 slot 22)
  const w = homeWorld({ [key(GEAR)]: [NSET.chestplate(2), NSET.leggings(3), NSET.boots(4), NSET.helmet(5), { slot: 8, name: 'diamond_helmet', count: 1 }, ...SPARES] });
  const f = home(MAIN(), w);
  const before = f.look();
  afield.work = afield.trip = true;
  try {
    t.is(kit.wants(before, w), null, 'the main set worn: nothing');
    t.true(kit.cuts!(before, w), 'a trip run not dressed for the Nether: cut as ever (the brain rules on one out)');
    await wearNetherSet(f.ctx);
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
  const f = home(MAIN(), w, { oldJar: true });
  t.is(await wearNetherSet(f.ctx), undefined);
  t.deepEqual(f.worn(), ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'diamond_helmet']);
  t.is(w.gearSwap, undefined);
  t.false(f.calls.some(c => c.startsWith('chest.')));
  t.true(f.said.includes('nether set: this jar cannot swap armour sets (no armor.wearset): the main set goes along'));
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

test.serial('the swap back takes out only a main piece the Guardian wears over the one on: a fire protection diamond chestplate worn, a plain iron one in the chests, is no swap back (it came back every 5 minutes, the iron one in and out of its chest)', async (t) => {
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
  const plainDiamond = homeWorld({ [key(GEAR)]: [{ slot: 2, name: 'diamond_chestplate', count: 1 }, ...SPARES] });
  t.is(homeSetWant(home(items, plainDiamond).look(), plainDiamond), 'home: the main set on again (the nether set\'s diamond_chestplate worn)');
  // the golden helmet worn: an iron helmet goes on over it, a copper one (the same tier to the Guardian) does not
  const gold = piece(39, 'golden_helmet');
  t.true(wornOver({ name: 'iron_helmet' }, gold));
  t.false(wornOver({ name: 'copper_helmet' }, gold));
  t.false(wornOver({ name: 'leather_helmet', enchantments: en('protection 4, unbreaking 3') }, gold));
  t.false(wornOver({ name: 'diamond_helmet', enchantments: en('binding_curse 1') }), 'bound by its curse: the Guardian never puts it on');
  for (const i of [fp, gold, ...MAIN().filter(m => m.slot >= 36), NSET.helmet(1)]) t.is(mainRank(i), rank(i, false), i.name);
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

test('the table\'s run for the Nether set with the book chore\'s pile in store (24 books): its books still turn the seed, up to twice that pile', async (t) => {
  const pile = (n: number) => Array.from({ length: n }, (_, i) => bookStack(i, 'bane_of_arthropods 2'));
  const book = [{ slot: 2, cost: 30, enchant: 'sharpness' }];
  const seeds = [
    { offers: [{ slot: 1, cost: 19, enchant: 'protection', level: 2 }, { slot: 2, cost: 30, enchant: 'protection', level: 4 }], book },
    { offers: [{ slot: 1, cost: 18, enchant: 'fire_protection', level: 2 }, { slot: 2, cost: 30, enchant: 'fire_protection', level: 3 }], book }
  ];
  t.is(NETHER_BOOK_PILE, 48);
  const w = homeWorld({ [key(GEAR)]: [...SPARES], [key(BOOKS)]: pile(24) });
  const f = home([...MAIN(), { slot: 14, name: 'diamond', count: 64 }, { slot: 15, name: 'book', count: 2 }], w, { seeds, results: [en('fire_protection 3, unbreaking 2')] });
  f.ctx.s = f.look();
  t.regex(await enchantGoal.run(f.ctx), /^enchanted the nether set's diamond_chestplate: fire_protection 3, unbreaking 2; the seed turned with 1 book /);
  // at twice the pile: no more books, the run fails on the offers it sees (the retry time)
  const full = homeWorld({ [key(GEAR)]: [...SPARES], [key(BOOKS)]: pile(26) });
  full.chestStacks![key(BOOKS)].push(...pile(22).map((b, i) => ({ ...b, slot: 26 + i })));
  full.chestItems![key(BOOKS)].enchanted_book = 48;
  const g = home([...MAIN(), { slot: 14, name: 'diamond', count: 64 }, { slot: 15, name: 'book', count: 2 }], full, { seeds });
  g.ctx.s = g.look();
  await t.throwsAsync(enchantGoal.run(g.ctx), { message: /^no fire protection offer for the nether set's diamond_chestplate \(19: protection 2, 30: protection 4\); into the chest/ });
});
