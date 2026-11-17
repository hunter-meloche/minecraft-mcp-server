import { brainRun, type ChestContents, type ChestStack } from '../tools.js';
import type { GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { holdHarmless, isHazard } from './fluidpick.js';
import { CHEST_SLOTS, categoryOf, packedSlots, roomFor, stackSize } from './storage.js';

/** The home chests as the brain last saw them (every open updates its memory). */

export const key = (p: Pos) => `${p.x},${p.y},${p.z}`;
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;

/** Baritone's throwaway blocks (and dirt): what can sit on a chest's lid by accident. */
const THROWAWAY = /^(minecraft:)?(cobblestone|cobbled_deepslate|netherrack|andesite|diorite|granite|tuff|dirt)$/;

type Call = <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

/**
 * Throwaway blocks on a chest's lid, or on its other half's: dug, so it opens (a build left cobblestone on three home
 * chests and the kit couldn't get at them). Anything else on a lid is someone's building and stays. Returns what it dug.
 */
export async function freeLid(call: Call, at: Pos): Promise<Pos[]> {
  type B = { name?: string; properties?: Record<string, string> };
  const block = (p: Pos) => call<B>('world.block', { ...p }).catch(() => ({} as B));
  const halves = [at];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const n = { x: at.x + dx, y: at.y, z: at.z + dz };
    const b = await block(n);
    if (/chest/.test(b.name ?? '') && b.properties?.type && b.properties.type !== 'single') halves.push(n);
  }
  const dug: Pos[] = [];
  for (const h of halves) {
    const top = { x: h.x, y: h.y + 1, z: h.z };
    if (!THROWAWAY.test((await block(top)).name ?? '')) continue;
    const r = await call<{ dug: boolean }>('dig', { ...top, timeoutMs: 20_000 }, 35_000).catch(() => ({ dug: false }));
    if (r.dug) dug.push(top);
  }
  return dug;
}

/**
 * What's in a chest (walks up to it first, frees a lid weighed down by scaffold); remembered for planning. The walk
 * only walks at first, to within 3 blocks (as the tools' openChest does): the storage house's floor is within 3 of a
 * chest two layers up but never within 2, so the walk to within 2 pillared up in the house. That walk comes second,
 * and not at all for a chest in reach whose lid is held down: no walk opens that one.
 */
export async function peekChest(ctx: GoalContext, at: Pos): Promise<Record<string, number>> {
  try {
    const got = await openAt(ctx, at);
    remember(ctx.world, at, got.items, got.stacks, got.free, got.slots);
    return got.items;
  } finally {
    await closeChest(ctx);
  }
}

/**
 * A chest's menu closed, outside the brain's run (brainRun.exit), as the anvil and the table are: once the brain gives
 * a run up every call of it is refused, the close too, and the chest stayed open. The bridge's next chest.open then
 * answered with that chest's contents, remembered under the next chest's key: live on Nov 15 the enchant chore was cut
 * while it stored a book in the gear chest, and seconds later the gear chest's memory had lost the spare set, the
 * golden helmet and the flint and steel.
 */
const closeChest = (ctx: GoalContext) => brainRun.exit(() => ctx.call('container.close')).catch(() => undefined);

