import type { Goal, GoalContext } from './goals.js';
import type { Milestone, MilestoneState } from './progress.js';
import { buildStep, siteStep } from './milestones.js';
import { pen, type Side } from './blueprints.js';
import { nextAnimalAction, PEN_FOOD, type Animal, type Pen, type PenKind } from './animals.js';
import { prepareBill } from './project.js';
import { takeFromChests } from './chests.js';
import { someones, type Creature } from './courtesy.js';

/**
 * Animal pens: a 7 x 7 fenced pen per kind (cows, then sheep) with a gate toward home, and a chore that keeps each
 * stocked: strays lured in with wheat (walking, not sprinting: an animal can't keep up with a sprinting player), the
 * herd bred up to 6, the surplus culled for food and leather, the sheep sheared.
 */

const MINUTE = 60_000;
const SIZE = 7;
const MAX_ADULTS = 6;
/** An animal fed to breed can't breed again for 5 minutes (the client can't see that), by entity id. */
const fedAt = new Map<number, number>();

function gateToward(st: MilestoneState, home: { x: number; z: number }): Side {
  const site = st.data.site as { x: number; z: number };
  const cx = site.x + SIZE / 2, cz = site.z + SIZE / 2;
  return Math.abs(home.x - cx) > Math.abs(home.z - cz) ? (home.x < cx ? 'west' : 'east') : (home.z < cz ? 'north' : 'south');
}

export function penMilestone(kind: PenKind, prereqs: string[]): Milestone {
  const zone = `pen:${kind}`;
  const build = buildStep(zone, st => pen(SIZE, st.data.gate as Side), `${kind} pen`);
  return {
    id: `pen-${kind}`,
    title: `a ${kind} pen`,
    prereqs,
    done: v => !!v.world.zones?.[zone]?.length,
    steps: [
      siteStep(`${kind} pen`, SIZE, SIZE),
      { ...build, run: async (ctx, st) => { st.data.gate ??= gateToward(st, ctx.s.home!); return build.run(ctx, st); } }
    ]
  };
}

// ------------------------------------------------------------------------------------------------ the chore

type Ent = Animal & { category: string };
// someone's animals (named, tamed, on a lead, in their pen or by their builds) are never lured, bred or culled
const entities = async (ctx: GoalContext) =>
  (await ctx.call<{ entities: (Ent & Creature)[] }>('world.entities', { maxDistance: 48 })).entities.filter(e => e.category === 'creature' && !someones(e, ctx.world.yard));
const find = async (ctx: GoalContext, id: number) => (await entities(ctx)).find(e => e.id === id);
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const OUT: Record<Side, { x: number; z: number }> = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, east: { x: 1, z: 0 } };
const inside = (p: Pen, e: { x: number; z: number }) => e.x >= p.x1 && e.x < p.x2 + 1 && e.z >= p.z1 && e.z < p.z2 + 1;

/** Walk up to an animal and use `item` on it; true when the client says it was used. */
async function useOn(ctx: GoalContext, id: number, item: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const e = await find(ctx, id);
    if (!e) return false;
    if (e.distance > 3.5) await ctx.act('move-to-position', { ...e.position, range: 2, timeoutMs: 45_000 });
    try { await ctx.call('entity.use', { id, item }); return true; } catch { /* it moved: again */ }
  }
  return false;
}

/** The pen's gate, and the cells just outside it and two in. */
export function gateOf(gate: { x: number; y: number; z: number } | undefined, p: Pen) {
  if (!gate) return undefined;
  const side: Side = gate.z === p.z1 ? 'north' : gate.z === p.z2 ? 'south' : gate.x === p.x1 ? 'west' : 'east';
  const o = OUT[side];
  return { gate, side, outside: { x: gate.x + o.x, y: gate.y, z: gate.z + o.z }, inside: { x: gate.x - 2 * o.x, y: gate.y, z: gate.z - 2 * o.z } };
}

async function gateOpen(ctx: GoalContext, at: { x: number; y: number; z: number }): Promise<boolean> {
  const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...at, width: 1, height: 1, length: 1 });
  return /open=true/.test(blocks[0] ?? '');
}

/**
 * Lead a stray in: food in hand, walk to it, then back to the gate a few blocks at a time, waiting for it to keep up;
 * in through the gate, a moment for it to follow, then out with the food put away, shutting the gate.
 */
