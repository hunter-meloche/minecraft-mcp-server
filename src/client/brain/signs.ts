import { nearHome, type Goal, type GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { key } from './chests.js';
import { chestAssignment } from './chores.js';
import { categoryOfLabel, chestLabels, type Category } from './storage.js';
import { prepare } from './project.js';
import { allItems, mostWood } from './progress.js';
import { roundDue, roundFrom, toRound } from './work.js';

/**
 * A sign over every home chest naming what goes in it ("food1", "tools1", "ore2", ...), like a person labels their
 * storage. The labels follow the chest assignment the stash and the sort round use, so storing and fetching go by
 * them; a sign someone else wrote (a label the bot didn't put there) decides that chest's category instead.
 */

const MINUTE = 60_000;
/** Near enough home to start the round where it is; from further out in the yard it walks home first (work.ts roundFrom). */
const REACH = 24;
/** a chest's sign is tried this often, then the chest is left without */
const TRIES = 2;
const SIDES: Record<string, Pos> = { north: { x: 0, y: 0, z: -1 }, south: { x: 0, y: 0, z: 1 }, west: { x: -1, y: 0, z: 0 }, east: { x: 1, y: 0, z: 0 } };
const OPPOSITE: Record<string, string> = { north: 'south', south: 'north', west: 'east', east: 'west' };
const AIRY = /^(air|cave_air)$/;
const FACING = /facing=(north|south|east|west)/;
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
  const facing = FACING.exec(chestState)?.[1] ?? 'north';
  const order = [OPPOSITE[facing], ...Object.keys(SIDES).filter(s => s !== OPPOSITE[facing] && s !== facing)];
  for (const side of order) if (!SOLID_NOT.test(name(around.sides[side]))) return { face: side };
  return { face: 'down' };
}

/**
 * A chest the round couldn't sign twice, for the label it is to wear now: left be (one under another chest has no room
 * for a sign, ever: counted as missing, it started the round every 20 minutes for a sign that cannot be hung).
 */
const leftBe = (world: WorldMemory, k: string, want: string) => world.signTries?.[k]?.label === want && world.signTries[k].tries >= TRIES;

/**
 * Up to a chest on foot only, breaking and placing nothing, to within 3 blocks of it: that the floor can meet for a
 * chest one or two layers up as well, and the sign over the chest is in reach from there. The walk before went to
 * within 2 of the sign cell, which over a top-layer chest nothing on the floor is: Baritone pillared up on cobblestone
 * in the storage house, the run was cut short, and the pillar stayed, on the home cell too (the way to bed was shut).
 */