/** Walk up to a chest and open it, as peekChest says; the caller closes it. */
async function openAt(ctx: GoalContext, at: Pos): Promise<ChestContents> {
  const open = () => ctx.call<ChestContents>('chest.open', { ...at });
  const tryOpen = () => open().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  let got = await tryOpen();
  if (got instanceof Error) {
    await ctx.call('goto', { ...at, range: 3, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
    got = await tryOpen();
  }
  if (got instanceof Error) {
    if (!/did not open/.test(got.message)) {
      const r = await ctx.act('move-to-position', { ...at, range: 2, timeoutMs: 60_000 });
      if (!r.ok) throw new Error(`could not reach the chest at ${fmt(at)}: ${r.text}`);
    }
    try { got = await open(); } catch (e) {
      if (!/did not open/.test((e as Error).message) || !(await freeLid(ctx.call, at)).length) throw e;
      got = await open();
    }
  }
  return got;
}

/**
 * What a chest holds, into memory: the totals, and its stacks by slot when the reply has them (chest.open, withdraw
 * and deposit do; an older jar's don't). Without them (a tool's "It holds:" text) the stacks of every name whose
 * total changed are left out: the text says how many went, not from which slot, and a remembered slot that no longer
 * holds its stack would take another one (the book with unbreaking for the one with mending). The other names'
 * stacks stand where they were: a chest's stacks never move when others are taken or put in. `free`: its empty slots,
 * where the reply says (fullChests); `slots`: all of them, 27 or 54 (chestSize).
 */
export function remember(world: WorldMemory, at: Pos, items: Record<string, number>, stacks?: ChestStack[], free?: number, slots?: number): void {
  const k = key(at);
  noteFree(world, k, free);
  noteSize(world, k, slots);
  world.chestItems ??= {};
  const before = world.chestItems[k];
  world.chestItems[k] = { ...items };
  if (Array.isArray(stacks)) { (world.chestStacks ??= {})[k] = stacks.map(st => ({ ...st })); return; }
  const old = world.chestStacks?.[k];
  if (!old) return;
  const kept = before ? old.filter(st => (before[st.name] ?? 0) === (items[st.name] ?? 0)) : [];
  if (kept.length) world.chestStacks![k] = kept;
  else delete world.chestStacks![k];
}

/** Two stacks the same thing: the name, the enchantments (a book's stored ones too) and the potion (not wear or count). */
export function sameStack(a: ChestStack, b: ChestStack): boolean {
  const ench = (s: ChestStack) => (s.enchantments ?? []).map(e => `${e.name} ${e.level}`).sort().join(',');
  return a.name === b.name && ench(a) === ench(b) && (a.potion ?? '') === (b.potion ?? '');
}

/** The stacks in the home chests that `match`, as last seen, chest by chest (each with the chest it is in). */
export function storedStacks(world: WorldMemory, match: (st: ChestStack) => boolean): { chest: Pos; stack: ChestStack }[] {
  const out: { chest: Pos; stack: ChestStack }[] = [];
  for (const c of world.landmarks.chests) {
    const stacks = world.chestStacks?.[key(c)];
    if (Array.isArray(stacks)) for (const st of stacks) if (match(st)) out.push({ chest: c, stack: st });
  }
  return out;
}

/**
 * Take the stack remembered in `slot` of a home chest (all of it, or `count`): the book with mending, the potion of
 * fire resistance, not the first of their names. The chest's fresh contents are checked first: when that slot holds
 * something else now, the same stack in another slot of this chest is taken, and none at all when it is gone, or when
 * the jar sends no stacks to check against. Returns how many came; 0 also when nothing is remembered in that slot
 * (peekChest the chest first).
 */
export async function takeSlot(ctx: GoalContext, chest: Pos, slot: number, count?: number): Promise<number> {
  const want = ctx.world.chestStacks?.[key(chest)]?.find(st => st.slot === slot);
  if (!want) return 0;
  try {
    const opened = await openAt(ctx, chest);
    remember(ctx.world, chest, opened.items, opened.stacks, opened.free, opened.slots);
    // an older jar (the one kept for a rollback) sends no stacks and ignores `slot`: its withdraw takes the first of
    // the name, the book with unbreaking for the one with mending. Nothing then, and this chest's stacks forgotten,
    // so storedStacks stops offering them
    if (!Array.isArray(opened.stacks)) {
      delete ctx.world.chestStacks?.[key(chest)];
      ctx.progress(`this jar can't take the ${want.name} by its slot (the chest at ${fmt(chest)}): left there`);
      return 0;
    }
    const now = opened.stacks.find(st => st.slot === slot && sameStack(st, want)) ?? opened.stacks.find(st => sameStack(st, want));
    if (!now) {
      ctx.progress(`the ${want.name} from slot ${slot} of the chest at ${fmt(chest)} is gone`);
      return 0;
    }
    // with a count always: without one chest.withdraw goes on to every stack the same as the first (Interact.sources),
    // both of two books with mending for the one asked for
    const r = await ctx.call<ChestContents>('chest.withdraw', { name: want.name, slot: now.slot, count: count && count > 0 ? count : now.count });
    remember(ctx.world, chest, r.items, r.stacks, r.free, r.slots);
    return r.moved ?? 0;
  } finally {
    await closeChest(ctx);
  }
}

/**
 * Put the one stack in pocket `slot` (0-35) into a home chest and remember that chest by its stacks: an enchanted book
 * the enchant chore made, which the anvil later takes back out by what it holds (anvil.ts). A tool's "It holds:" reply
 * says how many went, not which, and the chest's books were then told apart no longer (remember). Of `chests` in their
 * order (the caller's: the stash's chest for the kind first), the first few. Returns the chest it went into; undefined
 * when none took it (it stays carried, and the stash puts it away in time).
 */
export async function storeStack(ctx: GoalContext, name: string, slot: number, chests: Pos[] = ctx.world.landmarks.chests, tries = 3): Promise<Pos | undefined> {
  return (await storeStackAt(ctx, name, slot, chests, tries))?.chest;
}

/**
 * storeStack, and the chest's own slot the stack went into, by the deposit's reply against the chest as it was opened
 * (undefined when the jar sends no stacks): the spare set is remembered by it (portal.ts).
 */
export async function storeStackAt(ctx: GoalContext, name: string, slot: number, chests: Pos[] = ctx.world.landmarks.chests, tries = 3): Promise<{ chest: Pos; slot?: number } | undefined> {
  for (const c of chests.slice(0, tries)) {
    if (ctx.signal.aborted) break;
    try {
      const opened = await openAt(ctx, c);
      remember(ctx.world, c, opened.items, opened.stacks, opened.free, opened.slots);
      if (opened.free <= 0) continue;
      // with the slot and a count of one: that stack, never another of its name (Interact.sources)
      const r = await ctx.call<ChestContents>('chest.deposit', { name, slot, count: 1 });
      remember(ctx.world, c, r.items, r.stacks, r.free, r.slots);
      if ((r.moved ?? 0) > 0) {
        const before = new Map((opened.stacks ?? []).map(st => [st.slot, st]));
        const into = (r.stacks ?? []).find(st => st.name === name && (before.get(st.slot)?.name !== name || before.get(st.slot)!.count < st.count));
        return { chest: c, slot: into?.slot };
      }
    } catch (e) {
      ctx.progress(`the ${name} into the chest at ${fmt(c)}: ${(e as Error).message}`);
    } finally {
      await closeChest(ctx);
    }
  }
  return undefined;
}

/**
 * The home chests in the order one stack of `name` goes into them by its slot (storeStack): those the stash keeps its
 * kind in first (storage.ts), the fullest of a kind as last seen after the emptier (enchant.ts bookChests, the books';
 * chores.ts putAway, the fishing rods beyond the one kept).
 */
export function kindChests(world: WorldMemory, name: string): Pos[] {
  const kind = categoryOf(name);
  const own = (c: Pos) => world.chestAssign?.[key(c)] === kind;
  // by its stacks or its totals, the more of the two (a take's reply keeps only the stacks it left alone)
  const used = (c: Pos) => Math.max(world.chestStacks?.[key(c)]?.length ?? 0,
    Object.entries(world.chestItems?.[key(c)] ?? {}).reduce((n, [item, k]) => n + Math.ceil(k / stackSize(item)), 0));
  return [...world.landmarks.chests].sort((a, b) => Number(own(b)) - Number(own(a)) || used(a) - used(b));
}

/** Everything in the home chests together, as last seen. */
export function chestTotals(world: WorldMemory): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of world.landmarks.chests) {
    for (const [n, k] of Object.entries(world.chestItems?.[key(c)] ?? {})) out[n] = (out[n] ?? 0) + k;
  }
  return out;
}

