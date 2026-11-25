/**
 * The pasture: the fake world the villager fetch is tested against (acquiring villagers, design section 8), its core
 * (S0). The live yard (x -565..-533, z 2119..2215, ground at y 62) with its fence and four gates, the hall with its
 * gate H, the lock in front of it with its gate P, the socket, the sill and the post, the Nether portal and its ring,
 * the two pens, the workshop with its smithing table, the decoration a villager wedged on, and the crossings the bot's
 * own walks left over the fence; the bot (its cell, pockets, health, food); villagers, animals and drops with uuids;
 * time in game ticks, which every call, walk, wait and poll moves on; and the bridge as the brain meets it: `call`
 * and `act` with a log that keeps brain.json as it was SAVED at each call, the protection store (placed-blocks.json)
 * as a store of its own beside the client mod's list of it, and a kill or a restart between any two calls, with the
 * game client dying too (the bridge's holds and sets are statics of it) or not.
 *
 * What the bridge can reach and see is PORTED here from the Java, rule for rule, and each port is pinned to its Java
 * lines in tests/client/pasture.test.ts as rails-bridge.test.ts pins Rails.java: a kinder fake passes every lock
 * scenario that fails live (the socket's one open face has the sill's rail before it).
 *   - `place` (Interact.java aimPlace): the target replaceable, the reference block tried down, north, south, east,
 *     west, up (the asked face first), the first that will do judged alone, 4.5 from the eye to the hit, no sight;
 *   - `dig.here` (Interact.java, as bridge change B6 leaves it): a face is covered only by a full cube before it, its
 *     middle scaled 0.49 within 4.4 of the eye, and an OUTLINE clip from the eye to it must meet this block first;
 *   - `useOn`: 4.5 from the eye to the face's middle, no sight; a gate or door is only ever toggled, as it stands
 *     when the click lands two ticks on, not as it was read at the call;
 *   - the gate closer (Gates.java): a gate that opens within 2.5 of the bot is the bot's, shut once it is clear of it
 *     by 2.2 and within 4.4 of the eye, never with a screen open, an item in use, a block being broken or the sneak
 *     key down; forgotten 6 off or after a minute unless strict (its opening of a door the bot is shut in is not
 *     ported: no walk here ends in a doorway);
 *   - the holds, the strict set, the pair, the guard and `leftOpen` (GateHolds.java, ported whole below).
 * A careful `goto` walks only where a way on foot exists (rises of one, drops of three, its own gates opened) and
 * FAILS where none does: one that always arrives hides every "no way on foot". A plain one arrives all the same, as
 * Baritone digs and pillars, and is counted in `broke`.
 *
 * The villagers of the core are still, or LEAK-SEEKING: awake and within 6 of an open gate with a way through it, one
 * walks out with probability 1, on through every open gate it comes to, and it follows the bot, through the very cell
 * the bot stands in (entities push, they do not block: the bot in a gateway is no wall). The lock's rule (never both
 * gates open, never P open onto a villager) is tested against that, not against luck. The game's own villager (job
 * sites, the bell, the bed) is the reference villagers' half (S1), written apart.
 *
 * A scenario's own: `on.call[method]` and `on.act[tool]` answer first (undefined: the pasture's own answer, which a
 * handler can also give itself by `answer`, to lose a reply after the act); `at(tick, run)` lets something happen;
 * `killAt` / `restartAt` / `kill` / `restart` end and begin brain processes. A bridge call the core has no answer for
 * throws: a mistyped name is a caller's bug, not an empty reply.
 */
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { InventoryItem, Status } from '../../src/client/tools.js';
import type { StructureSpec } from '../../src/client/schematic.js';
import { billLeft, fenceRing, hall, hallLock, pen, portal, portalRing, workshop, type Blueprint, type Side } from '../../src/client/brain/blueprints.js';
import { activityAt } from '../../src/client/brain/schedule.js';

// ------------------------------------------------------------------------------------------------ numbers

/** A game tick, ms. The client's ticks and the world's are one here (a slow server is a scenario's own). */
export const TICK_MS = 50;
/** Eye over feet, standing (the bridge's getEyePosition). */
export const EYE = 1.62;
/** dig.here and the gate closer: blockInteractionRange() - 0.1, from the eye. */
export const REACH = 4.4;
/** place and useOn: from the eye to the point clicked. */
export const CLICK_REACH = 4.5;
/** The closer: a gate that opens this near the bot's feet is the bot's; it is shut once the bot is this clear of it. */
export const ADOPT = 2.5;
export const CLEAR = 2.2;
/** The closer forgets a gate that is not strict this far off, or this long after it opened. */
const FORGET = 6;
const FORGET_TICKS = 20 * 60;
/**
 * The bot walks a block in this many ticks (4 b/s). So does a leak-seeking villager: it is the adversary, and keeps up
 * with the bot it follows (the game's own walk 2 b/s: the reference villagers' number).
 */
const WALK_TICKS = 5;
const LEAK_TICKS = WALK_TICKS;
const HOMING_TICKS = 10;
/** A leak-seeking villager sees an open gate, or the bot, this far off. */
export const LEAK_R = 6;
/** Blocks are read (and gates "loaded") this far from the bot across the ground; entities tick this far from it or a player. */
const SIGHT = 96;
const SIMULATION = 160;
/** A careful walk that finds no way gives up after this long. */
const NO_WAY_TICKS = 100;
/** The game client's way back after it died with the brain (the unit restarted): about 90 s. */
export const CLIENT_BACK_TICKS = 1800;
export const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);

export const HOME: Pos = { x: -549, y: 63, z: 2183 };
export const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
export const HALL = { x: -561, y: 62, z: 2126, width: 11, length: 9 };
/** The hall's gate, and what the design's lock table (4.8) puts round it for a gate on the south side. */
export const H: Pos = { x: -556, y: 63, z: 2134 };
export const P: Pos = { x: H.x, y: H.y, z: H.z + 3 };
/** The Nether portal's site (the frame's blueprint: 6 x 3, its plinth in the ground), and its lit cells. */
export const PORTAL = { x: -562, y: 62, z: 2146, width: 6, length: 3 };
export const SMITHING: Pos = { x: -541, y: 63, z: 2153 };
export const YARD_GATES: Record<Side, Pos> = {
  north: { x: -549, y: 63, z: 2119 }, east: { x: -533, y: 63, z: 2183 }, south: { x: -549, y: 63, z: 2215 }, west: { x: -565, y: 63, z: 2183 }
};

