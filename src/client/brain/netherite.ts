import {
  NETHERITE_INGOT, NETHERITE_TEMPLATE, brainRun, netheriteOf, smithTableText, smithingText,
  type InventoryItem, type ItemEnchantment, type SmithClosed, type SmithPut, type SmithStatus, type SmithTake
} from '../tools.js';
import type { Goal, GoalContext, Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { RECIPES, type Milestone, type Step, type StepResult } from './progress.js';
import { prepare } from './project.js';
import { freeChestTotals } from './chests.js';
import { better, fireProtected, type ArmourKind } from './kit.js';
import { wornSlot } from './enchant.js';
import { withSwapped } from './netherset.js';
import { holdHarmless } from './fluidpick.js';
import { goHome } from './homeward.js';
import { inFence } from './yardgates.js';
import { REPAIR_BELOW } from './anvil.js';

/**
 * Netherite (P6 of the progression plan): the chain from the Nether's ancient debris to the main set's four netherite
 * pieces, and the milestone that smiths them one by one at the workshop's smithing table (client-mod Smithing.java).
 *
 * - **The chain.** Ancient debris (the tunnels at y 15 bring it: nethertunnel.ts, the user's decision 5 of Nov 17)
 *   smelts into netherite scrap (project.ts SMELTED; the smelt goal loads what comes home, chores.ts ORES); four scrap
 *   and four gold ingots make an ingot (progress.ts RECIPES, at a table). One ingot a piece: 16 debris and 16 gold for
 *   the four (the tunnel's DEBRIS_WANT, the barter's GOLD.netherite).
 * - **The template.** One upgrade template a piece, used up by the smithing. Nothing makes the first: a bastion's
 *   treasure chest has one (the bastion work, the user's choice of Nov 13). Each copy is seven diamonds, a netherrack
 *   and a template for two (RECIPES; the 28 diamonds of regear.ts DIAMONDS_KEPT.netherite are the four copies), and
 *   TEMPLATE_SPARE stays at home always: a copy is made when the home has only that one, before the piece takes one,
 *   so the last template is never used up and the next bastion is never the only way on.
 * - **The milestone** (netheriteMilestone, after the brewing: the bastion and the tunnel go under its potions). One
 *   step a piece, in PIECES' order: the chestplate (it covers the most), the leggings, the boots, then the main diamond
 *   helmet. The golden helmet of the Nether stays gold (the piglins leave a player in gold alone, netherset.ts): only
 *   the main set is smithed. A worn piece comes off at the table (armor.unequip, held off the Guardian's gear check),
 *   the template, the piece and the ingot go in, the result is taken only if it is the netherite piece (smith.take's
 *   `expect`), and smith.close wears it again. The upgrade keeps every enchantment, the damage and the repair cost (the
 *   26.3 recipe's createWithOriginalComponents), so the fire gear's protection 4 stays (netherset.ts fireGear counts
 *   netherite as diamond or better). Logged: `smithing: diamond_chestplate -> netherite_chestplate (protection 4,
 *   unbreaking 3, mending kept)`.
 * - **What it waits for** (Step.waits: no step of the project can bring it about): mending on the diamond piece (no
 *   other repair reaches a netherite piece: unfitToSmith) and the piece above REPAIR_BELOW, a template at home, an
 *   ingot's makings (an ingot, or its four scrap or debris), and for the helmet the main helmet back from the Nether swap.
 *   netheriteNeed says what is short, for the bastion's want (its template); the tunnels already dig toward the four
 *   ingots' 16 debris on their own count (nethertunnel.ts DEBRIS_WANT, the pieces made counted).
 */

const MINUTE = 60_000;
export const ID = 'netherite';

/** The main set's pieces smithed, in the milestone's order: the chestplate first (it covers the most), the helmet last. */
export const PIECES: readonly ArmourKind[] = ['chestplate', 'leggings', 'boots', 'helmet'];
/** Templates the home always keeps (the plan's "1 spare always"): a copy is made before the last one would be used. */
export const TEMPLATE_SPARE = 1;
/**
 * What a copy of the template takes beside a template (RECIPES has the same): seven diamonds and a netherrack, for two.
 * Written out, as INGOT_SCRAP is: nothing here reads another module at its top level (tree.ts builds the milestone as
 * it loads).
 */
export const TEMPLATE_COPY: Readonly<Record<string, number>> = { diamond: 7, netherrack: 1 };
/** Scrap an ingot takes (RECIPES has the same): four, each smelted from a debris. */
export const INGOT_SCRAP = 4;
/** The debris the scrap is smelted from. */
export const DEBRIS = 'ancient_debris';
/**
 * How long a worn piece taken off for the table stays off whatever the Guardian's gear check would wear: the opening,
 * three puts (the last waits up to a second for the server's result) and the take. smith.close ends the hold and wears
 * the best again; this is only the backstop for a close that never reaches the client (as anvil.ts ANVIL_HOLD_MS).
 */
export const SMITH_HOLD_MS = 30_000;
/**
 * Pocket slots a piece's step fills at most: the templates, the copy's diamonds and netherrack, the scrap (or the
 * debris) and the gold, the ingot, and the worn piece taken off into one. Short of them the chest takes move fewer
 * than asked, and the step came back "short" of what the chests held.
 */
export const SMITH_SLOTS = 6;

const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const ok = (text: string): StepResult => ({ status: 'done', text });
const blocked = (text: string, retryMs = 10 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });
const shortOf = (text: string, need: Record<string, number>): StepResult => ({ status: 'blocked', text, retryMs: 3 * MINUTE, need });
const list = (short: Record<string, number>) => Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ');
const pocket = (i: Pick<InventoryItem, 'slot'>) => i.slot >= 0 && i.slot < 36;
const inYardBox = (p: { x: number; z: number }, y: NonNullable<WorldMemory['yard']>) => p.x >= y.x1 && p.x <= y.x2 && p.z >= y.z1 && p.z <= y.z2;
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> => (await ctx.call<{ items: InventoryItem[] }>('inventory')).items;
const carried = (items: readonly InventoryItem[], name: string) => items.filter(i => pocket(i) && i.name === name).reduce((a, i) => a + i.count, 0);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ------------------------------------------------------------------------------------------------ what there is, pure

