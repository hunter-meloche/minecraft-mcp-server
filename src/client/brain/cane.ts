import { fromGate, no, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Milestone, StepResult } from './progress.js';
import type { Pos, WorldMemory } from './memory.js';
import { addZone } from './milestones.js';
import { takeFromChests } from './chests.js';
import { toTheWoods, WOODS_DIRS } from './chores.js';
import { makeRoom, noRoom, room } from './pockets.js';

/**
 * Sugar cane on the lake shore (paper for books, books for the enchanting table and its shelves): a few stalks from
 * the wild, planted on the land cells right beside the water, and a daily round that cuts the top two blocks and
 * leaves the base to grow again.
 */

const MINUTE = 60_000;
const CANE_ON = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|sand|red_sand|mud|moss_block)$/;
const AIRY = /^(air|short_grass|tall_grass|fern|leaf_litter|dandelion|poppy|bush)$/;
const name = (b: string | null | undefined) => (b ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
const ok = (text: string): StepResult => ({ status: 'done', text });
const blocked = (text: string, retryMs = 30 * MINUTE): StepResult => ({ status: 'blocked', text, retryMs });

/**
 * Shore cells for cane in a region read 3 high from the water's level (layer 0: the ground the cane stands on and the
 * water beside it; layers 1 and 2: open air for the cane): ground cane grows on, with water right next to it on some
 * side and air above. Returns the cells the cane goes in (a block above the ground), every other one along the shore.
 */
export function shoreCells(box: { x: number; y: number; z: number; width: number; height: number; length: number },
  blocks: (string | null)[], max: number): Pos[] {
  const { width: w, length: l } = box;
  const at = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= w || z >= l || y < 0 || y >= box.height ? '' : name(blocks[x + z * w + y * w * l]));
  const out: Pos[] = [];
  const taken = new Set<string>();
  for (let z = 0; z < l && out.length < max; z++) for (let x = 0; x < w && out.length < max; x++) {
    if (!CANE_ON.test(at(x, 0, z)) || !AIRY.test(at(x, 1, z)) || !AIRY.test(at(x, 2, z))) continue;
    if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => at(x + dx, 0, z + dz) === 'water')) continue;
    // a gap between plants, so each can be cut without stepping on the next
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => taken.has(`${x + dx},${z + dz}`))) continue;
    taken.add(`${x},${z}`);
    out.push({ x: box.x + x, y: box.y + 1, z: box.z + z });
  }
  return out;
}

const caneCount = async (ctx: GoalContext) =>
  (await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory')).items
    .filter(i => i.slot < 36 && i.name === 'sugar_cane').reduce((a, i) => a + i.count, 0);

export function caneMilestone(prereqs: string[]): Milestone {
  return {
    id: 'cane',
    title: 'sugar cane by the lake',
    prereqs,
    done: v => !!v.world.zones?.cane?.length,
    steps: [
      {
        name: 'find sugar cane',
        run: async (ctx, st) => {
          if ((await caneCount(ctx)) < 3) await takeFromChests(ctx, 'sugar_cane', 12);
          if ((await caneCount(ctx)) >= 3) return ok('cane in hand');
          // none in sight from home: off to where it found cane before, else one side of home a run, in turn (the
          // step only ever looked from home, found "no sugar_cane in sight" hourly from 09:57 on, and the enchanting
          // room behind it never started; all four sides at once would outrun the project's 9 minutes)
          const looked = Number(st.data.caneLooked ?? 0);
          const side = WOODS_DIRS[looked % WOODS_DIRS.length];
          const wild = await toTheWoods(ctx, ['sugar_cane'], false, { zone: 'wildcane', what: 'sugar cane', dirs: [side] });
          let r = wild.ok ? await ctx.act('mine-blocks', { block: 'sugar_cane', count: 6, timeoutMs: 4 * MINUTE }) : undefined;
          await ctx.act('go-home', { name: 'home', timeoutMs: 180_000 }).catch(() => undefined);
          if ((await caneCount(ctx)) >= 1) return ok((r?.text ?? wild.text).split('\n')[0].slice(0, 100));
          if (wild.ok && wild.text) delete ctx.world.zones?.wildcane; // seen, but none came of it: look elsewhere next time
          st.data.caneLooked = looked + 1;
          const why = r ? r.text.split('\n')[0].slice(0, 100) : wild.text;
          // the next side soon; once round all four, an hour (cane may come into reach as the yard and leash grow)
          return blocked(`no sugar cane found: ${why}`, (looked + 1) % WOODS_DIRS.length ? 5 * MINUTE : 60 * MINUTE);
        }
      },
      {
        name: 'plant cane on the lake shore',
        run: async ctx => {
          const water = (await ctx.call<{ positions: Pos[] }>('world.findBlocks', { block: 'water', maxDistance: 64, count: 64, openAbove: true })).positions;
          const lake = water[0];
          if (!lake) return blocked('no open water within 64 blocks', 60 * MINUTE);
          const box = { x: lake.x - 12, y: lake.y, z: lake.z - 12, width: 25, height: 3, length: 25 };
          const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', box);
          const cells = shoreCells(box, blocks, Math.min(12, await caneCount(ctx)));
          if (!cells.length) return blocked(`no shore to plant on round (${lake.x}, ${lake.z})`, 60 * MINUTE);
          let planted = 0;
          for (const c of cells) {
            if (ctx.signal.aborted) break;
            const r = await ctx.act('place-block', { ...c, faceDirection: 'down', item: 'sugar_cane' });
            if (/^Placed/.test(r.text)) { planted++; addZone(ctx.world, 'cane', c); }
          }
          return planted ? ok(`planted ${planted} cane on the shore by (${lake.x}, ${lake.z})`) : blocked('the cane would not go in', 20 * MINUTE);
        }
      }
    ]
  };
}

/**
 * What a filler block in a cane cell can be: the scaffold kinds (Baritone's throwaway blocks, what tidy clears). Live
 * 2026-11-09: all five cane cells by the lake held cobblestone, the cane gone; the round only replanted into air, so
 * it cut 0 stalks every 20 min for 15 hours with 15 cane carried, and the enchanting room sat short of 120 cane.
 */
const FILLER = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack)$/;