export const key = (p: Pos) => `${p.x},${p.y},${p.z}`;
export const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
const cellOf = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const same = (a: Pos | undefined, b: Pos | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
const mid = (c: Pos): Pos => ({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });
/** Standing in a cell: its middle, on its floor (an entity's position). */
const feet = (c: Pos): Pos => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
const dist = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const flat = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const round = (n: number) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------------------------------------ blocks

/** A block's id ("oak_fence_gate[facing=south,open=false]" -> "oak_fence_gate"), '' for a cell not read. */
export const idOf = (state: string | null | undefined) => (state ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
export const propsOf = (state: string): Record<string, string> =>
  Object.fromEntries((/\[(.*)\]$/.exec(state)?.[1] ?? '').split(',').filter(Boolean).map(kv => kv.split('=') as [string, string]));
/** A state as the bridge writes it: the properties by name, as the game orders them. */
export const stateOf = (id: string, props: Record<string, string>) => {
  const list = Object.keys(props).sort().map(k => `${k}=${props[k]}`).join(',');
  return list ? `${id}[${list}]` : id;
};

/** A box inside a cell: x1, y1, z1, x2, y2, z2. */
type Box = [number, number, number, number, number, number];
const WHOLE: Box = [0, 0, 0, 1, 1, 1];
/** What a block is to a click, a ray and a walker. */
interface Shape {
  /** a block may be put in its place (Interact.java replaceable: air, or canBeReplaced) */
  soft: boolean;
  /** isCollisionShapeFullBlock: what covers a face for dig.here */
  full: boolean;
  /** nothing walks into it */
  solid: boolean;
  /** its top is a floor level with the cell's top */
  floor: boolean;
  /** its outline, for the OUTLINE clip (a fence's arms are added where it stands: outlineAt) */
  outline: Box[];
}
const px = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): Box => [x1 / 16, y1 / 16, z1 / 16, x2 / 16, y2 / 16, z2 / 16];
/** What has no outline at all: the air, the fluids (the bridge's clips ask for none), a light block. */
const SOFT = /^(|air|cave_air|void_air|water|lava|light)$/;
/**
 * What grows, and the small things that stand on the ground: nothing walks into trouble on them, but a ray stops on
 * each, and on no less of it than in the game (a kinder outline here sees the lure through a plant the bridge's clip
 * stops on). Their OUTLINE shapes as the 26.3 jar has them (javap): TallGrassBlock and DryVegetationBlock
 * column(12, 0, 13); FlowerBlock column(6, 0, 10), moved up to a quarter block by its position; MushroomBlock
 * column(6, 0, 6); SaplingBlock column(12, 0, 12); BaseTorchBlock column(4, 0, 10); LanternBlock 6 wide, to 9 high
 * standing and from 1 to 10 hanging. Each low plant is taken at its own height and the cell's whole width. A
 * DoublePlantBlock (tall grass, a large fern, a sunflower, a rose bush) has no shape of its own: a whole cube to a ray.
 * So are grown crops (cell-wide, 16 high at full age) and whatever else is here without a shape checked: its cell
 * (a vine, seagrass). Snow lies two sixteenths a layer (SnowLayerBlock), fire one over the ground (BaseFireBlock).
 * What a block is PUT INTO as into air (`soft`: the game's canBeReplaced) is another matter: of these the grasses, the
 * ferns, a dead bush, a vine, seagrass, fire, and snow one layer deep.
 */
const VINE_LIKE = /^(vine|seagrass|tall_seagrass)$/;
const FIRE = /^(soul_)?fire$/;
const GRASS = /^(short_grass|fern|dead_bush)$/;
const TALL_GRASS = /^(tall_grass|large_fern)$/;
const FLOWER = /^(poppy|dandelion|cornflower|oxeye_daisy|azure_bluet|allium|blue_orchid|.*_tulip|lily_of_the_valley)$/;
const MUSHROOM = /^(red|brown)_mushroom$/;
const SAPLING = /_sapling$/;
const TORCH = /^(redstone_|soul_)?torch$/;
const GROWN = /^(sunflower|lilac|peony|rose_bush|wheat|carrots|potatoes|beetroots|sugar_cane|lever|.*_button)$/;
const FLOOR_FLAT = /^(.*rail|.*_carpet|.*_pressure_plate|redstone_wire)$/;
const POST = /(_fence|_wall|glass_pane|iron_bars)$/;
const LOW_FLOOR = /^(farmland|dirt_path|soul_sand)$/;
const FURNITURE = /^(.*_bed|.*chest|lectern|composter|brewing_stand|enchanting_table|.*anvil|stonecutter|grindstone|bell|.*cauldron|.*campfire|cactus|hopper|.*_trapdoor|.*_sign|ladder|cobweb)$/;
/** What no way on foot goes through, the bot's or a villager's. */
const HAZARD = /^(lava|fire|soul_fire|cactus|sweet_berry_bush|.*campfire|powder_snow|wither_rose|cobweb)$/;
export const isGate = (state: string | null | undefined) => /_fence_gate$/.test(idOf(state));
const isDoor = (state: string | null | undefined) => /_door$/.test(idOf(state));
export const isOpen = (state: string | null | undefined) => /[[,]open=true/.test(state ?? '');
/** Turned from "facing south" (a gate across x, a torch on the block north of it) to the block's own facing. */
const turned = (b: Box, facing: string | undefined): Box =>
  (facing === 'east' ? [b[2], b[1], b[0], b[5], b[4], b[3]] : facing === 'west' ? [1 - b[5], b[1], b[0], 1 - b[2], b[4], b[3]]
    : facing === 'north' ? [b[0], b[1], 1 - b[5], b[3], b[4], 1 - b[2]] : b);

export function shapeOf(state: string | null | undefined): Shape {
  const id = idOf(state), props = state?.includes('[') ? propsOf(state) : {};
  if (SOFT.test(id)) return { soft: true, full: false, solid: false, floor: false, outline: [] };
  if (GRASS.test(id)) return { soft: true, full: false, solid: false, floor: false, outline: [px(0, 0, 0, 16, 13, 16)] };
  if (TALL_GRASS.test(id) || VINE_LIKE.test(id)) return { soft: true, full: false, solid: false, floor: false, outline: [WHOLE] };
  if (FIRE.test(id)) return { soft: true, full: false, solid: false, floor: false, outline: [px(0, 0, 0, 16, 1, 16)] };
  if (id === 'snow') {
    // (deeper than one layer it is a block: nothing is put into it, and a take finds it standing there)
    const layers = Math.min(8, Math.max(1, Number(props.layers ?? 1) || 1));
    return { soft: layers === 1, full: false, solid: false, floor: false, outline: [px(0, 0, 0, 16, 2 * layers, 16)] };
  }
  const low = FLOWER.test(id) ? px(0, 0, 0, 16, 10, 16) : MUSHROOM.test(id) ? px(0, 0, 0, 16, 6, 16) : SAPLING.test(id) ? px(0, 0, 0, 16, 12, 16)
    : TORCH.test(id) ? px(6, 0, 6, 10, 10, 10) : id === 'lantern' ? px(5, 0, 5, 11, 10, 11) : GROWN.test(id) ? WHOLE : undefined;
  if (low) return { soft: false, full: false, solid: false, floor: false, outline: [low] };
  // (WallTorchBlock: 5 wide, from 3 to 13 up, 5 out of the block it hangs on; a rail that climbs is half a block high)
  if (id === 'wall_torch') return { soft: false, full: false, solid: false, floor: false, outline: [turned(px(5.5, 3, 0, 10.5, 13, 5), props.facing)] };
  if (FLOOR_FLAT.test(id)) return { soft: false, full: false, solid: false, floor: false, outline: [px(0, 0, 0, 16, /^ascending/.test(props.shape ?? '') ? 8 : 2, 16)] };
  if (id === 'nether_portal') return { soft: false, full: false, solid: false, floor: false, outline: [props.axis === 'z' ? [0.375, 0, 0, 0.625, 1, 1] : [0, 0, 0.375, 1, 1, 0.625]] };
  if (isGate(id)) {
    // shut: a bar across its cell, 1.5 high to a walker; open: a way through for whoever walks. To a ray it is the
    // same bar open or shut (FenceGateBlock.getShape reads the facing's axis and in_wall, never `open`: a click or a
    // dig aimed through an open gate lands on the gate)
    const open = props.open === 'true';
    const bar: Box = px(0, 0, 6, 16, props.in_wall === 'true' ? 13 : 16, 10);
    return { soft: false, full: false, solid: !open, floor: false, outline: [turned(bar, props.facing === 'east' || props.facing === 'west' ? 'east' : 'south')] };
  }
  // a door: both the bot and a villager open it; to a ray it is its whole cell (the stricter side)
  if (isDoor(id)) return { soft: false, full: false, solid: false, floor: false, outline: [WHOLE] };
  if (POST.test(id)) return { soft: false, full: false, solid: true, floor: false, outline: [[0.375, 0, 0.375, 0.625, 1, 0.625]] };
  if (LOW_FLOOR.test(id)) return { soft: false, full: false, solid: true, floor: true, outline: [[0, 0, 0, 1, 0.9375, 1]] };
  if (/_slab$/.test(id) && props.type !== 'double') {
    const top = props.type === 'top';
    return { soft: false, full: false, solid: true, floor: top, outline: [top ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1]] };
  }
  // stairs: a floor at their high side (the bench a villager walked onto and wedged on)
  if (/_stairs$/.test(id)) return { soft: false, full: false, solid: true, floor: true, outline: [WHOLE] };
  if (FURNITURE.test(id)) return { soft: false, full: false, solid: true, floor: false, outline: [/_bed$/.test(id) ? [0, 0, 0, 1, 0.5625, 1] : WHOLE] };
  return { soft: false, full: true, solid: true, floor: true, outline: [WHOLE] };
}

/** What cannot be put down as a block (the kit's tools and food): a click with one in hand places nothing. */
const NOT_A_BLOCK = /_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots|ingot|bucket)$|^(bread|apple|cooked_.*|stick|flint|emerald|book|paper|bucket|lead|shield|bow|arrow|string|coal|diamond)$/;
/** An item as the block it places, in the state the game gives it (`facing`: the way the bot looks). */
function placedState(item: string, facing: Side): string {
  if (isGate(item)) return stateOf(item, { facing, in_wall: 'false', open: 'false', powered: 'false' });
  if (/rail$/.test(item)) return stateOf(item, { shape: 'north_south', waterlogged: 'false', ...(item === 'rail' ? {} : { powered: 'false' }) });
  if (item === 'lectern') return stateOf(item, { facing, has_book: 'false', powered: 'false' });
  if (item === 'composter') return 'composter[level=0]';
  if (item === 'grass_block') return 'grass_block[snowy=false]';
  return item;
}
/** What a dug block drops (itself, but the few that do not). */
const dropOf = (id: string) => (id === 'grass_block' ? 'dirt' : id === 'stone' ? 'cobblestone' : id === 'wall_torch' ? 'torch' : /glass|_leaves$|nether_portal|fire$/.test(id) ? '' : id);
/** How long the bot's hand or tool takes to break it, ticks (the kit's tools: an axe for wood, a pickaxe for stone). */
const digTicks = (id: string) => (/torch|rail$|_sapling|grass$/.test(id) ? 1 : /^(dirt|grass_block|sand|gravel)$/.test(id) ? 8 : /stone|ore|obsidian/.test(id) ? 20 : 12);
/** A state as the world keeps it: a gate or a door always says whether it is open (the brain reads `open=true`). */
function whole(state: string): string {
  const id = idOf(state);
  if (isGate(id)) return stateOf(id, { facing: 'south', in_wall: 'false', open: 'false', powered: 'false', ...propsOf(state) });
  if (isDoor(id)) return stateOf(id, { facing: 'south', half: 'lower', hinge: 'left', open: 'false', powered: 'false', ...propsOf(state) });
  return state.replace(/^minecraft:/, '');
}

// ------------------------------------------------------------------------------------------------ GateHolds.java, ported

const MAX_HOLD_MS = 30_000, MAX_OFF_MS = 120_000, LEFT_OPEN_TICKS = 100, CLICK_GAP = 10;
const ticksOf = (ms: number) => Math.floor((ms + TICK_MS - 1) / TICK_MS);

/** A gate as the closer read it this tick (GateHolds.Sight): `eye` and `feet` the bot's distances to its middle. */
interface Sight { key: string; loaded: boolean; open: boolean; powered: boolean; eye: number; feet: number; inside: boolean }
/** A guarded gate and its box of cells, both corners in it (GateHolds.Guard). */
export interface Guard { gate: Pos; box: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number } }
interface Held { loaded: boolean; open: boolean; powered: boolean; inside: boolean; eye: number; feet: number; openTicks: number; until: number; owed: boolean; clickedAt: number }
type Why = 'hold' | 'pair' | 'guard';

/**
 * GateHolds.java, rule for rule (gates by "x,y,z" where the Java has BlockPos.asLong): which gate the bridge clicks
 * shut by itself and when. The holds (a time the brain must keep renewing; its end, a release or the bot gone from
 * the open gate make it the bridge's to shut, tried every tick), the strict set, the pairs (never both open: the one
 * farther from the bot shut on the tick the second opens), the guards (never open onto a villager in its box unless
 * held) and gates.auto's timer. It decides only: the world is read and clicked by the pasture, as Gates.java does.
 */
export class GateHolds {
  private readonly gates = new Map<string, Held>();
  private readonly strictSet = new Set<string>();
  private pairList: [string, string][] = [];
  private guardList: Guard[] = [];
  private readonly made = new Map<string, number>();
  private offUntil = -1;

  off(forMs: number, now: number): number {
    const ms = forMs <= 0 || forMs > MAX_OFF_MS ? MAX_OFF_MS : forMs;
    this.offUntil = now + ticksOf(ms);
    return ms;
  }
  on(): void { this.offUntil = -1; }
  enabled(now: number): boolean { return this.offUntil < 0 || now >= this.offUntil; }
  offLeftMs(now: number): number { return this.enabled(now) ? 0 : (this.offUntil - now) * TICK_MS; }

  strict(gates: Pos[], pairs: [Pos, Pos][], guards: Guard[]): void {
    this.strictSet.clear();
    for (const g of gates) { this.strictSet.add(key(g)); this.gate(key(g)); }
    this.pairList = pairs.map(([a, b]) => [key(a), key(b)]);
    for (const p of this.pairList) { this.gate(p[0]); this.gate(p[1]); }
    this.guardList = guards.map(g => ({ gate: { ...g.gate }, box: { ...g.box } }));
    for (const g of this.guardList) this.gate(key(g.gate));
    this.prune();
  }
  isStrict(k: string): boolean { return this.strictSet.has(k); }
  strictGates(): string[] { return [...this.strictSet]; }
  pairs(): number { return this.pairList.length; }
  guards(): Guard[] { return [...this.guardList]; }
  tracked(): string[] { return [...this.gates.keys()]; }

  private gate(k: string): Held {
    let g = this.gates.get(k);
    if (!g) this.gates.set(k, g = { loaded: false, open: false, powered: false, inside: false, eye: Infinity, feet: Infinity, openTicks: 0, until: -1, owed: false, clickedAt: -1 });
    return g;
  }
  private named(k: string): boolean {
    return this.strictSet.has(k) || this.pairList.some(p => p[0] === k || p[1] === k) || this.guardList.some(g => key(g.gate) === k);
  }
  private prune(): void {
    for (const [k, g] of [...this.gates]) if (!this.named(k) && g.until < 0 && !g.owed) this.gates.delete(k);
  }

  look(s: Sight): void {
    const g = this.gate(s.key);
    g.loaded = s.loaded;
    g.eye = s.eye;
    g.feet = s.feet;
    g.inside = s.inside;
    if (!s.loaded) return; // out of sight: as last read
    g.open = s.open;
    g.powered = s.powered;
    if (!g.open) g.clickedAt = -1;
  }
  open(k: string): boolean { return this.gates.get(k)?.open ?? false; }
  loaded(k: string): boolean { return this.gates.get(k)?.loaded ?? false; }
  openTicks(k: string): number { return this.gates.get(k)?.openTicks ?? 0; }
  leftOpen(k: string, now: number): boolean {
    const g = this.gates.get(k);
    return !!g && g.open && !this.held(k, now) && (!g.loaded || g.eye > REACH || g.openTicks >= LEFT_OPEN_TICKS);
  }

  hold(k: string, ms: number, now: number): number {
    if (ms <= 0) return 0;
    const g = this.gate(k);
    if (g.open && g.eye > REACH) { g.until = -1; g.owed = true; return 0; }
    g.until = now + ticksOf(Math.min(ms, MAX_HOLD_MS));
    g.owed = false;
    return (g.until - now) * TICK_MS;
  }
  release(k: string, shut: boolean, now: number): boolean {
    const was = this.held(k, now);
    const g = shut ? this.gate(k) : this.gates.get(k);
    if (g) {
      g.until = -1;
      if (shut) g.owed = g.open;
    }
    this.prune();
    return was;
  }
  held(k: string, now: number): boolean { const g = this.gates.get(k); return !!g && g.until >= 0 && now < g.until; }
  heldMs(k: string, now: number): number { return this.held(k, now) ? (this.gates.get(k)!.until - now) * TICK_MS : 0; }

