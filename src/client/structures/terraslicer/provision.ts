import type { GoalContext } from '../../brain/goals.js';
import type { BuildJob, WorldMemory } from '../../brain/memory.js';
import { chestTotals, reservedCount, storeInChests } from '../../brain/chests.js';
import { prepare } from '../../brain/project.js';
import { sourceBill } from '../bill.js';
import type { Toolpath } from './slicer.js';

/**
 * Provisioning: everything a toolpath needs secured in the home chests before a block is placed (the filament on the
 * spool before the print starts). One step a goal run, so anything more urgent can come first: what's in the chests is
 * reserved for the job as it's found (other chores take only what's beyond it: see takeFromChests); what's short is
 * gathered by the stock trips, or crafted and smelted here in batches, into the chests; things nobody can get stop it
 * with the reason. The job is ready when the whole bill is reserved.
 */

const list = (r: Record<string, number>) => Object.entries(r).map(([k, v]) => `${k} x${v}`).join(', ');
/** What the kit keeps on the bot for itself: left carried (it counts for the bill where it is). */
const KIT_CARRIES = /^(torch|cobblestone|cobbled_deepslate|dirt|bread|cooked_[a-z_]+|baked_potato)$/;

/**
 * The bill of a toolpath: what its loads place, the scaffold at the most any load has standing (it comes back as it's
 * taken down), and a spare of the plentiful kinds (a block misplaced, or broken before the job is done).
 */
export function toolpathBill(path: Toolpath, spare = true): Record<string, number> {
  const bill: Record<string, number> = {};
  let scaffold = 0;
  for (const l of path.loads) {
    for (const [k, v] of Object.entries(l.items)) bill[k] = (bill[k] ?? 0) + v;
    if (l.scaffold) { bill[path.scaffoldItem] = (bill[path.scaffoldItem] ?? 0) - l.scaffold; scaffold = Math.max(scaffold, l.scaffold); }
  }
  if (spare) for (const [k, v] of Object.entries(bill)) if (v > 16) bill[k] = v + Math.max(1, Math.ceil(v * 0.02));
  if (scaffold) bill[path.scaffoldItem] = (bill[path.scaffoldItem] ?? 0) + scaffold;
  for (const k of Object.keys(bill)) if (!(bill[k] > 0)) delete bill[k];
  return bill;
}

/** The tools the toolpath works blocks with (a hoe for farmland, a shovel for paths): kinds, not items. */
export function toolsFor(path: Toolpath): string[] {
  const out = new Set<string>();
  for (const s of path.stations) for (const a of s.actions) if (a.op === 'work' && a.item) out.add(a.item);
  return [...out];
}

/** What there is for a job: the home chests (less what other jobs hold there) and the pockets. */
export function haveFor(world: WorldMemory, items: { name: string; count: number; slot: number }[], jobId: number): Record<string, number> {
  const have: Record<string, number> = {};
  for (const [n, k] of Object.entries(chestTotals(world))) { const free = k - reservedCount(world, n, jobId); if (free > 0) have[n] = free; }
  for (const i of items) if (i.slot < 36) have[i.name] = (have[i.name] ?? 0) + i.count;
  return have;
}

/** Hold the bill's items in the chests for the job, up to the bill (what other chores mustn't take). */
export function reserve(world: WorldMemory, jobId: number, bill: Record<string, number>): void {
  const chest = chestTotals(world);
  const mine: Record<string, number> = {};
  for (const [item, n] of Object.entries(bill)) {
    const there = Math.max(0, (chest[item] ?? 0) - reservedCount(world, item, jobId));
    if (Math.min(n, there) > 0) mine[item] = Math.min(n, there);
  }
  world.reserved ??= {};
  if (Object.keys(mine).length) world.reserved[jobId] = mine; else delete world.reserved[jobId];
}

/** Let the job's materials go (done, cancelled, failed). */
export function release(world: WorldMemory, jobId: number): void {
  if (world.reserved) delete world.reserved[jobId];
}

/** The bill with the tools the job needs and doesn't have (any hoe will do for tilling; else a stone one). */
export function withTools(bill: Record<string, number>, tools: string[], have: Record<string, number>): Record<string, number> {
  const b = { ...bill };
  for (const tool of tools) if (!Object.keys(have).some(n => n.endsWith(`_${tool}`) && have[n] > 0)) b[`stone_${tool}`] = 1;
  return b;
}