/** The chests holding an item, as last seen, most first. */
export function chestsWith(world: WorldMemory, item: string): Pos[] {
  return world.landmarks.chests
    .filter(c => (world.chestItems?.[key(c)]?.[item] ?? 0) > 0)
    .sort((a, b) => (world.chestItems![key(b)][item] ?? 0) - (world.chestItems![key(a)][item] ?? 0));
}

/**
 * Parse the "It holds: a x1, b x2" tail of a chest tool's reply into the chest's memory, and its room where the reply
 * says: "N/M slots free" (store-in-chest's and take-from-chest's: the chest's empty slots and all of them) and
 * store-in-chest's "(the chest is full)" (it took less than it was given). A take of whole stacks frees slots its
 * reply now counts, and the chest's full mark goes. A reply without the count (an older build's) leaves the mark as it
 * was: what it took left room in its own stacks, which the plans count anyway, and a slot freed is seen at the next
 * look in.
 */
export function rememberReply(world: WorldMemory, at: Pos, text: string): void {
  const room = /; (\d+)\/(\d+) slots free/.exec(text);
  const free = room ? Number(room[1]) : /\(the chest is full\)/.test(text) ? 0 : undefined;
  const slots = room ? Number(room[2]) : undefined;
  const m = /It holds: (.*?)(?:;|\.$|$)/.exec(text);
  if (!m) { noteFree(world, key(at), free); noteSize(world, key(at), slots); return; }
  const items: Record<string, number> = {};
  if (m[1].trim() !== 'nothing') {
    for (const part of m[1].split(', ')) {
      const e = /^(\S+) x(\d+)$/.exec(part.trim());
      if (e) items[e[1]] = Number(e[2]);
    }
  }
  remember(world, at, items, undefined, free, slots);
}

