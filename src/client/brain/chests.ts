import type { ChestContents, ChestStack } from '../tools.js';
import type { GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';

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
    remember(ctx.world, at, got.items, got.stacks);
    return got.items;
  } finally {
    await ctx.call('container.close').catch(() => undefined);
  }
}

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
 * stacks stand where they were: a chest's stacks never move when others are taken or put in.
 */
export function remember(world: WorldMemory, at: Pos, items: Record<string, number>, stacks?: ChestStack[]): void {
  const k = key(at);
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
    remember(ctx.world, chest, opened.items, opened.stacks);
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
    remember(ctx.world, chest, r.items, r.stacks);
    return r.moved ?? 0;
  } finally {
    await ctx.call('container.close').catch(() => undefined);
  }
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

/** Parse the "It holds: a x1, b x2" tail of a chest tool's reply into the chest's memory. */
export function rememberReply(world: WorldMemory, at: Pos, text: string): void {
  const m = /It holds: (.*?)(?:;|\.$|$)/.exec(text);
  if (!m) return;
  const items: Record<string, number> = {};
  if (m[1].trim() !== 'nothing') {
    for (const part of m[1].split(', ')) {
      const e = /^(\S+) x(\d+)$/.exec(part.trim());
      if (e) items[e[1]] = Number(e[2]);
    }
  }
  remember(world, at, items);
}

/**
 * The home chests less what the build jobs hold there: what the kit, the cook and the projects can count on (the kit
 * planned to take torches a job held, found none, and never made any: over and over, stopping the job each time).
 */
export function freeChestTotals(world: WorldMemory): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [n, k] of Object.entries(chestTotals(world))) { const free = k - reservedCount(world, n); if (free > 0) out[n] = free; }
  return out;
}

/** How many of an item the build jobs (and the community's missions, key 'community') hold in the chests (all, or all but `except`'s). */
export function reservedCount(world: WorldMemory, item: string, except?: number | string): number {
  let n = 0;
  for (const [job, items] of Object.entries(world.reserved ?? {})) if (except === undefined || job !== String(except)) n += items[item] ?? 0;
  return n;
}

/**
 * Take an item from whichever home chests hold it; returns how many it got. What a build job has secured there is
 * left alone, unless `forJob` is that job (its materials stay its own: the kit, the cook and the fuel take the rest).
 */
export async function takeFromChests(ctx: GoalContext, item: string, count: number, opts: { forJob?: number | string } = {}): Promise<number> {
  const held = reservedCount(ctx.world, item, opts.forJob);
  if (held) count = Math.min(count, Math.max(0, (chestTotals(ctx.world)[item] ?? 0) - held));
  if (count <= 0) return 0;
  let got = 0;
  for (const c of chestsWith(ctx.world, item)) {
    if (got >= count) break;
    const r = await ctx.act('take-from-chest', { ...c, item, count: count - got });
    rememberReply(ctx.world, c, r.text);
    const m = /^Took (\d+)/.exec(r.text);
    if (m) got += Number(m[1]);
  }
  return got;
}

/** Store an item in the first home chest with room; returns how many went in. */
export async function storeInChests(ctx: GoalContext, item: string, count?: number): Promise<number> {
  let stored = 0;
  for (const c of ctx.world.landmarks.chests) {
    const r = await ctx.act('store-in-chest', { ...c, item, ...(count ? { count: count - stored } : {}) });
    rememberReply(ctx.world, c, r.text);
    const m = /^Stored (\d+)/.exec(r.text);
    if (m) stored += Number(m[1]);
    if (!/the chest is full/.test(r.text) && r.ok) break;
  }
  return stored;
}