  private click(g: Held, now: number, busy: boolean): boolean {
    if (busy || !g.loaded || g.powered || g.inside || g.eye > REACH) return false;
    if (g.clickedAt >= 0 && now - g.clickedAt < CLICK_GAP) return false;
    g.clickedAt = now;
    return true;
  }
  private did(k: string, why: Why): { key: string; why: Why } {
    this.made.set(why, (this.made.get(why) ?? 0) + 1);
    return { key: k, why };
  }
  clicks(why: Why): number { return this.made.get(why) ?? 0; }
  clicked(k: string, now: number): void { const g = this.gates.get(k); if (g) g.clickedAt = now; }
  recent(k: string, now: number): boolean { const g = this.gates.get(k); return !!g && g.clickedAt >= 0 && now - g.clickedAt < CLICK_GAP; }
  shutNow(k: string, now: number, busy: boolean): boolean {
    const g = this.gates.get(k);
    if (!g || !g.owed || !g.open || !this.click(g, now, busy)) return false;
    this.did(k, 'hold');
    return true;
  }

  /** One tick, every tracked gate looked at first: the clicks to make now. `villagers`: the guarded gates with a villager in their box. */
  tick(now: number, busy: boolean, villagers: Set<string>): { key: string; why: Why }[] {
    const out: { key: string; why: Why }[] = [];
    for (const g of this.gates.values()) {
      if (g.loaded) g.openTicks = g.open ? g.openTicks + 1 : 0;
      if (g.until >= 0 && (now >= g.until || (g.open && g.eye > REACH))) { g.until = -1; g.owed = g.open; }
      if (g.owed && g.loaded && !g.open) g.owed = false;
    }
    for (const gd of this.guardList) {
      const k = key(gd.gate), g = this.gates.get(k)!;
      if (g.loaded && g.open && g.until < 0 && villagers.has(k) && this.click(g, now, busy)) out.push(this.did(k, 'guard'));
    }
    for (const p of this.pairList) {
      const a = this.gates.get(p[0])!, b = this.gates.get(p[1])!;
      if (!(a.loaded && a.open && a.clickedAt !== now) || !(b.loaded && b.open && b.clickedAt !== now)) continue;
      const second = b.feet > a.feet;
      if (this.click(second ? b : a, now, busy)) out.push(this.did(second ? p[1] : p[0], 'pair'));
    }
    for (const [k, g] of this.gates) if (g.owed && g.open && this.click(g, now, busy)) out.push(this.did(k, 'hold'));
    this.prune();
    return out;
  }
}

// ------------------------------------------------------------------------------------------------ who lives there

/**
 * A villager of the core. `mind`: 'leak' leaves by any open way and follows the bot (awake, within 6 of an open gate
 * with a way through it: probability 1); 'still' stands where it is put; 'home' walks back to its `home` cell at the
 * game's pace whenever a way there is open (a resident shut in the lock, once the hall's gate is opened for it: an
 * employed villager goes back to its block in work hours). Its `id` is the client's for it and dies with an unload;
 * its `uuid` is the server's, and what the brain keeps.
 */
export interface Villager {
  id: number; uuid: string; position: Pos; profession: string; level: number; baby: boolean; health: number; sleeping: boolean;
  mind: 'leak' | 'still' | 'home';
  home?: Pos;
  /** it waits rather than step into the cell the bot stands in (default: it does not wait, as in the game) */
  yields?: boolean;
  /** gone through the portal: no longer in this world */
  dim?: 'nether';
  /** the cells it is walking, the cell it came from, the gates it has gone through (it does not turn back through one) */
  way: Pos[]; last?: Pos; passed: string[];
}
/** Anything else alive: a cow of the bot's, a zombie, a player (name 'player'). */
export interface Animal { id: number; uuid: string; name: string; category: string; position: Pos; health: number; baby: boolean }
/** An item lying: a dug block's drop (`since`: the tick it fell; it is picked up half a second on). */
export interface Drop { id: number; uuid: string; item: string; count: number; position: Pos; since: number }
/** One bridge call or tool run, as it was asked: when, from where, and brain.json as it was SAVED at that moment. */
export interface Entry {
  i: number; t: number; tod: number; kind: 'call' | 'act'; name: string; params: Record<string, unknown>;
  /** the bot's cell */
  at: Pos;
  /** brain.json as last saved before this call (JSON): what a kill here leaves a restart to read */
  saved: string;
  /** made inside own.put or own.take */
  via?: 'own.put' | 'own.take';
  reply?: unknown;
}
/** The brain process is dead (killAt, restartAt): thrown by every call, tool and wait of its context from then on. */
export class Killed extends Error {}

type Reply = Record<string, unknown>;
type Handler<R> = (params: Record<string, unknown>, p: Pasture) => R | undefined | Promise<R | undefined>;
interface Walker { drop: number; gates: boolean; nodes: number }
/** The bot on a careful walk (Baritone: a jump up, a fall of three, its own gates opened) and a villager (open gates only). */
const BOT: Walker = { drop: 3, gates: true, nodes: 8000 }, VILLAGER: Walker = { drop: 3, gates: false, nodes: 768 };
const FACE: Record<string, [number, number, number]> = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
/** Direction.values(): the order dig.here tries a block's faces in. */
const FACES = ['down', 'up', 'north', 'south', 'west', 'east'] as const;
/** aimPlace's order of reference blocks. */
const PLACE_ORDER = ['down', 'north', 'south', 'east', 'west', 'up'] as const;
/** Interact.java ACTIVATABLE: a click on one of these uses it, so nothing is placed against it. */
export const ACTIVATABLE = new RegExp('^(crafting_table|crafter|(blast_)?furnace|smoker|(trapped_)?chest|ender_chest|barrel|.*shulker_box|hopper|dispenser|dropper|brewing_stand|'
  + 'enchanting_table|(chipped_|damaged_)?anvil|grindstone|stonecutter|loom|cartography_table|smithing_table|fletching_table|lectern|beacon|'
  + 'bell|note_block|jukebox|lever|respawn_anchor|.*_(door|trapdoor|fence_gate|bed|button|sign|hanging_sign))$');
const up = (c: Pos, n = 1): Pos => ({ x: c.x, y: c.y + n, z: c.z });
const parse = (k: string): Pos => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };
const inBox = (b: Guard['box'], c: Pos) => c.x >= Math.min(b.x1, b.x2) && c.x <= Math.max(b.x1, b.x2) && c.y >= Math.min(b.y1, b.y2) && c.y <= Math.max(b.y1, b.y2)
  && c.z >= Math.min(b.z1, b.z2) && c.z <= Math.max(b.z1, b.z2);
/** A call that failed is an answer of its own to the runtime's code (a lost reply), but a dead brain's is the end of it. */
const rethrow = (e: unknown): undefined => { if (e instanceof Killed) throw e; return undefined; };
const uuidOf = (id: number) => `00000000-0000-4000-8000-${id.toString(16).padStart(12, '0')}`;
/** Where along a ray (0..1 from `a` by `d`) it meets a box, or not at all; 0 when it starts inside (VoxelShape.clip). */
function meets(a: Pos, d: Pos, b: Box): number | undefined {
  let t0 = 0, t1 = 1;
  for (const [o, by, lo, hi] of [[a.x, d.x, b[0], b[3]], [a.y, d.y, b[1], b[4]], [a.z, d.z, b[2], b[5]]]) {
    if (Math.abs(by) < 1e-12) { if (o < lo || o > hi) return undefined; continue; }
    const u = (lo - o) / by, v = (hi - o) / by;
    t0 = Math.max(t0, Math.min(u, v));
    t1 = Math.min(t1, Math.max(u, v));
    if (t0 > t1) return undefined;
  }
  return t0;
}

export interface PastureOpts {
  /** the ground under everything set since: a block by cell, null where the world is not read (default: the yard's lawn at y 62, dirt under it) */
  base?: (p: Pos) => string | null;
  /** the time of day the world starts at (default 1000) */
  tod?: number;
  /** the bot's pockets (default: the kit of KIT) and where it stands (default: home) */
  items?: InventoryItem[];
  at?: Pos;
  /** the brain's memory of this world (default: nothing but the yard) */
  world?: WorldMemory;
}

/** What the bot carries by default: its tools, food, and the makings the home side's work asks for. */
export const KIT = (): InventoryItem[] => [
  { slot: 0, name: 'diamond_pickaxe', count: 1 }, { slot: 1, name: 'diamond_axe', count: 1 }, { slot: 2, name: 'diamond_shovel', count: 1 }, { slot: 3, name: 'bread', count: 32 },
  { slot: 4, name: 'fletching_table', count: 4 }, { slot: 5, name: 'oak_planks', count: 64 }, { slot: 6, name: 'dirt', count: 16 }, { slot: 7, name: 'rail', count: 2 }
];

// ------------------------------------------------------------------------------------------------ the world

export class Pasture {
  /** game ticks since the world began: every call, walk, wait and poll moves it */
  tick = 0;
  private readonly tod0: number;
  private readonly base: (p: Pos) => string | null;
  /** the blocks set over the ground, and of them the gates and doors (lower halves) that stand: the closer's and the leak-seekers' */
  private readonly over = new Map<string, string>();
  private readonly doors = new Map<string, Pos>();
  /** every block changed, in order (`how`: 'placed', 'dug', 'shut (pair)', 'the bot\'s walk'...) */
  readonly changed: { t: number; at: Pos; from: string; to: string; how: string }[] = [];
  /** the bot: its cell (feet), what it holds, and what keeps the bridge from clicking (a screen, an item in use, a block being broken, sneak) */
  bot = { at: { ...HOME }, health: 20, food: 20, held: '', facing: 'south' as Side, screen: null as string | null, using: false, sneaking: false, destroying: false };
  items: InventoryItem[];
  villagers: Villager[] = [];
  animals: Animal[] = [];
  drops: Drop[] = [];
  /** other players' builds (foreign.zones, surface ones): dig.here takes nothing in one but what the client mod's list holds */
  zones: Guard['box'][] = [];
  raining = false;
  thundering = false;
  world: WorldMemory;
  /** brain.json as ctx.save last wrote it, and how often it has */
  saved: string;
  saves = 0;
  /** placed-blocks.json: the bot's own cells ("x,y,z") with the state each went down in ('' not yet known) */
  readonly protection = new Map<string, string>();
  /** the client mod's list of them (protect.set): what its dig.here takes for the bot's own inside a zone */
  told = new Set<string>();
  private protVersion = 0;
  private toldVersion = -1;
  /** the bridge's holds, strict set and auto timer, and its closer's own gates: statics of the game client */
  holds = new GateHolds();
  private opened = new Map<string, number>();
  private seen = new Map<string, boolean>();
  readonly log: Entry[] = [];
  readonly said: string[] = [];
  /** every goto: careful or not, and whether it arrived; and the plain ones that went where no way on foot is (Baritone dug or pillared) */
  readonly walks: { t: number; from: Pos; to: Pos; at: Pos; careful: boolean; arrived: boolean }[] = [];
  readonly broke: { t: number; from: Pos; to: Pos }[] = [];
  /** every villager that walked through a gate's cell: which, when, and the cell it stepped out onto */
  readonly leaks: { t: number; uuid: string; gate: Pos; to: Pos }[] = [];
  readonly dumps: { name: string; data: unknown }[] = [];
  gained = 0;
  /** a scenario's own answers: a call or a tool handled here first (undefined: the pasture's own answer) */
  readonly on: { call: Record<string, Handler<unknown>>; act: Record<string, Handler<{ ok: boolean; text: string }>> } = { call: {}, act: {} };
  /** the gates Baritone's builder opens on its own walk as a build-structure begins (a test's) */
  builderOpens: Pos[] = [];
  /** brain processes so far: a context of an older one is dead */
  private gen = 0;
  private cut?: { at: number; client: boolean; restart: boolean; after?: number };
  /** the game client is down (killed with the brain): no bridge, and the bot is not in the world */
  private away = false;
  private blindUntil = -1;
  private readonly events: { t: number; run: () => void }[] = [];
  private abort = new AbortController();
  private via?: Entry['via'];
  private nextId = 9000;