/**
 * Remember whether a chest ("x,y,z") has an empty slot, as a reply or a look in just said (`free`; undefined: it did
 * not say, and what was known stands). Seen with every slot used, it is in `world.fullChests` until it is seen with
 * one free again: the plans count no free slot in it, only what its own stacks still take (chestSlots). Live on Nov
 * 14 the plan, counting each chest's things packed into whole stacks, kept finding four free slots in the misc chest
 * (27 stacks, 23 packed) and the stash went to fill them every few minutes: "nothing could be put away", 44 times.
 */
function noteFree(world: WorldMemory, k: string, free: number | undefined): void {
  if (free === undefined || !Number.isFinite(free)) return;
  const full = fullChests(world);
  const was = full.has(k);
  if (free > 0) full.delete(k);
  else full.add(k);
  if (full.has(k) === was) return;
  if (full.size) world.fullChests = [...full];
  else delete world.fullChests;
}

/** The home chests seen with every slot used (noteFree), by key: none for a memory without the list, or with something else there. */
export function fullChests(world: WorldMemory): Set<string> {
  return new Set(Array.isArray(world.fullChests) ? world.fullChests.filter(k => typeof k === 'string') : []);
}

/**
 * Remember how many slots a chest ("x,y,z") has, 27 or 54 (a double chest), as a look in or a reply just said
 * (`slots`; undefined or no count: what was known stands). The memory of its things cannot tell: a double chest
 * filled to its first half packs into 27 slots, the same as a single one full.
 */
function noteSize(world: WorldMemory, k: string, slots: number | undefined): void {
  if (slots === undefined || !Number.isInteger(slots) || slots <= 0) return;
  if (!world.chestSize || typeof world.chestSize !== 'object' || Array.isArray(world.chestSize)) world.chestSize = {};
  world.chestSize[k] = slots;
}

/** A chest's slots as last seen (noteSize); undefined when none was seen, or brain.json holds something else there. */
function sizeOf(world: WorldMemory, k: string): number | undefined {
  const sizes = world.chestSize;
  const n = sizes && typeof sizes === 'object' && !Array.isArray(sizes) ? sizes[k] : undefined;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * The slots the plans count each home chest ("x,y,z") as holding (storage.ts depositPlan, misplaced; pockets.ts):
 * CHEST_SLOTS, or none for one seen with every slot used, so that only the room left in its own stacks is counted.
 */
export function chestSlots(world: WorldMemory): (chest: string) => number {
  const full = fullChests(world);
  return k => (full.has(k) ? 0 : CHEST_SLOTS);
}

/**
 * The slots storeInChests can fill in each home chest ("x,y,z"), for what the categories' own chests leave over
 * (pockets.ts stashReach): none for one seen with every slot used, else its size as a look in or a reply last said
 * (chestSize: 54 for a double chest). The plans count each chest as 27 (a double chest's second half room to spare),
 * and storeInChests, which tries every chest not seen full, puts what is left over in that half: the storage house is
 * all double chests. A chest whose size was never seen is a double one when its memory shows a stack past slot 26 or
 * packs into more than 27 slots, else 27. Counted as 27, a double chest with its first half full looked full, and the
 * stash stopped wanting with the storage "full" and its second half empty.
 */
export function storeSlots(world: WorldMemory): (chest: string) => number {
  const full = fullChests(world);
  const guess = (k: string) => {
    const stacks = world.chestStacks?.[k];
    const past = Array.isArray(stacks) && stacks.some(st => typeof st?.slot === 'number' && st.slot >= CHEST_SLOTS);
    return past || packedSlots(world.chestItems?.[k] ?? {}) > CHEST_SLOTS ? 2 * CHEST_SLOTS : CHEST_SLOTS;
  };
  return k => (full.has(k) ? 0 : sizeOf(world, k) ?? guess(k));
}

/**
 * The home chests less what the build jobs hold there: what the kit, the cook and the projects can count on (the kit
 * planned to take torches a job held, found none, and never made any: over and over, stopping the job each time).
 */
export function freeChestTotals(world: WorldMemory): Record<string, number> {
  const out: Record<string, number> = {};
  // (the spare set counted once, not once a name: the gates ask this many times a tick)
  const spare = new Map<string, number>();
  for (const p of spareHeld(world)) spare.set(p.name, (spare.get(p.name) ?? 0) + 1);
  for (const [n, k] of Object.entries(chestTotals(world))) { const free = k - reservedCount(world, n, SPARE) - (spare.get(n) ?? 0); if (free > 0) out[n] = free; }
  return out;
}

/**
 * How many of an item the build jobs (and the community's missions, key 'community') hold in the chests (all, or all but
 * `except`'s), and the spare set's pieces (but for `except` SPARE: the regear's own takes).
 */
export function reservedCount(world: WorldMemory, item: string, except?: number | string): number {
  let n = 0;
  for (const [job, items] of Object.entries(world.reserved ?? {})) if (except === undefined || job !== String(except)) n += items[item] ?? 0;
  if (except !== SPARE) n += spareHeld(world).filter(p => p.name === item).length;
  return n;
}

// ------------------------------------------------------------------------------------------------ the spare set

/**
 * The spare diamond set (the portal milestone's, P2a of the progression plan): a plain diamond helmet, chestplate,
 * leggings, boots, pickaxe and sword in a home chest, for the regear after a death in the Nether (P2b takes them out
 * by their slots). Each piece by its chest and the chest's own slot, as the deposit's reply had it.
 */
export interface SparePiece { name: string; chest: Pos; slot: number }
export interface SpareSet { pieces: SparePiece[]; at?: number }
/** The key reservedCount and takeFromChests leave the spare set out under: the regear's own takes. */
export const SPARE = 'spare';

/** The spare set's pieces as remembered; whatever else brain.json holds there reads as none. */
export function sparePieces(world: WorldMemory): SparePiece[] {
  const list: unknown = world.spareSet?.pieces;
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is SparePiece => !!p && typeof p === 'object' && typeof (p as SparePiece).name === 'string' &&
    !!(p as SparePiece).chest && typeof (p as SparePiece).chest.x === 'number' && Number.isInteger((p as SparePiece).slot));
}