/** How many of an item the home has: carried (the pockets) and in the chests beyond what the jobs hold (freeChestTotals). */
export function homeCount(items: readonly InventoryItem[], world: WorldMemory, name: string): number {
  return carried(items, name) + (freeChestTotals(world)[name] ?? 0);
}

/** Templates at home, carried and in the chests. */
export const templatesHome = (items: readonly InventoryItem[], world: WorldMemory) => homeCount(items, world, NETHERITE_TEMPLATE);

/** Ingots the home could have: those made, and one for each four of the scrap and the debris together. */
export function ingotsHome(items: readonly InventoryItem[], world: WorldMemory): number {
  const scrap = homeCount(items, world, 'netherite_scrap') + homeCount(items, world, DEBRIS);
  return homeCount(items, world, NETHERITE_INGOT) + Math.floor(scrap / INGOT_SCRAP);
}

/**
 * The netherite piece of a kind the bot has on it (worn, carried, or the main helmet put in the chests for a Nether
 * trip: netherset.ts withSwapped), or undefined. Pure.
 */
export function netheritePiece(items: readonly InventoryItem[], world: WorldMemory, kind: ArmourKind): InventoryItem | undefined {
  return withSwapped([...items], world).find(i => i.name === `netherite_${kind}` && (i.slot === -1 || pocket(i) || (i.slot >= 36 && i.slot <= 39)));
}

/**
 * The main set's diamond piece of a kind to smith (pure): the one worn, else the best carried (kit.ts better). Never
 * one with fire protection (an old Nether set's piece: the main set has protection), nor one bound by its curse (it
 * would never come off for the table). The golden helmet is no diamond piece: it stays gold.
 */
export function pieceToSmith(items: readonly InventoryItem[], kind: ArmourKind): InventoryItem | undefined {
  const name = `diamond_${kind}`;
  const fit = (i: InventoryItem) => i.name === name && !fireProtected(i) && !i.enchantments?.some(e => e.name === 'binding_curse');
  const worn = items.find(i => fit(i) && wornSlot(i));
  if (worn) return worn;
  return items.filter(i => pocket(i) && fit(i)).sort(better)[0];
}

const levelOf = (i: Pick<InventoryItem, 'enchantments'>, name: string) => i.enchantments?.find(e => e.name === name)?.level ?? 0;
const durabilityLeft = (i: Pick<InventoryItem, 'damage' | 'maxDamage'>) => (i.maxDamage ? 1 - (i.damage ?? 0) / i.maxDamage : 1);

