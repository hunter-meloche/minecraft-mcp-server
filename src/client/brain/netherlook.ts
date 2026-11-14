/**
 * The look trip into the Nether (P2b of the progression plan, run supervised): the second trip of stage 0, once the
 * setup has built its own Nether-side portal and found it linked with the home portal. Through the home portal, out
 * in its own hut; a look at the Nether round it (others' builds and the natural fortresses and bastions the bridge's
 * scan has seen down there, lava lakes, the way out of the hut on foot), kept in `world.nether.sites`; and back through
 * its own portal. At most 10 minutes, the kit at home included. It digs, places and takes nothing down there, and
 * walks nowhere but back into the portal: the trips after it (P3) go out from the hut by what it saw.
 *
 * The home portal coming out anywhere but at its own breaks the link the one way (a portal of someone's nearer home's
 * scaled point since, or its own put out and one the server made): it marks the two not linked, goes straight back
 * through the portal it came out of, nothing touched there, and holds the setup a day, which sees to it after (the
 * lead looks in between). Coming back out anywhere but by the home portal is the same. The walk home from the portal
 * is the work wrapper's, and whatever goes wrong down there the leave nether goal's.
 *
 * Coordinates are `nether (x, y, z)` and `overworld (x, y, z)` in the lines, as nether.ts says them. Nothing here is
 * used at the module's top level (worktasks.ts reaches it).
 */
import { no, type Decline, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { WorkResult } from './work.js';
import { homePortal } from './portal.js';
import { NETHER, OVERWORLD, netherOf, noteSites, notePortals, peekNether, portalCells, type NetherSite, type PortalShape } from './nether.js';
import {
  LINK_RANGE, SETUP_HEALTH, SETUP_WAITS, blockAt, bottomOf, boxGap, boxOf, enter, fetchSetupKit, footing, holdSetup, inBox, intoNether,
  listPortals, readGround, setupShort, walkFrom, zoneBox, type Box, type Grid, type Listed, type NetherZone
} from './nethersetup.js';

const MINUTE = 60_000;

/** The look's whole time, from the kit at home to back through its own portal. */
export const LOOK_MAX_MS = 10 * MINUTE;
/** What the look still needs of it once the kit is fetched: the way to the portal, through, the look, back. */
export const LOOK_LEAST_MS = 3 * MINUTE;
/** How far round its portal the look reads the ground (lava lakes, the way out), across; and down and up from it. */
export const LOOK_RADIUS = 24;
const LOOK_DOWN = 16;
const LOOK_UP = 8;
/** Out of the hut: this far from its portal across (the hut reaches 4 out of the portal's plane, its door's cell). */
export const HUT_OUT = 6;
/** A lava lake: this many lava cells together at the least (a fall's thin column or a drip is none). */
export const LAKE_MIN = 8;
/** Sites kept from one look: the builds of others nearest, the lava lakes nearest (every natural one seen is kept). */
const BUILDS_KEPT = 4;
const LAKES_KEPT = 3;

const fmt = (p: { x: number; y: number; z: number }) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const parse = (k: string): Pos => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------------------------------------ the gate

/** The look is open once the two sides are linked and its own portal is known, until the stage is past 0. */
export function lookOpen(world: WorldMemory): boolean {
  const n = peekNether(world);
  return n.linked === true && !!n.portal && n.stage === 0;
}

/**
 * Whether the look can set out now, pure: not hurt past what the run heals at home (the setup's SETUP_HEALTH), and
 * nothing of the Nether kit short that the chests do not hold either (the setup's own list: its frame's obsidian is
 * asked no more once its own portal stands). The hour is the rung's (3 min down there and home by dusk).
 */
export function lookReady(s: Snapshot, world: WorldMemory): Decline | null {
  if (s.health < SETUP_HEALTH) return no.health(s, 'the nether look', SETUP_HEALTH, 10);
  const short = setupShort(s, world);
  if (short.length) return { cause: 'kit', text: `look: short of ${short.join(', ')} (carried or in the chests)` };
  return null;
}

// ------------------------------------------------------------------------------------------------ what it sees

/** What a look found round its portal: the sites to keep, and the line that says them. */
export interface LookFound {
  sites: NetherSite[];
  text: string;
  /** the walk out of the hut on foot: where it ends (HUT_OUT clear of the portal) and in how many steps; none when shut in */
  exit?: { at: Pos; steps: number };
}

/** A box's middle, to the block. */
const middle = (b: Box): Pos => ({ x: Math.floor((b.x1 + b.x2) / 2), y: Math.floor((b.y1 + b.y2) / 2), z: Math.floor((b.z1 + b.z2) / 2) });
/** How far a cell is from a box across (x and z, the square the hut is measured in). */
const across = (p: Pos, b: Box) => Math.max(Math.max(0, b.x1 - p.x, p.x - b.x2), Math.max(0, b.z1 - p.z, p.z - b.z2));

/**
 * The lava lakes in a box of ground, pure: lava cells joined face to face, LAKE_MIN of them at the least, each by its
 * cell nearest `from` (where the danger starts) and how far that is, the nearest lake first.
 */
export function lavaLakes(g: Grid, from: Box): { at: Pos; size: number; off: number }[] {
  const seen = new Set<string>();
  const out: { at: Pos; size: number; off: number }[] = [];
  const lava = (p: Pos) => blockAt(g, p) === 'lava';
  for (let y = g.y; y < g.y + g.height; y++) for (let z = g.z; z < g.z + g.length; z++) for (let x = g.x; x < g.x + g.width; x++) {
    const p = { x, y, z };
    const k = `${x},${y},${z}`;
    if (seen.has(k) || !lava(p)) continue;
    seen.add(k);
    const lake: Pos[] = [];
    for (const queue = [p]; queue.length;) {
      const c = queue.pop()!;
      lake.push(c);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const q = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        const qk = `${q.x},${q.y},${q.z}`;
        if (seen.has(qk) || !lava(q)) continue;
        seen.add(qk);
        queue.push(q);
      }
    }
    if (lake.length < LAKE_MIN) continue;
    const gap = (c: Pos) => boxGap(from, { x1: c.x, y1: c.y, z1: c.z, x2: c.x, y2: c.y, z2: c.z });
    const near = lake.reduce((a, c) => (gap(c) < gap(a) ? c : a));
    out.push({ at: near, size: lake.length, off: Math.round(gap(near)) });
  }
  return out.sort((a, b) => a.off - b.off || b.size - a.size);
}