/**
 * The spare set's pieces still in their chests, as the chests' memory has them: in a home chest that holds that many
 * of the name, and in its slot where the chest's stacks of that name are known (a tool's text reply lets go of a
 * name's stacks: then the count alone). What is gone is reserved no longer, and the spare set's step makes it again
 * (once its chest is looked into again: portal.ts spareSetStep). One piece of each name, the first recorded that is
 * held: the set is one set, and a second piece of a name in the record is plain stock (oneSpareSet).
 */
export function spareHeld(world: WorldMemory): SparePiece[] {
  const out: SparePiece[] = [];
  const seen = new Map<string, number>();
  const home = new Set(world.landmarks.chests.map(key));
  for (const p of sparePieces(world)) {
    if (out.some(o => o.name === p.name)) continue;
    const k = key(p.chest);
    if (!home.has(k)) continue;
    const stacks = world.chestStacks?.[k];
    if (Array.isArray(stacks) && stacks.some(st => st.name === p.name) && !stacks.some(st => st.slot === p.slot && st.name === p.name)) continue;
    const n = (seen.get(`${k}|${p.name}`) ?? 0) + 1;
    if (n > (world.chestItems?.[k]?.[p.name] ?? 0)) continue;
    seen.set(`${k}|${p.name}`, n);
    out.push(p);
  }
  return out;
}

/**
 * The spare set's record made one set again: of each name the piece the chests' memory holds (spareHeld), else the
 * first recorded, and the rest let go, plain stock from then on (the kit, the trip kit and the regear may take them).
 * Live on Nov 15 the nether spares chore stored a second set (29 diamonds) while the first lay in its slots 12 to 17
 * of the gear chest, whose memory had lost them for a moment, and the record listed both: twelve pieces in three
 * chests. The brain asks this on every tick (a record of one set is left as it is). Returns the pieces let go.
 */
export function oneSpareSet(world: WorldMemory): SparePiece[] {
  const all = sparePieces(world);
  const held = spareHeld(world);
  const kept: SparePiece[] = [];
  for (const p of all) if (!kept.some(k => k.name === p.name)) kept.push(held.find(h => h.name === p.name) ?? p);
  const loose = all.filter(p => !kept.includes(p));
  if (loose.length) world.spareSet = { ...world.spareSet, pieces: kept };
  return loose;
}

/** The slots of a chest that hold the spare set's pieces (of `item` only, if given). */
export function spareSlots(world: WorldMemory, chest: Pos, item?: string): Set<number> {
  const k = key(chest);
  return new Set(spareHeld(world).filter(p => key(p.chest) === k && (item === undefined || p.name === item)).map(p => p.slot));
}