/** What the round does with one of its cells, from the cell's block and the one above: cut, replant, clear, or leave. */
export function caneCellPlan(base: string, mid: string, haveCane: boolean): 'cut' | 'plant' | 'clear' | 'leave' {
  if (base === 'sugar_cane') return mid === 'sugar_cane' ? 'cut' : 'leave';
  if (!haveCane) return 'leave';
  if (AIRY.test(base)) return 'plant';
  // a scaffold block in the bot's own cane cell (anything else someone may have put there on purpose stays)
  return FILLER.test(base) && AIRY.test(mid) ? 'clear' : 'leave';
}

/**
 * Run now? The "no" is said in this order: no cane to see to (no patch, or the round is not due); then what keeps a
 * round that is due from going (not in the yard, no room for the stalks); the hour last.
 */
const gate = (s: Snapshot, world: WorldMemory): Gate => {
  if (!world.zones?.cane?.length) return { cause: 'unneeded', text: 'no cane patch' };
  const last = world.lastDone?.cane ?? 0;
  if (!(s.now - last > 20 * MINUTE)) return no.notDue('cane', s.now, last, 20 * MINUTE);
  if (s.distHome > 24) return no.away(s, 'cane', 24);
  // two slots free for the stalks, or the stash able to make them (the round does that first)
  if (room('yard', s, world) === 'no') return noRoom('yard', 'cane', s, world);
  return no.late(s, 'cane') ?? { want: 'daily round: the sugar cane' };
};

/** Once a day: cut the cane down to its base (the stalk above the bottom block), and replant a missing base. */
export const caneRound: Goal = {
  name: 'cane',
  priority: 29,
  timeoutMs: 6 * MINUTE,
  retryMs: 30 * MINUTE,
  gate,
  ...fromGate(gate),
  // a round that cuts nothing and plants nothing (the cells bare and no cane to plant) is busy time to no gain
  gains: true,
  run: async ctx => {
    // room for the stalks first (home to the chests where the pockets are too full; the walk to the cane is the
    // round's own, as ever). Before the round is written down: one that could make no room has not been
    await makeRoom(ctx, 'yard');
    (ctx.world.lastDone ??= {}).cane = ctx.s.now;
    let cut = 0, replanted = 0, cleared = 0;
    const cells = ctx.world.zones!.cane;
    const read = async (c: Pos) => (await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...c, width: 1, height: 3, length: 1 })).blocks.map(name);
    const seen = new Map<Pos, string[]>();
    for (const c of cells) seen.set(c, await read(c));
    // bases to put back, and too few carried: a few from the chests first. Live 2026-11-10: the stash had put every
    // stalk away (37 in the food chest), all five cells stood empty, and the round "cut 0 stalk(s) (0 cane)" every
    // 20 min for 9 hours with nothing to replant, while the enchanting room waited on 98 cane.
    const bare = [...seen.values()].filter(([base, mid]) => caneCellPlan(base, mid, true) !== 'leave' && base !== 'sugar_cane').length;
    // (a chest out of reach is no reason to skip the cutting: live, stranded on a scaffold, "chest too far to open")
    if (bare && (await caneCount(ctx)) < bare) await takeFromChests(ctx, 'sugar_cane', bare - (await caneCount(ctx))).catch(() => 0);
    const before = await caneCount(ctx);
    for (const c of cells) {
      if (ctx.signal.aborted) break;
      const [base, mid] = seen.get(c)!;
      const plan = caneCellPlan(base, mid, base !== 'sugar_cane' && (await caneCount(ctx)) > 0);
      if (plan === 'cut') {
        // cutting the second block brings the rest down with it
        const r = await ctx.act('dig-block', { x: c.x, y: c.y + 1, z: c.z, collect: true });
        if (/^Dug/.test(r.text)) { cut++; ctx.gain(1); }
      } else if (plan === 'plant' || plan === 'clear') {
        if (plan === 'clear') {
          const d = await ctx.act('dig-block', { ...c, collect: true }).catch(e => ({ ok: false, text: (e as Error).message }));
          if (!/^Dug|^No block/.test(d.text)) { ctx.progress(`cane cell ${c.x},${c.y},${c.z}: ${base} would not come out: ${d.text.slice(0, 100)}`); continue; }
          cleared++;
        }
        const r = await ctx.act('place-block', { ...c, faceDirection: 'down', item: 'sugar_cane' });
        if (/^Placed/.test(r.text)) { replanted++; ctx.gain(1); }
      }
    }
    const got = (await caneCount(ctx)) - before + replanted;
    return `cut ${cut} stalk(s) (${Math.max(0, got)} cane)${replanted ? `, replanted ${replanted}` : ''}${cleared ? ` (${cleared} cell(s) cleared of scaffold first)` : ''}`;
  }
};