/**
 * The Nether round its own portal, pure: the builds of others (the bridge's Nether zones that are no natural fortress
 * or bastion), the natural fortresses and bastions, the lava lakes in the ground read, and the way out of the hut on
 * foot from where the bot stands (`me`), never into anyone's build: to the first cell HUT_OUT clear of the portal a
 * walk of fewest steps reaches. The sites to keep: every natural one by its middle, the nearest BUILDS_KEPT builds by
 * theirs, the hut's exit, the nearest LAKES_KEPT lakes by their cell nearest the portal.
 */
export function lookRound(g: Grid, portal: PortalShape, zones: NetherZone[], me: Pos): LookFound {
  const pb = boxOf(portalCells(portal));
  const off = (b: Box) => Math.round(boxGap(pb, b));
  const built = zones.filter(z => !z.natural).map(zoneBox).sort((a, b) => off(a) - off(b));
  const natural = zones.filter(z => !!z.natural).map(z => ({ kind: z.natural!, box: zoneBox(z) })).sort((a, b) => off(a.box) - off(b.box));
  const lakes = lavaLakes(g, pb);
  const start = footing(g, me);
  const reach = start ? walkFrom(g, [start], p => !built.some(b => inBox(b, p))) : new Map<string, { from: string | null; n: number }>();
  let exit: LookFound['exit'];
  for (const [k, r] of reach) {
    const p = parse(k);
    if (across(p, pb) >= HUT_OUT) { exit = { at: p, steps: r.n }; break; }
  }
  const sites: NetherSite[] = [
    ...natural.map(z => ({ kind: z.kind, ...middle(z.box) })),
    ...built.slice(0, BUILDS_KEPT).map(b => ({ kind: 'build', ...middle(b) })),
    ...(exit ? [{ kind: 'exit', ...exit.at }] : []),
    ...lakes.slice(0, LAKES_KEPT).map(l => ({ kind: 'lava', ...l.at }))
  ];
  const kinds = (kind: string) => {
    const of = natural.filter(z => z.kind === kind);
    return of.length ? `${plural(of.length, kind, `${kind}s`)} (the nearest at nether ${fmt(middle(of[0].box))}, ${off(of[0].box)} off)` : `no ${kind}`;
  };
  const text = [
    built.length ? `${plural(built.length, 'build of others', 'builds of others')} (the nearest ${off(built[0])} off)` : 'no builds of others',
    kinds('fortress'), kinds('bastion'),
    lakes.length ? `${plural(lakes.length, 'lava lake')} (the nearest ${lakes[0].off} off)` : 'no lava lake',
    exit ? `the way out of the hut open (${exit.steps} steps to nether ${fmt(exit.at)})` : 'no way out of the hut on foot'
  ].join(', ');
  return { sites, text, ...(exit ? { exit } : {}) };
}