const walkUp = (ctx: GoalContext, chest: Pos) =>
  ctx.call('goto', { ...chest, range: 3, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);

/**
 * Take a sign down by hand: from where the bot stands, or else from where the careful walk gets it. Not with
 * dig-block: that lets Baritone get at the block its own way (a pillar again, for the sign over a top-layer chest) and
 * walks onto the drop after. A sign that drops out of the way is a small loss (three come from one craft).
 * The hand needs the sign in sight, which hanging one does not, and within 3 of the chest is also the yard behind the
 * house wall and the floor right under a top-layer chest, whose own lid hides its sign: from there the old label stays
 * up, and after two such rounds the chest is left be with it. So before the try counts as failed, round to out in
 * front of the sign: three cells out, from where the sign of every layer shows over the lid; one, for a room too narrow.
 */
async function takeDown(ctx: GoalContext, cell: Pos, chest: Pos): Promise<boolean> {
  const dig = () => ctx.call<{ dug: boolean }>('dig.here', { ...cell, timeoutMs: 10_000 }, 20_000).catch(() => ({ dug: false }));
  if ((await dig()).dug) return true;
  await walkUp(ctx, chest);
  if ((await dig()).dug) return true;
  // a wall sign faces away from the wall it hangs on; a standing one faces nowhere: the chest's own front then
  const facing = FACING.exec(await blockAt(ctx, cell))?.[1] ?? FACING.exec(await blockAt(ctx, chest))?.[1];
  if (!facing) return false;
  for (const n of [3, 1]) {
    if (ctx.signal.aborted) break;
    // any height in that column: the floor's is not known from here (the chest may be two layers up)
    await ctx.call('goto', { x: cell.x + n * SIDES[facing].x, y: cell.y, z: cell.z + n * SIDES[facing].z, xz: true, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
    if ((await dig()).dug) return true;
  }
  return false;
}

export const signsGoal: Goal = {
  name: 'signs',
  priority: 24,
  timeoutMs: 8 * MINUTE,
  retryMs: 30 * MINUTE,
  wants: (s, world) => {
    if (s.activity !== 'work' || s.sleeping || !s.home || !roundFrom(s, world, REACH) || world.landmarks.chests.length < 3) return null;
    // after 20 min, and then in the evening, or when no trip could go instead (or it has waited 40): the morning is the trips'
    if (!roundDue(s, world, 'signs', 20 * MINUTE)) return null;
    // the assignment as it stands now (new chests in it), not as the stash last left it
    const labels = chestLabels(world.landmarks.chests, chestAssignment(world), world.chestSigns);
    const keys = new Set(world.landmarks.chests.map(key));
    const missing = world.landmarks.chests.filter(c => labels[key(c)] && world.chestSigns?.[key(c)] !== labels[key(c)] && !leftBe(world, key(c), labels[key(c)])).length +
      Object.keys(world.chestSigns ?? {}).filter(k => !keys.has(k)).length;
    return missing ? `${missing} chest(s) without the right sign` : null;
  },
  // within its reach it cuts in as ever; from out in the yard it waits for what runs to end
  cuts: s => nearHome(s, REACH),
  run: async run => {
    // from out in the yard, home first (on foot); its walks up to the chests go from there, as they always did
    const ctx: GoalContext = { ...run, s: await toRound(run, REACH) };
    (ctx.world.lastDone ??= {}).signs = ctx.s.now;
    const signs = (ctx.world.chestSigns ??= {});
    const tries = (ctx.world.signTries ??= {});
    let labels = chestLabels(ctx.world.landmarks.chests, chestAssignment(ctx.world), signs);
    let placed = 0, adopted = 0, skipped = 0, removed = 0;
    // our signs over what is no longer a chest of its own (the right half of a double chest, a chest taken away)
    const chestKeys = new Set(ctx.world.landmarks.chests.map(key));
    for (const k of Object.keys(tries)) if (!chestKeys.has(k)) delete tries[k]; // a chest that is gone
    for (const [k, text] of Object.entries(signs)) {
      if (chestKeys.has(k) || ctx.signal.aborted) continue;
      const [x, y, z] = k.split(',').map(Number);
      const cell = { x, y: y + 1, z };
      const there = await ctx.call<{ sign: boolean; lines?: string[] }>('sign.read', { ...cell });
      if (there.sign && (there.lines ?? []).join(' ').trim() === text && await takeDown(ctx, cell, { x, y, z })) removed++;
      delete signs[k];
    }
    for (const c of ctx.world.landmarks.chests) {
      if (ctx.signal.aborted) break;
      const k = key(c);
      const want = labels[k];
      if (!want || signs[k] === want) { delete tries[k]; continue; }
      if (tries[k] && tries[k].label !== want) delete tries[k]; // another label to wear now: its tries start again
      // a try that failed (a run cut short is not one)
      const miss = (why: string) => {
        if (ctx.signal.aborted) return;
        tries[k] = { label: want, tries: (tries[k]?.tries ?? 0) + 1 };
        skipped++;
        ctx.progress(why);
      };
      const cell = at(c, { x: 0, y: 1, z: 0 });
      const there = await ctx.call<{ sign: boolean; lines?: string[] }>('sign.read', { ...cell });
      const text = (there.lines ?? []).join(' ').trim();
      if (there.sign && text === want) { signs[k] = want; delete tries[k]; continue; }
      // someone else's label: it decides this chest's category (and the numbering follows)
      const theirs = there.sign && text && !Object.values(signs).includes(text) ? categoryOfLabel(text) : undefined;
      if (theirs) {
        (ctx.world.chestAssign ??= {})[k] = theirs as Category;
        signs[k] = text;
        delete tries[k];
        adopted++;
        labels = chestLabels(ctx.world.landmarks.chests, ctx.world.chestAssign, signs);
        continue;
      }
      // left be only now: the sign over it is still read every round, so a label someone hangs there is followed
      if (leftBe(ctx.world, k, want)) continue;
      const chestState = await blockAt(ctx, c);
      const sides: Record<string, string> = {};
      for (const [side, d] of Object.entries(SIDES)) sides[side] = await blockAt(ctx, at(cell, d));
      const spot = signSpot(chestState, { above: await blockAt(ctx, cell), sides, aboveSign: there.sign });
      if (!spot) { miss(`no room for a sign over the chest at ${k}`); continue; }
      // our old label
      if (there.sign && !await takeDown(ctx, cell, c)) { miss(`sign at ${k}: the old one did not come down`); continue; }
      // a sign to hang: crafted from planks (3 a craft)
      const inv = await ctx.call<{ items: { name: string; count: number; slot: number }[] }>('inventory');
      if (!inv.items.some(i => i.slot < 36 && /_sign$/.test(i.name) && !/hanging/.test(i.name))) {
        const short = await prepare(ctx, `${mostWood(allItems(ctx.s, ctx.world))}_sign`, 3);
        if (Object.keys(short).length) throw new Error(`no signs, short of ${Object.entries(short).map(([n, v]) => `${v} ${n}`).join(', ')}`);
      }
      const place = () => ctx.call<{ placed: boolean; written?: boolean; reason?: string }>('sign.place', { ...cell, face: spot.face, lines: [want] }, 15_000);
      // from where it stands first (the middle of the house has most of its chests in reach), and a walk only when
      // that is too far; still too far after it: this chest goes without
      let r = await place();
      if (!r.placed && r.reason === 'too far') {
        await walkUp(ctx, c);
        r = await place();
      }
      if (r.placed && r.written !== false) { signs[k] = want; delete tries[k]; placed++; ctx.progress(`"${want}" over the chest at ${k}`); }
      else miss(`sign at ${k}: ${r.reason ?? 'not written'}`);
    }
    return `${placed} sign(s) put up${removed ? `, ${removed} old one(s) taken down` : ''}${adopted ? `, ${adopted} label(s) someone else wrote followed` : ''}${skipped ? `, ${skipped} chest(s) left without` : ''}`;
  }
};