/**
 * The home chests' contents as remembered, less the spare set's pieces: what the sort may move (storage.ts misplaced).
 * Moved to their category's chest, the pieces would no longer be where the spare set says.
 */
export function withoutSpare(world: WorldMemory): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [k, items] of Object.entries(world.chestItems ?? {})) out[k] = { ...items };
  for (const p of spareHeld(world)) {
    const items = out[key(p.chest)];
    if (!items?.[p.name]) continue;
    items[p.name] -= 1;
    if (items[p.name] <= 0) delete items[p.name];
  }
  return out;
}

/**
 * Take `count` of an item from a chest that holds spare-set pieces of that name: the other stacks, each by its slot
 * (a take by name takes the first stack of it the game finds, which may be the spare one). Nothing from a jar that
 * sends no stacks. Returns how many came.
 */
async function takeAround(ctx: GoalContext, chest: Pos, item: string, count: number, kept: Set<number>): Promise<number> {
  let got = 0;
  try {
    const opened = await openAt(ctx, chest);
    remember(ctx.world, chest, opened.items, opened.stacks, opened.free, opened.slots);
    if (!Array.isArray(opened.stacks)) return 0;
    for (const st of opened.stacks.filter(x => x.name === item && !kept.has(x.slot))) {
      if (got >= count) break;
      const r = await ctx.call<ChestContents>('chest.withdraw', { name: item, slot: st.slot, count: Math.min(st.count, count - got) });
      remember(ctx.world, chest, r.items, r.stacks, r.free, r.slots);
      got += r.moved ?? 0;
    }
  } finally {
    await closeChest(ctx);
  }
  if (got > 0 && isHazard(item)) await holdHarmless(ctx);
  return got;
}

/**
 * Take an item from whichever home chests hold it; returns how many it got. What a build job has secured there is
 * left alone, unless `forJob` is that job (its materials stay its own: the kit, the cook and the fuel take the rest),
 * and so is the spare set (unless `forJob` is SPARE).
 * A full bucket or a fire starter taken is put out of the hand before anything walks on (holdHarmless): a chest's
 * shift-click fills the hotbar first, from its far end, often the slot in hand.
 */
export async function takeFromChests(ctx: GoalContext, item: string, count: number, opts: { forJob?: number | string } = {}): Promise<number> {
  const held = reservedCount(ctx.world, item, opts.forJob);
  if (held) count = Math.min(count, Math.max(0, (chestTotals(ctx.world)[item] ?? 0) - held));
  if (count <= 0) return 0;
  let got = 0;
  for (const c of chestsWith(ctx.world, item)) {
    if (got >= count) break;
    // the chest with the spare set's piece of this name: the other stacks by their slots, never the spare one
    const kept = opts.forJob === SPARE ? new Set<number>() : spareSlots(ctx.world, c, item);
    if (kept.size) { got += await takeAround(ctx, c, item, count - got, kept); continue; }
    const r = await ctx.act('take-from-chest', { ...c, item, count: count - got });
    rememberReply(ctx.world, c, r.text);
    const m = /^Took (\d+)/.exec(r.text);
    if (m) got += Number(m[1]);
    if (m && Number(m[1]) > 0 && isHazard(item)) await holdHarmless(ctx);
  }
  return got;
}

/**
 * Store an item in the first home chest with room; returns how many went in. Not a chest seen with every slot used
 * whose own stacks of the item are full (fullChests): the plan counts no room there (pockets.ts stashReach), and the
 * walk to it stores nothing. Any other is tried, whatever its memory packs into 27 slots: a double chest is one
 * chest of 54 to the game, and its second half takes what the plan leaves out.
 */
export async function storeInChests(ctx: GoalContext, item: string, count?: number): Promise<number> {
  let stored = 0;
  const slots = chestSlots(ctx.world);
  for (const c of ctx.world.landmarks.chests) {
    const k = key(c);
    if (!slots(k) && roomFor(ctx.world.chestItems?.[k] ?? {}, item, 0) <= 0) continue;
    const r = await ctx.act('store-in-chest', { ...c, item, ...(count ? { count: count - stored } : {}) });
    rememberReply(ctx.world, c, r.text);
    const m = /^Stored (\d+)/.exec(r.text);
    if (m) stored += Number(m[1]);
    if (!/the chest is full/.test(r.text) && r.ok) break;
  }
  return stored;
}