  constructor(opts: PastureOpts = {}) {
    this.tod0 = opts.tod ?? 1000;
    this.base = opts.base ?? (p => (p.y < YARD.y ? 'dirt' : p.y === YARD.y ? 'grass_block[snowy=false]' : 'air'));
    this.items = opts.items ?? KIT();
    if (opts.at) this.bot.at = cellOf(opts.at);
    this.world = opts.world ?? ({ landmarks: { chests: [], farmland: [] }, leash: 96, yard: { ...YARD }, chestItems: {}, lastDone: {}, zones: {} } as WorldMemory);
    this.saved = JSON.stringify(this.world);
  }

  // ---------------------------------------------------------------- time

  /** The time of day, 0..23999. */
  get tod(): number { return (this.tod0 + this.tick) % 24_000; }
  /** Real time, ms: it runs with the game's (20 ticks a second). */
  now(): number { return T0 + this.tick * TICK_MS; }
  /** The clock a run's waits go by (a LureClock): a wait is game time passing, and a dead brain's wait throws. */
  get clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    const gen = this.gen;
    return { now: () => this.now(), sleep: async (ms: number) => { this.alive(gen); this.advance(Math.ceil(ms / TICK_MS)); } };
  }
  /** Something a scenario lets happen at a tick (a player's click, a mob stepping in). */
  at(tick: number, run: () => void): void { this.events.push({ t: tick, run }); }
  /** Game ticks passing: what is due, the bridge's closer and rules (while the client lives), the villagers, the drops by the bot. */
  advance(ticks = 1): void {
    for (let n = 0; n < ticks; n++) {
      this.tick++;
      for (const e of this.events.filter(x => x.t <= this.tick)) { this.events.splice(this.events.indexOf(e), 1); e.run(); }
      if (!this.away) this.bridgeTick();
      for (const v of this.villagers) this.villagerTick(v);
      if (!this.away) this.pickup();
    }
  }

  // ---------------------------------------------------------------- blocks

  /** The block of a cell, as the bridge names it. */
  get(p: Pos): string { return this.over.get(key(p)) ?? this.base(p) ?? 'air'; }
  /** Whether the client has the cell: within sight of the bot, the base read there, and not in the blind seconds after a rejoin. */
  loaded(p: Pos): boolean {
    return !this.away && this.tick >= this.blindUntil && flat(p, this.bot.at) <= SIGHT && (this.over.has(key(p)) || this.base(p) !== null);
  }
  /** After a rejoin the chunks come one by one: for so many ticks every read is null and no entity is listed. */
  blind(ticks: number): void { this.blindUntil = this.tick + ticks; }
  set(p: Pos, state: string, how = 'set'): void {
    const c = cellOf(p), k = key(c), from = this.get(c), to = whole(state);
    this.over.set(k, to);
    if (isGate(to) || (isDoor(to) && !/half=upper/.test(to) && idOf(to) !== 'iron_door')) this.doors.set(k, c); else this.doors.delete(k);
    if (how !== 'set') this.changed.push({ t: this.tick, at: c, from, to, how });
  }
  /** A spec put down with its minimum corner at `origin` (' ' left as it is, '.' air), as a finished build stands. */
  stamp(spec: StructureSpec, origin: Pos, how = 'set'): void {
    spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
      if (ch !== ' ') this.set(at(origin.x + x, origin.y + y, origin.z + z), ch === '.' ? 'air' : spec.palette[ch], how);
    })));
  }
  /** A gate or door swung (a click's whole effect: the client sets the block itself). */
  swing(p: Pos, open: boolean, how: string): void {
    const s = this.get(p);
    if ('open' in propsOf(s) && isOpen(s) !== open) this.set(p, stateOf(idOf(s), { ...propsOf(s), open: String(open) }), how);
  }
  /** A box of cells as world.region gives it: x fastest, then z, then y; null where the client has no chunk. */
  region(o: Pos, width: number, height: number, length: number): (string | null)[] {
    const out: (string | null)[] = [];
    for (let y = 0; y < height; y++) for (let z = 0; z < length; z++) for (let x = 0; x < width; x++) {
      const c = at(o.x + x, o.y + y, o.z + z);
      out.push(this.loaded(c) ? this.get(c) : null);
    }
    return out;
  }
  /** A block's outline where it stands: a fence's post with its arms toward what it joins. */
  private outlineAt(c: Pos): Box[] {
    const s = this.get(c), boxes = shapeOf(s).outline;
    if (!POST.test(idOf(s))) return boxes;
    const arms: Box[] = [];
    for (const [dx, dz, arm] of [[0, -1, [0.375, 0, 0, 0.625, 1, 0.375]], [0, 1, [0.375, 0, 0.625, 0.625, 1, 1]], [-1, 0, [0, 0, 0.375, 0.375, 1, 0.625]], [1, 0, [0.625, 0, 0.375, 1, 1, 0.625]]] as [number, number, Box][]) {
      const n = this.get(at(c.x + dx, c.y, c.z + dz));
      if (POST.test(idOf(n)) || isGate(n) || shapeOf(n).full) arms.push(arm);
    }
    return [...boxes, ...arms];
  }
  /** The first block whose outline a ray from `a` to `b` meets (the game's clip, ClipContext.Block.OUTLINE), or none. */
  clip(a: Pos, b: Pos): Pos | undefined {
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    let best: { t: number; c: Pos } | undefined;
    for (let x = Math.floor(Math.min(a.x, b.x)); x <= Math.floor(Math.max(a.x, b.x)); x++) for (let y = Math.floor(Math.min(a.y, b.y)); y <= Math.floor(Math.max(a.y, b.y)); y++) {
      for (let z = Math.floor(Math.min(a.z, b.z)); z <= Math.floor(Math.max(a.z, b.z)); z++) {
        for (const o of this.outlineAt(at(x, y, z))) {
          const t = meets(a, d, [x + o[0], y + o[1], z + o[2], x + o[3], y + o[4], z + o[5]]);
          if (t !== undefined && (!best || t < best.t)) best = { t, c: at(x, y, z) };
        }
      }
    }
    return best?.c;
  }

  // ---------------------------------------------------------------- the bot

  eye(cell: Pos = this.bot.at): Pos { return { x: cell.x + 0.5, y: cell.y + EYE, z: cell.z + 0.5 }; }
  count(name: string): number { return this.items.filter(i => i.slot < 36 && i.name === name).reduce((n, i) => n + i.count, 0); }
  give(name: string, n = 1): void {
    const has = this.items.find(i => i.slot < 36 && i.name === name && i.count + n <= 64);
    if (has) { has.count += n; return; }
    let slot = 0;
    while (this.items.some(i => i.slot === slot)) slot++;
    this.items.push({ slot, name, count: n });
  }
  take(name: string, n = 1): boolean {
    if (this.count(name) < n) return false;
    let left = n;
    for (const i of this.items.filter(x => x.slot < 36 && x.name === name)) { const k = Math.min(left, i.count); i.count -= k; left -= k; }
    this.items = this.items.filter(i => i.count > 0);
    if (!this.count(name) && this.bot.held === name) this.bot.held = '';
    return true;
  }
  /** A look as the brain takes it at a run's start. */
  look(over: Partial<Snapshot> = {}): Snapshot {
    const items = this.items.map(i => ({ ...i })), counts = new Map<string, number>();
    for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
    return {
      now: this.now(), timeOfDay: this.tod, activity: activityAt(this.tod, this.thundering), health: this.bot.health, food: this.bot.food, position: { ...this.bot.at }, dimension: 'overworld',
      sleeping: false, raining: this.raining, thundering: this.thundering, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length,
      home: { ...HOME, dimension: 'overworld' }, distHome: flat(this.bot.at, HOME), held: this.bot.held, ...over
    };
  }
  /** A drop the bot stands by comes in (the player's box grown by 1 across and half a block up and down), half a second after it fell. */
  private pickup(): void {
    const me = feet(this.bot.at);
    for (const d of [...this.drops]) {
      if (this.tick - d.since < 10 || Math.abs(d.position.x - me.x) > 1.425 || Math.abs(d.position.z - me.z) > 1.425 || d.position.y < me.y - 0.75 || d.position.y > me.y + 2.3) continue;
      this.drops.splice(this.drops.indexOf(d), 1);
      this.give(d.item, d.count);
    }
  }

  // ---------------------------------------------------------------- who lives there

  villager(o: Partial<Villager> & { at: Pos }): Villager {
    const { at: where, ...over } = o, id = o.id ?? this.nextId++;
    const v: Villager = { id, uuid: uuidOf(id), position: feet(cellOf(where)), profession: 'none', level: 1, baby: false, health: 20, sleeping: false, mind: 'leak', way: [], passed: [], ...over };
    this.villagers.push(v);
    return v;
  }
  animal(name: string, where: Pos, over: Partial<Animal> = {}): Animal {
    const id = over.id ?? this.nextId++;
    const a: Animal = { id, uuid: uuidOf(id), name, category: /zombie|skeleton|creeper|pillager/.test(name) ? 'monster' : name === 'player' ? 'misc' : 'creature', position: feet(cellOf(where)), health: 10, baby: false, ...over };
    this.animals.push(a);
    return a;
  }
  /** Everything alive, with the cell it stands in (a block is not placed into one). */
  private bodies(): { position: Pos }[] { return [...this.villagers.filter(v => !v.dim), ...this.animals]; }
  /** The server ticks what is within its simulation distance of a player: the bot while its client is up, or anyone else. */
  private ticking(p: Pos): boolean {
    return (!this.away && flat(p, this.bot.at) <= SIMULATION) || this.animals.some(a => a.name === 'player' && flat(p, a.position) <= SIMULATION);
  }

  // ---------------------------------------------------------------- ways on foot

  /** A cell a walker's body goes through: nothing solid in it (the bot opens a shut gate), nothing that burns or pricks, and for the bot no portal. */
  private passes(c: Pos, w: Walker): boolean {
    const s = this.get(c), id = idOf(s);
    if (HAZARD.test(id) || (w.gates && id === 'nether_portal')) return false;
    return !shapeOf(s).solid || (w.gates && isGate(s));
  }
  private stands(c: Pos, w: Walker): boolean { return shapeOf(this.get(up(c, -1))).floor && this.passes(c, w) && this.passes(up(c), w); }
  /** The cells one step from `c`: up a block with room over its own head, level, or down the open column to the first floor. */
  private steps(c: Pos, w: Walker): Pos[] {
    const out: Pos[] = [];
    for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const x = c.x + dx, z = c.z + dz;
      if (this.stands(at(x, c.y + 1, z), w) && this.passes(up(c, 2), w)) { out.push(at(x, c.y + 1, z)); continue; }
      if (!this.passes(at(x, c.y, z), w) || !this.passes(at(x, c.y + 1, z), w)) continue;
      for (let y = c.y; y >= c.y - w.drop; y--) {
        if (shapeOf(this.get(at(x, y - 1, z))).floor) { out.push(at(x, y, z)); break; }
        if (!this.passes(at(x, y - 1, z), w)) break;
      }
    }
    return out;
  }
  /**
   * The shortest way on foot from `from` to a cell `goal` takes (the cells after `from`; none: it stands there), and
   * whether there is one. With none and `toward` given: the way to the cell it can reach that is nearest that place.
   */
  private search(from: Pos, goal: (c: Pos) => boolean, w: Walker, toward?: Pos): { cells: Pos[]; arrived: boolean } {
    const prev = new Map<string, Pos | null>([[key(from), null]]);
    const back = (c: Pos): Pos[] => { const out: Pos[] = []; for (let q: Pos | null = c; q && !same(q, from); q = prev.get(key(q)) ?? null) out.unshift(q); return out; };
    if (goal(from)) return { cells: [], arrived: true };
    let near = from;
    for (const queue = [from]; queue.length && prev.size <= w.nodes;) {
      const c = queue.shift()!;
      for (const n of this.steps(c, w)) {
        if (prev.has(key(n))) continue;
        prev.set(key(n), c);
        if (goal(n)) return { cells: back(n), arrived: true };
        if (toward && dist(n, toward) < dist(near, toward)) near = n;
        queue.push(n);
      }
    }
    return { cells: toward ? back(near) : [], arrived: false };
  }
  /** A villager's way (open gates only, the game's reach of nodes) from a cell to one `goal` takes, or none. */
  villagerWay(from: Pos, goal: (c: Pos) => boolean): Pos[] | undefined {
    const r = this.search(from, goal, VILLAGER);
    return r.arrived ? r.cells : undefined;
  }

  /** One step of the bot's walk: a shut gate before it is clicked open first (three tries: the guard or the pair may shut it again). */
  private stepBot(c: Pos): boolean {
    if (this.abort.signal.aborted) return false;
    for (let n = 0; isGate(this.get(c)) && !isOpen(this.get(c)); n++) {
      if (n === 3) return false;
      this.swing(c, true, 'the bot\'s walk');
      this.advance(2);
    }
    const d = { x: c.x - this.bot.at.x, z: c.z - this.bot.at.z };
    this.bot.facing = d.x > 0 ? 'east' : d.x < 0 ? 'west' : d.z < 0 ? 'north' : 'south';
    this.bot.at = { ...c };
    this.advance(WALK_TICKS);
    return true;
  }

  /**
   * goto {x, y, z, range?, careful?}: GoalNear (range 0: the cell itself). A careful walk goes only where a way on foot
   * is and stops, not arrived, at the nearest cell it can reach when there is none; a plain one arrives all the same
   * (Baritone breaks and places), and is counted in `broke`.
   */
  private goto(p: Reply): Reply {
    const to = cellOf(p as unknown as Pos), range = Number(p.range ?? 1), careful = !!p.careful, from = { ...this.bot.at };
    const goal = (c: Pos) => (range <= 0 ? same(c, to) : dist(c, to) <= range + 0.01);
    const r = this.search(from, goal, BOT, to);
    let arrived = r.arrived;
    for (const c of r.cells) if (!this.stepBot(c)) { arrived = false; break; }
    if (!arrived && !careful && !this.abort.signal.aborted) {
      this.broke.push({ t: this.tick, from: { ...this.bot.at }, to });
      this.advance(Math.ceil(dist(this.bot.at, to)) * WALK_TICKS * 2);
      this.bot.at = { ...to };
      arrived = true;
    } else if (!arrived) this.advance(NO_WAY_TICKS);
    this.walks.push({ t: this.tick, from, to, at: { ...this.bot.at }, careful, arrived });
    return { arrived, at: { ...this.bot.at }, distance: round(dist(this.bot.at, to)) };
  }

  // ---------------------------------------------------------------- the leak-seeking villager

  /**
   * An open gate within 6 with a way through it: to it, through it the way it was going, and up to two cells on. The
   * nearest by the way; never one it has gone through. Standing in a gate's cell as it shuts, it walks on out: the
   * worst case (a gate closing on a villager harms nothing, and which side it ends on is the game's).
   */
  private leakWay(v: Villager): Pos[] | undefined {
    const here = cellOf(v.position);
    let best: Pos[] | undefined;
    for (const [k, q] of this.doors) {
      const s = this.get(q), inIt = same(here, q);
      if (!isGate(s) || v.passed.includes(k) || dist(v.position, mid(q)) > LEAK_R || (!inIt && !isOpen(s))) continue;
      const to = inIt ? [] : this.villagerWay(here, c => same(c, q));
      if (!to) continue;
      const before = to.length > 1 ? to[to.length - 2] : inIt ? v.last ?? here : here;
      const d = { x: q.x - before.x, z: q.z - before.z };
      const on: Pos[] = [];
      for (let c = q, i = 0; i < 3 && Math.abs(d.x) + Math.abs(d.z) === 1; i++) {
        const n = this.steps(c, VILLAGER).find(e => e.x === c.x + d.x && e.z === c.z + d.z);
        if (!n) break;
        on.push(n);
        c = n;
      }
      if (on.length && (!best || to.length + on.length < best.length)) best = [...to, ...on];
    }
    return best;
  }
  /** The bot within 6 and a way to a cell beside it: one step along it (so it is behind the bot as the bot goes through a gate). */
  private followWay(v: Villager): Pos[] | undefined {
    const here = cellOf(v.position), me = this.bot.at;
    if (this.away || dist(v.position, feet(me)) > LEAK_R) return undefined;
    const beside = (c: Pos) => Math.abs(c.x - me.x) + Math.abs(c.z - me.z) === 1 && Math.abs(c.y - me.y) <= 1;
    return beside(here) ? undefined : this.villagerWay(here, beside)?.slice(0, 1);
  }
  private villagerTick(v: Villager): void {
    if (v.dim || v.sleeping || v.mind === 'still' || v.health <= 0 || (this.tick + v.id) % (v.mind === 'leak' ? LEAK_TICKS : HOMING_TICKS) || !this.ticking(v.position)) return;
    const here = cellOf(v.position);
    if (v.mind === 'home') v.way = (v.home && this.villagerWay(here, c => same(c, v.home))?.slice(0, 1)) || [];
    else if (!v.way.length) v.way = this.leakWay(v) ?? this.followWay(v) ?? [];
    const next = v.way[0];
    // (the bot in its way does not stop it: entities push, they do not block. A villager walks through a player who
    // stands in a one-wide gateway, and stands in the bot's very cell on the way: `yields` is the courtesy the game
    // does not have, a scenario's own to ask for)
    if (!next || (v.yields && !this.away && same(next, this.bot.at))) return;
    v.way.shift();
    // the way shut before it (a gate clicked shut): it looks again at its next step
    if (!this.steps(here, VILLAGER).some(c => same(c, next))) { v.way = []; return; }
    v.position = feet(next);
    v.last = here;
    if (isGate(this.get(here))) { v.passed.push(key(here)); this.leaks.push({ t: this.tick, uuid: v.uuid, gate: here, to: next }); }
    // into a portal's cells: gone from this world
    if ([next, up(next)].some(c => idOf(this.get(c)) === 'nether_portal')) { v.dim = 'nether'; v.way = []; }
  }

  // ---------------------------------------------------------------- the bridge: the gate closer (Gates.java) and GateHolds' clicks

  private busy(): boolean { return this.bot.screen !== null || this.bot.using || this.bot.destroying || this.bot.sneaking; }
  /** A gate as GateHolds wants it read: its state, and where the bot is to it (Gates.java sight). */
  private sight(q: Pos): Sight {
    const loaded = this.loaded(q), s = this.get(q), gate = loaded && this.doors.has(key(q)), me = this.bot.at, c = mid(q);
    return {
      key: key(q), loaded, open: gate && isOpen(s), powered: gate && /powered=true/.test(s), eye: dist(this.eye(), c), feet: dist(feet(me), c),
      inside: q.x === me.x && q.z === me.z && Math.abs(q.y - me.y) <= 1
    };
  }
  private lookAll(): void { for (const k of this.holds.tracked()) this.holds.look(this.sight(parse(k))); }
  /** The holds' ends, the pairs and the guards: their clicks, made at once, with the closer on or off (Gates.java rules). */
  private rules(now: number): void {
    if (!this.holds.tracked().length) return;
    this.lookAll();
    const villagers = new Set<string>();
    for (const g of this.holds.guards()) {
      if (this.holds.open(key(g.gate)) && this.villagers.some(v => !v.dim && v.health > 0 && inBox(g.box, cellOf(v.position)))) villagers.add(key(g.gate));
    }
    for (const c of this.holds.tick(now, this.busy(), villagers)) {
      // (read again: a click that took reads shut at once, and may be made again the very tick the gate opens again)
      this.swing(parse(c.key), false, `shut (${c.why})`);
      this.holds.look(this.sight(parse(c.key)));
    }
  }
  /** One client tick of Gates.java: the rules, then the closer: gates that just opened next to the bot are its own, shut once it is clear of them. */
  private bridgeTick(): void {
    const now = this.tick, me = this.bot.at, pos = feet(me);
    this.rules(now);
    if (!this.holds.enabled(now)) { this.opened.clear(); this.seen.clear(); return; }
    const seen = new Map<string, boolean>();
    for (const [k, q] of this.doors) {
      if (Math.abs(q.x - me.x) > 3 || Math.abs(q.z - me.z) > 3 || q.y < me.y - 1 || q.y > me.y + 2) continue;
      const s = this.get(q), o = isOpen(s);
      seen.set(k, o);
      if (o && this.seen.get(k) === false && !/powered=true/.test(s) && dist(mid(q), pos) <= ADOPT && !this.opened.has(k)) this.opened.set(k, now);
    }
    this.seen = seen;
    for (const [k, since] of [...this.opened]) {
      const q = parse(k), strict = this.holds.isStrict(k);
      if (strict && !this.loaded(q)) continue;
      const s = this.get(q);
      if (!this.doors.has(k) || !isOpen(s) || /powered=true/.test(s)) { this.opened.delete(k); continue; }
      if (this.holds.held(k, now)) continue;
      const c = mid(q), d = dist(c, pos);
      if (!strict && (d > FORGET || now - since > FORGET_TICKS)) { this.opened.delete(k); continue; }
      if ((q.x === me.x && q.z === me.z && Math.abs(q.y - me.y) <= 1) || d < CLEAR || dist(this.eye(), c) > REACH) continue;
      if (this.bot.screen !== null || this.bot.using || this.bot.destroying) continue;
      if (this.bot.sneaking) continue;
      if (this.holds.recent(k, now)) continue;
      this.swing(q, false, 'shut (closer)');
      if (strict) this.holds.clicked(k, now); else this.opened.delete(k);
    }
  }
  /** The gates the closer has taken for the bot's own (a test's look). */
  adopted(): Pos[] { return [...this.opened.keys()].map(parse); }

  private gate(call: string, p: Reply): Reply {
    const now = this.tick;
    if (call === 'gates.auto') {
      const enabled = p.enabled === undefined || !!p.enabled;
      if (enabled) this.holds.on(); else this.holds.off(Number(p.forMs ?? MAX_OFF_MS), now);
      return { enabled, ...(enabled ? {} : { autoOffLeftMs: this.holds.offLeftMs(now) }) };
    }
    if (call === 'gates.strict') {
      const cells = (v: unknown) => (Array.isArray(v) ? v : []);
      this.holds.strict(cells(p.gates).map(cellOf), cells(p.pairs).map(two => [cellOf(two[0]), cellOf(two[1])] as [Pos, Pos]), cells(p.guard).map(g => ({ gate: cellOf(g.gate), box: { ...g.box } })));
      this.lookAll();
      return { strict: this.holds.strictGates().length, pairs: this.holds.pairs(), guard: this.holds.guards().length };
    }
    if (call === 'gates.status') {
      this.lookAll();
      const strict = this.holds.strictGates().map(k => ({
        ...parse(k), open: this.holds.open(k), loaded: this.holds.loaded(k), heldMs: this.holds.heldMs(k, now), openTicks: this.holds.openTicks(k), leftOpen: this.holds.leftOpen(k, now)
      }));
      const clicks = { hold: this.holds.clicks('hold'), pair: this.holds.clicks('pair'), guard: this.holds.clicks('guard') };
      return { enabled: this.holds.enabled(now), strict, count: strict.length, clicks, ...(this.holds.enabled(now) ? {} : { autoOffLeftMs: this.holds.offLeftMs(now) }) };
    }
    const q = cellOf(p as unknown as Pos), k = key(q), seen = this.sight(q);
    if (call === 'gates.hold') {
      const why = !this.loaded(q) ? 'not loaded' : this.doors.has(k) ? undefined : `no gate or door at ${q.x}, ${q.y}, ${q.z}: ${idOf(this.get(q))}`;
      if (why) return { held: false, open: false, leftMs: 0, reason: why };
      const ms = Number(p.ms ?? 0);
      if (ms <= 0) return { held: false, open: seen.open, leftMs: 0, reason: `ms: how long to hold it (${MAX_HOLD_MS} at most)` };
      this.holds.look(seen);
      const left = this.holds.hold(k, ms, now);
      if (left <= 0) return { held: false, open: seen.open, leftMs: 0, reason: `open and ${round(seen.eye)} from the bot's eye, out of a click's reach (${REACH}): shut once the bot is by it` };
      return { held: true, open: seen.open, leftMs: left };
    }
    // gates.release {x, y, z, shut?}: the hold ended; with `shut` the click at once when it can be made, else on the first tick it can
    this.holds.look(seen);
    const last = this.holds.open(k), shut = !!p.shut, released = this.holds.release(k, shut, now);
    if (shut && this.holds.shutNow(k, now, this.busy())) { this.swing(q, false, 'shut (released)'); this.holds.look(this.sight(q)); }
    else if (!shut && seen.loaded && seen.open && this.holds.enabled(now) && !this.opened.has(k)) this.opened.set(k, now);
    return { released, open: seen.loaded ? this.sight(q).open : last, ...(seen.loaded ? {} : { loaded: false }) };
  }

  // ---------------------------------------------------------------- the bridge: place, dig.here, useOn (Interact.java)

  /**
   * Where a block is placed from: the reference block and its face, or why not (aimPlace). The first neighbour that
   * will do (not replaceable, not one a click uses) is judged alone: 4.5 from the eye to the point clicked, a side
   * face a quarter low. No sight is asked.
   */
  aim(target: Pos, face?: string, eyeCell: Pos = this.bot.at): { face: string; ref: Pos; hit: Pos; distance: number } | { reason: string; distance?: number } {
    if (!shapeOf(this.get(target)).soft) return { reason: `occupied by ${idOf(this.get(target))}` };
    if (same(eyeCell, target) || same(up(eyeCell), target)) return { reason: 'the bot is standing there' };
    const order: string[] = [...PLACE_ORDER];
    if (face && order.includes(face)) { order.splice(order.indexOf(face), 1); order.unshift(face); }
    for (const f of order) {
      const [dx, dy, dz] = FACE[f], ref = at(target.x + dx, target.y + dy, target.z + dz), rs = this.get(ref);
      if (shapeOf(rs).soft || ACTIVATABLE.test(idOf(rs))) continue;
      const hit = { x: ref.x + 0.5 - dx * 0.5, y: ref.y + 0.5 - dy * 0.5 + (dy === 0 ? -0.25 : 0), z: ref.z + 0.5 - dz * 0.5 };
      const d = dist(this.eye(eyeCell), hit);
      return d > CLICK_REACH ? { reason: 'too far', distance: round(d) } : { face: f, ref, hit, distance: d };
    }
    return { reason: 'nothing solid next to it to place against' };
  }
  private place(p: Reply): Reply {
    const target = cellOf(p as unknown as Pos), aim = this.aim(target, p.face as string | undefined);
    if ('reason' in aim) return { placed: false, reason: aim.reason, distance: aim.distance ?? null };
    if (p.item) this.answer('item.select', { name: p.item });
    // the click goes out two ticks on (the rotation first), the answer three after
    this.advance(4);
    const item = this.bot.held;
    const state = item && !NOT_A_BLOCK.test(item) && this.count(item) > 0 ? placedState(item, this.bot.facing) : undefined;
    // the server's side: something to place, the cell still free, and nobody standing where a block would fill the cell
    if (state && shapeOf(this.get(target)).soft && !(shapeOf(state).solid && this.bodies().some(b => same(cellOf(b.position), target)))) {
      this.take(item, 1);
      this.set(target, state, 'placed');
    }
    const now = this.get(target);
    return { placed: !shapeOf(now).soft, block: idOf(now), face: aim.face };
  }

  /**
   * The face of a block dig.here sees from an eye, and how far it is; none: "out of reach or out of sight" (the port
   * of Interact.java's lines as bridge change B6 leaves them). A face is covered only by a full cube before it (a
   * rail, a torch or a flower there hides nothing); its middle, scaled 0.49, must be within 4.4 of the eye; and the
   * OUTLINE clip from the eye to it must meet this block first. A small block with no face seen: the middle of its
   * own outline, judged the same way.
   */
  digSight(target: Pos, eyeCell: Pos = this.bot.at): { face: string; dist: number } | undefined {
    const eye = this.eye(eyeCell), c = mid(target);
    let best: { face: string; dist: number } | undefined;
    for (const f of FACES) {
      const [dx, dy, dz] = FACE[f];
      if (shapeOf(this.get(at(target.x + dx, target.y + dy, target.z + dz))).full) continue; // covered: not seen
      const fc = { x: c.x + dx * 0.49, y: c.y + dy * 0.49, z: c.z + dz * 0.49 }, d = dist(fc, eye);
      if (d > REACH) continue;
      if (!same(this.clip(eye, fc), target)) continue;
      if (!best || d < best.dist) best = { face: f, dist: d };
    }
    const shape = shapeOf(this.get(target));
    if (!best && !shape.full && shape.outline.length) {
      const o = shape.outline[0], m = { x: target.x + (o[0] + o[3]) / 2, y: target.y + (o[1] + o[4]) / 2, z: target.z + (o[2] + o[5]) / 2 };
      if (dist(m, eye) <= REACH && same(this.clip(eye, m), target)) best = { face: 'up', dist: dist(m, eye) };
    }
    return best;
  }
  /** Foreign.guarded: in someone's build on the surface, and not on the client mod's list of the bot's own. */
  guarded(c: Pos): boolean { return !this.told.has(key(c)) && this.zones.some(z => inBox(z, c)); }
  private dig(p: Reply): Reply {
    const target = cellOf(p as unknown as Pos), id = idOf(this.get(target));
    if (!this.loaded(target) || /^(air|cave_air|void_air)$/.test(id)) return { dug: false, reason: 'air' };
    if (this.guarded(target) && !p.force) return { dug: false, reason: 'someone else\'s build (force: true to dig it anyway)', block: id };
    if (!this.digSight(target)) return { dug: false, reason: 'out of reach or out of sight', block: id };
    // the rotation and the tool go out first; while the block is being broken the closer and the holds' clicks wait
    this.advance(2);
    this.bot.destroying = true;
    this.advance(digTicks(id));
    this.bot.destroying = false;
    this.set(target, 'air', 'dug');
    const item = dropOf(id);
    let y = target.y;
    while (y > target.y - 8 && !shapeOf(this.get(at(target.x, y - 1, target.z))).solid) y--;
    if (item) this.drops.push({ id: this.nextId, uuid: uuidOf(this.nextId++), item, count: 1, position: { x: target.x + 0.5, y, z: target.z + 0.5 }, since: this.tick });
    return { dug: true, block: id, tool: this.bot.held || null };
  }

  /** useOn {x, y, z, face?}: 4.5 from the eye to the face's middle and no sight asked; a gate, door or trapdoor is toggled. */
  private useOn(p: Reply): Reply {
    const q = cellOf(p as unknown as Pos), f = FACE[String(p.face ?? 'up')] ?? FACE.up;
    const d = dist(this.eye(), { x: q.x + 0.5 + f[0] * 0.5, y: q.y + 0.5 + f[1] * 0.5, z: q.z + 0.5 + f[2] * 0.5 });
    if (d > CLICK_REACH) return { used: false, reason: 'too far', distance: round(d), held: this.bot.held || 'air' };
    // the block read at the call (`before`), the click two ticks on (the rotation first), the answer three ticks after
    // it. The click toggles the gate AS IT STANDS WHEN IT LANDS, not as it was read: one read open that the closer, the
    // pair, the guard or a hold's end shut in between is opened again by it, and the answer, which reads the block as
    // it is then against `before`, says nothing changed. (And a gate the guard or the pair shut again after the click
    // reads unchanged too.) This is the blind toggle a shut that reads back is for
    const before = this.get(q);
    this.advance(2);
    const then = this.get(q);
    if (this.doors.has(key(q)) || /_trapdoor$/.test(idOf(then))) this.swing(q, !isOpen(then), 'useOn');
    this.advance(3);
    const now = this.get(q);
    return {
      used: true, before: idOf(before), after: idOf(now), changed: now !== before, properties: propsOf(now), held: this.bot.held || 'nothing',
      result: now !== before ? 'Success' : 'Pass', sneaking: this.bot.sneaking, answered: true
    };
  }

  // ---------------------------------------------------------------- the bridge: what it is asked

  private status(): Status {
    return {
      inWorld: true, username: 'claudebot', screen: this.bot.screen, position: feet(this.bot.at), block: { ...this.bot.at }, health: this.bot.health, food: this.bot.food,
      dimension: 'overworld', gameMode: 'survival', timeOfDay: this.tod, sleeping: false, onGround: true, destroying: this.bot.destroying, raining: this.raining,
      thundering: this.thundering, process: null, goal: null, protectedCount: this.told.size, protectSynced: this.toldVersion >= 0
    };
  }
  /** world.entities {maxDistance?, type?}: every entity with its uuid, the nearest first; a sleeper says so (bridge change B1). */
  private entities(p: Reply): Reply {
    const me = feet(this.bot.at), max = Number(p.maxDistance ?? 32);
    if (this.tick < this.blindUntil) return { entities: [] };
    const seen = (e: { id: number; uuid: string; position: Pos }, name: string, category: string, height: number, more: Reply) =>
      ({ id: e.id, uuid: e.uuid, name, category, position: { ...e.position }, distance: round(dist(e.position, me)), height, ...more });
    const all = [
      ...this.villagers.filter(v => !v.dim).map(v => seen(v, 'villager', 'misc', v.baby ? 0.98 : 1.95, {
        health: v.health, ...(v.sleeping ? { sleeping: true } : {}), baby: v.baby, aggressive: false, merchant: true, profession: v.profession, level: v.level, type: 'plains'
      })),
      ...this.animals.map(a => seen(a, a.name, a.category, 1.4, { health: a.health, baby: a.baby, aggressive: false })),
      ...this.drops.map(d => seen(d, 'item', 'misc', 0.25, { item: d.item, count: d.count }))
    ];
    return { entities: all.filter(e => e.distance <= max && (p.type === undefined || e.name === p.type)).sort((a, b) => a.distance - b.distance) };
  }
  /** The pasture's own answer to a bridge call (a scenario's handler wraps it: the block goes down, the reply is lost). */
  answer(method: string, p: Reply): unknown {
    const q = cellOf({ x: Number(p.x), y: Number(p.y), z: Number(p.z) });
    switch (method) {
      case 'status': return this.status();
      case 'inventory': return { items: this.items.map(i => ({ ...i })), held: this.bot.held ? { name: this.bot.held, count: this.count(this.bot.held) } : null };
      case 'item.select': {
        // the very item, else one whose name holds the name asked (Interact.java select: "log" takes an oak_log)
        const name = String(p.name).replace(/^minecraft:/, '');
        const has = this.items.find(i => i.slot < 36 && i.name === name) ?? this.items.find(i => i.slot < 36 && i.name.includes(name));
        if (!has) throw new Error(`no ${p.name} in inventory`);
        this.bot.held = has.name;
        return { held: has.slot };
      }
      case 'world.block': return this.loaded(q) ? { loaded: true, name: idOf(this.get(q)), properties: propsOf(this.get(q)) } : { loaded: false };
      case 'world.region': return { blocks: this.region(q, Number(p.width ?? 1), Number(p.height ?? 1), Number(p.length ?? 1)) };
      case 'world.entities': return this.entities(p);
      case 'goto': return this.goto(p);
      case 'place': return this.place(p);
      case 'dig.here': return this.dig(p);
      case 'useOn': return this.useOn(p);
      case 'protect.set': this.told = new Set(((p.positions ?? []) as number[][]).map(a => a.join(','))); this.toldVersion = this.protVersion; return { count: this.told.size };
      case 'gates.auto': case 'gates.hold': case 'gates.release': case 'gates.strict': case 'gates.status': return this.gate(method, p);
      case 'foreign.zones': return { dimension: 'overworld', zones: this.zones.map(z => ({ ...z, surface: true })) };
      case 'container.close': this.bot.screen = null; return { ok: true };
      case 'cancel': case 'sprint.set': case 'look': return {};
      default: throw new Error(`unexpected bridge call ${method}`);
    }
  }
  /** A call or a tool as it is asked: a dead brain's throws, the kill that is due falls here, and it goes on the log with brain.json as saved. */
  private enter(gen: number, kind: Entry['kind'], name: string, params: Reply): Entry {
    this.alive(gen);
    if (this.cut && this.log.length >= this.cut.at) {
      const cut = this.cut;
      this.die(cut.client);
      if (cut.restart) this.restart({ after: cut.after });
      throw new Killed(`the brain was killed before ${kind} ${this.log.length} (${name})`);
    }
    const e: Entry = { i: this.log.length, t: this.tick, tod: this.tod, kind, name, params: structuredClone(params), at: { ...this.bot.at }, saved: this.saved, ...(this.via ? { via: this.via } : {}) };
    this.log.push(e);
    return e;
  }
  private alive(gen: number): void { if (gen !== this.gen) throw new Killed('this brain process is dead'); }
  /** A bridge call: a tick at the least (the game thread answers on its next), then what the call itself takes. */
  private async call(gen: number, method: string, params: Reply = {}): Promise<unknown> {
    const e = this.enter(gen, 'call', method, params);
    this.advance(1);
    const own = await this.on.call[method]?.(params, this);
    e.reply = own !== undefined ? own : this.answer(method, params);
    return e.reply;
  }

  // ---------------------------------------------------------------- the runtime: own.put, own.take (tools.ts), the tools

  /** The client mod told what is the bot's own (tools.ts syncProtection: only on a change, or forced). */
  private async sync(gen: number, force = false): Promise<void> {
    if (!force && this.toldVersion === this.protVersion) return;
    await this.call(gen, 'protect.set', { positions: [...this.protection.keys()].map(k => k.split(',').map(Number)), dimension: 'overworld' });
  }
  /** A cell of the bot's own as a finished build leaves it: on the record with its state, and on the client mod's list. */
  mine(c: Pos, state = this.get(c)): void {
    this.record(key(c), state);
    this.told.add(key(c));
    this.toldVersion = this.protVersion;
  }
  private record(k: string, state: string | undefined): void {
    if (state === undefined) this.protection.delete(k); else this.protection.set(k, state);
    this.protVersion++;
  }
  private async stateAt(gen: number, p: Pos): Promise<string | undefined> {
    const b = await this.call(gen, 'world.block', { ...p }).catch(rethrow) as { loaded: boolean; name?: string; properties?: Record<string, string> } | undefined;
    return b?.loaded && b.name ? stateOf(b.name, b.properties ?? {}) : undefined;
  }
  /**
   * own.put and own.take as tools.ts has them (5.4), over this bridge and this protection store, their waits on the
   * pasture's clock: the record BEFORE the place and the client mod told at once; one careful walk into reach unless
   * `stay`; a refused place leaves no record; the take looks first (status: a relaunched client is told the bot's own
   * again) and reads the cell (air, or grass, snow, water: record off, nothing there; another block: never dug),
   * refuses what the record does not name unless `adopt`, digs with dig.here from where the bot stands, and waits for
   * the drop 4 x 400 ms before it walks onto the cell.
   */
  private own(gen: number): NonNullable<GoalContext['own']> {
    const call = <T>(m: string, p: Reply) => this.call(gen, m, p) as Promise<T>;
    const within = async <T>(via: NonNullable<Entry['via']>, run: () => Promise<T>): Promise<T> => { this.via = via; try { return await run(); } finally { this.via = undefined; } };
    const sleep = (ms: number) => { this.alive(gen); this.advance(Math.ceil(ms / TICK_MS)); };
    const near = (p: Pos) => call('goto', { ...p, range: 2, careful: true, timeoutMs: 30_000 });
    return {
      put: (where, item, o = {}) => within('own.put', async () => {
        const p = cellOf(where), k = key(p), want = idOf(item), had = this.protection.has(k);
        if (!had) this.record(k, '');
        await this.sync(gen, true);
        // (a place that threw has no answer: the block may be down all the same, and the cell is read)
        let lost = false;
        const ask = async () => {
          lost = false;
          try { await call('item.select', { name: want }); } catch (e) { rethrow(e); return { ok: false, placed: false, reason: (e as Error).message }; }
          try {
            const r = await call<{ placed: boolean; block?: string; reason?: string }>('place', { ...p, face: o.face ?? 'down' });
            return { ok: r.placed, placed: r.placed, ...(r.block ? { block: r.block } : {}), ...(r.reason ? { reason: r.reason } : {}) };
          } catch (e) { rethrow(e); lost = true; return { ok: false, placed: false, reason: (e as Error).message }; }
        };
        let r: { ok: boolean; placed: boolean; block?: string; reason?: string } = await ask();
        if (!r.placed && !o.stay && /^too far/.test(r.reason ?? '')) { await near(p); r = await ask(); }
        let read: string | undefined;
        if (!r.placed && lost) {
          read = await this.stateAt(gen, p);
          if (read !== undefined && idOf(read) === want) r = { ok: true, placed: true, block: want, reason: `the reply was lost (${r.reason ?? 'no answer'}); read down after` };
        }
        if (r.placed) {
          const state = read ?? await this.stateAt(gen, p) ?? r.block ?? want;
          this.record(k, state);
          if (idOf(state) !== want) r = { ok: false, placed: true, block: idOf(state), reason: `it came out ${idOf(state)}, not ${want}` };
        } else if (!had && !(lost && read === undefined)) {
          this.record(k, undefined);
          await this.sync(gen);
        }
        return r;
      }),
      take: (where, item, o = {}) => within('own.take', async () => {
        const p = cellOf(where), k = key(p), want = idOf(item);
        // its first call is a look (tools.ts dimension(): status), and that look tells a relaunched client what is the
        // bot's own again (a client that says it has no list, or another count): the bot's lure in a village's zone is
        // dig.here's to take after the unit was restarted, as it is live
        const st = await call<Status>('status', {});
        await this.sync(gen, (st.protectedCount !== undefined && st.protectedCount !== this.protection.size) || st.protectSynced === false);
        const state = await this.stateAt(gen, p);
        if (!state) return { ok: false, dug: false, reason: 'not loaded' };
        const name = idOf(state);
        if (/^(air|cave_air|void_air)$/.test(name)) { this.record(k, undefined); await this.sync(gen); return { ok: true, dug: false, reason: 'nothing there' }; }
        if (name !== want) {
          const kept = this.protection.get(k);
          if (kept && idOf(kept) === name) return { ok: false, dug: false, block: name, reason: `the bot's own ${name} stands there, not its ${want}` };
          this.record(k, undefined);
          await this.sync(gen);
          // (room, not a block: what this bridge's place goes into as into air)
          if (shapeOf(state).soft) return { ok: true, dug: false, block: name, reason: 'nothing there' };
          return { ok: false, dug: false, block: name, reason: `the bot did not put that ${name} there (its ${want} is gone)` };
        }
        if (!this.protection.has(k)) {
          if (!o.adopt) return { ok: false, dug: false, reason: `the bot did not put that ${name} there` };
          this.record(k, state);
          await this.sync(gen, true);
        }
        const count = async () => (await call<{ items: InventoryItem[] }>('inventory', {})).items.filter(i => i.name === want).reduce((n, i) => n + i.count, 0);
        const had = o.pickup === false ? 0 : await count();
        const dig = () => call<{ dug?: boolean; reason?: string }>('dig.here', { ...p, timeoutMs: 15_000 }).catch((e: Error) => { rethrow(e); return { dug: false, reason: e.message }; });
        let r = await dig();
        if (!r.dug && !o.stay && /out of reach|out of sight/.test(r.reason ?? '')) { await near(p); r = await dig(); }
        if (!r.dug && r.reason !== 'air') return { ok: false, dug: false, reason: r.reason ?? 'not dug' };
        this.record(k, undefined);
        await this.sync(gen);
        if (!r.dug) return { ok: true, dug: false, reason: 'nothing there' };
        if (o.pickup === false) return { ok: true, dug: true };
        let got = false;
        for (let n = 0; n < 4 && !got; n++) { sleep(400); got = await count() > had; }
        if (!got && !o.stay) {
          await call('goto', { ...p, range: 0, careful: true, timeoutMs: 8000 });
          got = await count() > had;
          if (!got) { sleep(600); got = await count() > had; }
        }
        return { ok: true, dug: true, pickedUp: got };
      })
    };
  }

  /** The tools a home-side run uses, over this bridge (their own calls are on the log): what tools.ts's do, in short. */
  private async tool(gen: number, name: string, a: Reply): Promise<{ ok: boolean; text: string }> {
    const call = <T>(m: string, p: Reply) => this.call(gen, m, p) as Promise<T>;
    const p = cellOf({ x: Number(a.x), y: Number(a.y), z: Number(a.z) });
    if (name === 'place-block') {
      // (its walk into reach is a plain one)
      if (a.item) { try { await call('item.select', { name: a.item }); } catch (e) { rethrow(e); return { ok: true, text: `No ${a.item} in inventory to place` }; } }
      let r = await call<{ placed: boolean; block?: string; face?: string; reason?: string }>('place', { ...p, face: a.faceDirection ?? 'down' });
      if (!r.placed && r.reason === 'too far') { await call('goto', { ...p, range: 3 }); r = await call('place', { ...p, face: a.faceDirection ?? 'down' }); }
      if (!r.placed) return { ok: true, text: r.reason?.startsWith('occupied by ') ? `There's already a block (${r.reason.slice(12)}) at ${fmt(p)}` : `Failed to place block at ${fmt(p)}: ${r.reason ?? 'the server did not accept it'}` };
      this.record(key(p), this.get(p));
      return { ok: true, text: `Placed ${r.block} at ${fmt(p)} using ${r.face} face` };
    }
    if (name === 'use-item-on-block') {
      if (a.item) await call('item.select', { name: a.item });
      type Used = { used: boolean; reason?: string; before?: string; after?: string; changed?: boolean; properties?: Record<string, string> };
      let r = await call<Used>('useOn', { ...p, face: a.face ?? 'up', ...(a.toggle ? { toggle: true } : {}) });
      if (!r.used && r.reason === 'too far') { await call('goto', { ...p, range: 3 }); r = await call<Used>('useOn', { ...p, face: a.face ?? 'up' }); }
      if (!r.used) return { ok: false, text: `Could not use ${a.item ?? 'the held item'} on ${fmt(p)}: ${r.reason}` };
      const after = stateOf(r.after ?? '', r.properties ?? {});
      return { ok: true, text: r.changed ? `Used ${a.item ?? 'the held item'} on ${r.before} at ${fmt(p)}: it is now ${after}` : `Used ${a.item ?? 'the held item'} on ${r.before} at ${fmt(p)}; nothing changed, it is ${after}` };
    }
    if (name === 'move-to-position') {
      const r = await call<{ arrived: boolean; at: Pos; distance: number }>('goto', { ...p, range: a.range ?? 1 });
      if (!r.arrived) throw new Error(`Could not reach ${fmt(p)}: no path found. Stopped at ${fmt(r.at)}, ${r.distance} blocks away.`);
      return { ok: true, text: `Successfully moved to position near ${fmt(p)}` };
    }
    if (name === 'build-structure') {
      // Baritone's builder: only what is not in place yet, out of the pockets; on its own walk it opens what gate is
      // in its way and leaves it to the closer; what it puts down is the bot's own
      const spec = a.spec as StructureSpec, width = Math.max(...spec.layers.flat().map(r => r.length)), length = Math.max(...spec.layers.map(l => l.length));
      const left = billLeft(spec, this.region(p, width, spec.layers.length, length), { width, length });
      const short = Object.entries(left).find(([n, k]) => this.count(n) < k);
      if (short) return { ok: false, text: `Failed: Not enough blocks to build it. Missing: ${short[0]} ${this.count(short[0])}/${short[1]}` };
      for (const g of this.builderOpens) this.swing(g, true, 'the builder\'s walk');
      const before = this.changed.length, began = this.tick;
      this.stamp(spec, p, 'built');
      for (const c of this.changed.slice(before)) {
        if (c.from === c.to) continue;
        if (idOf(c.to) !== 'air') this.record(key(c.at), c.to);
        this.advance(4);
      }
      for (const [n, k] of Object.entries(left)) this.take(n, k);
      const all = spec.layers.flat().join('').replace(/[ .]/g, '').length;
      return { ok: true, text: `Built ${a.name} at ${fmt(p)} in ${Math.round((this.tick - began) / 20)}s: all ${all} blocks in place.` };
    }
    return { ok: false, text: `unexpected ${name}` };
  }

  // ---------------------------------------------------------------- the brain: its context, a kill, a restart

  /**
   * A run's context over this world, of the brain process that lives now: `call` and `act` on the log, `status`,
   * `own`, `save` (brain.json: what a kill leaves), `dump`. After a kill every one of them throws `Killed`.
   */
  get ctx(): GoalContext {
    const gen = this.gen;
    return {
      s: this.look(), world: this.world, signal: this.abort.signal,
      call: <T>(m: string, p?: Reply) => this.call(gen, m, p) as Promise<T>,
      act: async (name: string, a: Reply = {}) => {
        const e = this.enter(gen, 'act', name, a);
        const own = await this.on.act[name]?.(a, this);
        e.reply = own !== undefined ? own : await this.tool(gen, name, a);
        return e.reply as { ok: boolean; text: string };
      },
      status: async () => await this.call(gen, 'status') as Status,
      progress: (text: string) => { this.said.push(text); },
      gain: (n: number) => { this.gained += n; },
      builds: () => [],
      own: this.own(gen),
      save: () => { this.alive(gen); this.saved = JSON.stringify(this.world); this.saves++; },
      dump: (name: string, data: unknown) => { this.dumps.push({ name, data }); }
    };
  }
  /**
   * The brain process killed before its bridge call or tool number `i` of the log (kill -9: no exit handler, nothing
   * saved after). `client`: the game client dies with it, as when the unit is restarted: the bridge's holds, strict
   * set and closer are gone (no dead-man shuts a held gate) and the bot is out of the world until `restart`.
   */
  killAt(i: number, client = false): void { this.cut = { at: i, client, restart: false }; }
  /** The same, and the brain back at once (`after` ticks on): `ctx` is then the new process's, over brain.json as saved. */
  restartAt(i: number, client = false, after?: number): void { this.cut = { at: i, client, restart: true, after }; }
  /** The brain killed now, between two calls. */
  kill(client = false): void { this.die(client); }
  private die(client: boolean): void {
    this.cut = undefined;
    this.gen++;
    // (nothing the dead process still does reaches the world; its signal only ends the loops it would spin in)
    this.abort.abort(new Killed('killed'));
    this.via = undefined;
    this.bot.destroying = false;
    if (client) {
      this.away = true;
      this.holds = new GateHolds();
      this.opened.clear();
      this.seen.clear();
      this.told = new Set();
      this.toldVersion = -1;
    }
  }
  /**
   * A new brain process: its memory is brain.json as last saved. First `after` ticks pass with no brain (default: none
   * with the client alive, its 90 s back with it dead); a client that died is back then, blind for its first seconds,
   * its bridge knowing no strict gate and no block of the bot's.
   */
  restart(o: { after?: number } = {}): GoalContext {
    if (!this.abort.signal.aborted) this.die(false);
    this.advance(o.after ?? (this.away ? CLIENT_BACK_TICKS : 0));
    if (this.away) { this.away = false; this.blind(100); }
    this.world = JSON.parse(this.saved) as WorldMemory;
    this.abort = new AbortController();
    return this.ctx;
  }
}

