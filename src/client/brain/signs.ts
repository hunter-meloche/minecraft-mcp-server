import type { Goal, GoalContext } from './goals.js';
import type { Pos } from './memory.js';
import { key } from './chests.js';
import { chestAssignment } from './chores.js';
import { categoryOfLabel, chestLabels, type Category } from './storage.js';
import { prepare } from './project.js';
import { allItems, mostWood } from './progress.js';

/**
 * A sign over every home chest naming what goes in it ("food1", "tools1", "ore2", ...), like a person labels their
 * storage. The labels follow the chest assignment the stash and the sort round use, so storing and fetching go by
 * them; a sign someone else wrote (a label the bot didn't put there) decides that chest's category instead.
 */

const MINUTE = 60_000;
const SIDES: Record<string, Pos> = { north: { x: 0, y: 0, z: -1 }, south: { x: 0, y: 0, z: 1 }, west: { x: -1, y: 0, z: 0 }, east: { x: 1, y: 0, z: 0 } };
const OPPOSITE: Record<string, string> = { north: 'south', south: 'north', west: 'east', east: 'west' };
const AIRY = /^(air|cave_air)$/;
const SOLID_NOT = /^(air|cave_air|water|lava|torch|wall_torch|.*_sign|.*_wall_sign|.*_carpet|.*_pressure_plate|.*_button|ladder|.*_door|.*_trapdoor)$/;
const name = (b: string | null | undefined) => (b ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
const at = (p: Pos, d: Pos) => ({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z });

async function blockAt(ctx: GoalContext, p: Pos): Promise<string> {
  const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', { ...p, width: 1, height: 1, length: 1 });
  return blocks[0] ?? '';
}

/**
 * Where a chest's sign goes: the cell above it, hung on the wall behind the chest (the side opposite its front), or
 * on another solid side; standing on the chest when there's no wall. Undefined when the cell above isn't free.
 */
export function signSpot(chestState: string, around: { above: string; sides: Record<string, string>; aboveSign?: boolean }): { face: string } | undefined {
  if (!AIRY.test(name(around.above)) && !around.aboveSign) return undefined;
  const facing = /facing=(north|south|east|west)/.exec(chestState)?.[1] ?? 'north';
  const order = [OPPOSITE[facing], ...Object.keys(SIDES).filter(s => s !== OPPOSITE[facing] && s !== facing)];
  for (const side of order) if (!SOLID_NOT.test(name(around.sides[side]))) return { face: side };
  return { face: 'down' };
}

export const signsGoal: Goal = {
  name: 'signs',
  priority: 24,
  timeoutMs: 8 * MINUTE,
  retryMs: 30 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || !s.home || s.distHome > 24 || world.landmarks.chests.length < 3) return null;
    if (s.now - (world.lastDone?.signs ?? 0) < 20 * MINUTE) return null;
    // the assignment as it stands now (new chests in it), not as the stash last left it
    const labels = chestLabels(world.landmarks.chests, chestAssignment(world));
    const keys = new Set(world.landmarks.chests.map(key));
    const missing = world.landmarks.chests.filter(c => labels[key(c)] && world.chestSigns?.[key(c)] !== labels[key(c)]).length +
      Object.keys(world.chestSigns ?? {}).filter(k => !keys.has(k)).length;
    return missing ? `${missing} chest(s) without the right sign` : null;
  },
  run: async ctx => {
    (ctx.world.lastDone ??= {}).signs = ctx.s.now;
    const signs = (ctx.world.chestSigns ??= {});
    let labels = chestLabels(ctx.world.landmarks.chests, chestAssignment(ctx.world));
    let placed = 0, adopted = 0, skipped = 0, removed = 0;
    // our signs over what is no longer a chest of its own (the right half of a double chest, a chest taken away)
    const chestKeys = new Set(ctx.world.landmarks.chests.map(key));
    for (const [k, text] of Object.entries(signs)) {
      if (chestKeys.has(k) || ctx.signal.aborted) continue;
      const [x, y, z] = k.split(',').map(Number);
      const cell = { x, y: y + 1, z };
      const there = await ctx.call<{ sign: boolean; lines?: string[] }>('sign.read', { ...cell });
      if (there.sign && (there.lines ?? []).join(' ').trim() === text) {
        await ctx.act('dig-block', { ...cell, collect: true }).catch(() => undefined);
        removed++;
      }
      delete signs[k];
    }
    for (const c of ctx.world.landmarks.chests) {
      if (ctx.signal.aborted) break;
      const k = key(c);
      const want = labels[k];
      if (!want || signs[k] === want) continue;
      const cell = at(c, { x: 0, y: 1, z: 0 });
      const there = await ctx.call<{ sign: boolean; lines?: string[] }>('sign.read', { ...cell });
      const text = (there.lines ?? []).join(' ').trim();
      if (there.sign && text === want) { signs[k] = want; continue; }
      // someone else's label: it decides this chest's category (and the numbering follows)
      const theirs = there.sign && text && !Object.values(signs).includes(text) ? categoryOfLabel(text) : undefined;
      if (theirs) {
        (ctx.world.chestAssign ??= {})[k] = theirs as Category;
        signs[k] = text;
        adopted++;
        labels = chestLabels(ctx.world.landmarks.chests, ctx.world.chestAssign);
        continue;
      }
      const chestState = await blockAt(ctx, c);
      const sides: Record<string, string> = {};
      for (const [side, d] of Object.entries(SIDES)) sides[side] = await blockAt(ctx, at(cell, d));
      const spot = signSpot(chestState, { above: await blockAt(ctx, cell), sides, aboveSign: there.sign });
      if (!spot) { skipped++; ctx.progress(`no room for a sign over the chest at ${k}`); continue; }
      if (there.sign) await ctx.act('dig-block', { ...cell, collect: true }); // our old label
      // a sign to hang: crafted from planks (3 a craft)
      const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
      if (!inv.items.some(i => i.slot < 36 && /_sign$/.test(i.name) && !/hanging/.test(i.name))) {
        const short = await prepare(ctx, `${mostWood(allItems(ctx.s, ctx.world))}_sign`, 3);
        if (Object.keys(short).length) throw new Error(`no signs, short of ${Object.entries(short).map(([n, v]) => `${v} ${n}`).join(', ')}`);
      }
      // near enough to reach it will do (a walk to the cell itself found no path 2 blocks away)
      await ctx.act('move-to-position', { ...cell, range: 2, timeoutMs: 60_000 }).catch(() => undefined);
      let r = await ctx.call<{ placed: boolean; written?: boolean; reason?: string }>('sign.place', { ...cell, face: spot.face, lines: [want] }, 15_000);
      if (!r.placed && r.reason === 'too far') {
        await ctx.act('move-to-position', { ...cell, range: 1, timeoutMs: 30_000 }).catch(() => undefined);
        r = await ctx.call('sign.place', { ...cell, face: spot.face, lines: [want] }, 15_000);
      }
      if (r.placed && r.written !== false) { signs[k] = want; placed++; ctx.progress(`"${want}" over the chest at ${k}`); }
      else { skipped++; ctx.progress(`sign at ${k}: ${r.reason ?? 'not written'}`); }
    }
    return `${placed} sign(s) put up${removed ? `, ${removed} old one(s) taken down` : ''}${adopted ? `, ${adopted} label(s) someone else wrote followed` : ''}${skipped ? `, ${skipped} chest(s) left without` : ''}`;
  }
};