/**
 * Why a diamond piece is not smithed yet, or undefined (pure). Nothing repairs a netherite piece here but mending: the
 * anvil mends diamond with diamonds and gold with gold ingots (anvil.ts repairWith), the debris the tunnels bring is the
 * four ingots' only, and the upgrade keeps the piece's repair cost; the Guardian keeps the best tier on until it breaks
 * (Combat.armorRank has no wear in it). A piece without mending smithed would wear out in a day or two of the main set's
 * wear and break, its enchantments, the template, the ingot and the copy's diamonds with it. So the piece waits for
 * mending (the anvil's mending book: the hall's librarian sells them, anvil.ts mendingLacking), and, as the upgrade
 * keeps the wear, for the anvil's repair below REPAIR_BELOW.
 */
export function unfitToSmith(piece: InventoryItem): string | undefined {
  if (!levelOf(piece, 'mending')) {
    return `the ${piece.name} has no mending: nothing else would repair the netherite piece (the anvil mends diamond with diamonds only), it waits for a mending book onto it`;
  }
  const left = durabilityLeft(piece);
  if (left < REPAIR_BELOW) return `the ${piece.name} has ${Math.floor(left * 100)}% of its durability left: the upgrade keeps the wear, it waits for the anvil's repair`;
  return undefined;
}

/** The pieces not yet netherite, in PIECES' order (pure). */
export function piecesLeft(items: readonly InventoryItem[], world: WorldMemory): ArmourKind[] {
  return PIECES.filter(k => !netheritePiece(items, world, k));
}

/**
 * What the netherite still wants from the Nether (pure), for the bastion's want: the pieces left; a
 * template while the home has none (the copies make the rest from it); the ingots short of the pieces left (each four
 * debris, its scrap counted). Nothing once every piece is netherite.
 */
export function netheriteNeed(items: readonly InventoryItem[], world: WorldMemory): { pieces: ArmourKind[]; templates: number; ingots: number; debris: number } {
  const pieces = piecesLeft(items, world);
  if (!pieces.length) return { pieces, templates: 0, ingots: 0, debris: 0 };
  const ingots = Math.max(0, pieces.length - ingotsHome(items, world));
  const scrap = homeCount(items, world, 'netherite_scrap') + homeCount(items, world, DEBRIS);
  const debris = ingots ? Math.max(0, ingots * INGOT_SCRAP - (scrap % INGOT_SCRAP)) : 0;
  return { pieces, templates: templatesHome(items, world) < 1 ? 1 : 0, ingots, debris };
}

/**
 * The smithing table to work at: the workshop's landmark, else one standing in the yard as the last look round home saw
 * it (findLandmarks: the improvement run's, which the workshop milestone counts as its own).
 */
export function smithingTable(world: WorldMemory): Pos | undefined {
  const own = world.zones?.['workshop:smithing']?.[0];
  if (own) return { x: own.x, y: own.y, z: own.z };
  const seen = world.landmarks.smithing;
  return seen && world.yard && inYardBox(seen, world.yard) ? { ...seen } : undefined;
}

/**
 * Why a piece's step cannot get on now, of what no step of the project brings about, or undefined (pure: the step's
 * `waits`, and its run's first look). The piece already netherite waits for nothing (its run says so and goes on).
 * In order: the main helmet away for the Nether (the swap back brings it, netherset.ts homeSetGoal); no diamond piece
 * of the kind in use; the piece without mending, or worn below REPAIR_BELOW (unfitToSmith); no template at home (the
 * bastion brings one); no ingot's makings at home (the tunnels bring the debris).
 */