async function lure(ctx: GoalContext, kind: PenKind, p: Pen, id: number, food: string): Promise<string> {
  const way = gateOf(ctx.world.zones?.[`pen:${kind}:gate`]?.[0], p);
  if (!way) return `${kind}: no gate on the pen`;
  await ctx.call('sprint.set', { allowed: false });
  // the gate stays open while the animal follows the bot in (the client shuts gates behind the bot otherwise)
  await ctx.call('gates.auto', { enabled: false }).catch(() => undefined);
  try {
    await ctx.call('item.select', { name: food });
    let e = await find(ctx, id);
    if (!e) return `${kind}: it wandered off`;
    await ctx.act('move-to-position', { ...e.position, range: 3, timeoutMs: 60_000 });
    // back to the gate in legs of 4 blocks, waiting for it each time
    for (let leg = 0; leg < 20; leg++) {
      if (ctx.signal.aborted) return `${kind}: stopped`;
      const me = (await ctx.status()).position!;
      const d = Math.hypot(way.outside.x - me.x, way.outside.z - me.z);
      if (d < 2) break;
      const t = Math.min(1, 4 / d);
      await ctx.call('item.select', { name: food });
      await ctx.act('move-to-position', { x: me.x + (way.outside.x - me.x) * t, y: way.outside.y, z: me.z + (way.outside.z - me.z) * t, range: 1, timeoutMs: 20_000 });
      for (let w = 0; w < 4; w++) { e = await find(ctx, id); if (!e || e.distance < 5) break; await pause(1000); }
      if (!e || e.distance > 10) return `${kind}: it stopped following`;
    }
    if (!(await gateOpen(ctx, way.gate))) await ctx.act('use-item-on-block', { ...way.gate, face: 'up' });
    await ctx.call('item.select', { name: food });
    await ctx.act('move-to-position', { ...way.inside, range: 0, timeoutMs: 20_000 });
    for (let w = 0; w < 6; w++) { e = await find(ctx, id); if (!e || inside(p, e.position)) break; await pause(1000); }
    // food away (a sword in hand), or it follows the bot straight back out
    const weapon = ctx.s.items.find(i => /_sword$/.test(i.name))?.name;
    if (weapon) await ctx.call('item.select', { name: weapon });
    await pause(1500);
    await ctx.act('move-to-position', { ...way.outside, range: 0, timeoutMs: 20_000 });
    if (await gateOpen(ctx, way.gate)) await ctx.act('use-item-on-block', { ...way.gate, face: 'up' });
    e = await find(ctx, id);
    return e && inside(p, e.position) ? `${kind}: led one into the pen` : `${kind}: it did not come in`;
  } finally {
    await ctx.call('sprint.set', { allowed: true }).catch(() => undefined);
    await ctx.call('gates.auto', { enabled: true }).catch(() => undefined);
  }
}

/** Every few minutes by day: up to three things at each pen (lure, cull, shear, breed). */
export const pens: Goal = {
  name: 'pens',
  priority: 46,
  timeoutMs: 8 * MINUTE,
  retryMs: 10 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || s.distHome > 24 || s.slotsUsed >= 34) return null;
    if (!Object.keys(world.zones ?? {}).some(k => /^pen:[a-z]+$/.test(k))) return null;
    return s.now - (world.lastDone?.pens ?? 0) > 6 * MINUTE ? 'the pens: lure, breed, cull, shear' : null;
  },
  run: async ctx => {
    (ctx.world.lastDone ??= {}).pens = ctx.s.now;
    const out: string[] = [];
    for (const [key, zs] of Object.entries(ctx.world.zones ?? {})) {
      const m = /^pen:([a-z]+)$/.exec(key);
      if (!m || !zs[0]?.width) continue;
      const kind = m[1] as PenKind;
      const z = zs[0];
      const p: Pen = { x1: z.x, z1: z.z, x2: z.x + z.width! - 1, z2: z.z + z.length! - 1, kind };
      // food for it from the chests (wheat from the farm), and shears for the sheep
      const food = PEN_FOOD[kind];
      if (!food.some(f => (ctx.s.counts.get(f) ?? 0) >= 2)) for (const f of food) if (await takeFromChests(ctx, f, 16)) break;
      if (kind === 'sheep' && !ctx.s.counts.get('shears')) await prepareBill(ctx, { shears: 1 }).catch(() => undefined);
      for (let i = 0; i < 3 && !ctx.signal.aborted; i++) {
        const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
        const counts = new Map<string, number>();
        for (const it of inv.items) if (it.slot < 36) counts.set(it.name, (counts.get(it.name) ?? 0) + it.count);
        const a = nextAnimalAction(p, await entities(ctx), counts, {
          minAdults: 2, maxAdults: MAX_ADULTS, breedCooldownOk: id => Date.now() - (fedAt.get(id) ?? 0) > 5.5 * MINUTE
        });
        if (a.kind === 'wait') { out.push(`${kind}: ${a.why}`); break; }
        if (a.kind === 'lure') out.push(await lure(ctx, kind, p, a.target, a.food));
        else if (a.kind === 'breed') {
          let fed = 0;
          for (const id of a.ids) if (await useOn(ctx, id, a.food)) { fed++; fedAt.set(id, Date.now()); }
          out.push(`${kind}: fed ${fed} to breed`);
        } else if (a.kind === 'cull') {
          const r = await ctx.act('attack-entity', { target: `#${a.id}`, maxDistance: 24, timeoutMs: 30_000 });
          out.push(`${kind}: culled one (${r.text.split('\n')[0].slice(0, 60)})`);
        } else {
          out.push(`${kind}: ${(await useOn(ctx, a.id, 'shears')) ? 'sheared one' : 'could not shear'}`);
        }
        ctx.progress(out.at(-1)!);
      }
    }
    // empty pens and no animal near to lure: nothing changes in six minutes, and each look stopped whatever ran
    // (a wood trip for the homestead, twice): look again in half an hour
    if (out.length && out.every(o => /: 0 \w+ in the pen and none within \d+ to lure/.test(o))) ctx.world.lastDone.pens = ctx.s.now + 24 * MINUTE;
    return out.join('; ') || 'nothing to do at the pens';
  }
};