// ------------------------------------------------------------------------------------------------ the yard

export interface YardOpts extends PastureOpts {
  /** the lock in front of the hall's gate: standing (default), standing the other way round ('mirror'), or not built yet (false) */
  lock?: boolean | 'mirror';
  /** the fence ring round the portal, its gate on this side (default south, toward home), or none yet (false) */
  ring?: Side | false;
  /** the crossings the bot's own walks left over the fence (default: they stand, as on Nov 24) */
  crossings?: boolean;
}

/**
 * The live homestead as the fetch meets it (Nov 24), every build stamped from its own blueprint (one source of each
 * geometry) and its landmarks written as zones the way a build step writes them (`kind:landmark`): the fence with its
 * four gates and post torches; the hall (11 x 9 at (-561, 62, 2126), its gate H south, three beds, its fletching
 * table); the lock in front of H with P three cells out (the design's table, 4.8), its sill laid; the Nether portal
 * (lit, at (-560..-559, 64..66, 2147)) and the ring round it; the cow pen and the sheep pen with two animals each; the
 * workshop, its smithing table at (-541, 63, 2153); the pavilion's bench against its fence rail (where a villager
 * wedged), a lamp post, the floor torch beside P's lane and the cobblestone walk under the lock; and the two crossings
 * of the bot's own scaffold: the staircase by the west gate and the heap over the north fence at x -545 (unrecorded,
 * as Baritone's scaffold is). Everything built is the bot's own, in the protection store and on the client mod's list.
 * Nobody lives in the hall until a test puts someone there.
 */