export function pieceWaits(kind: ArmourKind, items: readonly InventoryItem[], world: WorldMemory): string | undefined {
  if (netheritePiece(items, world, kind)) return undefined;
  if (kind === 'helmet' && world.gearSwap?.wearing === 'nether') return 'the main helmet is in the chests for the Nether: it waits for the swap back home';
  const piece = pieceToSmith(items, kind);
  if (!piece) return `no diamond_${kind} worn or carried to smith`;
  const why = unfitToSmith(piece);
  if (why) return why;
  if (templatesHome(items, world) < 1) return `no ${NETHERITE_TEMPLATE} at home: a bastion's treasure chest has one`;
  if (ingotsHome(items, world) < 1) {
    const scrap = homeCount(items, world, 'netherite_scrap') + homeCount(items, world, DEBRIS);
    return `no ${NETHERITE_INGOT} at home, and ${scrap} of the ${INGOT_SCRAP} ancient debris (or scrap) one takes: the tunnels bring them`;
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------ at the table

/** One job at the smithing table: a diamond piece upgraded to netherite. */
export interface SmithJob {
  /** the table, within reach (the caller walks there first) */
  at: Pos;
  /** the diamond piece: by name, from pocket `slot` (0-35) of several by the name; `worn`: it comes off at the table first */
  base: string;
  slot?: number;
  worn?: 'head' | 'chest' | 'legs' | 'feet';
}

/** How a job ended: the take (the piece out, with its enchantments), or why the table gave nothing; `wore`: what smith.close put on again. */
export type SmithOutcome = ({ taken: true; take: SmithTake; before: ItemEnchantment[] } | { taken: false; text: string; status: SmithStatus }) & { wore: string[] };

/**
 * Do one job at the smithing table, from the opening to the close (as anvil.ts useAnvil): a worn piece taken off first
 * (armor.unequip shuts any open screen, and the table's menu has no armour slots), the template, the piece and the
 * ingot in, the result taken only if it is the netherite piece (`expect`: a trim template that strayed in would trim
 * the piece). A table that shows no result is no failure but `taken: false` with what it holds. The table is closed in
 * a finally, outside the brain's run (brainRun.exit): once the brain gives a run up every call of it is refused, and
 * the table would stay open with the piece in it. The close also ends the unequip's hold and wears the best again.
 */
export async function useSmithing(ctx: GoalContext, job: SmithJob): Promise<SmithOutcome> {
  const into = netheriteOf(job.base);
  if (!into) throw new Error(`${job.base} has no netherite upgrade`);
  let outcome: { taken: true; take: SmithTake; before: ItemEnchantment[] } | { taken: false; text: string; status: SmithStatus };
  let closed: SmithClosed | undefined;
  try {
    let slot = job.slot;
    if (job.worn) {
      const off = await ctx.call<{ ok: boolean; slot: number; name: string }>('armor.unequip', { slot: job.worn, holdMs: SMITH_HOLD_MS });
      slot = off.slot;
      ctx.progress(`took the ${job.base} off for the smithing table`);
    }
    await ctx.call<SmithStatus>('smith.open', { ...job.at });
    // (written at once: a disconnect with the three in the table throws them on the ground, smithDropsGoal)
    ctx.world.smithingOpen = { at: { ...job.at }, since: Date.now() };
    ctx.save?.();
    await ctx.call<SmithPut>('smith.put', { which: 'template', name: NETHERITE_TEMPLATE, count: 1 });
    const base = await ctx.call<SmithPut>('smith.put', { which: 'base', name: job.base, ...(slot !== undefined && slot >= 0 ? { slot } : {}), count: 1 }).catch((e: unknown) => {
      // the hold gives way while the bot is hurt, and a fight wears its best whatever the hold says
      if (job.worn && message(e).includes(`no ${job.base} in inventory`)) throw new Error(`the ${job.base} went back on before the smithing table had it (hurt, or a fight)`);
      throw e;
    });
    const st = await ctx.call<SmithPut>('smith.put', { which: 'addition', name: NETHERITE_INGOT, count: 1 });
    if (!st.result) {
      outcome = { taken: false, status: st, text: `the smithing table shows no result${st.noRecipe ? '' : ' yet'} (${smithTableText(st)})` };
    } else {
      const take = await ctx.call<SmithTake>('smith.take', { expect: into }, 15_000);
      if (!take.ok) throw new Error(take.reason ?? `the smithing table did not hand the ${into} over`);
      outcome = { taken: true, take, before: base.put?.enchantments ?? [] };
    }
  } finally {
    closed = await brainRun.exit(() => ctx.call<SmithClosed>('smith.close')).catch(() => undefined);
    // the table closed by this close: what was in it is back in the pockets (else the drops' goal looks round it)
    if (closed?.wasOpen && ctx.world.smithingOpen) { delete ctx.world.smithingOpen; ctx.save?.(); }
  }
  return { ...outcome, wore: closed?.wore ?? [] };
}

// ------------------------------------------------------------------------------------------------ the table's drops

/** The record of a job at the smithing table with the piece in it (world.smithingOpen), from smith.open to its close. */
export interface SmithingOpen { at: Pos; since: number }
/**
 * A job at the table takes seconds (its calls' timeouts add up to about two minutes): a record older than this is no
 * job still at it, and the drops' goal may look. One written before this process started (a restart) is looked for at once.
 */
export const SMITH_DROPS_AFTER_MS = 3 * MINUTE;
const STARTED = Date.now();
/** How far round the table the drops are looked for (thrown toward the table from up to 2 off, the bot's goto range). */
export const SMITH_DROPS_RADIUS = 4;

/**
 * The smithing table's drops: a disconnect (a restart, a kick, a crash) with the table open throws what is in it on the
 * ground by the table (26.3 ItemCombinerMenu.removed: clearContainer drops the stacks of a player removed), after the
 * player was saved without them: the protection 4 piece, the template and the ingot, gone in 5 minutes. useSmithing
 * writes world.smithingOpen at the opening and lets it go only when its own close shut the table; one left (a run that
 * never got to its close, a close that found the table gone) is looked round for once on foot, and let go: at once
 * when it is from before a restart, else SMITH_DROPS_AFTER_MS on (a rejoin within the process).
 */
export const smithDropsGoal: Goal = {
  name: 'smithing drops',
  priority: 89,
  timeoutMs: 3 * MINUTE,
  retryMs: MINUTE,
  wants: (s, world) => {
    const o = world.smithingOpen;
    if (!o || s.dimension !== 'overworld' || (o.since >= STARTED && s.now - o.since < SMITH_DROPS_AFTER_MS)) return null;
    return `the smithing table at ${fmt(o.at)} was left with a job in it: pick up what it dropped`;
  },
  run: async ctx => {
    const o = ctx.world.smithingOpen!;
    await ctx.call('goto', { ...o.at, range: 2, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => undefined);
    if (ctx.signal.aborted) throw new Error('aborted');
    const r = await ctx.act('collect-items', { ...o.at, radius: SMITH_DROPS_RADIUS, timeoutMs: 30_000 }).catch((e: unknown) => ({ ok: false, text: message(e) }));
    if (ctx.signal.aborted) throw new Error('aborted');
    delete ctx.world.smithingOpen;
    return `the smithing table at ${fmt(o.at)} left with a job in it: ${r.text}`;
  }
};

// ------------------------------------------------------------------------------------------------ a piece's step

/**
 * The templates for a piece, carried: one for the piece and TEMPLATE_SPARE left at home after it. With only the spare
 * at home it is copied first (seven diamonds, a netherrack and the template, at a table: two come out), so the last one
 * is never used up. What is short, or {} with a template carried and the spare at home.
 */
async function templatesFor(ctx: GoalContext): Promise<Record<string, number>> {
  const had = templatesHome(await inventory(ctx), ctx.world);
  if (had < 1) return { [NETHERITE_TEMPLATE]: 1 };
  const copy = had <= TEMPLATE_SPARE;
  // (prepare takes one out of the chests, or the spare and the copy's makings, and crafts the copy from them)
  const short = await prepare(ctx, NETHERITE_TEMPLATE, copy ? TEMPLATE_SPARE + 1 : 1);
  if (Object.keys(short).length) return short;
  const items = await inventory(ctx);
  const now = templatesHome(items, ctx.world);
  if (carried(items, NETHERITE_TEMPLATE) < 1 || now <= TEMPLATE_SPARE) return { [NETHERITE_TEMPLATE]: TEMPLATE_SPARE + 1 - Math.min(now, TEMPLATE_SPARE) };
  if (copy) ctx.progress(`netherite: copied the upgrade template (${TEMPLATE_COPY.diamond} diamonds, ${TEMPLATE_COPY.netherrack} netherrack and a template make two): ${now} at home, ${TEMPLATE_SPARE} kept spare`);
  return {};
}

/** An ingot carried: one there, else made of four scrap and four gold (the scrap smelted from debris). What is short, the scrap said as the debris it is smelted from. */
async function ingotFor(ctx: GoalContext): Promise<Record<string, number>> {
  const before = carried(await inventory(ctx), NETHERITE_INGOT) + (freeChestTotals(ctx.world)[NETHERITE_INGOT] ?? 0);
  const short = await prepare(ctx, NETHERITE_INGOT, 1);
  if (!Object.keys(short).length) {
    if (before < 1) ctx.progress(`netherite: made a ${NETHERITE_INGOT} (${INGOT_SCRAP} scrap, ${RECIPES[NETHERITE_INGOT].from.gold_ingot} gold ingots)`);
    return {};
  }
  // scrap comes only out of the furnace, from debris: the debris is what is fetched (the stock list and the waits read it)
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(short)) { const n = k === 'netherite_scrap' ? DEBRIS : k; out[n] = (out[n] ?? 0) + v; }
  return out;
}

/**
 * A piece's step: its diamond piece smithed into netherite at the workshop's table. Done at once with the netherite
 * piece already on the bot. Else, while none of what it waits for is short (pieceWaits): the templates (a copy where
 * the home has only the spare), an ingot (made from the scrap, smelted from the debris), on foot into the workshop
 * (A11) from inside the fence, and the job at the table (useSmithing). The piece's enchantments are its own: the take
 * says them, logged as `smithing: <smithingText>`.
 */
export function pieceStep(kind: ArmourKind): Step {
  return {
    name: `smith the netherite ${kind}`,
    waits: v => pieceWaits(kind, v.s.items, v.world),
    run: async ctx => {
      let items = await inventory(ctx);
      const has = netheritePiece(items, ctx.world, kind);
      if (has) return ok(`the ${has.name} is ${has.slot >= 36 ? 'worn' : has.slot === -1 ? 'in the chests for the Nether' : 'carried'}`);
      const wait = pieceWaits(kind, items, ctx.world);
      if (wait) return blocked(wait, 30 * MINUTE);
      const at = smithingTable(ctx.world);
      if (!at) return blocked('no smithing table in the workshop (workshop:smithing) nor in the yard', 60 * MINUTE);
      // (a wait of its own, short: the stash makes the room meanwhile)
      const used = new Set(items.filter(pocket).map(i => i.slot)).size;
      if (36 - used < SMITH_SLOTS) return blocked(`pockets: ${used}/36, the smithing wants ${SMITH_SLOTS} free (the templates, the ingot's makings, the piece)`, 5 * MINUTE);
      const templates = await templatesFor(ctx);
      if (Object.keys(templates).length) return shortOf(`the template for the ${kind}: short of ${list(templates)}`, templates);
      const ingot = await ingotFor(ctx);
      if (Object.keys(ingot).length) return shortOf(`the ${NETHERITE_INGOT} for the ${kind}: short of ${list(ingot)}`, ingot);
      if (ctx.signal.aborted) return { status: 'progress', text: 'stopped before the smithing table' };
      await holdHarmless(ctx);
      const here = (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
      if (!inFence(ctx.world, here)) await goHome(ctx, 180_000).catch(() => undefined);
      if (ctx.signal.aborted) return { status: 'progress', text: 'stopped on the way to the workshop' };
      // on foot only (A11): Baritone neither breaks nor places in the yard, and the workshop's way in is its door
      const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...at, range: 2, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
      if (walk?.arrived === false) return blocked(`no way on foot to the smithing table at ${fmt(at)}`);
      // the piece as it is now (the templates and the ingot moved things about in the pockets)
      items = await inventory(ctx);
      const piece = pieceToSmith(items, kind);
      if (!piece) return blocked(`no diamond_${kind} worn or carried to smith`, 30 * MINUTE);
      const unfit = unfitToSmith(piece);
      if (unfit) return blocked(unfit, 30 * MINUTE);
      const worn = wornSlot(piece);
      let out: SmithOutcome;
      try {
        out = await useSmithing(ctx, { at, base: piece.name, ...(worn ? { worn } : { slot: piece.slot }) });
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        return blocked(`at the smithing table at ${fmt(at)}: ${message(e)}`);
      }
      if (!out.taken) return blocked(`${out.text}: the ${piece.name} is as it was`, 60 * MINUTE);
      const line = smithingText(out.take, out.before);
      ctx.progress(`smithing: ${line}`);
      const into = out.take.item;
      const back = out.wore.includes(into) ? '; worn' : worn ? '; not worn again yet: the Guardian puts it on' : '';
      return ok(`${line}${back}`);
    }
  };
}

// ------------------------------------------------------------------------------------------------ the milestone

/** Every main piece is netherite, on the bot (worn or carried) or put away for a Nether trip (pure). */
export const allNetherite = (s: Pick<Snapshot, 'items'>, world: WorldMemory): boolean => !piecesLeft(s.items, world).length;

/**
 * The netherite milestone (P6), after the brewing: one step a piece (PIECES: chestplate, leggings, boots, the main
 * helmet), each waiting for a template and an ingot's makings at home (pieceWaits: the bastion and the tunnels bring
 * them). Done once the world shows it: all four netherite.
 */
export function netheriteMilestone(prereqs: string[]): Milestone {
  return {
    id: ID,
    title: 'netherite armour',
    prereqs,
    done: v => allNetherite(v.s, v.world),
    steps: PIECES.map(pieceStep)
  };
}