// ------------------------------------------------------------------------------------------------ the run

/**
 * The look trip (see the top of the file). From home with the Nether kit (or it does not set out: untried), through
 * the home portal; at its own portal, the look, the sites kept, `nether: look from its hut at nether (x, y, z): ...`
 * said, and back through its own portal (out by the home portal: still linked). At anyone else's, or back out
 * elsewhere: not linked, the setup held a day. Ends where it ends: the work wrapper takes it home.
 */
export async function lookRun(ctx: GoalContext, budgetMs: number, now: () => number): Promise<WorkResult> {
  const began = now();
  const left = () => Math.min(budgetMs, LOOK_MAX_MS) - (now() - began);
  const world = ctx.world;
  const home = homePortal(world);
  const own = peekNether(world).portal;
  if (!home) return { gain: 0, text: 'no home portal lit', untried: true };
  if (!own) return { gain: 0, text: 'no portal of its own down there to look from', untried: true };
  const lacking = await fetchSetupKit(ctx);
  if (lacking) return { gain: 0, text: `not setting out: ${lacking}`, untried: true };
  if (left() < LOOK_LEAST_MS) {
    return { gain: 0, text: `not setting out: the kit took ${Math.round((now() - began) / 1000)} s, too little of the look's ${LOOK_MAX_MS / MINUTE} min is left`, untried: true };
  }
  const went = await intoNether(ctx, home);
  if ('why' in went) return { gain: 0, text: went.why, untried: true };
  const { homeShape, r, came } = went;

  // ---- where it came out: its own portal, or the link is broken the one way
  const st = await ctx.status().catch(() => undefined);
  const me = st?.position ?? r.position ?? came;
  const block = { x: Math.floor(came.x), y: Math.floor(came.y), z: Math.floor(came.z) };
  // the portal it came out of: the bridge's word, else the listed one the block is in, else (chunks still loading:
  // asked once more) the one it stands by
  const by = (list: Listed[]) => list.find(p => portalCells(p).some(c => same(c, block))) ??
    list.find(p => portalCells(p).some(c => Math.hypot(c.x - me.x, c.y - me.y, c.z - me.z) <= 3));
  let arrived: Listed | undefined = r.arrived ?? by(await listPortals(ctx, 128));
  if (!arrived) {
    await pause(SETUP_WAITS.loadMs);
    if (ctx.signal.aborted) throw new Error('aborted');
    arrived = by(await listPortals(ctx, 128));
  }
  // (none to be seen: no word on the link either way; the wrapper's way home looks for a portal itself)
  if (!arrived) return { gain: 0, text: `came out at nether ${fmt(block)} by no portal the bridge lists: nothing looked at` };
  const isOwn = (p: PortalShape) => portalCells(p).some(c => Math.abs(c.x - own.x) <= 1 && Math.abs(c.y - own.y) <= 1 && Math.abs(c.z - own.z) <= 1);
  const seen = (await ctx.call<{ portals?: PortalShape[] }>('foreign.portals', { dimension: NETHER }).catch(() => ({ portals: [] as PortalShape[] }))).portals ?? [];
  const theirs = !isOwn(arrived);
  notePortals(world, NETHER, theirs && !seen.some(p => p.x === arrived.x && p.y === arrived.y && p.z === arrived.z) ? [...seen, arrived] : seen);
  const nearest = (p: PortalShape) => bottomOf(p).sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
  if (theirs) {
    // nothing done there, not a step but back into the portal it came out of: the setup sees to the link after a
    // day's hold (its own portal stands: it checks it straight away then)
    netherOf(world).linked = false;
    const said = `nether: not linked: the home portal came out at nether ${fmt(arrived)}, not at its own at nether ${fmt(own)}`;
    holdSetup(ctx, now(), `${said}: setup held a day`, said.replace(/^nether: /, ''));
    const text = `the home portal came out at nether ${fmt(arrived)}, not at its own: not linked`;
    const b = await enter(ctx, nearest(arrived));
    const ok = b.ok === true && b.dimension === OVERWORLD;
    return {
      gain: 0, text: `${text}; ${ok ? `back at overworld ${fmt(b.portal ?? b.block ?? b.position ?? came)}` : `back through it: ${b.reason ?? b.dimension ?? 'no answer'}`}; setup held a day`,
      ...(ok ? { cameBack: true as const } : {})
    };
  }

  // (the walk to the portal ate the look's 10 minutes: back at once, the wrapper's way home through its own portal)
  if (left() <= 0) return { gain: 0, text: `out of the look's ${LOOK_MAX_MS / MINUTE} min on the way down: nothing looked at` };

  // ---- the look: the bridge's scan of the Nether round it (it follows the protection sync: a moment), and the ground
  await pause(SETUP_WAITS.loadMs);
  if (ctx.signal.aborted) throw new Error('aborted');
  const zones = (await ctx.call<{ zones?: NetherZone[] }>('foreign.zones', { dimension: NETHER }).catch(() => ({ zones: [] as NetherZone[] }))).zones ?? [];
  const pb = boxOf(portalCells(arrived));
  const g = await readGround(ctx, {
    x1: pb.x1 - LOOK_RADIUS, y1: Math.max(1, pb.y1 - LOOK_DOWN), z1: pb.z1 - LOOK_RADIUS,
    x2: pb.x2 + LOOK_RADIUS, y2: Math.min(126, pb.y2 + LOOK_UP), z2: pb.z2 + LOOK_RADIUS
  });
  const found = lookRound(g, arrived, zones, me);
  noteSites(world, found.sites, now());
  ctx.progress(`nether: look from its hut at nether ${fmt(arrived)}: ${found.text}`);
  const looked = `looked round its hut at nether ${fmt(arrived)}: ${found.text}`;

  // ---- back through its own portal: out by the home portal, still linked
  const b = await enter(ctx, nearest(arrived));
  if (!b.ok || b.dimension !== OVERWORLD) return { gain: 1, text: `${looked}; back through its own portal: ${b.ok ? `came out in ${b.dimension ?? 'the same place'}` : b.reason ?? 'no answer'}` };
  const out = b.portal ?? b.block ?? b.position ?? ctx.s.position;
  if (portalCells(homeShape).some(c => Math.hypot(c.x - out.x, c.y - out.y, c.z - out.z) <= LINK_RANGE)) {
    return { gain: 1, text: `${looked}; back at overworld ${fmt(out)}`, cameBack: true };
  }
  netherOf(world).linked = false;
  holdSetup(ctx, now(), `nether: not linked: came out at overworld ${fmt(out)}`, `its own portal at nether ${fmt(own)} led back to overworld ${fmt(out)}, not home`);
  return { gain: 1, text: `${looked}; its own portal led back to overworld ${fmt(out)}: not linked; setup held a day`, cameBack: true };
}
