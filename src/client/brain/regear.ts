/**
 * The regear after a death in the Nether (P2b of the progression plan). Gear lost down there is not gone after (the
 * user's call: no walk back into the Nether for it, recover leaves such a death alone): the bot wears the spare
 * diamond set the portal milestone put by instead, each piece taken by its chest and the chest's own slot (chests.ts
 * SpareSet, takeSlot: the plain spare, never another of its name), ahead of the kit, which would otherwise craft a new
 * set from the diamonds. Then a small chore makes the Nether's things whole again for the next trips: a new spare set
 * when the diamonds allow it (the anvil's repairs and the plan's netherite kept aside), a golden helmet and a flint
 * and steel when none is left (the milestone that made them is done and makes nothing again), and the obsidian of its
 * own portal's frame while that is still to build and the chests lack it (a death on the setup trip lost what it
 * carried, and the portal milestone gathered exactly the frame's 10).
 *
 * Both wait for what only the Nether brings about: the regear for a death down there, the chore for the nether-trips
 * switch. With the switch off and no death in the Nether neither ever wants.
 */
import type { InventoryItem } from '../tools.js';
import { nearHome, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';
import { NEAR_HOME, inYardOrNear } from './pockets.js';
import { clock } from './idlelog.js';
import { freeChestTotals, key, peekChest, spareHeld, sparePieces, takeSlot, type SparePiece } from './chests.js';
import { carriedKit, gearKind } from './kit.js';
import { ownItems } from './community.js';
import { prepare } from './project.js';
import { holdHarmless } from './fluidpick.js';
import { OBSIDIAN_BATCH, SPARE_SET, spareSetStep, tripsOn } from './portal.js';
import { obsidianStep } from './cast.js';
import { netherOf, peekNether, type NetherDeath } from './nether.js';
import { findKit, setupObsidian, setupOpen } from './nethersetup.js';

const MINUTE = 60_000;

/** A death in the Nether this long ago or more is regeared for no more: the kit has made the bot whole by then. */
export const REGEAR_WITHIN_MS = 60 * MINUTE;
/** The waits for the Guardian to put the armour on (it looks every 2 s with no screen open); a test sets them to nothing. */
export const REGEAR_WAITS = { pollMs: 2000, tries: 4 };
/**
 * Diamonds the new spare set leaves in the chests: the anvil's repairs (up to 4 a piece for each of its six kinds,
 * anvil.ts repairUnits and ANVIL_ORDER) and the 28 the plan's netherite takes (P6: four templates' copies).
 */
export const DIAMONDS_KEPT = { repairs: 24, netherite: 28 };
/** A golden helmet's gold: five ingots (smelted from the raw gold by prepare where the ingots are short). */
const HELMET_GOLD = 5;

const ARMOUR = new Set(['helmet', 'chestplate', 'leggings', 'boots']);
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const atHome = (s: Snapshot) => !s.sleeping && s.dimension === 'overworld' && !!s.home && nearHome(s, NEAR_HOME);
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> =>
  (await ctx.call<{ items: InventoryItem[] }>('inventory').catch(() => ({ items: [] as InventoryItem[] }))).items ?? [];
const samePiece = (a: SparePiece, b: SparePiece) => a.name === b.name && a.slot === b.slot && key(a.chest) === key(b.chest);

// ------------------------------------------------------------------------------------------------ the regear

/** The newest death in the Nether not regeared for yet, within REGEAR_WITHIN_MS; undefined with none. */
export function deathToRegear(s: Pick<Snapshot, 'now'>, world: WorldMemory): NetherDeath | undefined {
  const n = peekNether(world);
  const last = [...n.deaths].sort((a, b) => b.at - a.at)[0];
  if (!last || s.now - last.at >= REGEAR_WITHIN_MS || (n.regearedFor !== undefined && n.regearedFor >= last.at)) return undefined;
  return last;
}

/**
 * The spare set's pieces still in their chests whose kind the bot has none of now, carried or worn (what the death
 * took): what the regear takes, one a kind. A kind it has again (the kit made one first) keeps its spare.
 */
export function regearPieces(items: InventoryItem[], world: WorldMemory): SparePiece[] {
  const { best } = carriedKit(items);
  const kinds = new Set<string>();
  return spareHeld(world).filter(p => {
    const kind = gearKind(p.name);
    if (!kind || best[kind] || kinds.has(kind)) return false;
    kinds.add(kind);
    return true;
  });
}

const worn = (items: InventoryItem[], name: string) => items.some(i => i.slot >= 36 && i.slot <= 39 && i.name === name);

/**
 * Wear the spare set after a death in the Nether (72: above the kit, which would craft a new set from the diamonds
 * first, below food and every survival goal). Awake in the yard, within an hour of the death, while a kind the death
 * took has its spare piece in the chests. Each piece out by its chest and slot (the chest looked into first where its
 * memory does not hold that slot's stack), the armour put on by the Guardian (waited for), the pieces taken let go
 * of as the set's, the death marked seen to. Says `regear: wore the spare diamond set after a death in the nether`
 * when the whole set came, else which pieces came and which the kit makes. Nothing taken at all: a failure (the
 * retry time, then again).
 */
export const regearGoal: Goal = {
  name: 'regear',
  priority: 72,
  timeoutMs: 3 * MINUTE,
  retryMs: 5 * MINUTE,
  wants: (s, world) => {
    // from anywhere in the yard (it wakes at the bed, 16 from home): the chests' walk is takeSlot's own, and the trip
    // kit's rung, which takes armour from the yard, must not make the bot whole from the diamonds first
    if (s.sleeping || s.dimension !== 'overworld' || !inYardOrNear(s, world)) return null;
    const d = deathToRegear(s, world);
    if (!d) return null;
    const pieces = regearPieces(s.items, world);
    return pieces.length ? `after the death in the nether at ${clock(d.at)}: the spare ${pieces.map(p => p.name).join(', ')}` : null;
  },
  run: async ctx => {
    const d = deathToRegear(ctx.s, ctx.world);
    if (!d) return 'no death in the nether to regear for';
    const before = await inventory(ctx);
    const pieces = regearPieces(before, ctx.world);
    if (!pieces.length) return 'nothing of the spare set to take';
    const took: SparePiece[] = [];
    const failed: string[] = [];
    for (const p of pieces) {
      if (ctx.signal.aborted) throw new Error('aborted');
      // takeSlot takes only what the chest's memory holds in that slot: a text reply let go of its stacks
      if (!ctx.world.chestStacks?.[key(p.chest)]?.some(st => st.slot === p.slot && st.name === p.name)) await peekChest(ctx, p.chest).catch(() => undefined);
      const got = await takeSlot(ctx, p.chest, p.slot, 1).catch((e: Error) => { failed.push(`${p.name}: ${e.message}`); return -1; });
      if (got > 0) took.push(p);
      else if (got === 0) failed.push(`${p.name}: not in slot ${p.slot} of its chest`);
    }
    if (!took.length) throw new Error(`no spare piece came out of the chests: ${failed.join('; ')}`);
    // taken out, they are the set's no more: the chore makes it again (and a plain piece the stash puts back in that
    // slot one day is no spare)
    if (ctx.world.spareSet) ctx.world.spareSet = { ...ctx.world.spareSet, pieces: sparePieces(ctx.world).filter(p => !took.some(t => samePiece(t, p))) };
    netherOf(ctx.world).regearedFor = d.at;
    const armour = took.filter(p => ARMOUR.has(gearKind(p.name) ?? ''));
    let items = await inventory(ctx);
    for (let i = 0; i < REGEAR_WAITS.tries && armour.some(p => !worn(items, p.name)); i++) {
      await pause(REGEAR_WAITS.pollMs);
      if (ctx.signal.aborted) throw new Error('aborted');
      items = await inventory(ctx);
    }
    const on = armour.filter(p => worn(items, p.name)).map(p => p.name);
    const off = armour.filter(p => !worn(items, p.name)).map(p => p.name);
    const tools = took.filter(p => !ARMOUR.has(gearKind(p.name) ?? '')).map(p => p.name);
    // what the death took that no spare made good: the kit's to make
    const { best } = carriedKit(items);
    const short = SPARE_SET.filter(p => { const kind = gearKind(p.name); return !!kind && !best[kind]; }).map(p => p.name);
    const whole = took.length === SPARE_SET.length && !off.length;
    const line = whole ? 'regear: wore the spare diamond set after a death in the nether'
      : `regear: after a death in the nether, ${on.length ? `wore the spare ${on.join(', ')}` : 'wore no spare piece'}` +
        `${tools.length ? `, took the spare ${tools.join(', ')}` : ''}${off.length ? `; not on yet: ${off.join(', ')}` : ''}` +
        `${short.length ? `; still short of ${short.join(', ')} (the kit makes them)` : ''}`;
    ctx.progress(line);
    return line.replace(/^regear: /, '');
  }
};

// ------------------------------------------------------------------------------------------------ the chore

/** What the chore would make now, read off the pockets and the chests' memory: the spare pieces missing and their diamonds, the helmet, the flint, the frame's obsidian. */
export interface SparesShort {
  pieces: { name: string; diamonds: number }[];
  /** the diamonds over those kept (DIAMONDS_KEPT), carried and in the chests (the jobs' and the missions' left alone) */
  surplus: number;
  helmet: boolean;
  flint: boolean;
  /** obsidian short of what its own portal's frame still needs (nethersetup.ts setupObsidian), carried and in the chests */
  obsidian: number;
}

export function sparesShort(s: Pick<Snapshot, 'items'>, world: WorldMemory): SparesShort {
  const free = freeChestTotals(world);
  const own = ownItems(s.items, world);
  const has = (n: string) => own.filter(i => i.name === n).reduce((a, i) => a + i.count, 0) + (free[n] ?? 0);
  const held = spareHeld(world);
  const pieces = SPARE_SET.filter(p => !held.some(h => h.name === p.name)).map(p => ({ name: p.name, diamonds: p.diamonds }));
  return {
    pieces,
    surplus: has('diamond') - DIAMONDS_KEPT.repairs - DIAMONDS_KEPT.netherite,
    helmet: has('golden_helmet') < 1 && has('gold_ingot') + has('raw_gold') >= HELMET_GOLD,
    flint: has('flint_and_steel') < 1 && has('iron_ingot') + has('raw_iron') >= 1 && has('flint') >= 1,
    obsidian: setupOpen(world) ? Math.max(0, setupObsidian(world) - has('obsidian')) : 0
  };
}

/** The spare pieces the diamonds allow now: all that are missing, or none (a set half made waits for the diamonds). */
const sparesDue = (k: SparesShort) => (k.pieces.length && k.pieces.reduce((a, p) => a + p.diamonds, 0) <= k.surplus ? k.pieces : []);

/** Why the chore wants to run, or null: the switch on and the portal milestone done, at home, the chests all looked into, something to make. */
export function sparesWant(s: Snapshot, world: WorldMemory): string | null {
  if (!tripsOn(world) || !(world.progress?.done ?? []).includes('nether-portal') || !atHome(s)) return null;
  if (world.landmarks.chests.some(c => !world.chestItems?.[key(c)])) return null;
  const k = sparesShort(s, world);
  const due = sparesDue(k);
  const parts = [
    ...(due.length ? [`the spare ${due.map(p => p.name).join(', ')} (${due.reduce((a, p) => a + p.diamonds, 0)} of the ${k.surplus} diamonds over the ${DIAMONDS_KEPT.repairs + DIAMONDS_KEPT.netherite} kept)`] : []),
    ...(k.helmet ? ['a golden helmet'] : []),
    ...(k.flint ? ['a flint and steel'] : []),
    ...(k.obsidian ? [`${k.obsidian} obsidian for its own portal's frame`] : [])
  ];
  return parts.length ? `for the nether trips: ${parts.join(', ')}` : null;
}

/**
 * The Nether's things made whole again (32: a chore that can always wait; it stops nothing and takes over at the
 * hand-over): the spare set's missing pieces by the portal milestone's own step (crafted, stored by their slots,
 * remembered as the set) once the diamonds over those kept pay for them all, never a piece the record holds before its
 * chest is looked into again (the step's); a golden helmet and a flint and steel when none is carried or stored, the
 * chests looked into first (nethersetup.ts findKit: live on Nov 15 it crafted both again 3 s after the barter's takes
 * found neither where the memory had them); the obsidian its own portal's frame still needs, OBSIDIAN_BATCH a run, by
 * the portal milestone's own obsidian step (dug where no portal owns it, else cast at home from lava). A run that made
 * or found none of it fails (its retry time).
 */
export const netherSparesGoal: Goal = {
  name: 'nether spares',
  priority: 32,
  // (a batch of obsidian cast from the remembered lava pool: the portal milestone's own runs took up to 9 min)
  timeoutMs: 12 * MINUTE,
  retryMs: 20 * MINUTE,
  cuts: () => false,
  wants: (s, world) => sparesWant(s, world),
  run: async ctx => {
    let k = sparesShort({ items: await inventory(ctx) }, ctx.world);
    const did: string[] = [];
    let made = 0;
    if (sparesDue(k).length) {
      const r = await spareSetStep.run(ctx, { step: 0, data: {} });
      did.push(r.text);
      if (r.status !== 'blocked') made++;
    }
    // what the chests' memory has none of may yet be in them: looked for before anything is crafted
    const lost = [...(k.helmet ? ['golden_helmet'] : []), ...(k.flint ? ['flint_and_steel'] : [])];
    if (lost.length && !ctx.signal.aborted) {
      const seen = await findKit(ctx, lost);
      for (const f of seen) did.push(`${f.name === 'golden_helmet' ? 'a golden helmet' : 'a flint and steel'} in the chest at (${f.chest.x}, ${f.chest.y}, ${f.chest.z}) after all`);
      made += seen.length;
      k = sparesShort({ items: await inventory(ctx) }, ctx.world);
    }
    for (const [want, item, what] of [[k.helmet, 'golden_helmet', 'a golden helmet'], [k.flint, 'flint_and_steel', 'a flint and steel']] as const) {
      if (!want || ctx.signal.aborted) continue;
      const short = await prepare(ctx, item, 1);
      // (a fire starter crafted lands where the hand may be: out of it before anything walks on, F1's guard)
      await holdHarmless(ctx);
      const left = Object.entries(short);
      did.push(left.length ? `${what}: short of ${left.map(([n, c]) => `${c} ${n}`).join(', ')}` : `crafted ${what} for the nether`);
      if (!left.length) made++;
    }
    if (k.obsidian && !ctx.signal.aborted) {
      // the frame's whole need carried at the end (the step takes what the chests hold first, then a batch more). The
      // step marks obsidian carried for a milestone's build; there is none in hand here, so that mark is put back as
      // it was: the stash may put the obsidian away between batches, and the next batch or the setup's kit takes it out
      const carry = ctx.world.progress?.carry;
      try {
        const r = await obsidianStep('nether-portal', setupObsidian(ctx.world), { name: 'obsidian for its own portal\'s frame', batch: OBSIDIAN_BATCH }).run(ctx, { step: 0, data: {} });
        did.push(`obsidian for its own portal's frame: ${r.text}`);
        if (r.status !== 'blocked') made++;
      } finally {
        if (ctx.world.progress) ctx.world.progress.carry = carry;
      }
    }
    if (!made) throw new Error(did.join('; ') || 'nothing to make');
    return did.join('; ');
  }
};