export interface Provisioned {
  /** the whole bill is in the chests and reserved */
  ready: boolean;
  note: string;
  /** raw materials the stock trips should bring */
  need?: Record<string, number>;
  /** what the bot can't get by itself */
  missing?: Record<string, number>;
}

/** One step of securing the bill: reserve what's there, then gather, or make one kind, or say it's ready. */
export async function provisionStep(ctx: GoalContext, job: BuildJob, bill: Record<string, number>, tools: string[]): Promise<Provisioned> {
  const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
  // what the bill places that the bot carries goes into the chests first (counted, held, safe from the cook's fuel),
  // as much as the chests are short of it; not what the kit carries for itself (torches, its throwaway blocks: stored,
  // the kit took them straight back out, and the two took turns all morning)
  const carried = new Map<string, number>();
  for (const i of inv.items) if (i.slot < 36) carried.set(i.name, (carried.get(i.name) ?? 0) + i.count);
  for (const [name, n] of carried) {
    if (ctx.signal.aborted) break;
    if (!bill[name] || KIT_CARRIES.test(name)) continue;
    const inChests = (chestTotals(ctx.world)[name] ?? 0) - reservedCount(ctx.world, name, job.id);
    const want = Math.min(n, bill[name] - inChests);
    if (want > 0) await storeInChests(ctx, name, want).catch(() => 0);
  }
  const items = (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items;
  reserve(ctx.world, job.id, bill);
  const have = haveFor(ctx.world, items, job.id);
  const b = withTools(bill, tools, have);
  const src = sourceBill(b, have);
  if (Object.keys(src.missing).length) {
    return { ready: false, note: `it can't get ${list(src.missing)} by itself: put them in a home chest, or change the design`, missing: src.missing };
  }
  if (Object.keys(src.gather).length) return { ready: false, note: `gathering ${list(src.gather)}`, need: src.gather };
  // only making left: one kind a run, in a batch, into the chests (what's held for the job stays where it is: prepare
  // takes only what's beyond the reservation, so it makes the shortfall)
  const make = src.lines.find(l => l.source === 'craft' || l.source === 'smelt');
  if (make) {
    const short = make.need - Math.min(make.need, have[make.item] ?? 0);
    // prepare holds back what the bill places as it is from what's carried: here that's in the chests, held by the
    // ledger (which prepare's chest takes respect); holding it back again counted the 45 logs twice, and with 85 logs
    // there it made no stairs, "short of oak_log x5", run after run
    const held = ctx.world.reserved?.[job.id] ?? {};
    const keepCarried: Record<string, number> = {};
    for (const [k, v] of Object.entries(b)) if (v - (held[k] ?? 0) > 0) keepCarried[k] = v - (held[k] ?? 0);
    const left = await prepare(ctx, make.item, short, 0, keepCarried);
    await storeInChests(ctx, make.item).catch(() => 0);
    reserve(ctx.world, job.id, bill);
    // short of what it's made from after all (the counts were off, or a furnace's fuel): the stock trips bring it
    if (Object.keys(left).length) return { ready: false, note: `making ${make.item}: gathering ${list(left)}`, need: left };
    return { ready: false, note: `${make.source === 'smelt' ? 'smelted' : 'made'} ${make.item}` };
  }
  reserve(ctx.world, job.id, bill);
  return { ready: true, note: `all ${Object.values(bill).reduce((a, v) => a + v, 0)} item(s) of its bill in the chests, held for it` };
}

/** How much of the bill is secured (for the status line): items held over items needed. */
export function provisioned(world: WorldMemory, job: BuildJob): { held: number; total: number; short: Record<string, number> } {
  const bill = job.bill ?? {};
  const mine = world.reserved?.[job.id] ?? {};
  let held = 0, total = 0;
  const short: Record<string, number> = {};
  for (const [k, v] of Object.entries(bill)) {
    total += v;
    held += Math.min(v, mine[k] ?? 0);
    if ((mine[k] ?? 0) < v) short[k] = v - (mine[k] ?? 0);
  }
  return { held, total, short };
}
