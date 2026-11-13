import { fromGate, nearHome, no, type Decline, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';
import {
  allItems, backoffMs, backoffOf, countOf, haveFn, heldUntil, journal, milestoneOf, nextMilestone, progressOf, recipeFor, stepId, stillShort,
  type Milestone
} from './progress.js';
import { chestTotals, reservedCount, takeFromChests } from './chests.js';
import { clock } from './idlelog.js';
import { makeRoom, noRoom, room } from './pockets.js';

/**
 * The project goal: works the next milestone of the long game, one step per slot of free daytime, so the bot keeps
 * getting somewhere once its needs are met instead of standing about "idle (day)".
 */

const MINUTE = 60_000;

export function projectGoal(tree: Milestone[]): Goal {
  // while a step runs it keeps the raised urgency: a stock trip for 1 cobblestone stopped the yard's leveling midway
  let running = false;
  /** Nowhere it could work from: no home, another dimension. */
  const off = (s: Snapshot): Decline | null =>
    (s.dimension !== 'overworld' || !s.home || !Number.isFinite(s.distHome) ? no.away(s, 'project', 64) : null);
  // its work is in and around the yard (it ran while the bot was out on a deep trip); its own materials can fill
  // the pockets (one slot free will do, and the step makes it first where the stash can); two minutes before the
  // evening it is not worth starting
  const heldBack = (s: Snapshot, world: WorldMemory): Decline | null => (!nearHome(s, 64) ? no.away(s, 'project', 64) : s.health < 12 ? no.health(s, 'project', 12)
    : room('project', s, world) === 'no' ? noRoom('project', 'project', s, world) : null) ?? no.late(s, 'project', 2400);
  /**
   * Run now? The "no" is said in this order: nowhere it could work from; no milestone that can be worked (that is the
   * project's own reason, whatever the hour and the pockets); then what keeps it from one that can; the hour last.
   */
  const gate = (s: Snapshot, world: WorldMemory): Gate => {
    const away = off(s);
    if (away) return away;
    const held = heldBack(s, world);
    // not to run anyway: the tree is only looked at (nextMilestone below writes down what it finds in place)
    if (held) return waiting(tree, s, world) ?? held;
    const m = nextMilestone(tree, s, world);
    if (!m) return waiting(tree, s, world) ?? { cause: 'project', text: 'no milestone to work on' };
    const cur = progressOf(world).current;
    const step = m.steps[cur?.id === m.id ? cur.step : 0];
    return { want: `${m.title}: ${step?.name ?? 'finishing'}` };
  };
  return {
    name: 'project',
    priority: 28,
    // chores (stock trips, sorting, the farm round) can fill a short day: after 4 minutes of waiting the project goes
    // ahead of them, below food, kit and the stash (a whole day went by with the storage house never touched). Not
    // with a step that has come back short of materials twice running and is short still: that put a project that
    // could only come back short again ahead of the chores, the trips that fetch what it waits for among them (stuck)
    urgency: (s, world) => (running ? 39 : stuck(tree, s, world) ? 28 : s.now - (world.lastDone?.project ?? 0) > 4 * MINUTE ? 39 : 28),
    timeoutMs: 9 * MINUTE,
    retryMs: 2 * MINUTE,
    gate,
    wants: fromGate(gate).wants,
    // the gate's "no" as a look only, not through fromGate: the gate writes down a milestone it finds in place, as
    // wants() always did when the brain decides. The idle log and brain-status ask this where nothing decides (another
    // goal running, the project held back after a failure, the LLM driving, the autopilot off), and a milestone marked
    // done there was one the brain had not got to: it must say the same "no" and leave the world as it was
    declines: (s, world) => off(s) ?? waiting(tree, s, world) ?? heldBack(s, world),
    // a step that ends where it began (short of something, waiting) is busy time to no gain
    gains: true,
    run: async ctx => {
      running = true;
      // a slot free first (home to the chests where there is none): the step is then chosen and counted from the bot
      // as it is after that, before anything is written down
      try { return await runStep({ ...ctx, s: await makeRoom(ctx, 'project') }); } finally { running = false; }
    }
  };

  async function runStep(ctx: GoalContext): Promise<string> {
      const p = progressOf(ctx.world);
      (ctx.world.lastDone ??= {}).project = ctx.s.now;
      const m = nextMilestone(tree, ctx.s, ctx.world);
      if (!m) return 'nothing left to do';
      if (p.current?.id !== m.id) { p.current = { id: m.id, step: 0, data: {} }; journal(ctx.world, ctx.s.now, `started: ${m.title}`); }
      const cur = p.current;
      const step = m.steps[cur.step];
      if (!step) return finish(ctx, m);
      const id = stepId(m.id, cur.step);
      // what there was when the step set out (it moves things between the chests and the pockets as it goes)
      const before = allItems(ctx.s, ctx.world);
      ctx.progress(`${m.title} - ${step.name}`);
      // the gain of a step that is not done yet is the blocks it worked: counted from what its tools report, as they
      // report it (so a run stopped midway has what it did), and the steps stay as they are
      const act: GoalContext['act'] = async (tool, args) => {
        const done = await ctx.act(tool, args);
        ctx.gain(blocksWorked(tool, done.text));
        return done;
      };
      const r = await step.run({ ...ctx, act }, cur);
      if (r.status === 'blocked') {
        p.blockedUntil ??= {};
        const short = Object.entries(r.need ?? {}).filter(([, n]) => n > 0);
        if (short.length) {
          // short of materials: the same step coming back short again waits longer each time (3, 6, 12, 24 min), and
          // what it waits for is remembered as totals to reach, so the wait ends the moment all of it is there
          // (heldUntil) and not for a part of it. It came back every 3 min, whatever had or had not come in
          const have = await totalsNow(ctx, before);
          const n = (p.blocked?.id === id && p.blocked.n >= 1 ? Math.floor(p.blocked.n) : 0) + 1;
          p.blocked = { id, n, at: ctx.s.now, need: Object.fromEntries(short.map(([k, v]) => [k, countOf(have, k) + v])) };
          p.blockedUntil[m.id] = ctx.s.now + backoffMs(n);
        } else {
          // waiting for something else (a site, room in the yard, ground that would not level): its own fixed time,
          // which the materials being there must not cut short. The record of an earlier shortage stays (the step
          // has not got anywhere); the wait is told apart from that record's own by its end (backoffOf)
          const until = ctx.s.now + (r.retryMs ?? 10 * MINUTE);
          const own = p.blocked && typeof p.blocked.id === 'string' && milestoneOf(p.blocked.id) === m.id ? p.blocked.at + backoffMs(p.blocked.n) : NaN;
          p.blockedUntil[m.id] = until === own ? until + 1 : until;
        }
        journal(ctx.world, ctx.s.now, `${m.title}: ${step.name} blocked (${r.text})`);
        return `${m.title} - ${step.name}: ${r.text}`;
      }
      // it got somewhere: what it waited for, it waits for no longer (a wait cut short by the materials coming in
      // would otherwise stand, with nothing left to end it early)
      settle(ctx.world, m.id);
      if (r.status === 'done') {
        ctx.gain(1);
        journal(ctx.world, ctx.s.now, `${m.title}: ${step.name} done (${r.text})`);
        cur.step++;
        p.need = undefined;
        if (cur.step >= m.steps.length) return finish(ctx, m);
      }
      return `${m.title} - ${step.name}: ${r.text}`;
  }
}

function finish(ctx: GoalContext, m: Milestone): string {
  const p = progressOf(ctx.world);
  if (!p.done.includes(m.id)) p.done.push(m.id);
  p.current = undefined;
  p.need = undefined;
  settle(ctx.world, m.id);
  ctx.gain(1);
  journal(ctx.world, ctx.s.now, `done: ${m.title}`);
  return `${m.title} complete`;
}

/** A milestone that got on: its wait and its step's record of being short of materials are over. */
function settle(world: WorldMemory, milestone: string): void {
  const p = progressOf(world);
  if (typeof p.blocked?.id === 'string' && milestoneOf(p.blocked.id) === milestone) p.blocked = undefined;
  if (p.blockedUntil) delete p.blockedUntil[milestone];
}

/**
 * Everything carried and in the chests as it is now, counted the way the tick counts it (allItems: every slot, the
 * chests as remembered). Asked after a step came back short: it took things out of the chests and crafted on the way,
 * so the pockets are read again. If they cannot be read, what there was when the step set out: never less of a raw
 * material than there is now, so the wait errs on the long side.
 */
async function totalsNow(ctx: GoalContext, before: Record<string, number>): Promise<Record<string, number>> {
  try {
    const inv = await ctx.call<{ items: { name: string; count: number }[] }>('inventory');
    const out: Record<string, number> = { ...chestTotals(ctx.world) };
    for (const i of inv.items) out[i.name] = (out[i.name] ?? 0) + i.count;
    return out;
  } catch {
    return before;
  }
}

/** The tree as nextMilestone() sees it, as a look only: the milestone it would work on, and the ones that wait. */
function look(tree: Milestone[], s: Snapshot, world: WorldMemory): { next?: Milestone; held: { m: Milestone; until: number }[]; done: Set<string> } {
  const done = new Set(world.progress?.done ?? []);
  const view = { s, world, have: haveFn(s, world) };
  const held: { m: Milestone; until: number }[] = [];
  for (const m of tree) {
    if (done.has(m.id)) continue;
    if (m.done?.(view)) { done.add(m.id); continue; }
    if (!m.prereqs.every(r => done.has(r))) continue;
    const until = heldUntil(s, world, m.id);
    if (!(until > s.now)) return { next: m, held, done };
    held.push({ m, until });
  }
  return { held, done };
}

/**
 * Whether the step the project would work on now has come back short of materials twice or more in a row and is
 * short still: then it does not go ahead of the chores. Two things end that, so that the lower urgency cannot keep the
 * project behind chores for good. With everything it waited for there it can get on, and waits no longer than any
 * other step. And once it has stood behind the chores for as long again as its wait was (they wanted to run all that
 * time: a mission, a long build), it goes ahead of them as it used to: its run is what tells the stock trips what is
 * still short, and nothing else looks whether the step can get on by now.
 */
function stuck(tree: Milestone[], s: Snapshot, world: WorldMemory): boolean {
  try {
    const p = world.progress;
    const b = p?.blocked;
    // asked many times a tick (the brain sorts the goals by urgency): the tree is looked at only with such a record
    if (!b || !(b.n >= 2) || typeof b.id !== 'string') return false;
    if (!(s.now < b.at + 2 * backoffMs(b.n))) return false;
    // the milestone it would work on: the one that can be worked now, else the record's own while it waits
    const { next, held } = look(tree, s, world);
    const m = next ?? held.find(h => h.m.id === milestoneOf(b.id))?.m;
    if (!m || stepId(m.id, p?.current?.id === m.id ? p.current.step : 0) !== b.id) return false;
    return Object.keys(stillShort(b.need, allItems(s, world))).length > 0;
  } catch {
    return false;
  }
}

/**
 * Why no milestone can be worked now, or null when one can: nextMilestone() as a look only. The gate asks it also
 * where the project would not run anyway (at night, with full pockets), where nothing looked at the tree before: so
 * nothing is written here, and a milestone's check that cannot answer there leaves the gate's other reason to stand.
 */
function waiting(tree: Milestone[], s: Snapshot, world: WorldMemory): Decline | null {
  try {
    const p = world.progress;
    const { next, held, done } = look(tree, s, world);
    if (next) return null;
    if (!held.length) {
      const left = tree.filter(m => !done.has(m.id)).length;
      return left ? { cause: 'project', text: `${left} milestone(s) wait for one that is not in the tree` }
        : { cause: 'unneeded', text: `all ${tree.length} milestone(s) done` };
    }
    const first = held.reduce((a, b) => (b.until < a.until ? b : a));
    const list = (short: [string, number][]) => short.map(([k, n]) => `${n} ${k}`).join(', ');
    // a step waiting for materials: what is short of them now (it goes down as they come in), which try that was and
    // when the next one is, so the status shows a wait that grows and not a bot that forgot its project
    for (const { m, until } of held) {
      const b = backoffOf(p, m.id);
      const short = b ? Object.entries(stillShort(b.need, allItems(s, world))) : [];
      if (b && short.length) return { cause: 'project', text: `short of ${list(short)} (try ${b.n}, next ${clock(until)})`, until: first.until };
    }
    // what the step that ran last was short of (the stock trips fetch it); else which milestone waits, and how long
    const short = Object.entries(p?.need ?? {}).filter(([, n]) => n > 0);
    return {
      cause: 'project',
      text: short.length ? `short of ${list(short)}`
        : `${first.m.title} tries again in ${Math.max(1, Math.ceil((first.until - s.now) / MINUTE))} min`,
      until: first.until
    };
  } catch {
    return null;
  }
}

/**
 * How many blocks a tool's report says it worked: placed, dug, tilled, or cut and filled while leveling. 0 for
 * everything else, and for a report that does not say (a walk, a look, a failure).
 */
export function blocksWorked(tool: string, text: string): number {
  if (tool === 'place-block') return /^Placed /.test(text) ? 1 : 0;
  if (tool === 'dig-block') return /^Dug /.test(text) ? 1 : 0;
  // the hoe on a plot's cell: the report names the block as it is afterwards
  if (tool === 'use-item-on-block') return /farmland/.test(text) ? 1 : 0;
  if (tool === 'build-structure') {
    // "Used: oak_planks x12, cobblestone x3; wore out: stone_axe.": the blocks, not the tools that broke
    const used = /Used: ([^;.]*)/.exec(text)?.[1] ?? '';
    return [...used.matchAll(/ x(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0);
  }
  if (tool === 'level-area') {
    // the plan it set out with, less what it says is still to do; a look alone ("Already level", a dry run) worked none
    if (!/\nWorked \d+\/\d+ tile/.test(text)) return 0;
    const sum = (m: RegExpExecArray | null) => (m ? m.slice(1).reduce((a, n) => a + Number(n), 0) : 0);
    const before = sum(/cut (\d+) block\(s\).*?, fill (\d+) dirt \+ (\d+) cobblestone;/.exec(text));
    const rest = sum(/Still to do: cut (\d+), fill (\d+) dirt \(have \d+\) \+ (\d+) cobblestone/.exec(text));
    return Math.max(0, before - rest);
  }
  return 0;
}

// ------------------------------------------------------------------------------------------------ materials

const count = async (ctx: GoalContext, match: (name: string) => boolean) =>
  (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items
    .filter(i => i.slot < 36 && match(i.name)).reduce((a, i) => a + i.count, 0);
const matcher = (item: string) => item === 'log' ? (n: string) => /_log$/.test(n) && !/^stripped_/.test(n)
  : item === 'planks' ? (n: string) => /_planks$/.test(n)
  : item === 'coal' ? (n: string) => n === 'coal' || n === 'charcoal'
  : item === 'cobblestone' ? (n: string) => n === 'cobblestone' || n === 'cobbled_deepslate'
  : (n: string) => n === item;

/**
 * Get `n` of an item into the inventory: from the home chests, else crafted (planks from logs, sticks from planks,
 * and so on down RECIPES). Returns what's still short, as raw materials for the stock trips; {} when all is there.
 */
export async function prepare(ctx: GoalContext, item: string, n: number, depth = 0, reserve: Record<string, number> = {}): Promise<Record<string, number>> {
  const match = matcher(item);
  // what the bill needs as it is (a house's log corners) isn't there to be crafted into something else
  const held = depth ? reserve[item] ?? 0 : 0;
  const counted = async () => Math.max(0, (await count(ctx, match)) - held);
  let have = await counted();
  if (have >= n) return {};
  // from the chests (any kind of log or planks will do)
  for (const [name] of Object.entries(ctx.world.chestItems ?? {}).flatMap(([, items]) => Object.entries(items)).filter(([nm]) => match(nm))) {
    if (have >= n) break;
    await takeFromChests(ctx, name, n - have);
    have = await counted();
  }
  if (have >= n) return {};
  // ingots: smelted from the raw ore carried or in the chests (14 raw iron sat in a chest while the trips mined more)
  const raw = SMELTED[item];
  if (raw && ctx.world.landmarks.furnace) {
    const want = n - have;
    // what the bill places as it is (a wall's cobblestone) isn't there to be smelted into something else
    const spareOre = async () => Math.max(0, (await count(ctx, x => x === raw)) - (reserve[raw] ?? 0));
    let ore = await spareOre();
    if (ore < want) { await takeFromChests(ctx, raw, want - ore); ore = await spareOre(); }
    // not enough of what it smelts from: get that first (cobblestone for stone, stone for smooth stone...); with none
    // at all, what that's short of is what's short
    if (ore < want && depth < 6) {
      const sub = await prepare(ctx, raw, want, depth + 1, reserve);
      ore = await spareOre();
      if (!ore) return Object.keys(sub).length ? sub : { [item]: want };
    }
    if (ore) {
      const fuel = await fuelFor(ctx, reserve);
      if (!fuel) return { coal: Math.max(1, Math.ceil(Math.min(ore, want, SMELT_BATCH) / 8)) };
      // a batch at a time (a stack of glass is 11 minutes at the furnace): the rest next run
      const k = Math.min(ore, want, SMELT_BATCH);
      // fuel the bill places (its logs, its planks) burns only beyond what the bill needs
      const fuelCount = reserve[fuel] ? Math.max(1, (await count(ctx, x => x === fuel)) - reserve[fuel]) : undefined;
      await ctx.act('smelt-item', { ...ctx.world.landmarks.furnace, inputItem: raw, inputCount: k, fuelItem: fuel, ...(fuelCount ? { fuelCount } : {}), takeOutput: true, timeoutMs: k * 10_500 + 15_000 });
      have = await counted();
      if (have >= n) return {};
      return { [item]: n - have };
    }
  }
  const r = recipeFor(item);
  if (!r || depth > 6) return { [item]: n - have };
  const crafts = Math.ceil((n - have) / r.makes);
  const short: Record<string, number> = {};
  for (const [inp, k] of Object.entries(r.from)) {
    for (const [sk, sv] of Object.entries(await prepare(ctx, inp, k * crafts, depth + 1, reserve))) short[sk] = (short[sk] ?? 0) + sv;
  }
  if (Object.keys(short).length) return short;
  const output = item === 'planks' ? await planksFor(ctx) : item;
  const c = await ctx.act('craft-item', { outputItem: output, amount: crafts });
  if (!c.ok) return { [item]: n - have };
  const now = await counted();
  return now >= n ? {} : { [item]: n - now };
}

/** What smelts into what: the ingots, and the building blocks (glass from sand, stone from cobblestone, ...). */
export const SMELTED: Record<string, string> = {
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper',
  glass: 'sand', stone: 'cobblestone', smooth_stone: 'stone', brick: 'clay_ball', terracotta: 'clay',
  cracked_stone_bricks: 'stone_bricks', smooth_sandstone: 'sandstone', deepslate: 'cobbled_deepslate'
};
/** Most to smelt in one go (about 4 minutes at the furnace): a bigger bill is smelted over several runs. */
export const SMELT_BATCH = 24;
const FUEL = /^(coal|charcoal|(?!stripped_)[a-z_]+_log|[a-z_]+_planks)$/;

/**
 * Something to burn: carried (coal first), else coal or logs from the chests. `keep` is what a bill places as it is: a
 * kind carried only that many times over isn't fuel (a build's logs went into the furnace that smelted its stone).
 */
export async function fuelFor(ctx: GoalContext, keep: Record<string, number> = {}): Promise<string | undefined> {
  const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
  const carried = new Map<string, number>();
  for (const i of inv.items) if (i.slot < 36 && FUEL.test(i.name)) carried.set(i.name, (carried.get(i.name) ?? 0) + i.count);
  const coalFirst = ([a]: [string, number], [b]: [string, number]) => Number(!/coal/.test(a)) - Number(!/coal/.test(b));
  const spare = [...carried].filter(([n, k]) => k > (keep[n] ?? 0)).sort(coalFirst)[0]?.[0];
  if (spare) return spare;
  // what a build job has secured isn't fuel
  const stored = Object.entries(chestTotals(ctx.world)).filter(([n, k]) => k > reservedCount(ctx.world, n) && FUEL.test(n)).sort(coalFirst)[0]?.[0];
  if (stored && await takeFromChests(ctx, stored, 8)) return stored;
  return undefined;
}

/** Planks of the kind of log carried most. */
async function planksFor(ctx: GoalContext): Promise<string> {
  const inv = await ctx.call<{ items: { name: string; count: number }[] }>('inventory');
  const logs = new Map<string, number>();
  for (const i of inv.items) if (/_log$/.test(i.name) && !/^stripped_/.test(i.name)) logs.set(i.name, (logs.get(i.name) ?? 0) + i.count);
  const best = [...logs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'oak_log';
  return best.replace(/_log$/, '_planks');
}

/** Prepare a whole bill; what's short goes to the stock trips (progress.need) and comes back. */
export async function prepareBill(ctx: GoalContext, bill: Record<string, number>, opts: { record?: boolean } = {}): Promise<Record<string, number>> {
  const short: Record<string, number> = {};
  // raw items first (they can't be crafted); everything the bill places is kept back from the making of the rest (its
  // logs and planks out of the stairs, its cobblestone out of the furnace, none of them burnt as fuel)
  const raw = Object.entries(bill).filter(([item]) => !recipeFor(item));
  const reserve = { ...bill };
  for (const [item, n] of [...raw, ...Object.entries(bill).filter(([item]) => recipeFor(item))]) {
    for (const [k, v] of Object.entries(await prepare(ctx, item, n, 0, reserve))) short[k] = (short[k] ?? 0) + v;
  }
  // the project's shortfall is the stock trips' to fetch; a build job keeps its own (opts.record false)
  if (opts.record !== false) progressOf(ctx.world).need = Object.keys(short).length ? short : undefined;
  return short;
}

/**
 * Everything a bill is made from, all the way down (its own items, what they're crafted and smelted from, and what
 * that is made from): what stays carried while a project prepares it. Only the bill's own items stayed: the
 * enchanting room took its books, diamonds and obsidian out of the chests for the table and shelves, the pockets went
 * to 33, the stash (more urgent) put the 26 of them back, and round again every 15 s for an hour. `wood` stands for
 * the recipes' any-wood planks and logs.
 */
export function billCarry(bill: Record<string, number>, wood = 'oak'): string[] {
  const out = new Set<string>();
  const add = (item: string, depth: number) => {
    const name = item === 'planks' ? `${wood}_planks` : item === 'log' ? `${wood}_log` : item;
    if (out.has(name) || depth > 6) return;
    out.add(name);
    if (SMELTED[name]) add(SMELTED[name], depth + 1);
    for (const inp of Object.keys(recipeFor(name)?.from ?? {})) add(inp, depth + 1);
  };
  for (const item of Object.keys(bill)) add(item, 0);
  return [...out];
}

/**
 * The most of each carried kind the rest of a bill could still use, given what's carried already (planks in the
 * pockets need no logs), in whole stacks: the stash lets go of the stacks beyond it. Kept without a cap, the
 * enchanting room's oak held 208 logs and 128 planks on the bot when the bill took 16 logs, 127 planks and the
 * shelves' planks: the pockets sat at 31/36, over the stock trip's limit, so the trip for its sugar cane never went,
 * and "a materials trip waits for room" stashed the farm's wheat mid-round, every farm round of the day
 * (live 2026-11-09).
 */
export function billCarryCap(bill: Record<string, number>, carried: Map<string, number>, wood = 'oak'): Record<string, number> {
  const norm = (item: string) => (item === 'planks' ? `${wood}_planks` : item === 'log' ? `${wood}_log` : item);
  const inputs = (name: string): [string, number, number][] => {
    if (SMELTED[name]) return [[norm(SMELTED[name]), 1, 1]];
    const r = recipeFor(name);
    return r ? Object.entries(r.from).map(([k, v]) => [norm(k), v, r.makes]) : [];
  };
  // every item before what it's made from (planks get all their askers' demand before the logs are worked out)
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string, depth: number) => {
    if (seen.has(name) || depth > 6) return;
    seen.add(name);
    for (const [inp] of inputs(name)) visit(inp, depth + 1);
    order.push(name);
  };
  for (const item of Object.keys(bill)) visit(norm(item), 0);
  const need: Record<string, number> = {};
  for (const [k, v] of Object.entries(bill)) need[norm(k)] = (need[norm(k)] ?? 0) + v;
  for (const name of order.reverse()) {
    const left = Math.max(0, (need[name] ?? 0) - (carried.get(name) ?? 0));
    for (const [inp, v, makes] of inputs(name)) need[inp] = (need[inp] ?? 0) + Math.ceil(left / makes) * v;
  }
  return Object.fromEntries(Object.entries(need).map(([k, v]) => [k, Math.max(64, Math.ceil(v / 64) * 64)]));
}