export function yard(opts: YardOpts = {}): Pasture {
  const p = new Pasture(opts);
  const zones = (p.world.zones ??= {});
  const ground = YARD.y;
  /** A blueprint with its minimum corner at `o` (y: the ground's level): stamped, the bot's own, its landmarks zones. */
  const build = (kind: string, bp: Blueprint, o: { x: number; z: number }, landmarks?: string[]) => {
    const origin = at(o.x, ground + bp.groundOffset, o.z);
    p.stamp(bp.spec, origin);
    bp.spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
      if (ch !== ' ' && ch !== '.') p.mine(at(origin.x + x, origin.y + y, origin.z + z));
    })));
    zones[kind] = [{ x: o.x, y: ground, z: o.z, width: bp.size.width, length: bp.size.length }];
    for (const l of bp.landmarks) if (!landmarks || landmarks.includes(l.kind)) (zones[`${kind}:${l.kind}`] ??= []).push(at(origin.x + l.at.x, origin.y + l.at.y, origin.z + l.at.z));
    return origin;
  };
  const mark = (bp: Blueprint, kind: string) => bp.landmarks.find(l => l.kind === kind)!.at;

  const gates = (['north', 'east', 'south', 'west'] as const).map(side => ({ side, offset: side === 'north' || side === 'south' ? YARD_GATES[side].x - YARD.x1 : YARD_GATES[side].z - YARD.z1 }));
  build('fence', fenceRing({ width: YARD.x2 - YARD.x1 + 1, length: YARD.z2 - YARD.z1 + 1 }, gates), { x: YARD.x1, z: YARD.z1 });
  build('hall', hall({ gateSide: 'south', panelSide: 'north' }), HALL);
  if (opts.lock !== false) {
    const bp = hallLock(opts.lock === 'mirror'), gate = mark(bp, 'gate');
    const o = build('lock', bp, { x: P.x - gate.x, z: P.z - gate.z }, ['inside', 'gate', 'socket', 'sill', 'post', 'sout']);
    // the zone `lock` is the footprint grown by 1; the sill is laid after the build
    zones.lock = [{ x: o.x - 1, y: ground, z: o.z - 1, width: bp.size.width + 2, length: bp.size.length + 2 }];
    p.set(zones['lock:sill'][0], 'rail[shape=north_south,waterlogged=false]');
    p.mine(zones['lock:sill'][0]);
  }
  const frame = portal({ axis: 'x' });
  const lit = mark(frame, 'frame');
  build('portal', frame, PORTAL, ['frame']);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 3; y++) p.set(at(PORTAL.x + lit.x + x, ground + lit.y + y, PORTAL.z + lit.z), 'nether_portal[axis=x]');
  zones['portal:lit'] = [{ ...zones['portal:frame'][0] }];
  if (opts.ring !== false) {
    const bp = portalRing('x', opts.ring ?? 'south');
    build('ring', bp, { x: PORTAL.x - (bp.size.width - PORTAL.width) / 2, z: PORTAL.z - (bp.size.length - PORTAL.length) / 2 }, ['gate']);
  }
  build('pen:cow', pen(7, 'south'), { x: -558, z: 2165 }, ['gate']);
  build('pen:sheep', pen(7, 'north'), { x: -542, z: 2196 }, ['gate']);
  for (const [name, x, z] of [['cow', -556, 2167], ['cow', -554, 2168], ['sheep', -540, 2199], ['sheep', -538, 2200]] as const) p.animal(name, at(x, ground + 1, z));
  const shop = workshop(), smithing = mark(shop, 'smithing');
  build('workshop', shop, { x: SMITHING.x - smithing.x, z: SMITHING.z - smithing.z });

  const g = ground + 1;
  const decoration: [Pos, string][] = [
    [at(-544, g, 2127), 'oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]'], [at(-544, g, 2128), 'oak_fence'],
    [at(-550, g, 2150), 'oak_fence'], [at(-550, g + 1, 2150), 'lantern[hanging=false,waterlogged=false]'], [at(-555, g, 2138), 'torch'],
    ...[-556, -555, -554, -553, -552].map(x => [at(x, ground, 2135), 'cobblestone'] as [Pos, string])
  ];
  for (const [c, state] of decoration) { p.set(c, state); p.mine(c); }
  if (opts.crossings !== false) {
    // the staircase by the west gate, 63 -> 67 (the bridge it led to is gone); the heap over the north fence
    for (let i = 0; i < 4; i++) for (const x of [-562, -561]) for (let y = g; y <= g + i; y++) p.set(at(x, y, 2180 + i), 'cobblestone');
    for (const [z, from, to] of [[2122, g, g], [2121, g, g + 1], [2120, g, g + 2], [2119, g + 1, g + 2], [2118, g, g + 1], [2117, g, g]]) {
      for (let y = from; y <= to; y++) p.set(at(-545, y, z), 'cobblestone');
    }
  }
  Object.assign(p.world, { landmarks: { chests: [], farmland: [], bed: at(-537, 63, 2193) }, progress: { done: ['perimeter', 'pen-cow', 'pen-sheep', 'workshop', 'nether-portal', 'hall'], journal: [] } });
  p.saved = JSON.stringify(p.world);
  return p;
}

/** A debug record's ground (boatroute.ts Ground.dump, as tests/fixtures/west-village.json keeps one) as a pasture's base; `beyond` outside its box. */
export function dumpBase(d: { y0: number; height: number; cols: Record<string, (string | null)[]> }, beyond: (p: Pos) => string | null = () => null): (p: Pos) => string | null {
  return p => { const col = d.cols[`${p.x},${p.z}`]; return col ? (p.y < d.y0 ? 'stone' : p.y >= d.y0 + d.height ? 'air' : col[p.y - d.y0]) : beyond(p); };
}
