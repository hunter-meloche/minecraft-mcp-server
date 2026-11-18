import fs from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';
import { z } from 'zod';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { MessageStore } from '../message-store.js';
import { mineflayerToolDefinitions } from '../tools/register-all.js';
import { matchesTarget } from '../combat.js';
import type { BridgeClient } from './bridge-client.js';
import { ClientProtection } from './protection.js';
import { survey, type Cluster } from './survey.js';
import { planLevel } from './level.js';
import { worldIdFromSeed, type ProtectionStore } from '../build-protection.js';
import { breakKinds, checkBuild, keepExisting, LEAVE, layoutSpec, missingCells, parseState, placerFacing, secondHalf, splitDirectional, writeSchematic, type Schematic, type StructureSpec } from './schematic.js';
import { itemOf } from './brain/blueprints.js';
import { freeLid } from './brain/chests.js';
import { holdHarmless, isHazard } from './brain/fluidpick.js';
import type { Item } from 'prismarine-item';
import { ALWAYS_EDIBLE, chooseFood, type FoodInfo } from '../food.js';
import { smeltsPerFuel } from '../tools/furnace-tools.js';
import { WILD_DISTANCE, homeProblems, zoneDistance, type Creature, type Zone } from './brain/courtesy.js';
import type { RailShape } from './brain/railroute.js';

export const foodsFor26 = () => (minecraftData('26.3') as unknown as { foodsByName: Record<string, FoodInfo> }).foodsByName;

/**
 * The client backend's tools: the same names and parameters as the mineflayer backend (taken from its definitions),
 * answered through the bridge mod, plus tools only Baritone makes possible (mine-blocks, build-structure, stop).
 */

interface Pos { x: number; y: number; z: number }
/** Why the bot can't act: off the server (and whether it's coming back by itself), or still joining. */
export function offServer(s: Pick<Status, 'screen' | 'disconnected'>): string {
  const d = s.disconnected;
  if (!d) return `The bot is not in a world yet (screen: ${s.screen ?? 'none'}). Try again shortly.`;
  return `The bot is off the server: "${d.reason}". ` + (d.rejoin
    ? `It rejoins by itself${d.inSeconds ? ` in about ${d.inSeconds} s` : ' shortly'} (and keeps trying every few minutes).`
    : "That's no dropped connection (a kick, a ban, the whitelist, a version mismatch, or it left when asked to), so it stays off: rejoin-server tries again once that's sorted out with the people there.");
}

export interface Status {
  inWorld: boolean; username: string; screen: string | null;
  /** off the server: why, and whether (and in how long) it rejoins by itself */
  disconnected?: { reason: string; key?: string | null; rejoin: boolean; inSeconds?: number | null };
  position?: Pos; block?: Pos; health?: number; food?: number; saturation?: number; air?: number;
  underWater?: boolean; inLava?: boolean; dimension?: string; gameMode?: string; difficulty?: string;
  timeOfDay?: number; process?: string | null; goal?: string | null; hashedSeed?: string | null; protectedCount?: number;
  /**
   * whether the mod has had the bot's built blocks and its home zone (none counts) from Node, for the dimension it is
   * in (through a portal both read false until Node sends that dimension's)
   */
  protectSynced?: boolean; zoneSynced?: boolean;
  /** standing in a nether portal's blocks; whether Node has told the mod which portals are its own (false after a client restart) */
  inPortal?: boolean; ownPortalsSynced?: boolean;
  windowMinimized?: boolean; mouseGrabbed?: boolean; onGround?: boolean; destroying?: boolean; sleeping?: boolean; raining?: boolean; thundering?: boolean;
  /** boxed in where it stands: the cells the Guardian's last wall-in filled there (empty when it didn't build this one) */
  boxedIn?: Pos[];
  xpLevel?: number;
  biome?: string;
  /** the world spawn (a server's spawn protection is round it) */
  spawn?: Pos;
  /** other players' builds the bot has seen (zones), and the nearest one's distance */
  foreign?: { zones: number; surface?: number; nearest: number | null };
  /** the effects on the bot (fire resistance drunk, poison...) */
  effects?: StatusEffect[];
  /** burning (fire resistance stops the hurt, not the flames) */
  onFire?: boolean;
  /**
   * what the bot rides (a boat, a minecart: the bridge's Vehicle.riding): the vehicle's id, uuid, where it is, its seat
   * (0 in front) and whether the bot steers it, its passengers (front seat first); null on foot, absent from an older jar
   */
  riding?: { id: number; uuid?: string; name?: string; position?: Pos; yaw?: number; own?: boolean; seat?: number; controlling?: boolean; passengers?: { id: number; name?: string }[] } | null;
}
/** An effect on the bot: amplifier 0 is level I; seconds left, -1 for one that never runs out. */
export interface StatusEffect { name: string; amplifier: number; seconds: number }

/** A block of the rails home as the bridge reads it (Rails.blockJson): a rail's shape, a powered rail's power, a torch's light. */
export interface RailBlock extends Pos { block: string; shape?: RailShape; powered?: boolean; lit?: boolean }
/**
 * What lay-rail answers (the bridge's rail.place, rail.torch; the stop by place): `ok` when it stands as asked: the rail
 * with the shape looked at (`predicted` now, `once` when the next rail is down) and the rail before as the plan has it,
 * or the torch lit with the rail it lights powered. `turned`: the rails whose shape changed. `newMovement`: the server
 * runs the minecart_improvements experiment (the line was planned on the old rules).
 */
export interface RailPlaced {
  ok: boolean; placed: boolean; reason?: string; dryRun?: boolean;
  block?: string; shape?: RailShape; powered?: boolean; lit?: boolean;
  predicted?: RailShape; once?: RailShape;
  turned?: (Pos & { from: RailShape | null; to: RailShape })[];
  prev?: RailBlock; lights?: RailBlock;
  newMovement?: boolean;
}
/** What lay-rail is asked: a cell of the plan (railroute.ts RailCell), the rail before it, the cell after it, or a torch and the rail it lights. */
export interface RailLay {
  at: Pos;
  item: 'rail' | 'powered_rail' | 'redstone_torch' | 'cobblestone';
  /** a rail's shape once the rail at `next` is down (none: now) */
  shape?: RailShape;
  /** the rail laid before this one, and the shape it must end with */
  prev?: Pos & { shape: RailShape };
  /** the plan's cell after this one (laid next), and what goes there */
  next?: Pos & { item?: 'rail' | 'powered_rail' };
  /** a torch: the powered rail it lights */
  lights?: Pos;
  /** the brain's courtesy judge found this village free (a cell in its zone) */
  inVillage?: boolean;
  /** look only: what the rail would do, nothing put down */
  dryRun?: boolean;
}
/** What take-up-rail answers: dug (and picked up) or why not. */
export interface RailTaken { ok: boolean; dug: boolean; block?: string; pickedUp?: boolean; reason?: string }
/** A minecart as cart.status reads it: speed in blocks a tick (on the client), the rail under it, who rides it. */
export interface CartState {
  id: number; uuid?: string; name?: string; position?: Pos; block?: Pos; yaw?: number; own?: boolean; distance?: number;
  speed?: number; moving?: boolean; rail?: RailBlock;
  passengers?: { id: number; name?: string; baby?: boolean; profession?: string }[];
}
/** What place-minecart answers (cart.place): the bot's own cart, by id and the uuid that names it after a restart. */
export interface CartPlaced extends Partial<CartState> { ok: boolean; reason?: string; newMovement?: boolean }
/** cart.status: the carts asked for (or the bot's own within 128), the rules the server runs, its simulation distance (chunks). */
export interface CartStatus { carts: CartState[]; riding?: Status['riding']; newMovement?: boolean; simulationDistance?: number; takeSpeed?: number }
/** cart.watch: why it stopped watching ("took", "at rest", "out of sight", "timed out", "cancelled", "died"), and where the cart is. */
export interface CartWatched {
  ok: boolean; reason: string; at?: Pos; block?: Pos; speed?: number; maxSpeed?: number; travelled?: number; seconds?: number;
  passengers?: CartState['passengers']; took?: number[]; rail?: RailBlock;
}
/** An enchantment and its level ('sharpness', 5). */
export interface ItemEnchantment { name: string; level: number }
export interface InventoryItem {
  slot: number; name: string; count: number; damage?: number; maxDamage?: number; enchanted?: boolean;
  /** its enchantments, absent when none; an enchanted book's are the ones it stores (its `enchanted` is not set) */
  enchantments?: ItemEnchantment[];
  /** the contents of a potion, splash or lingering potion or tipped arrow: 'long_fire_resistance', 'water' */
  potion?: string;
  /** what an anvil adds to the cost for the work done on it before (the game's REPAIR_COST); absent: 0 */
  repairCost?: number;
}
/** A stack in a chest: `slot` is the chest's own (0 the top left), what chest.withdraw's `slot` takes. */
export type ChestStack = InventoryItem;
/** What chest.open, chest.withdraw and chest.deposit answer: the totals by name, and each stack by its slot. */
export interface ChestContents {
  slots: number; free: number; items: Record<string, number>; stacks?: ChestStack[];
  /** withdraw/deposit: how many went */
  moved?: number;
  /** withdraw/deposit with `slot`: the slot taken from first (the one asked for, or the first by name when it no longer held that item); -1 none */
  from?: number;
}
interface Inventory { items: InventoryItem[]; selectedSlot: number; held: { name: string; count: number } | null }
interface EntityInfo { id: number; name: string; category: string; position: Pos; distance: number; health?: number }
interface FightResult {
  outcome: 'none' | 'done' | 'timeout' | 'low_health' | 'unreachable';
  kills: string[]; vanished: string[]; unreachable: string[]; hits: number; landed: number;
  swungWith: Record<string, number>; seconds: number; wore: string[]; target: string; dropsAt: Pos;
  retreat?: string; threats?: string; health?: number;
}
interface ProcessResult { reason: 'done' | 'timeout' | 'paused' | 'cancelled'; seconds: number; baritone: string[]; at?: Pos }

type Executor = (args: Record<string, unknown>) => Promise<ReturnType<ToolFactory['createResponse']>>;

/** build-structure: how often it looks at the build while Baritone works, and how long without change counts as stuck. */
let STALL_POLL_MS = 15_000;
let STALL_MS = 60_000;
/** For tests: shorter stall timing. */
export function setStallTiming(pollMs: number, stallMs: number): void { STALL_POLL_MS = pollMs; STALL_MS = stallMs; }

/** Items that break from use rather than being placed. */
const WEARABLE = /_(pickaxe|axe|shovel|hoe|sword)$|^(shears|fishing_rod|flint_and_steel|shield|bow|crossbow|trident|mace)$/;

/** Baritone's process names, readable: "Mine BlockOptionalMetaLookup{[...block=Block{minecraft:glass}...]}" -> "Mine glass". */
export function processName(raw: string): string {
  const blocks = [...raw.matchAll(/Block\{minecraft:([a-z0-9_]+)\}/g)].map(m => m[1]);
  return blocks.length ? `${raw.split(' ')[0]} ${blocks.join(', ')}` : raw;
}

/** How long farm waits for harvested items to reach the bot before counting them. */
let FARM_SETTLE_MS = 1500;
/** For tests. */
export function setFarmSettle(ms: number): void { FARM_SETTLE_MS = ms; }

/** Inventory slots in use among the 36 that hold items (hotbar and backpack; not armor or off-hand). */
export function packSlotsUsed(items: { slot: number }[]): number {
  return new Set(items.filter(i => i.slot >= 0 && i.slot <= 35).map(i => i.slot)).size;
}

/** A warning when every slot is taken: drops are then left on the ground. */
function fullWarning(items: { slot: number }[]): string {
  return packSlotsUsed(items) >= 36 ? ' The inventory is full: further drops stay on the ground (store or drop-item some).' : '';
}

/** Blocks Baritone builds scaffolding with (acceptableThrowawayItems in the bridge mod). */
const SCAFFOLD = /^(minecraft:)?(cobblestone|cobbled_deepslate|netherrack|andesite|diorite|granite|tuff)$/;
/** How far around a build to look for scaffolding it left. */
const SCAFFOLD_MARGIN = 6;

/**
 * The home zone: no ground or ore is broken within this many blocks of home (any depth), so mining leaves the lawn
 * alone; the game client holds the rule a few blocks past the edge (see Protection.java).
 */
export const HOME_ZONE = 24;
/** Where mining from home starts: ore at least this far from home (the zone, its margin and Baritone's reach). */
/** How far past the home zone's edge ore trips start (Baritone reaches some blocks past where it stands). */
const MINE_BEYOND = 12;
/** lay-rail's wait when the hand held something else at the use (a calm-time eat, about 32 ticks), before one more try */
const HAND_WAIT_MS = 2000;
/** How long after a first read that found nothing a lay whose call timed out is read again (its use done by then). */
const LOST_READ_MS = 1500;

/** How far craft-item looks for a crafting table to walk to. */
const TABLE_SEARCH = 48;

const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const floorPos = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** Game-client inventory index -> the slot number the mineflayer backend reports (hotbar 36-44, armor 5-8, off-hand 45). */
export function mineflayerSlot(clientSlot: number): number {
  if (clientSlot <= 8) return 36 + clientSlot;
  if (clientSlot <= 35) return clientSlot;
  if (clientSlot <= 39) return 8 - (clientSlot - 36); // feet 36 -> 8 ... head 39 -> 5
  return 45;
}

/**
 * What tells a stack from others of its name, for list-inventory: ": sharpness 5, unbreaking 3" (an enchanted book's
 * stored ones too), ": long_fire_resistance" for a potion's contents; nothing for a plain stack.
 */
export function itemDetail(i: Pick<InventoryItem, 'enchantments' | 'potion'>): string {
  const parts = [...(i.enchantments ?? []).map(e => `${e.name} ${e.level}`), ...(i.potion ? [i.potion] : [])];
  return parts.length ? `: ${parts.join(', ')}` : '';
}

/** The effects on the bot for get-status: "fire_resistance 2:40, strength II 1:30, on fire"; '' when none. */
export function effectsText(s: Pick<Status, 'effects' | 'onFire'>): string {
  const roman = ['', ' II', ' III', ' IV', ' V'];
  const left = (sec: number) => (sec < 0 ? 'no end' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
  const parts = (s.effects ?? []).map(e => `${e.name}${roman[e.amplifier] ?? ` ${e.amplifier + 1}`} ${left(e.seconds)}`);
  if (s.onFire) parts.push('on fire');
  return parts.join(', ');
}

/**
 * What's short for `times` crafts of `item`, by its closest recipe (minecraft-data 26.3), as "stick x1 (have 0)";
 * empty when every recipe is covered or there is none. Tags (any planks) aren't resolved, so a recipe is judged
 * by the exact items it lists.
 */
export function missingIngredients(item: string, times: number, have: Map<string, number>): string {
  const data = minecraftData('26.3') as unknown as {
    itemsByName: Record<string, { id: number }>; items: Record<number, { name: string }>;
    recipes: Record<number, { inShape?: (number | null)[][]; ingredients?: (number | null)[]; result: { count: number } }[]>
  };
  const recipes = data.recipes[data.itemsByName[item]?.id ?? -1] ?? [];
  let best: string[] | undefined;
  for (const r of recipes) {
    const need = new Map<string, number>();
    for (const id of [...(r.inShape?.flat() ?? []), ...(r.ingredients ?? [])]) {
      if (id === null || id === undefined) continue;
      const n = data.items[id]?.name;
      if (n) need.set(n, (need.get(n) ?? 0) + times);
    }
    const short = [...need].filter(([n, c]) => (have.get(n) ?? 0) < c).map(([n, c]) => `${n} x${c - (have.get(n) ?? 0)} (have ${have.get(n) ?? 0})`);
    if (!best || short.length < best.length) best = short;
  }
  return best?.join(', ') ?? '';
}

/** Item names a block drops (minecraft-data 26.3), or the block's own name when it lists none. */
export function blockDrops(block: string): string[] {
  const data = minecraftData('26.3') as unknown as { blocksByName: Record<string, { drops?: number[] }>; items: Record<number, { name: string }> };
  const names = (data.blocksByName[block]?.drops ?? []).map(id => data.items[id]?.name).filter((n): n is string => !!n);
  return names.length ? [...new Set(names)] : [block];
}

const entityTypes = (() => {
  const data = minecraftData('26.3') as unknown as { entitiesByName?: Record<string, { type: string }> };
  return data.entitiesByName ?? {};
})();

/** Entity kind for the shared hostile/mob/player matching (minecraft-data's categories, as the mineflayer backend sees them). */
export function entityKind(name: string): { type: string; name: string } {
  return { type: name === 'player' ? 'player' : entityTypes[name]?.type ?? 'other', name };
}

function timeLine(t: number): string {
  // monsters spawn from about tick 13000 to 23000; a day is 24000 ticks = 20 minutes
  const night = t >= 13000 && t < 23000;
  const until = night ? 23000 - t : (13000 - t + 24000) % 24000;
  const minutes = (until / 20 / 60).toFixed(1);
  return `Time of day ${t} (${night ? `night; dawn in ${minutes} min` : `day; night in ${minutes} min`})`;
}

/**
 * The blocks Baritone's builder paused for ("Missing materials for at least:" then "1x Block{minecraft:lantern}[...]").
 * It says so for blocks the bot does carry when no item of them places the state it wants as it reckons it (a lantern
 * on the floor): those go to the hand pass instead.
 */
export function pausedFor(lines: string[]): { id: string; count: number }[] {
  return lines.flatMap(l => [...l.matchAll(/(\d+)x Block\{(?:minecraft:)?([a-z0-9_]+)\}/g)].map(m => ({ id: m[2], count: +m[1] })));
}

function baritoneSaid(lines: string[], max = 3): string {
  const said = lines.map(l => l.replace(/^\[Baritone\]\s*/, '')).filter(l => l.trim()).slice(-max);
  return said.length ? ` Baritone: ${said.join(' | ')}` : '';
}

/**
 * Set while the brain (src/client/brain) runs a tool: once its signal aborts, every further bridge call of that run
 * fails at once, so a job the brain gave up (an LLM tool call came in, or something more urgent) stops between steps
 * instead of walking on. Tool calls from the LLM run outside it and are never affected.
 */
export const brainRun = new AsyncLocalStorage<{ signal: AbortSignal }>();

/** Tools that only look: an LLM calling them doesn't take control from the brain. */
/** Blocks that hang on the side of another block, and which way is the other way. */
const WALL_MOUNTED = /^(wall_torch|soul_wall_torch|redstone_wall_torch|copper_wall_torch|ladder|[a-z_]+_wall_banner)$/;
const OPPOSITE: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' };

const READ_ONLY = new Set(['get-position', 'get-status', 'list-inventory', 'find-item', 'get-block-info', 'find-blocks', 'find-entity',
  'detect-gamemode', 'read-chat', 'survey-area', 'get-recipe', 'list-recipes', 'can-craft']);

export type ToolReply = ReturnType<ToolFactory['createResponse']>;

/** What the brain gets from the client tools: their handlers by name and a few shared helpers. */
export interface ClientRuntime {
  /** every client tool's handler, called directly (no schema parsing: pass complete arguments) */
  actions: Record<string, (args: Record<string, unknown>) => Promise<ToolReply>>;
  call: <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  status: () => Promise<Status>;
  /** a place saved with set-home in the world the bot is in */
  home: (s: Status, name?: string) => (Pos & { dimension: string }) | undefined;
  /** where, when (ms) and in which dimension (an older jar: not said) the bot last died, if it has this session */
  lastDeath: () => { at: Pos; time: number; dimension?: string } | undefined;
  /** called before any tool the LLM runs that does more than look (the brain steps back) */
  setManualHook: (fn: ((tool: string) => Promise<void>) | undefined) => void;
  /**
   * Blocks the bot built (its protected positions) in the dimension it was in at the last status read, within
   * `radius` blocks of `center` (horizontally, and no further up or down), each with the block state that stood
   * there when it was built, when that is known (positions protected before states were kept have none).
   */
  builtNear: (center: Pos, radius: number) => { at: Pos; state?: string }[];
  /**
   * widen the home zone to cover a grown yard (never below HOME_ZONE); `pens`: the fence rings of the bot's pens in
   * it, sent with the yard's (the client mod keeps Baritone's paths from placing blocks by them, as by the yard's)
   */
  setHomeZone: (yard: { x1: number; z1: number; x2: number; z2: number } | undefined, pens?: { x1: number; z1: number; x2: number; z2: number }[]) => void;
  /**
   * the portals that are the bot's own, by dimension (the brain's: the home portal, its Nether side): sent to the
   * client mod (portal.own) when they change and whenever it says it has none, so nothing counts them as anyone's build
   */
  setOwnPortals?: (portals: { dimension: string; x: number; y: number; z: number }[]) => void;
  /**
   * Put `item` back at `at` (selecting it, clearing a wrong block, stepping out of the cell or closer as needed),
   * turned to `facing` (the way the bot looks while placing: see placerFacing) when given. Resolves to why it could
   * not, or undefined once placed; the position stays protected, with the state it was built with.
   */
  restoreBlock: (at: Pos, item: string, facing?: string) => Promise<string | undefined>;
  /** Remember the block state of built positions that have none yet (protected before states were kept). */
  adoptStates: (blocks: { at: Pos; state: string }[]) => void;
  /** Protect built positions with the state they stand in now (a build job's cells, as they come right). */
  protectBuilt: (blocks: { at: Pos; state: string }[]) => void;
  /**
   * The rails home (P5e): the same code as the lay-rail, take-up-rail and place-minecart tools, with the bridge's whole
   * replies (absent from a fake that has none)
   */
  rails?: {
    /**
     * A rail, a powered rail, a redstone torch or the stop's cobblestone put down as the plan has it (rail.place,
     * rail.torch), stepping carefully into reach when too far; the bot's own once down (protected with the state it
     * stands in, synced to the client mod before the next rail: its rail.place turns only the bot's own rails), and the
     * rail before it with its new shape.
     */
    lay: (args: RailLay) => Promise<RailPlaced>;
    /**
     * One block of the line taken back up: only a rail, powered rail, redstone torch or cobblestone the bot put down
     * (protected), dug from where it stands (dig.here: no Baritone), stepping carefully into reach when too far, and the
     * drop walked onto; protected no more. `item`: what the bot put there (the brain's record): another block of the line's
     * kinds standing there now (someone broke the bot's and put their own) is never dug, and the bot's no more.
     */
    takeUp: (at: Pos, item?: string) => Promise<RailTaken>;
    /** The minecart put on the rail at `at` (cart.place), stepping carefully into reach when too far. */
    placeCart: (at: Pos, opts?: { inVillage?: boolean; newMovement?: boolean }) => Promise<CartPlaced>;
  };
}

export interface ClientToolOptions {
  /** the client's game folder (schematics are written to <gameDir>/schematics) */
  gameDir: string;
  /** where the list of blocks the bot built is kept (default: memory only) */
  protectionStore?: ProtectionStore;
  /** the JSON file set-home writes (default: none, homes kept in memory) */
  homesFile?: string;
}

export function registerClientTools(factory: ToolFactory, bridge: BridgeClient, messageStore: MessageStore, options: ClientToolOptions): ClientRuntime {
  const call = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> => {
    if (brainRun.getStore()?.signal.aborted) return Promise.reject(new Error('aborted: the brain gave this job up'));
    return bridge.request<T>(method, params, timeoutMs ? { timeoutMs } : undefined);
  };
  const handlers: ClientRuntime['actions'] = {};
  let manualHook: ((tool: string) => Promise<void>) | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const register = (name: string, description: string, schema: Record<string, unknown>, fn: (args: any) => Promise<ToolReply>) => {
    handlers[name] = fn;
    factory.registerTool(name, description, schema, async (args: Record<string, unknown>) => {
      if (manualHook && !READ_ONLY.has(name)) await manualHook(name);
      return fn(args);
    });
  };
  const protection = new ClientProtection(options.protectionStore);
  type Homes = Record<string, Record<string, Pos & { dimension: string }>>;
  let memoryHomes: Homes = {};
  const readHomes = (): Homes => {
    if (!options.homesFile) return memoryHomes;
    try { return JSON.parse(fs.readFileSync(options.homesFile, 'utf8')) as Homes; } catch { return {}; }
  };
  const writeHomes = (h: Homes) => {
    if (!options.homesFile) { memoryHomes = h; return; }
    fs.mkdirSync(path.dirname(options.homesFile), { recursive: true });
    fs.writeFileSync(options.homesFile, JSON.stringify(h, null, 1));
  };
  // where the bot last died, for collect-items (its drops lie there for 5 minutes), and in which dimension: a death in
  // the Nether is never walked back to, and its coordinates are another place's
  let lastDeath: { at: Pos; time: number; dimension?: string } | undefined;
  const events = bridge as unknown as { on?: (event: string, fn: (e: { type: string; at?: Pos; dimension?: string }) => void) => void };
  events.on?.('event', e => {
    if (e.type === 'death' && e.at) lastDeath = { at: e.at, time: Date.now(), ...(typeof e.dimension === 'string' ? { dimension: e.dimension } : {}) };
  });
  let syncedVersion = -1;
  /** the dimension the positions went for: through a portal the other dimension's are sent */
  let syncedDim = 'overworld';
  // a client starts without one (the zone's key is its dimension and the zone: 'overworld none')
  let zoneSent = 'overworld none';
  /** the bot's own portals as the brain last said them, and the list as last sent (portal.own) */
  let ownPortals: { dimension: string; x: number; y: number; z: number }[] | undefined;
  let ownSent: string | undefined;
  /** the home zone's radius: grows with the yard (the brain sets it) */
  let zoneRect: { x1: number; z1: number; x2: number; z2: number } | undefined;
  /**
   * the pens' fence rings, sent with the yard's rectangle: the client mod's band round each, where Baritone's paths
   * place nothing (Protection.java). Live its way out of the cow pen was over the pen's fence, not through its gate
   */
  let zonePens: { x1: number; z1: number; x2: number; z2: number }[] = [];
  /** How far outside the home zone a point is (negative inside): from the yard's rectangle once it's known (the
   * brain sets it), else from the circle of HOME_ZONE round home. A circle as wide as a long yard's farthest corner
   * took in seven times the yard, and from anywhere in it Baritone wasn't allowed to dig, so it found no path to ore. */
  const outsideZone = (home: Pos, p: { x: number; z: number }) => (zoneRect
    ? Math.max(zoneRect.x1 - p.x, p.x - zoneRect.x2, zoneRect.z1 - p.z, p.z - zoneRect.z2)
    : Math.hypot(p.x - home.x, p.z - home.z) - HOME_ZONE);
  /** the dimension at the last status read */
  let lastDimension = 'overworld';
  /**
   * Keep the game client's copy of the protected positions (it turns them into Baritone's no-break list) current: for
   * the dimension the bot is in, said with them (a portal trip between the look and the call must not file the
   * overworld's under the Nether), and again on a change of dimension.
   */
  const syncProtection = async (dim: string, force = false) => {
    if (!force && syncedVersion === protection.version && syncedDim === dim) return;
    const positions = protection.positions(dim).map(p => [p.x, p.y, p.z]);
    await call('protect.set', { positions, dimension: dim }).then(() => { syncedVersion = protection.version; syncedDim = dim; }).catch(() => undefined);
  };
  const status = async () => {
    const s = await call<Status>('status');
    if (!s.inWorld) throw new Error(offServer(s));
    protection.attach(worldIdFromSeed(s.hashedSeed ?? undefined));
    lastDimension = s.dimension ?? 'overworld';
    const dim = s.dimension ?? 'overworld';
    // a relaunched client starts with none: resend when its count differs, or when it says it has had none (a new
    // world with nothing built has the same count as a fresh client: 0). Through a portal it says so too: its
    // positions are the other dimension's (and syncProtection resends on the change of dimension anyway)
    const relaunched = (s.protectedCount !== undefined && s.protectedCount !== protection.positions(dim).length) || s.protectSynced === false;
    await syncProtection(dim, relaunched);
    // the home zone, for the home in the dimension the bot is in (resent when it changes, the dimension changes or the
    // client is new): in the Nether none, and the mod keeps the home zone and the pens' bands off there
    const world = worldIdFromSeed(s.hashedSeed ?? undefined);
    const home = world ? readHomes()[world]?.home : undefined;
    const pensKey = zonePens.map(p => `${p.x1},${p.z1},${p.x2},${p.z2}`).join(';');
    const zone = home && home.dimension === dim ? (zoneRect ? `${zoneRect.x1},${zoneRect.z1},${zoneRect.x2},${zoneRect.z2}${pensKey ? ` pens ${pensKey}` : ''}` : `${home.x},${home.z}`) : 'none';
    const zoneKey = `${dim} ${zone}`;
    // no home yet is an answer too: the mod's build scanner waits for one (a new server: nearby-builds, set-home)
    if (zoneKey !== zoneSent || s.zoneSynced === false || (relaunched && zone !== 'none')) {
      const [x, z] = zone === 'none' ? [0, 0] : zone.split(',').map(Number);
      const params = zone === 'none' ? { x, z, radius: 0 } : zoneRect ? { ...zoneRect, ...(zonePens.length ? { pens: zonePens.map(p => ({ ...p })) } : {}) } : { x, z, radius: HOME_ZONE };
      await call('protect.zone', { ...params, dimension: dim }).then(() => { zoneSent = zoneKey; }).catch(() => undefined);
    }
    // its own portals: whenever the list changes, and whenever the mod says it has none (a client restart). Only to a
    // jar that knows them (its status says whether it has them): an older one would be asked on every look
    if (ownPortals && s.ownPortalsSynced !== undefined) {
      const key = JSON.stringify(ownPortals);
      if (s.ownPortalsSynced === false || key !== ownSent) {
        await call('portal.own', { portals: ownPortals.map(p => ({ ...p })) }).then(() => { ownSent = key; }).catch(() => undefined);
      }
    }
    return s;
  };
  const dimension = async () => (await status()).dimension ?? 'overworld';

  const impl: Record<string, Executor> = {
    'get-position': async () => {
      const s = await status();
      return factory.createResponse(`Current position: ${fmt(s.block!)}`);
    },

    'detect-gamemode': async () => factory.createResponse(`Bot gamemode: "${(await status()).gameMode}"`),

    'get-status': async () => {
      const s = await status();
      const guard = await call<{ enabled: boolean; armor: string[] }>('guardian.status');
      const effects = effectsText(s);
      return factory.createResponse([
        `Health ${s.health}/20, food ${s.food}/20, saturation ${s.saturation}`,
        ...(effects ? [`Effects: ${effects}`] : []),
        timeLine(s.timeOfDay ?? 0),
        `Dimension ${s.dimension}${s.biome ? `, biome ${s.biome}` : ''}, game mode ${s.gameMode}, difficulty ${s.difficulty}`,
        `Armor: ${guard.armor.length ? guard.armor.join(', ') : 'none'}; auto-defend ${guard.enabled ? 'on' : 'off'}` +
          await call<Inventory>('inventory').then(inv => `; inventory ${packSlotsUsed(inv.items)}/36 slots used`, () => ''),
        `Backend: game client with Baritone (${s.process ? `busy: ${processName(s.process)}` : 'idle'})` +
          (s.windowMinimized !== undefined ? `; window ${s.windowMinimized ? 'minimized' : 'shown'}${s.mouseGrabbed ? ', mouse captured' : ''}` : '') +
          (s.underWater ? `; under water, air ${s.air}/20${s.onGround === false ? ', afloat' : ''}` : '') + (s.destroying ? '; breaking a block' : '') + (s.inLava ? '; IN LAVA' : '')
      ].join('\n'));
    },

    'list-inventory': async () => {
      const inv = await call<Inventory>('inventory');
      if (!inv.items.length) return factory.createResponse('Inventory is empty');
      let text = `Found ${inv.items.length} items in inventory:\n\n`;
      for (const i of inv.items) text += `- ${i.name} (x${i.count}) in slot ${mineflayerSlot(i.slot)}${itemDetail(i)}\n`;
      return factory.createResponse(text);
    },

    'find-item': async ({ nameOrType }) => {
      const inv = await call<Inventory>('inventory');
      const q = String(nameOrType).toLowerCase();
      const item = inv.items.find(i => i.name === q) ?? inv.items.find(i => i.name.includes(q));
      return factory.createResponse(item
        ? `Found ${item.count} ${item.name} in inventory (slot ${mineflayerSlot(item.slot)})`
        : `Couldn't find any item matching '${nameOrType}' in inventory`);
    },

    'get-block-info': async ({ x, y, z }) => {
      const p = floorPos({ x: Number(x), y: Number(y), z: Number(z) });
      const b = await call<{ loaded: boolean; name?: string; properties?: Record<string, string> }>('world.block', { ...p });
      if (!b.loaded) return factory.createResponse(`No block information found at position ${fmt(p)} (not loaded)`);
      const props = Object.entries(b.properties ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
      return factory.createResponse(`Found ${b.name}${props ? `[${props}]` : ''} at position ${fmt(p)}`);
    },

    'find-blocks': async ({ blockType, maxDistance = 16, count = 1 }) => {
      const n = Math.min(Number(count), 256);
      const r = await call<{ positions: Pos[] }>('world.findBlocks', { block: blockType, maxDistance, count: n });
      if (!r.positions.length) return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
      if (n === 1) return factory.createResponse(`Found ${blockType} at position ${fmt(r.positions[0])}`);
      return factory.createResponse(`Found ${r.positions.length} ${blockType} block(s) within ${maxDistance} blocks:\n` +
        r.positions.map((p, i) => `${i + 1}. ${fmt(p)}`).join('\n'));
    },

    'find-entity': async ({ type = '', maxDistance = 16 }) => {
      const r = await call<{ entities: EntityInfo[] }>('world.entities', { maxDistance });
      const t = String(type).toLowerCase();
      const match = (e: EntityInfo) => !t || (['player', 'mob', 'hostile'].includes(t) ? matchesTarget(entityKind(e.name), t) : e.name.includes(t));
      const e = r.entities.find(match);
      if (!e) return factory.createResponse(`No ${type || 'entity'} found within ${maxDistance} blocks`);
      // someone's animal (a name tag, tamed, on a lead, in their pen or by their build): say so, it isn't the bot's to hunt
      const c = e as EntityInfo & Creature;
      const marks = [c.named && 'named', c.tamed && 'tamed', c.leashed && 'on a lead', c.foreign && "in someone's build",
        !c.foreign && c.buildDistance !== undefined && c.buildDistance < WILD_DISTANCE && `${Math.round(c.buildDistance)} blocks from someone's build`].filter(Boolean);
      return factory.createResponse(`Found ${e.name} at position ${fmt(floorPos(e.position))}${marks.length ? ` (someone's, most likely: ${marks.join(', ')})` : ''}`);
    },

    'send-chat': async ({ message }) => {
      await call('chat.send', { text: String(message) });
      return factory.createResponse(`Sent message: "${message}"`);
    },

    'read-chat': async ({ count = 10 }) => {
      const messages = messageStore.getRecentMessages(Math.min(Number(count), messageStore.getMaxMessages()));
      if (!messages.length) return factory.createResponse('No chat messages found');
      return factory.createResponse(`Found ${messages.length} chat message(s):\n\n` +
        messages.map((m, i) => `${i + 1}. ${new Date(m.timestamp).toISOString()} - ${m.username}: ${m.content}`).join('\n') + '\n');
    },

    'move-to-position': async ({ x, y, z, range = 1, timeoutMs = 180_000 }) => {
      const target = floorPos({ x: Number(x), y: Number(y), z: Number(z) });
      const start = (await status()).block!;
      let r = await call<ProcessResult & { arrived: boolean; distance: number }>('goto',
        { ...target, range, timeoutMs }, Number(timeoutMs) + 15_000);
      // stuck in flowing water where Baritone can't plan at all (a 1x1 shaft with water running in): block the flow, retry
      if (!r.arrived && r.at && fmt(floorPos(r.at)) === fmt(start) && await unstickFromWater()) {
        r = await call<ProcessResult & { arrived: boolean; distance: number }>('goto', { ...target, range, timeoutMs }, Number(timeoutMs) + 15_000);
      }
      if (r.arrived) return factory.createResponse(`Successfully moved to position near ${fmt(target)}`);
      const why = r.reason === 'timeout' ? `timed out after ${r.seconds}s` : 'no path found';
      throw new Error(`Could not reach ${fmt(target)}: ${why}. Stopped at ${fmt(r.at!)}, ${r.distance} blocks away.${baritoneSaid(r.baritone)}`);
    }
  };

  // ---- phase 2: interaction

  /**
   * mine-blocks when some blocks of the type nearby are the bot's own builds: dig the nearest others one at a time
   * (dig walks into reach) instead of Baritone's mine process, which would take the walls. Counts like Baritone does:
   * done when the inventory holds `count` of what the blocks drop (the first dig shows what that is).
   */
  const mineAround = async (block: string, count: number, timeoutMs: number, dim: string, guarded: number) => {
    const started = Date.now();
    const before = (await inventoryCounts()).counts;
    const skip = new Set<string>();
    let dug = 0;
    // what the block drops (minecraft-data), else the block's own item: count that (the first dig's pickup was sticks once)
    const drops = blockDrops(block);
    const have = async () => { const c = (await inventoryCounts()).counts; return Math.max(...drops.map(d => c.get(d) ?? 0)); };
    while (Date.now() - started < timeoutMs && (await have()) < count) {
      const found = await call<{ positions: Pos[] }>('world.findBlocks', { block, maxDistance: 64, count: 256 });
      const next = found.positions.find(p => !protection.has(dim, p) && !skip.has(fmt(p)));
      if (!next) break;
      skip.add(fmt(next));
      const r = await call<{ dug: boolean }>('dig', { ...next, timeoutMs: 30_000 }, 45_000).catch(() => ({ dug: false }));
      if (!r.dug) continue;
      dug++;
      await collectDropsNear(next);
    }
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const gained = gainedText(before, (await inventoryCounts()).counts);
    const why = (await have()) >= count ? '' : Date.now() - started >= timeoutMs ? ' (time limit)' : ` (no more reachable ${block} that isn't part of a build)`;
    return factory.createResponse(`Mined ${dug} ${block} one by one in ${seconds}s${why}, leaving ${guarded} that belong to your builds: ` +
      `${gained || 'nothing gained'}.`);
  };

  /** The world position of a structure cell (schematic index order: x, then z, then y). */
  const cellPos = (origin: Pos, layout: Schematic, i: number): Pos => ({
    x: origin.x + i % layout.width,
    y: origin.y + Math.floor(i / (layout.width * layout.length)),
    z: origin.z + Math.floor(i / layout.width) % layout.length
  });

  /**
   * Protect the structure's block cells (not air, not leave-as-is) that hold a block now, remembering the block
   * that stands in each (a later integrity check puts back what goes missing).
   */
  const protectStanding = (dim: string, origin: Pos, layout: Schematic, world: (string | null)[]): void => {
    const leave = layout.palette[LEAVE];
    const at: Pos[] = [];
    const states: string[] = [];
    layout.blocks.forEach((b, i) => {
      if (b === 0 || b === leave || !world[i] || /^(minecraft:)?(air|cave_air|void_air)$/.test(world[i]!)) return;
      at.push(cellPos(origin, layout, i));
      states.push(world[i]!.replace(/^minecraft:/, ''));
    });
    protection.add(dim, at, states);
  };

  /** The world's blocks in a structure's box (for checkBuild). */
  const region = async (origin: Pos, layout: Schematic) => (await call<{ blocks: (string | null)[] }>('world.region',
    { ...origin, width: layout.width, height: layout.height, length: layout.length }, 30_000)).blocks;

  /**
   * The bot sat for minutes at the bottom of a 1x1 shaft with water running in: Baritone can't plan out of flowing
   * water there, and blocking the water fixed it at once. Put cobblestone (or other stone) in the water cells beside
   * the bot's feet and head; returns how many were placed (0: not in water, or nothing to block).
   */
  const unstickFromWater = async (): Promise<number> => {
    const me = (await status()).block!;
    const box = { x: me.x - 1, y: me.y, z: me.z - 1, width: 3, height: 2, length: 3 };
    const { blocks } = await call<{ blocks: (string | null)[] }>('world.region', box);
    if (!blocks.some(b => /^(minecraft:)?water/.test(b ?? ''))) return 0;
    const counts = (await inventoryCounts()).counts;
    const stone = ['cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'dirt'].find(n => (counts.get(n) ?? 0) > 0);
    if (!stone) return 0;
    let placed = 0;
    for (let i = 0; i < blocks.length; i++) {
      const x = i % 3, z = Math.floor(i / 3) % 3, y = Math.floor(i / 9);
      if ((x === 1 && z === 1) || !/^(minecraft:)?water/.test(blocks[i] ?? '')) continue; // not the bot's own cells
      if (!(await placeFacing({ x: box.x + x, y: box.y + y, z: box.z + z }, stone))) placed++;
    }
    return placed;
  };

  /**
   * Mining from inside the home zone: the game client won't let Baritone break ground or ore there, so its miner
   * would find nothing. Walk out first, to above the nearest block of the kind outside the zone. Returns an error
   * reply when there's none in sight, else undefined (also when the bot isn't in the zone). Given `maxFromHome` (the
   * brain's leash, across the ground), only to blocks no further from home than that, and from wherever the bot
   * stands: outside the zone Baritone's miner heads for the nearest it knows of, at any distance.
   */
  const leaveHomeZone = async (names: string[], maxFromHome = Infinity): Promise<ReturnType<ToolFactory['createResponse']> | undefined> => {
    const s = await status();
    const world = worldIdFromSeed(s.hashedSeed ?? undefined);
    const home = world ? readHomes()[world]?.home : undefined;
    if (!home || home.dimension !== (s.dimension ?? 'overworld')) return undefined;
    const me = s.position!;
    // clear of it (the game client's rule reaches 6 past its edge), and no bound to keep to
    if (outsideZone(home, me) > 8 && !Number.isFinite(maxFromHome)) return undefined;
    const away = zoneRect ? { awayX1: zoneRect.x1, awayZ1: zoneRect.z1, awayX2: zoneRect.x2, awayZ2: zoneRect.z2, awayMin: MINE_BEYOND }
      : { awayX: home.x, awayZ: home.z, awayMin: HOME_ZONE + MINE_BEYOND };
    let best: Pos | undefined;
    for (const name of names) {
      const found = await call<{ positions: Pos[] }>('world.findBlocks', { block: name, maxDistance: 128, count: 256, ...away }, 60_000);
      for (const p of found.positions) {
        if (outsideZone(home, p) < MINE_BEYOND || Math.hypot(p.x - home.x, p.z - home.z) > maxFromHome) continue;
        if (!best || Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z) < Math.hypot(best.x - me.x, best.y - me.y, best.z - me.z)) best = p;
      }
    }
    if (!best) {
      return factory.createErrorResponse(`No ${names.join(' or ')} in sight outside the home area (${MINE_BEYOND}+ blocks past ${zoneRect ? 'the yard' : `${HOME_ZONE} blocks from home ${fmt(home)}`}` +
        `${Number.isFinite(maxFromHome) ? `, within ${maxFromHome} of home` : ''}); the bot doesn't mine in the home area. Go further out (explore) and mine from there.`);
    }
    const r = await call<ProcessResult & { arrived: boolean }>('goto', { ...best, xz: true, range: 3, timeoutMs: 180_000 }, 195_000);
    if (!r.arrived && outsideZone(home, (await status()).position!) <= 8) {
      return factory.createErrorResponse(`Could not get out of the home area to the ${names[0]} at ${fmt(best)}${baritoneSaid(r.baritone)}`);
    }
    return undefined;
  };

  /** Any box, read in slabs that fit a region call. */
  const readRegion = async (b: { x: number; y: number; z: number; width: number; height: number; length: number }) => {
    const out: (string | null)[] = [];
    const per = Math.max(1, Math.floor(65_536 / (b.width * b.length)));
    for (let y = 0; y < b.height; y += per) {
      const part = await call<{ blocks: (string | null)[] }>('world.region', { ...b, y: b.y + y, height: Math.min(per, b.height - y) }, 60_000);
      out.push(...part.blocks);
    }
    return out;
  };

  /**
   * Take down scaffolding a build left: blocks of Baritone's building materials that were air before the build, in
   * the box around it, and not a cell the structure wants (left standing, they dotted the cleared land: pillars by
   * the leveled area, single blocks at its edges). Top down, one pass; returns how many came down.
   */
  const removeScaffold = async (box: { x: number; y: number; z: number; width: number; height: number; length: number },
    before: (string | null)[], origin: Pos, layout: Schematic): Promise<number> => {
    const after = await readRegion(box).catch(() => undefined);
    if (!after) return 0;
    const leave = layout.palette[LEAVE];
    const wanted = (p: Pos) => {
      const lx = p.x - origin.x, ly = p.y - origin.y, lz = p.z - origin.z;
      if (lx < 0 || ly < 0 || lz < 0 || lx >= layout.width || ly >= layout.height || lz >= layout.length) return false;
      const b = layout.blocks[lx + lz * layout.width + ly * layout.width * layout.length];
      return b !== 0 && b !== leave;
    };
    const found: Pos[] = [];
    after.forEach((b, i) => {
      if (!b || !SCAFFOLD.test(b) || !/^(minecraft:)?(air|cave_air|water|short_grass|tall_grass|leaf_litter)/.test(before[i] ?? 'air')) return;
      const p = { x: box.x + i % box.width, y: box.y + Math.floor(i / (box.width * box.length)), z: box.z + Math.floor(i / box.width) % box.length };
      if (!wanted(p)) found.push(p);
    });
    found.sort((a, b) => b.y - a.y);
    let removed = 0;
    const dim = await dimension();
    for (const p of found) {
      const r = await call<{ dug: boolean }>('dig', { ...p, timeoutMs: 20_000 }, 35_000).catch(() => ({ dug: false }));
      if (r.dug) { removed++; protection.remove(dim, p); }
    }
    return removed;
  };

  /** Seeds for each crop, in planting preference. */
  const SEEDS = ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds'];

  /** Plant seeds from the inventory on bare farmland within `range` of the bot (counts what it planted and what stayed bare). */
  const replant = async (range: number) => {
    const s = await status();
    const me = floorPos(s.position!);
    const r = Math.min(range, 16);
    const box = { x: me.x - r, y: me.y - 2, z: me.z - r, width: 2 * r + 1, height: 4, length: 2 * r + 1 };
    const { blocks } = await call<{ blocks: (string | null)[] }>('world.region', box, 30_000);
    const w = box.width, l = box.length;
    const bare: Pos[] = [];
    for (let y = 0; y < box.height - 1; y++) for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
      const i = x + z * w + y * w * l;
      if (/^farmland/.test(blocks[i] ?? '') && blocks[i + w * l] === 'air') bare.push({ x: box.x + x, y: box.y + y + 1, z: box.z + z });
    }
    bare.sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z));
    const what: string[] = [];
    let count = 0;
    for (const at of bare) {
      const counts = (await inventoryCounts()).counts;
      const seed = SEEDS.find(n => (counts.get(n) ?? 0) > 0);
      if (!seed) break;
      if (!(await placeFacing(at, seed))) { count++; if (!what.includes(seed)) what.push(seed); }
    }
    return { count, what, empty: bare.length - count };
  };

  /** Place `item` at `at` while facing `look` (clearing a wrong block first); returns why not, or undefined when placed. */
  const placeFacing = async (at: Pos, block: string, look?: string, attach?: string, axis?: string): Promise<string | undefined> => {
    type Placed = { placed: boolean; block?: string; reason?: string };
    // the item that places the block (a wall torch is a torch); a wall-mounted one goes on the block on its `attach` side
    const item = itemOf(block);
    try { await call('item.select', { name: item }); } catch {
      // the right block in the wrong state (a stair turned round) is the item to re-place it with: break it first. The
      // hand pass gave up on "no oak_fence_gate in the inventory" with the gate standing right there.
      const { blocks: [b] } = await call<{ blocks: (string | null)[] }>('world.region', { ...at, width: 1, height: 1, length: 1 }).catch(() => ({ blocks: [null] }));
      if (!b || parseState(b).id !== parseState(block).id) return `no ${item} in the inventory`;
      await call('dig', { ...at }, 75_000).catch(() => undefined);
      await new Promise(res => setTimeout(res, 500)); // the drop to fly into the pockets
      try { await call('item.select', { name: item }); } catch { return `no ${item} in the inventory (broke the one standing there)`; }
    }
    const attempt = () => call<Placed>('place', { ...at, face: attach ?? 'down', ...(look ? { facing: look } : {}), ...(axis ? { axis } : {}) });
    let r = await attempt();
    if (!r.placed && r.reason?.startsWith('occupied by')) {
      await call('dig', { ...at }, 75_000).catch(() => undefined);
      await call('item.select', { name: item });
      r = await attempt();
    }
    if (!r.placed && r.reason === 'the bot is standing there') {
      // step out of the cell (Baritone may end a build standing where a block still goes), then place from beside it
      await call('goto', { ...at, away: 2, timeoutMs: 15_000 }, 30_000).catch(() => undefined);
      await call('item.select', { name: item });
      r = await attempt();
    }
    if (!r.placed && r.reason === 'too far') {
      await goNear(at, 2).catch(() => undefined);
      await call('item.select', { name: item });
      r = await attempt();
    }
    return r.placed ? undefined : (r.reason ?? 'the server did not accept it');
  };

  const inventoryCounts = async () => {
    const inv = await call<Inventory>('inventory');
    const counts = new Map<string, number>();
    for (const i of inv.items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
    return { inv, counts };
  };
  const gainedText = (before: Map<string, number>, after: Map<string, number>) =>
    [...after].filter(([n, c]) => c > (before.get(n) ?? 0)).map(([n, c]) => `${n} x${c - (before.get(n) ?? 0)}`).join(', ');
  const goNear = (p: Pos, range: number, timeoutMs = 30_000) =>
    call<ProcessResult & { arrived: boolean }>('goto', { ...floorPos(p), range, timeoutMs }, timeoutMs + 15_000);

  /**
   * A crafting table where there is none: crafted in the inventory grid (from planks, or a log made into planks first)
   * and placed on solid ground right beside the bot, never in someone else's build. Placed with place-block, so it's
   * the bot's own, and at home the brain takes it for the home table. Undefined when it can't.
   */
  const firstTable = async (): Promise<Pos | undefined> => {
    let { counts } = await inventoryCounts();
    if (!counts.get('crafting_table')) {
      const planks = () => [...counts].filter(([n]) => /_planks$/.test(n)).reduce((a, [, k]) => a + k, 0);
      if (planks() < 4) {
        const log = [...counts.keys()].find(n => /_(log|stem)$/.test(n) || /^stripped_.*_(log|stem)$/.test(n));
        if (!log) return undefined;
        await call('craft', { item: log.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks'), count: 1 }, 30_000).catch(() => undefined);
        ({ counts } = await inventoryCounts());
        if (planks() < 4) return undefined;
      }
      await call('craft', { item: 'crafting_table', count: 1 }, 30_000).catch(() => undefined);
      ({ counts } = await inventoryCounts());
      if (!counts.get('crafting_table')) return undefined;
    }
    const s = await status();
    const me = s.block!;
    const box = { x: me.x - 2, y: me.y - 1, z: me.z - 2, width: 5, height: 3, length: 5 };
    const { blocks } = await call<{ blocks: (string | null)[] }>('world.region', box);
    const at = (dx: number, dy: number, dz: number) => (blocks[(dx + 2) + (dz + 2) * 5 + (dy + 1) * 25] ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
    const OPEN = /^(air|cave_air|short_grass|tall_grass|fern|large_fern|leaf_litter|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|allium|wildflowers|pink_petals|snow)$/;
    const SOLID = /^(?!air$|cave_air$|water$|lava$)(.*(dirt|grass_block|stone|deepslate|sand|gravel|planks|cobblestone|netherrack|podzol|mud|clay|terracotta|andesite|diorite|granite|tuff|calcite|mycelium|moss_block|snow_block|sandstone))$/;
    const spots: Pos[] = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      if (OPEN.test(at(dx, 0, dz)) && SOLID.test(at(dx, -1, dz))) spots.push({ x: me.x + dx, y: me.y, z: me.z + dz });
    }
    if (!spots.length) return undefined;
    const inside = (await call<{ inside?: boolean[] }>('foreign.at', { positions: spots.map(p => [p.x, p.y, p.z]) }).catch(() => ({ inside: [] as boolean[] }))).inside ?? [];
    for (const [i, p] of spots.entries()) {
      if (inside[i]) continue;
      const r = await impl['place-block']({ ...p, item: 'crafting_table' });
      if (!r.isError && /^Placed/.test(String(r.content.map(c => (c as { text?: string }).text ?? '').join(' ')))) return p;
    }
    return undefined;
  };

  /**
   * Open a chest: walks up to it if it's out of reach, and frees a lid weighed down by scaffold. The walk only walks
   * at first (nothing dug, nothing placed), to within 3 blocks: a chest two layers up in the storage house opens from
   * the floor, and the floor is within 3 of it but not within 2, so the walk to within 2 could only be met by
   * pillaring up in the house (scaffold left there once stood on the home cell and kept the bot from its bed). That
   * walk comes second, for a chest that needs a dug or bridged way, and not at all for a chest in reach whose lid is
   * held down: no walk opens that one, the lid is freed.
   */
  const openChest = async <T>(at: Pos): Promise<T> => {
    try { return await call<T>('chest.open', { ...at }); } catch { /* out of reach, or the lid */ }
    await call('goto', { ...floorPos(at), range: 3, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
    let lid = false;
    try { return await call<T>('chest.open', { ...at }); } catch (e) { lid = /did not open/.test((e as Error).message); }
    if (!lid) await goNear(at, 2);
    try { return await call<T>('chest.open', { ...at }); } catch (e) {
      const freed = /did not open/.test((e as Error).message) ? await freeLid(call, at) : [];
      if (!freed.length) throw e;
      const dim = await dimension();
      for (const p of freed) protection.remove(dim, p);
      return await call<T>('chest.open', { ...at });
    }
  };

  /** Walk onto the drops near a broken block (they pop out and may fall a few blocks). */
  const collectDropsNear = async (p: Pos) => {
    const r = await call<{ entities: EntityInfo[] }>('world.entities', { maxDistance: 24, type: 'item' });
    const drops = r.entities.filter(e => Math.hypot(e.position.x - p.x - 0.5, e.position.z - p.z - 0.5) <= 3 &&
      e.position.y - p.y <= 1 && e.position.y - p.y >= -6);
    for (const d of drops.slice(0, 6)) {
      const r = await goNear(d.position, 0, 8000).catch(() => undefined);
      // Baritone has no path to a drop floating in water: swim straight at it when it's close
      if (!r?.arrived) await call('steer', { ...d.position, timeoutMs: 6000 }, 12_000).catch(() => undefined);
    }
  };

  Object.assign(impl, {
    'look-at': async ({ x, y, z }) => {
      await call('look', { x, y, z });
      return factory.createResponse(`Looking at position (${x}, ${y}, ${z})`);
    },

    'jump': async () => {
      await call('keys', { key: 'jump', ms: 100 });
      return factory.createResponse('Successfully jumped');
    },

    'move-in-direction': async ({ direction, duration = 1000 }) => {
      await call('keys', { key: direction, ms: duration }, Number(duration) + 10_000);
      return factory.createResponse(`Moved ${direction} for ${duration}ms`);
    },

    'equip-item': async ({ itemName, destination = 'hand' }) => {
      try {
        await call('item.equip', { name: itemName, destination });
      } catch (e) {
        if (/^no /.test((e as Error).message)) return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
        throw e;
      }
      return factory.createResponse(`Equipped ${itemName} to ${destination}`);
    },

    'dig-block': async ({ x, y, z, collect = true, force = false }) => {
      const p = floorPos({ x: Number(x), y: Number(y), z: Number(z) });
      const before = (await inventoryCounts()).counts;
      // inside someone else's build the mod refuses, unless a person asked for this block (force)
      const r = await call<{ dug: boolean; block?: string; tool?: string | null; reason: string; baritone?: string[] }>('dig', { ...p, timeoutMs: 60_000, ...(force ? { force: true } : {}) }, 75_000);
      if (r.reason === 'air' || r.block === undefined) return factory.createResponse(`No block found at position ${fmt(p)}`);
      if (!r.dug) throw new Error(`Could not dig ${r.block} at ${fmt(p)} (${r.reason}).${baritoneSaid(r.baritone ?? [])}`);
      protection.remove(await dimension(), p);
      if (collect) await collectDropsNear(p);
      const gained = gainedText(before, (await inventoryCounts()).counts);
      return factory.createResponse(`Dug ${r.block} at ${fmt(p)}${r.tool ? ` with ${r.tool}` : ''}` +
        (gained ? `. Picked up ${gained}` : collect ? '. Nothing picked up' : ''));
    },

    'place-block': async ({ x, y, z, faceDirection = 'down', item }) => {
      const p = floorPos({ x: Number(x), y: Number(y), z: Number(z) });
      if (item) {
        try { await call('item.select', { name: item }); } catch { return factory.createResponse(`No ${item} in inventory to place`); }
      }
      type Placed = { placed: boolean; block?: string; face?: string; reason?: string };
      let r = await call<Placed>('place', { ...p, face: faceDirection });
      if (!r.placed && r.reason === 'too far') {
        await goNear(p, 3);
        r = await call<Placed>('place', { ...p, face: faceDirection });
      }
      if (!r.placed) {
        if (r.reason?.startsWith('occupied by ')) return factory.createResponse(`There's already a block (${r.reason.slice(12)}) at ${fmt(p)}`);
        if (r.reason === 'the bot is standing there') return factory.createResponse(`You can't place a block where you're standing or one block above`);
        return factory.createResponse(`Failed to place block at ${fmt(p)}: ${r.reason ?? 'the server did not accept it'}`);
      }
      protection.add(await dimension(), [p], [r.block?.replace(/^minecraft:/, '')]);
      return factory.createResponse(`Placed ${r.block} at ${fmt(p)} using ${r.face} face`);
    },

    'eat': async ({ item }) => {
      const s = await status();
      if (s.gameMode === 'creative') return factory.createResponse('No need to eat in creative mode');
      const vitals = `Health ${s.health}/20, food ${s.food}/20`;
      const { inv } = await inventoryCounts();
      const foods = foodsFor26();
      let food: string | undefined;
      if (item) {
        food = String(item).replace(/^minecraft:/, '');
        if (!inv.items.some(i => i.name === food)) return factory.createResponse(`No ${food} in inventory`);
        if (!foods[food] && !ALWAYS_EDIBLE.has(food)) return factory.createResponse(`${food} isn't edible`);
      } else {
        food = chooseFood(inv.items as unknown as Item[], foods, s.food ?? 20)?.name;
        if (!food) return factory.createResponse(`Nothing safe to eat in inventory. ${vitals}`);
      }
      if ((s.food ?? 0) >= 20 && !ALWAYS_EDIBLE.has(food)) return factory.createResponse(`Not hungry. ${vitals}`);
      await call('item.select', { name: food });
      const r = await call<{ finished: boolean; food: number; foodBefore: number; health: number; healthBefore: number }>('use', {}, 15_000);
      if (!r.finished) throw new Error(`Could not eat ${food}`);
      return factory.createResponse(`Ate ${food}: food ${r.foodBefore} -> ${r.food}, health ${r.healthBefore} -> ${r.health}`);
    },

    'craft-item': async ({ outputItem, amount = 1 }) => {
      const item = String(outputItem).replace(/^minecraft:/, '');
      type Crafted = { crafted: number; gained: Record<string, number> };
      let r: Crafted;
      try {
        r = await call<Crafted>('craft', { item, count: amount }, 60_000);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.startsWith('missing ingredients')) {
          const short = missingIngredients(item, Number(amount), (await inventoryCounts()).counts);
          return factory.createErrorResponse(`${msg}${short ? `: needs ${short}` : ''}`);
        }
        if (!msg.startsWith('needs_table')) return factory.createErrorResponse(msg);
        // Baritone walks well, so look further than arm's reach plus a few steps (the mineflayer backend's 16)
        const tables = await call<{ positions: Pos[] }>('world.findBlocks', { block: 'crafting_table', maxDistance: TABLE_SEARCH, count: 1 });
        // none: make one and put it down beside the bot (a new bot's first table: without it no tool was ever made,
        // and the brain's kit failed until it gave up for ten minutes, again and again)
        const table = tables.positions[0] ?? await firstTable();
        if (!table) {
          return factory.createErrorResponse(`${item} needs a crafting table and there is none within ${TABLE_SEARCH} blocks, and the bot could not make and place one ` +
            '(it needs 4 planks or a log, and solid ground beside it). Craft a crafting_table, place it nearby, then craft again.');
        }
        await goNear(table, 3);
        r = await call<Crafted>('craft', { item, count: amount, ...table }, 60_000);
      }
      if (!r.crafted) return factory.createErrorResponse(`Failed to craft ${item}: nothing was crafted`);
      return factory.createResponse(`Successfully crafted ${item} ${r.crafted} time(s)`);
    },

    'smelt-item': async ({ x, y, z, inputItem, inputCount = 1, fuelItem, fuelCount, takeOutput = true, timeoutMs = 60_000 }) => {
      const at = floorPos({ x: Number(x), y: Number(y), z: Number(z) });
      const block = await call<{ name?: string }>('world.block', { ...at });
      if (!['furnace', 'blast_furnace', 'smoker'].includes(block.name ?? '')) return factory.createResponse(`No furnace at ${fmt(at)}`);
      type Slot = { name: string; count: number } | null;
      type Furnace = { open: boolean; input: Slot; fuel: Slot; output: Slot; lit: boolean };
      let f: Furnace;
      try {
        f = await call<Furnace>('furnace.open', { ...at });
      } catch {
        await goNear(at, 3);
        f = await call<Furnace>('furnace.open', { ...at });
      }
      try {
        const { counts } = await inventoryCounts();
        const input = String(inputItem).replace(/^minecraft:/, '');
        const fuel = String(fuelItem).replace(/^minecraft:/, '');
        if (f.input && f.input.name !== input) return factory.createResponse(`Furnace input slot is occupied by ${f.input.name}`);
        const queued = Math.min(Number(inputCount), counts.get(input) ?? 0) + (f.input?.count ?? 0);
        if (!queued && !f.output) return factory.createResponse(`Couldn't find any item matching '${inputItem}' in inventory`);
        // a lit furnace's leftover burn is not counted: it may be nearly spent (it was, and a log sat unsmelted)
        const stocked = f.fuel ? f.fuel.count * smeltsPerFuel(f.fuel.name) : 0;
        const needed = Math.ceil(Math.max(0, queued - stocked) / smeltsPerFuel(fuel));
        const addFuel = Math.min(needed, fuelCount === undefined ? needed : Number(fuelCount), counts.get(fuel) ?? 0);
        if (needed > 0 && !addFuel && !f.fuel && !f.lit) return factory.createResponse(`Couldn't find any fuel item matching '${fuelItem}' in inventory`);
        // the bridge's put moves one stack: a pocket of 16 planks ahead of the full ones was all the fuel that went in
        // (24 of 64 raw iron cooked, the fire out): again from the next stack, till the slot holds what it should
        const fill = async (slot: 'fuel' | 'input', name: string, count: number, had: number) => {
          let inSlot = had;
          for (let k = 0; k < 6 && inSlot < had + count; k++) {
            const st = await call<Partial<Furnace>>('furnace.put', { slot, name, count: had + count - inSlot });
            const now = st[slot]?.count;
            if (now === undefined || now <= inSlot) return;
            inSlot = now;
          }
        };
        if (addFuel > 0 && (!f.fuel || f.fuel.name === fuel)) await fill('fuel', fuel, addFuel, f.fuel?.count ?? 0);
        const putCount = Math.min(Number(inputCount), counts.get(input) ?? 0);
        if (putCount > 0) await fill('input', input, putCount, f.input?.count ?? 0);
        if (!takeOutput) return factory.createResponse(`Started smelting ${putCount} ${input}${addFuel ? ` with ${addFuel} ${fuel}` : ''}`);
        const deadline = Date.now() + Math.max(Number(timeoutMs), queued * 10_500 + 5000);
        let taken = 0;
        let outName = '';
        let unfuelled = 0;
        let left: Slot = null;
        while (Date.now() < deadline) {
          const st = await call<Furnace>('furnace.status');
          if (st.output) {
            const t = await call<{ took: Slot }>('furnace.take');
            if (t.took) { taken += t.took.count; outName = t.took.name; }
          }
          left = st.input;
          if (!st.input && !st.output) break;
          // input waiting with no fuel and no fire: it will never finish (two looks, so a re-light between items isn't mistaken for it)
          unfuelled = st.input && !st.fuel && !st.lit ? unfuelled + 1 : 0;
          if (unfuelled >= 2) break;
          await new Promise(r => setTimeout(r, 1000));
        }
        const smelted = taken ? `Smelted ${taken} ${outName}` : 'Nothing smelted';
        if (unfuelled >= 2 && left) return factory.createResponse(`${smelted}; the furnace ran out of fuel with ${left.count} ${left.name} still in it. Add fuel (smelt-item again with fuelItem).`);
        return taken ? factory.createResponse(smelted) : factory.createResponse(`No output after ${timeoutMs}ms`);
      } finally {
        await call('container.close').catch(() => undefined);
      }
    },

    'fly-to': async () => factory.createErrorResponse('fly-to is not supported on the client backend (Baritone walks; use move-to-position).'),

    // ---- phase 3: combat (the fight loop and reflexes run in the game client, on the tick)

    // collect: false leaves the drops where they fell, for the caller to pick up its own way (the pens round, from the
    // pen's inside cells: this walk to them took the bot into its cow pen's corner post, pens.ts dropsIn)
    'attack-entity': async ({ target, maxDistance = 16, timeoutMs = 30_000, minHealth = 6, retreat = true, collect = true }) => {
      const r = await call<FightResult>('fight', { target: String(target), maxDistance, timeoutMs, minHealth, retreat }, Number(timeoutMs) + 60_000);
      if (r.outcome === 'none') return factory.createResponse(`No ${target} within ${maxDistance} blocks`);
      const swings = r.hits
        ? `${r.hits} swing(s), ${r.landed} landed (${Object.entries(r.swungWith).map(([n, c]) => `${n} x${c}`).join(', ')})`
        : 'no swings';
      const killed = [r.kills.length ? `Killed ${r.kills.join(', ')}` : '', r.vanished.length ? `Gone without dying: ${r.vanished.join(', ')}` : '']
        .filter(Boolean).join('. ');
      const lines: string[] = [];
      if (r.wore.length) lines.push(`Put on ${r.wore.join(', ')}.`);
      switch (r.outcome) {
        case 'done': lines.push(`${killed} with ${swings} in ${r.seconds}s.` + (r.unreachable.length ? ` Couldn't get to ${r.unreachable.join(', ')}.` : '')); break;
        case 'low_health': lines.push(`${killed ? killed + '. ' : ''}Stopped fighting ${r.target} after ${swings}: health is low.` + (r.retreat ? ` Then ${r.retreat}.` : '')); break;
        case 'unreachable': lines.push(`Couldn't get to ${r.unreachable.join(', ')} (no way through, or not getting closer).`); break;
        default: lines.push(`${killed ? killed + '. ' : ''}${r.target} still alive after ${r.seconds}s and ${swings}.`);
      }
      const s = await status();
      lines.push(`Health ${s.health}/20, food ${s.food}/20.`);
      if (r.threats) lines.push(`Hostiles nearby: ${r.threats}.` + (r.outcome === 'low_health' ? ' Wall yourself in or keep away until health recovers.' : ''));
      // pick up the drops unless a hostile is close: at night there is always one within 16 blocks, which left the
      // wool of 3 of 4 sheep on the ground (the defend process handles ones further off)
      const nearest = Math.min(...[...(r.threats ?? '').matchAll(/(\d+) blocks away/g)].map(m => Number(m[1])));
      if (collect !== false && r.kills.length && r.outcome !== 'low_health' && !(nearest <= 6)) await collectDropsNear(r.dropsAt).catch(() => undefined);
      return factory.createResponse(lines.join(' '));
    },

    'wall-in': async () => {
      const r = await call<{ error?: string; at: Pos; placed: number; alreadySolid: number; gaps: Pos[] }>('wallin', {}, 30_000);
      if (r.error) return factory.createResponse('No blocks to wall in with (dirt, cobblestone, stone, planks, ...)');
      if (!r.gaps.length) return factory.createResponse(`Walled in at ${fmt(r.at)} (${r.placed} block(s) placed). Dig out with dig-block when it's safe.`);
      return factory.createResponse(`Walled in at ${fmt(r.at)} with ${r.gaps.length} gap(s) left at ${r.gaps.map(fmt).join(', ')} (${r.placed} placed).`);
    },

    'set-auto-defend': async ({ enabled }) => {
      await call('guardian.set', { enabled: Boolean(enabled) });
      return factory.createResponse(`Auto-defend ${enabled ? 'on' : 'off'}`);
    }
  } satisfies Record<string, Executor>);

  const notYet: Executor = async () => factory.createErrorResponse(
    'This tool is not available on the client backend yet. Run the server with --backend mineflayer to use it.');

  for (const def of mineflayerToolDefinitions()) {
    register(def.name, def.description, def.schema, impl[def.name] ?? notYet);
  }

  // ---- tools only the client backend has

  register(
    'mine-blocks',
    "Gather blocks with Baritone: it finds the nearest blocks of the type (from its memory of the world and nearby chunks), walks there, mines them with the right tool and picks up the drops, until the inventory has `count` of the item (counting what it already holds). E.g. block 'oak_log', count 16.",
    {
      block: z.string().describe("Block to mine, e.g. 'oak_log', 'stone', or several comma-separated: 'iron_ore,deepslate_iron_ore'"),
      count: z.coerce.number().int().positive().optional().describe('How many of the item to have in the inventory when done (default: 1)'),
      timeoutMs: z.number().int().min(1000).optional().describe('Give up after this long (default: 300000)'),
      maxFromHome: z.coerce.number().positive().optional().describe('From inside the home area, walk out only to blocks at most this far from home (horizontally)')
    },
    async ({ block, count = 1, timeoutMs = 300_000, maxFromHome }: { block: string; count?: number; timeoutMs?: number; maxFromHome?: number }) => {
      const names = block.split(',').map(n => n.trim().replace(/^minecraft:/, '')).filter(Boolean);
      const dim = await dimension();
      let guarded = 0;
      for (const name of names) {
        const near = await call<{ positions: Pos[] }>('world.findBlocks', { block: name, maxDistance: 64, count: 256 });
        guarded += near.positions.filter(p => protection.has(dim, p)).length;
      }
      if (guarded && names.length === 1) return mineAround(names[0], count, timeoutMs, dim, guarded);
      const out = await leaveHomeZone(names, maxFromHome);
      if (out) return out;
      let r: ProcessResult & { gained: Record<string, number> };
      try {
        r = await call<ProcessResult & { gained: Record<string, number> }>('mine', { block, count, timeoutMs }, timeoutMs + 15_000);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.startsWith('needs_tool: ')) return factory.createErrorResponse(msg.slice(12) + '. Craft one first.');
        throw e;
      }
      const gained = Object.entries(r.gained).map(([n, c]) => `${n} x${c}`).join(', ');
      const head = r.reason === 'timeout' ? `Stopped after ${r.seconds}s (time limit)` : `Mined for ${r.seconds}s`;
      const full = fullWarning((await call<Inventory>('inventory').catch(() => ({ items: [] }))).items);
      return factory.createResponse(`${head}: ${gained || 'nothing gained'}.${full}${baritoneSaid(r.baritone)}`);
    }
  );

  // kept as a function so level-area can build its plan the same way (verification, stall recovery, protection)
  let buildStructure: (args: { x: number; y: number; z: number; spec?: StructureSpec; file?: string; name?: string; timeoutMs?: number; keepProtection?: boolean; allow?: string[] }) =>
    Promise<ReturnType<ToolFactory['createResponse']>>;
  register(
    'build-structure',
    "Build a structure block by block with Baritone (it places blocks from the inventory, clears what's in the way, and scaffolds as needed). Describe it as `spec`: a palette of single characters to blocks and `layers` from the bottom up, each a list of rows along +z whose characters run along +x; '.' is air (cleared, except blocks the bot placed there itself, like a door or furniture), ' ' leaves the cell as it is. Example: {palette:{L:'oak_log[axis=y]',P:'oak_planks'}, layers:[['LPL','P.P','LPL']]}. Or give `file`, a .schem/.litematic path. The structure's minimum corner goes at x,y,z. Checks the inventory has the blocks first (survival).",
    {
      x: z.coerce.number().describe('X of the minimum corner'),
      y: z.coerce.number().describe('Y of the bottom layer'),
      z: z.coerce.number().describe('Z of the minimum corner'),
      spec: z.object({
        palette: z.record(z.string(), z.string()),
        layers: z.array(z.array(z.string()))
      }).optional().describe('Structure as palette + layers (see the tool description)'),
      file: z.string().optional().describe('Path to an existing .schem or .litematic file instead of spec'),
      name: z.string().regex(/^[\w-]+$/).optional().describe('Name for the schematic file (default: structure)'),
      timeoutMs: z.number().int().min(1000).optional().describe('Give up after this long (default: 600000)')
    },
    buildStructure = async ({ x, y, z: zz, spec, file, name = 'structure', timeoutMs = 600_000, keepProtection = false, allow }: {
      x: number; y: number; z: number; spec?: StructureSpec; file?: string; name?: string; timeoutMs?: number;
      /** the build jobs' packages: Baritone may break nothing the bot built (their clears are done first, by hand) */
      keepProtection?: boolean;
      /** with keepProtection: the only kinds Baritone may break (level-area's cuts: the natural blocks it cuts) */
      allow?: string[]
    }) => {
      const origin = floorPos({ x, y, z: zz });
      let schematicFile: string;
      let layout: Schematic | undefined;
      // a narrow lift by default: Baritone may break only the kinds standing in the cells this build clears or
      // replaces; everything else the bot built stays protected (keepProtection without allow: nothing at all)
      let narrow: string[] | undefined = keepProtection ? allow : undefined;
      if (spec) {
        layout = layoutSpec(spec);
        const s = await status();
        const dim = s.dimension ?? 'overworld';
        const now = await region(origin, layout);
        const box = layout;
        if (s.gameMode !== 'creative') {
          // only what is not standing yet: a second run continues a build
          const before = checkBuild(layout, now);
          protectStanding(dim, origin, layout, now); // what stands of it is the bot's, even if it stops here
          // done only when every block stands and every '.' cell is empty (a clearing-only plan has no blocks at all)
          const toClear = layout.blocks.filter((b, i) => b === 0 && !!now[i] && !/^(minecraft:)?(air|cave_air|void_air)$/.test(now[i]!) &&
            !protection.has(dim, cellPos(origin, box, i))).length;
          if (before.placed === before.total && !toClear) {
            return factory.createResponse(`${name} is already built at ${fmt(origin)}: all ${before.total} blocks in place.`);
          }
          const { counts: have } = await inventoryCounts();
          // by the item that places each block (a wall torch is placed with a torch)
          const own = (id: string) => (have.get(itemOf(id)) ?? 0) + (before.misplaced[id] ?? 0);
          const missing = Object.entries(before.missing).filter(([id, n]) => own(id) < n)
            .map(([id, n]) => `${itemOf(id)} ${own(id)}/${n}`);
          if (missing.length) return factory.createErrorResponse(`Not enough blocks to build it. Missing: ${missing.join(', ')}`);
        }
        const dir = path.join(options.gameDir, 'schematics');
        fs.mkdirSync(dir, { recursive: true });
        schematicFile = path.join(dir, `${name}.schem`);
        // '.' clears a cell, but not of what the bot placed there itself: a rebuild of the cabin cleared its door and furniture
        const isKept = (i: number) => !!now[i] && !/^(minecraft:)?(air|cave_air|void_air)$/.test(now[i]!) && protection.has(dim, cellPos(origin, box, i));
        const kept = keepExisting(layout, isKept);
        if (!keepProtection) narrow = breakKinds(layout, now, isKept);
        fs.writeFileSync(schematicFile, writeSchematic(splitDirectional(kept).baritone));
      } else if (file) {
        schematicFile = path.resolve(file);
      } else {
        return factory.createErrorResponse('Give either spec or file');
      }
      // Baritone pillars up and bridges with its building blocks to reach things and leaves them standing: remember the
      // surroundings so new ones can be taken down afterwards
      const around = layout ? { x: origin.x - SCAFFOLD_MARGIN, y: origin.y - 2, z: origin.z - SCAFFOLD_MARGIN,
        width: layout.width + 2 * SCAFFOLD_MARGIN, height: layout.height + 8, length: layout.length + 2 * SCAFFOLD_MARGIN } : undefined;
      const aroundBefore = around ? await readRegion(around).catch(() => undefined) : undefined;
      const building = call<ProcessResult & { used: Record<string, number> }>('build', { file: schematicFile, ...origin, timeoutMs, ...(keepProtection || narrow ? { keepProtection: true } : {}), ...(narrow?.length ? { allow: narrow } : {}) }, timeoutMs + 15_000);
      // Baritone can stand still for minutes when nothing left is placeable from where it can stand (a log over a
      // doorway, a ridge with no stairs under it yet): when the box hasn't changed for STALL_MS, stop it and finish by hand
      let stalled = false;
      if (layout) {
        const box = layout;
        let done = false;
        void building.finally(() => { done = true; }).catch(() => undefined);
        let last = JSON.stringify(await region(origin, box).catch(() => []));
        let lastChange = Date.now();
        while (!done) {
          await Promise.race([building.catch(() => undefined), new Promise(res => setTimeout(res, STALL_POLL_MS))]);
          if (done) break;
          const now = JSON.stringify(await region(origin, box).catch(() => []));
          if (now !== last) { last = now; lastChange = Date.now(); continue; }
          if (Date.now() - lastChange >= STALL_MS) { stalled = true; await call('cancel').catch(() => undefined); break; }
        }
      }
      const r = await building;
      // tools that went missing broke from wear (digging, fighting): say so instead of listing them as material
      const worn = Object.entries(r.used).filter(([n]) => WEARABLE.test(n));
      const placedItems = Object.entries(r.used).filter(([n]) => !WEARABLE.test(n)).map(([n, c]) => `${n} x${c}`).join(', ');
      const used = [placedItems, worn.length ? `wore out: ${worn.map(([n, c]) => c > 1 ? `${n} x${c}` : n).join(', ')}` : '']
        .filter(Boolean).join('; ');
      if (r.reason === 'paused') {
        // paused "for" blocks the bot carries: Baritone's mistake, not a shortage; the hand pass places them
        const wanted = pausedFor(r.baritone);
        const { counts } = await inventoryCounts();
        if (layout && wanted.length && wanted.every(w => (counts.get(itemOf(w.id)) ?? 0) >= w.count)) {
          await call('cancel').catch(() => undefined);
          stalled = true;
        }
      }
      if (r.reason === 'paused' && !stalled) {
        return factory.createErrorResponse(`Build paused after ${r.seconds}s (probably out of a block it needs).${baritoneSaid(r.baritone)}`);
      }
      let placedByHand = 0;
      const handFailures: string[] = [];
      if (layout && (r.reason === 'done' || stalled)) {
        // what Baritone skipped (directional blocks) or couldn't get to, placed by hand; passes repeat while they make
        // progress, since a block may only have something to rest against once its neighbour is in
        const failures = new Map<string, string>();
        for (let pass = 0; pass < 4; pass++) {
          const todo = missingCells(layout, await region(origin, layout));
          if (!todo.length) break;
          let progress = 0;
          for (const cell of todo) {
            if (secondHalf(cell.state)) continue; // comes with the lower half / foot
            const at = { x: origin.x + cell.x, y: origin.y + cell.y, z: origin.z + cell.z };
            // wall torches and ladders hang on the block behind them (the side opposite their facing)
            const attach = cell.facing && WALL_MOUNTED.test(cell.id) ? OPPOSITE[cell.facing] : undefined;
            const why = await placeFacing(at, cell.id, cell.facing ? placerFacing(cell.id, cell.facing) : undefined, attach, cell.axis);
            if (why) failures.set(fmt(at), `${cell.id} at ${fmt(at)}: ${why}`);
            else { failures.delete(fmt(at)); progress++; placedByHand++; }
          }
          if (!progress) break;
        }
        handFailures.push(...failures.values());
      }
      let scaffoldRemoved = 0;
      if (layout && around && aroundBefore) scaffoldRemoved = await removeScaffold(around, aroundBefore, origin, layout);
      if (layout) {
        // Baritone can call a build done with most of it missing (it did: 19 of 117 blocks), so look at the world
        const finalWorld = await region(origin, layout);
        const check = checkBuild(layout, finalWorld);
        // what stands now is the bot's: mine-blocks leaves it alone
        protectStanding(await dimension(), origin, layout, finalWorld);
        if (check.placed < check.total) {
          const inv = await inventoryCounts();
          const missing = Object.entries(check.missing).map(([n, c]) => `${n} x${c} (have ${inv.counts.get(n) ?? 0})`).join(', ');
          const why = r.reason === 'timeout' ? `stopped after ${r.seconds}s (time limit)` : stalled ? `stalled after ${r.seconds}s`
            : r.reason === 'cancelled' ? `was stopped after ${r.seconds}s` : `ended after ${r.seconds}s`;
          const hand = handFailures.length ? ` Couldn't place: ${handFailures.slice(0, 5).join('; ')}.` : '';
          return factory.createErrorResponse(`Build of ${name} ${why} with ${check.placed}/${check.total} blocks in place. ` +
            `Missing: ${missing}. Used: ${used || 'nothing'}.${hand}${baritoneSaid(r.baritone)} Run build-structure again to continue.`);
        }
        const hand = (placedByHand ? ` (${placedByHand} placed by hand${stalled ? ' after Baritone stalled' : ''})` : '') +
          (scaffoldRemoved ? `; took down ${scaffoldRemoved} scaffold block(s) it left` : '');
        return factory.createResponse(`Built ${name} at ${fmt(origin)} in ${r.seconds}s: all ${check.total} blocks in place${hand}. Used: ${used || 'nothing'}.${baritoneSaid(r.baritone)}`);
      }
      const head = r.reason === 'timeout' ? `Build stopped after ${r.seconds}s (time limit)` : `Built ${name} at ${fmt(origin)} in ${r.seconds}s`;
      return factory.createResponse(`${head}. Used: ${used || 'nothing'}.${baritoneSaid(r.baritone)}`);
    }
  );

  register(
    'use-item-on-block',
    "Right-click a block, holding `item` if given (else what's in hand): till grass or dirt with a hoe, open or close a door or trapdoor, flip a lever, press a button, use bone meal, fill or empty a bucket. Walks closer if needed. Reports the block before and after.",
    {
      x: z.coerce.number().describe('X of the block'),
      y: z.coerce.number().describe('Y of the block'),
      z: z.coerce.number().describe('Z of the block'),
      item: z.string().optional().describe("Item to hold, e.g. 'wooden_hoe' (default: whatever is in hand)"),
      face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Which face to click (default: 'up')"),
      toggle: z.boolean().optional().describe('Only open or close it (a door, gate, trapdoor, lever): never pour, fill or use what is held')
    },
    async ({ x, y, z: zz, item, face = 'up', toggle }: { x: number; y: number; z: number; item?: string; face?: string; toggle?: boolean }) => {
      const at = floorPos({ x, y, z: zz });
      if (item) {
        try { await call('item.select', { name: item }); } catch { return factory.createErrorResponse(`No ${item} in inventory`); }
      }
      // bucket: the server's word on a bucket's use (filled, poured at, nothing happened), never the client's guess;
      // answered: the server acked the use within 2 s (else `after` may be only what the client predicted)
      type Used = { used: boolean; reason?: string; before?: string; after?: string; changed?: boolean; properties?: Record<string, string>; held?: string; result?: string; bucket?: string; answered?: boolean };
      // toggle: a water bucket in hand once poured outside the door it was shutting (the game client checks doors too)
      const how = toggle ? { face, toggle: true } : { face };
      let r = await call<Used>('useOn', { ...at, ...how });
      if (!r.used && r.reason === 'too far') {
        // a full bucket (or flint and steel) is not walked with in hand: Baritone's walk opens doors with right clicks
        // (brain/fluidpick.ts holdHarmless); it is taken back in hand for the use
        const hazard = isHazard(item ?? r.held) ? item ?? r.held : undefined;
        if (hazard) await holdHarmless({ call });
        await goNear(at, 3);
        if (item ?? hazard) await call('item.select', { name: item ?? hazard });
        r = await call<Used>('useOn', { ...at, ...how });
      }
      if (!r.used) return factory.createErrorResponse(`Could not use ${item ?? 'the held item'} on ${fmt(at)}: ${r.reason}`);
      // a hoe only tills with air above: grass or leaf litter on top makes it do nothing, so clear that and try again
      if ((r.changed === false || (r.changed === undefined && r.before === r.after)) && /_hoe$/.test(r.held ?? item ?? '') && /^(grass_block|dirt|coarse_dirt|rooted_dirt|dirt_path)$/.test(r.before ?? '')) {
        const above = { ...at, y: at.y + 1 };
        const top = await call<{ name?: string }>('world.block', { ...above });
        if (top.name && top.name !== 'air' && /grass|fern|flower|leaf_litter|petals|bush|snow|dandelion|poppy|tulip|daisy|bluet|allium|cornflower|lily_of_the_valley|wildflowers/.test(top.name)) {
          await call('dig', { ...above, timeoutMs: 15_000 }, 30_000).catch(() => undefined);
          await call('item.select', { name: r.held ?? item });
          r = await call<Used>('useOn', { ...at, face });
        }
      }
      // a bucket: what the server did with it. Live the client showed buckets filled that the server never filled, and
      // the reply said only "nothing changed" about the block clicked
      if (r.bucket) return factory.createResponse(`Used ${r.held ?? item ?? 'the held item'} on ${r.before} at ${fmt(at)}: ${r.bucket}`);
      const props = Object.entries(r.properties ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
      const after = `${r.after}${props ? `[${props}]` : ''}`;
      const unchanged = r.changed === undefined ? r.before === r.after : !r.changed;
      // the game's answer only helps when nothing happened (Pass / Fail), not the long Success[...] record
      const answer = r.result && !/^Success/.test(r.result) ? `: ${r.result}` : '';
      // with no ack from the server the block read may be only the client's own prediction
      const word = r.answered === false ? ' (no word from the server within 2 s)' : '';
      return factory.createResponse(unchanged
        ? `Used ${r.held ?? item ?? 'the held item'} on ${r.before} at ${fmt(at)}; nothing changed, it is ${after}${answer}${word}`
        : r.before === r.after
          ? `Used ${r.held ?? item ?? 'the held item'} on ${r.before} at ${fmt(at)}: it is now ${after}${word}`
        : `Used ${item ?? 'the held item'} on ${r.before} at ${fmt(at)}: it became ${after}${word}`);
    }
  );

  register(
    'level-area',
    "Level the land in a box to a ground height: cuts hills, trees and leftovers above it, fills dips below it (cobblestone, dirt on top), and leaves whole columns alone where there is water, a crop or farmland, furniture, or something the bot built. dryRun shows what it would do. Needs the fill blocks in the inventory.",
    {
      x1: z.coerce.number().describe('One corner X'), z1: z.coerce.number().describe('One corner Z'),
      x2: z.coerce.number().describe('Other corner X'), z2: z.coerce.number().describe('Other corner Z'),
      level: z.coerce.number().int().describe('Height of the ground top after leveling (the block you stand on)'),
      above: z.coerce.number().int().min(1).max(40).optional().describe('How far above the level to cut (default: 20, enough for trees)'),
      below: z.coerce.number().int().min(1).max(20).optional().describe('How deep below the level to look for ground (default: 8)'),
      dryRun: z.boolean().optional().describe('Only report the plan'),
      cutLeaves: z.boolean().optional().describe('Also cut natural leaves (by default they are left to decay once their trunks are gone)'),
      fillWater: z.boolean().optional().describe('Fill ponds and other open water too, down to the ground under them (by default water columns are left alone); give `below` deep enough to reach the bottom'),
      timeoutMs: z.number().int().min(10000).optional().describe('Give up after this long (default: 1200000)')
    },
    async ({ x1, z1, x2, z2, level, above = 20, below = 8, dryRun = false, cutLeaves = false, fillWater = false, timeoutMs = 1_200_000 }: {
      x1: number; z1: number; x2: number; z2: number; level: number; above?: number; below?: number; dryRun?: boolean; cutLeaves?: boolean; fillWater?: boolean; timeoutMs?: number
    }) => {
      const box = { x: Math.min(x1, x2), y: level - below, z: Math.min(z1, z2), width: Math.abs(x2 - x1) + 1, height: below + above + 1, length: Math.abs(z2 - z1) + 1 };
      if (box.width * box.length > 128 * 128) return factory.createErrorResponse('Area too large (at most 128 x 128)');
      const perLayer = box.width * box.length;
      const step = Math.max(1, Math.floor(65_536 / perLayer));
      const blocks: (string | null)[] = [];
      for (let y = 0; y < box.height; y += step) {
        const part = await call<{ blocks: (string | null)[] }>('world.region', { ...box, y: box.y + y, height: Math.min(step, box.height - y) }, 60_000);
        blocks.push(...part.blocks);
      }
      if (blocks.some(b => b === null)) return factory.createErrorResponse('Part of the area is not loaded; move closer to it first');
      const dim = await dimension();
      const plan = planLevel(box, blocks, level, p => protection.has(dim, p), cutLeaves, fillWater);
      const summary = `Level (${box.x}, ${box.z})..(${box.x + box.width - 1}, ${box.z + box.length - 1}) to ground y ${level}: ` +
        `cut ${plan.cut} block(s)${plan.cut ? ` (${Object.entries(plan.cutKinds).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}, fill ${plan.dirt} dirt + ${plan.cobblestone} cobblestone; ` +
        (plan.leaves ? `${plan.leaves} natural leaves left to decay once their trunks are gone; ` : '') +
        `left alone: ${plan.kept.water} water column(s), ${plan.kept.built} column(s) with builds, crops or furniture.`;
      if (!plan.spec) return factory.createResponse(`${summary} Already level.`);
      if (dryRun) return factory.createResponse(summary);
      // Baritone's builder chokes on one big schematic (a 34 x 26 area cut ~170 blocks in 7 minutes, then stalled),
      // while small ones go fast (22 blocks in a minute): work in tiles, nearest first, in a serpentine sweep
      const TILE = 8;
      const started = Date.now();
      const textOf = (r: ReturnType<ToolFactory['createResponse']>) => r.content.map(c => (c as { text?: string }).text ?? '').join(' ');
      const readBox = async (b: typeof box) => {
        const out: (string | null)[] = [];
        const per = Math.max(1, Math.floor(65_536 / (b.width * b.length)));
        for (let y = 0; y < b.height; y += per) {
          const part = await call<{ blocks: (string | null)[] }>('world.region', { ...b, y: b.y + y, height: Math.min(per, b.height - y) }, 60_000);
          out.push(...part.blocks);
        }
        return out;
      };
      const tiles: (typeof box)[] = [];
      for (let tz = 0; tz < box.length; tz += TILE) {
        const row: (typeof box)[] = [];
        for (let tx = 0; tx < box.width; tx += TILE) {
          row.push({ ...box, x: box.x + tx, z: box.z + tz, width: Math.min(TILE, box.width - tx), length: Math.min(TILE, box.length - tz) });
        }
        tiles.push(...((tz / TILE) % 2 ? row.reverse() : row));
      }
      // Baritone may break things it walks past while building (protection has to be off for the cut: it works by block
      // type, and dirt is one): it took the cabin's outside pressure plate and the block under it. Remember every
      // protected block in the area and the block it stands on, and put back what goes missing.
      const watched = new Map<string, { at: Pos; state: string }>();
      blocks.forEach((b, i) => {
        const at = { x: box.x + i % box.width, y: box.y + Math.floor(i / (box.width * box.length)), z: box.z + Math.floor(i / box.width) % box.length };
        if (!b || /^(minecraft:)?(air|cave_air)$/.test(b) || !protection.has(dim, at)) return;
        watched.set(fmt(at), { at, state: b });
        const j = i - box.width * box.length;
        const under = blocks[j];
        if (j >= 0 && under && !/^(minecraft:)?(air|cave_air|water)/.test(under)) {
          const below = { ...at, y: at.y - 1 };
          if (!watched.has(fmt(below))) watched.set(fmt(below), { at: below, state: under });
        }
      });
      const restored: string[] = [];
      const lost: string[] = [];
      const repair = async () => {
        // one read of the area, compared locally (a lookup per watched block took most of a tile's time)
        const nowAll = await readBox(box);
        const idOf = (st: string | null | undefined) => (st ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
        const wanted = [...watched.values()].sort((a, b) => a.at.y - b.at.y); // supports first
        const reTorched = new Set<string>();
        for (const w of wanted) {
          // ground above the level was meant to go: don't rebuild it; a torch that stood on it goes on the new ground
          if (!/torch/.test(w.state) && w.at.y > level) continue;
          if (/torch/.test(w.state) && w.at.y > level + 1) {
            const k0 = `${w.at.x},${w.at.z}`;
            if (reTorched.has(k0)) continue;
            reTorched.add(k0);
            const spot = { x: w.at.x, y: level + 1, z: w.at.z };
            const k1 = (spot.x - box.x) + (spot.z - box.z) * box.width + (spot.y - box.y) * box.width * box.length;
            if (!/^(minecraft:)?(air|short_grass|tall_grass|leaf_litter)/.test(nowAll[k1] ?? '')) continue;
            const below = nowAll[k1 - box.width * box.length] ?? '';
            if (/^(minecraft:)?(air|water)/.test(below)) continue;
            const why = await placeFacing(spot, 'torch');
            if (why) lost.push(`torch at ${fmt(spot)} (${why})`); else restored.push(`torch at ${fmt(spot)} (moved down to the new ground)`);
            continue;
          }
          const k = (w.at.x - box.x) + (w.at.z - box.z) * box.width + (w.at.y - box.y) * box.width * box.length;
          const nowName = idOf(nowAll[k]);
          const id = idOf(w.state);
          if (nowName === id) continue;
          if (nowName && !/^(air|cave_air|short_grass|tall_grass|leaf_litter|water)$/.test(nowName)) continue; // something else stands there
          const item = id === 'wall_torch' ? 'torch' : id === 'grass_block' ? 'dirt' : id;
          if (/_door$|_bed$/.test(id)) { lost.push(`${id} at ${fmt(w.at)}`); continue; }
          const facing = /facing=(\w+)/.exec(w.state)?.[1];
          const why = await placeFacing(w.at, item, facing ? placerFacing(id, facing) : undefined);
          if (why) lost.push(`${id} at ${fmt(w.at)} (${why})`); else restored.push(`${item} at ${fmt(w.at)}`);
        }
      };
      const me = (await status()).position!;
      // start from the tile nearest the bot, then follow the sweep from there round to the beginning
      const first = tiles.reduce((best, t, i) => (Math.hypot(t.x + t.width / 2 - me.x, t.z + t.length / 2 - me.z) <
        Math.hypot(tiles[best].x + tiles[best].width / 2 - me.x, tiles[best].z + tiles[best].length / 2 - me.z) ? i : best), 0);
      const order = [...tiles.slice(first), ...tiles.slice(0, first)];
      let tilesDone = 0, shortTiles = 0;
      for (const t of order) {
        if (Date.now() - started > timeoutMs) break;
        let p = planLevel(t, await readBox(t), level, q => protection.has(dim, q), cutLeaves, fillWater);
        if (!p.spec) { tilesDone++; continue; }
        const left = () => Math.max(30_000, timeoutMs - (Date.now() - started));
        if (p.cut) {
          const cutOnly = { ...p.spec, layers: p.spec.layers.map(rows => rows.map(r => r.replace(/[CD]/g, ' '))) };
          // a narrow lift: only the kinds it cuts here may break, so the walk to the tile goes round what the bot built
          // (lifted whole, it went out of the storage house through the north wall, the door being on the south side)
          await buildStructure({ ...p.origin, spec: cutOnly, name: 'level_tile_cut', timeoutMs: Math.min(180_000, left()), keepProtection: true, allow: p.cutNames });
          p = planLevel(t, await readBox(t), level, q => protection.has(dim, q), cutLeaves, fillWater);
        }
        if (p.spec && (p.dirt || p.cobblestone)) {
          const have = (await inventoryCounts()).counts;
          if ((have.get('dirt') ?? 0) >= p.dirt && (have.get('cobblestone') ?? 0) >= p.cobblestone) {
            const fillOnly = { ...p.spec, layers: p.spec.layers.map(rows => rows.map(r => r.replace(/\./g, ' '))) };
            // filling only places: nothing need break at all
            const r = await buildStructure({ ...p.origin, spec: fillOnly, name: 'level_tile_fill', timeoutMs: Math.min(180_000, left()), keepProtection: true });
            if (r.isError && !/blocks in place/.test(textOf(r))) shortTiles++;
          } else {
            shortTiles++;
          }
        }
        tilesDone++;
        await repair();
      }
      const after = planLevel(box, await readBox(box), level, p => protection.has(dim, p), cutLeaves, fillWater);
      const have = (await inventoryCounts()).counts;
      const secs = Math.round((Date.now() - started) / 1000);
      const rest = after.spec
        ? `Still to do: cut ${after.cut}, fill ${after.dirt} dirt (have ${have.get('dirt') ?? 0}) + ${after.cobblestone} cobblestone (have ${have.get('cobblestone') ?? 0}).` +
          (shortTiles ? ` ${shortTiles} tile(s) were short of fill blocks.` : '') + ' Run level-area again to continue.'
        : 'Now level.';
      const fixes = (restored.length ? ` Put back what the work knocked out: ${restored.slice(0, 8).join(', ')}${restored.length > 8 ? ', ...' : ''}.` : '') +
        (lost.length ? ` Could not put back: ${lost.slice(0, 8).join(', ')}.` : '');
      const text = `${summary}\nWorked ${tilesDone}/${tiles.length} tile(s) of ${TILE}x${TILE} in ${secs}s. ${rest}${fixes}`;
      return after.spec ? factory.createErrorResponse(text) : factory.createResponse(text);
    }
  );

  register(
    'survey-area',
    'Look over an area around a point (default: the bot) without moving: surface heights, trees, water, clusters of blocks that look placed rather than natural (scaffolding, emergency walls, leftovers; the bot\'s own builds and furniture excluded) and open pits. Use it before clearing land.',
    {
      x: z.coerce.number().optional().describe('X of the centre (default: the bot)'),
      z: z.coerce.number().optional().describe('Z of the centre'),
      radius: z.coerce.number().int().min(4).max(64).optional().describe('How far around (default: 32)'),
      yMin: z.coerce.number().int().optional().describe('Lowest Y to look at (default: 6 below the bot)'),
      yMax: z.coerce.number().int().optional().describe('Highest Y (default: 20 above the bot)'),
      map: z.boolean().optional().describe('Also draw a map, one row per z north to south: T tree, ~ water, B builds, x leftovers, 0 ground at the median height, 1-9 higher, a-i lower')
    },
    async ({ x, z: zz, radius = 32, yMin, yMax, map = false }: { x?: number; z?: number; radius?: number; yMin?: number; yMax?: number; map?: boolean }) => {
      const s = await status();
      const me = s.block!;
      const cx = x ?? me.x, cz = zz ?? me.z;
      const y0 = yMin ?? me.y - 6, y1 = yMax ?? me.y + 20;
      const box = { x: Math.floor(cx) - radius, y: y0, z: Math.floor(cz) - radius, width: 2 * radius + 1, height: y1 - y0 + 1, length: 2 * radius + 1 };
      // read in slabs of whole layers (a region call holds at most 65536 blocks)
      const perLayer = box.width * box.length;
      const layers = Math.max(1, Math.floor(65_536 / perLayer));
      const blocks: (string | null)[] = [];
      for (let y = 0; y < box.height; y += layers) {
        const hgt = Math.min(layers, box.height - y);
        const part = await call<{ blocks: (string | null)[] }>('world.region', { ...box, y: box.y + y, height: hgt }, 60_000);
        blocks.push(...part.blocks);
      }
      const dim = s.dimension ?? 'overworld';
      const r = survey(box, blocks, p => protection.has(dim, p));
      const fmtC = (c: Cluster) => `${c.blocks} block(s) ${fmt(c.min)}..${fmt(c.max)}: ${Object.entries(c.kinds).map(([n, k]) => `${n} x${k}`).join(', ')}`;
      const lines = [
        `Area (${box.x}, ${box.z})..(${box.x + box.width - 1}, ${box.z + box.length - 1}), y ${y0}..${y1}: ground ${r.surface.min}..${r.surface.max} (median ${r.surface.median}); ${r.trees} tree column(s), ${r.water} water column(s).`,
        r.placed.length ? `Placed-looking blocks (${r.placed.length} cluster(s)):\n${r.placed.slice(0, 25).map(c => `- ${fmtC(c)}`).join('\n')}${r.placed.length > 25 ? `\n- ... ${r.placed.length - 25} more` : ''}` : 'No placed-looking blocks.',
        r.pits.length ? `Open pits (${r.pits.length} column(s)): ${r.pits.slice(0, 20).map(p => `(${p.x}, ${p.surface}, ${p.z}) ${p.around - p.surface} deep`).join('; ')}${r.pits.length > 20 ? ' ...' : ''}` : 'No open pits.'
      ];
      // a far area reads as air where its chunks aren't loaded: an all-flat map that looked like a bug (11-17)
      if (r.unloaded) lines.unshift(`Not loaded: ${Math.round(100 * r.unloaded / blocks.length)}% of the area (the bot is ${Math.round(Math.hypot(me.x - cx, me.z - cz))} blocks from its centre); those parts read as empty air below.`);
      if (map) lines.push(`Map, x ${box.x}..${box.x + box.width - 1} left to right, z ${box.z} at the top:\n${r.map.join('\n')}`);
      return factory.createResponse(lines.join('\n'));
    }
  );

  register(
    'set-home',
    "Remember a place as home (default: where the bot stands), per world and across restarts, so go-home can walk back from anywhere. On a shared server home is where the bot settles and builds its homestead: it refuses a spot within 48 blocks of someone else's build or 24 of the world spawn (non-ops can't build in spawn protection), unless `force`.",
    {
      name: z.string().regex(/^[\w-]+$/).optional().describe("Name of the place (default: 'home')"),
      x: z.coerce.number().optional().describe('X (default: the bot)'),
      y: z.coerce.number().optional().describe('Y'),
      z: z.coerce.number().optional().describe('Z'),
      force: z.boolean().optional().describe("Set it even near someone else's build or the spawn (only when the people there agree)")
    },
    async ({ name = 'home', x, y, z: zz, force = false }: { name?: string; x?: number; y?: number; z?: number; force?: boolean }) => {
      const s = await status();
      const world = worldIdFromSeed(s.hashedSeed ?? undefined);
      if (!world) return factory.createErrorResponse('Cannot tell which world this is (no seed from the server)');
      const at = x !== undefined && y !== undefined && zz !== undefined ? floorPos({ x, y, z: zz }) : s.block!;
      if (name === 'home' && !force) {
        // others' builds the mod has seen round the bot, measured from the spot itself
        const zones = (await call<{ zones: Zone[] }>('foreign.zones').catch(() => ({ zones: [] as Zone[] }))).zones;
        const problems = homeProblems(at, zones, s.spawn);
        if (problems.length) return factory.createErrorResponse(`Not setting home at ${fmt(at)}: ${problems.join('; ')}. Pick a spot further out (force: true sets it anyway).`);
      }
      const homes = readHomes();
      homes[world] = { ...(homes[world] ?? {}), [name]: { ...at, dimension: s.dimension ?? 'overworld' } };
      writeHomes(homes);
      return factory.createResponse(`Home '${name}' set at ${fmt(at)} (${s.dimension ?? 'overworld'})`);
    }
  );

  register(
    'nearby-builds',
    "Other players' builds the bot has seen round itself (on a shared server: a friend's base; anywhere: villages), as boxes, and what's built under ground (mineshafts, dungeons, cellars). It breaks nothing in a build on the surface, takes nothing from their chests and leaves their animals alone; under ground it leaves the built blocks be and mines the rock round them. set-home keeps 48 blocks from builds on the surface and 16 from those under ground. It looks within 48 blocks of where it is as it moves, so walk round an area before deciding it's empty.",
    {},
    async () => {
      const s = await status();
      const me = s.block ?? floorPos(s.position ?? { x: 0, y: 0, z: 0 });
      const zones = (await call<{ zones: Zone[] }>('foreign.zones').catch(() => ({ zones: [] as Zone[] }))).zones;
      const spawn = s.spawn ? ` The world spawn is at ${fmt(s.spawn)}, ${Math.round(Math.hypot(s.spawn.x - me.x, s.spawn.z - me.z))} blocks away.` : '';
      if (!zones.length) return factory.createResponse(`No one else's builds seen near ${fmt(me)} (it looks within 48 blocks as it moves).${spawn}`);
      const height = (zn: Zone) => (zn.y2 < me.y - 4 ? `, ${me.y - zn.y2} below` : zn.y1 > me.y + 4 ? `, ${zn.y1 - me.y} above` : '');
      const line = (zn: Zone, i: number) => `${i + 1}. x ${zn.x1}..${zn.x2}, z ${zn.z1}..${zn.z2} (y ${zn.y1}..${zn.y2}): ${zn.markers ?? '?'} placed block(s)` +
        `${zn.kinds?.length ? `, mostly ${zn.kinds.slice(0, 4).join(', ')}` : zn.sample ? ` such as ${zn.sample}` : ''}; ${Math.round(zoneDistance(me, zn))} blocks away${height(zn)}`;
      const byDistance = (a: Zone, b: Zone) => zoneDistance(me, a) - zoneDistance(me, b);
      const surface = zones.filter(zn => zn.surface ?? true).sort(byDistance).slice(0, 10);
      const under = zones.filter(zn => !(zn.surface ?? true)).sort(byDistance).slice(0, 5);
      const lines: string[] = [];
      lines.push(surface.length ? `Builds on the surface (${zones.filter(zn => zn.surface ?? true).length}), nearest first:` : 'No builds on the surface seen.', ...surface.map(line));
      if (under.length) lines.push(`Built under ground (${zones.length - zones.filter(zn => zn.surface ?? true).length}; mineshafts and dungeons mostly: it leaves their blocks and mines round them):`, ...under.map(line));
      if (spawn) lines.push(spawn.trim());
      return factory.createResponse(lines.join('\n'));
    }
  );

  register(
    'leave-server',
    "Log the bot off the server (when someone there asks it to go). It stays off until rejoin-server. With rejoin: true it only drops the connection and comes back by itself in about 30 s (a fresh connection for a stuck client).",
    {
      rejoin: z.boolean().optional().describe('Come back by itself in about 30 s (default: stay off)')
    },
    async ({ rejoin = false }: { rejoin?: boolean }) => {
      const r = await call<{ left: boolean; reason?: string }>('server.leave', { rejoin });
      if (!r.left) return factory.createErrorResponse(`Not leaving: ${r.reason ?? 'unknown'}.`);
      return factory.createResponse(rejoin ? 'Dropped the connection: it rejoins by itself in about 30 s.' : 'Left the server: it stays off until rejoin-server.');
    }
  );

  register(
    'rejoin-server',
    "Join the server again after the bot was disconnected. It rejoins by itself after a server restart or a dropped connection; after a kick, a ban or a whitelist refusal it stays off until this is used (only once the people there agree).",
    {},
    async () => {
      const r = await call<{ rejoining: boolean; server?: string; reason?: string }>('server.rejoin');
      return r.rejoining
        ? factory.createResponse(`Rejoining ${r.server}: it takes a few seconds; get-status shows when it's back.`)
        : factory.createErrorResponse(`Not rejoining: ${r.reason ?? 'unknown'}.`);
    }
  );

  register(
    'go-home',
    "Walk back to a place saved with set-home (default 'home'), however far, in legs over unexplored land. Reports how far it got.",
    {
      name: z.string().optional().describe("Which saved place (default: 'home')"),
      timeoutMs: z.number().int().min(10000).optional().describe('Give up after this long (default: 900000)')
    },
    async ({ name = 'home', timeoutMs = 900_000 }: { name?: string; timeoutMs?: number }) => {
      const s = await status();
      const world = worldIdFromSeed(s.hashedSeed ?? undefined);
      const home = world ? readHomes()[world]?.[name] : undefined;
      if (!home) return factory.createErrorResponse(`No home '${name}' saved in this world. Use set-home first.`);
      if (home.dimension !== (s.dimension ?? 'overworld')) return factory.createErrorResponse(`Home '${name}' is in ${home.dimension}; the bot is in ${s.dimension}`);
      const started = Date.now();
      const left = () => timeoutMs - (Date.now() - started);
      // far away: legs of up to 200 blocks toward it at any height (Baritone plans over loaded chunks), then the exact spot
      for (let leg = 0; leg < 50 && left() > 5000; leg++) {
        const me = (await status()).position!;
        const d = Math.hypot(home.x - me.x, home.z - me.z);
        if (d <= 48) break;
        const k = Math.min(1, 200 / d);
        const stop = { x: Math.round(me.x + (home.x - me.x) * k), y: home.y, z: Math.round(me.z + (home.z - me.z) * k) };
        const r = await call<ProcessResult & { arrived: boolean }>('goto', { ...stop, xz: true, range: 8, timeoutMs: Math.min(left(), 240_000) }, Math.min(left(), 240_000) + 15_000);
        if (!r.arrived && Math.hypot(home.x - r.at!.x, home.z - r.at!.z) >= d - 4) break; // no progress on this leg
      }
      if (left() > 5000) {
        const before = (await status()).block!;
        const r = await goNear(home, 2, Math.min(left(), 180_000)).catch(() => undefined);
        if (r && !r.arrived && r.at && fmt(floorPos(r.at)) === fmt(before) && await unstickFromWater() && left() > 5000) {
          await goNear(home, 2, Math.min(left(), 180_000)).catch(() => undefined);
        }
      }
      const at = (await status()).block!;
      const d = Math.hypot(home.x - at.x, home.y - at.y, home.z - at.z);
      const secs = Math.round((Date.now() - started) / 1000);
      return d <= 3
        ? factory.createResponse(`Home: at ${fmt(at)}, by '${name}' ${fmt(home)}, after ${secs}s`)
        : factory.createErrorResponse(`Stopped ${Math.round(d)} blocks from home '${name}' ${fmt(home)} at ${fmt(at)} after ${secs}s. Run go-home again to keep going.`);
    }
  );

  // the operator's way through a portal: the brain's own trips go by portal.enter (nether.ts netherHome) and wait for
  // the nether-trips switch, and nether_portal is on Baritone's avoid list, so move-to-position stops short of one and
  // move-in-direction walks through its one block before the game's 4 s are up. A bot stranded in the Nether (the leave
  // nether goal's 'stranded' line) comes home by this
  register(
    'use-portal',
    "Go through a lit nether portal: walk carefully (nothing placed or broken) into it, stand in it until the game takes the bot across, then step out of the far portal onto safe ground. Give a block of the portal, or nothing for the nearest lit one in sight (the bot's own first). From the Nether it steps out on the side toward home. For a bot stranded in the Nether; the autopilot's own trips wait for its nether-trips switch.",
    {
      x: z.coerce.number().optional().describe('X of a block of the portal (its bottom row is best; default: the nearest lit portal)'),
      y: z.coerce.number().optional().describe('Y of that block'),
      z: z.coerce.number().optional().describe('Z of that block'),
      toward: z.object({ x: z.coerce.number(), z: z.coerce.number() }).optional().describe('Step out of the far portal on the side nearer this point (default: home, from the Nether)'),
      timeoutMs: z.number().int().min(10000).optional().describe('Give up after this long (default: 60000)')
    },
    async ({ x, y, z: zz, toward, timeoutMs = 60_000 }: { x?: number; y?: number; z?: number; toward?: { x: number; z: number }; timeoutMs?: number }) => {
      const s = await status();
      const dim = s.dimension ?? 'overworld';
      let at = x !== undefined && y !== undefined && zz !== undefined ? floorPos({ x, y, z: zz }) : undefined;
      if (!at) {
        type Listed = Pos & { own?: boolean; distance?: number };
        const listed = (await call<{ portals?: Listed[] }>('portal.list', { range: 128 }).catch(() => ({ portals: [] as Listed[] }))).portals ?? [];
        const pick = [...listed].sort((a, b) => Number(!!b.own) - Number(!!a.own) || (a.distance ?? 0) - (b.distance ?? 0))[0];
        if (!pick) return factory.createErrorResponse(`No lit portal in sight (within 128) in ${dim}: give one's position.`);
        at = { x: pick.x, y: pick.y, z: pick.z };
      }
      let side = toward;
      if (!side && dim === 'the_nether') {
        const world = worldIdFromSeed(s.hashedSeed ?? undefined);
        const home = world ? readHomes()[world]?.home : undefined;
        if (home && home.dimension === 'overworld') side = { x: home.x, z: home.z };
      }
      type Entered = { ok?: boolean; reason?: string; from?: string; dimension?: string; block?: Pos; portal?: Pos | null; stepped?: boolean; steppedTo?: Pos; seconds?: number; note?: string };
      const r = await call<Entered>('portal.enter', { ...at, timeoutMs, ...(side ? { toward: { x: side.x, z: side.z } } : {}) }, timeoutMs + 30_000)
        .catch((e: Error): Entered => ({ ok: false, reason: e.message }));
      if (!r.ok) return factory.createErrorResponse(`Not through the portal at ${fmt(at)} in ${dim}: ${r.reason ?? 'no answer'}.`);
      const where = r.block ? ` at ${fmt(r.block)}` : '';
      const came = r.portal ? `, by the portal at ${fmt(r.portal)}` : '';
      const out = r.stepped ? `stepped out${r.steppedTo ? ` to ${fmt(r.steppedTo)}` : ''}` : `still in the arrival portal (${r.note ?? 'no safe side to step out'})`;
      return factory.createResponse(`Through the portal at ${fmt(at)}: ${r.from ?? dim} -> ${r.dimension ?? 'unknown'}${where}${came}; ${out}${r.seconds !== undefined ? ` after ${r.seconds}s` : ''}.`);
    }
  );

  register(
    'explore',
    "Travel in a direction looking for something: an entity type ('sheep', 'cow', 'villager') or a block ('sweet_berry_bush', 'water'). Walks in legs of `step` blocks and looks around after each, up to maxDistance. Says where it found it and how far home is. Set home first so go-home can bring the bot back.",
    {
      target: z.string().describe("Entity type or block to look for, e.g. 'sheep'"),
      direction: z.enum(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']).describe('Which way to go (south is +z, east is +x)'),
      maxDistance: z.coerce.number().int().min(16).max(4000).optional().describe('How far to go at most (default: 1000)'),
      step: z.coerce.number().int().min(16).max(256).optional().describe('Blocks per leg (default: 96)'),
      timeoutMs: z.number().int().min(10000).optional().describe('Give up after this long (default: 900000)')
    },
    async ({ target, direction, maxDistance = 1000, step = 96, timeoutMs = 900_000 }: { target: string; direction: string; maxDistance?: number; step?: number; timeoutMs?: number }) => {
      const name = target.replace(/^minecraft:/, '');
      const dirs: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], northeast: [1, -1], northwest: [-1, -1], southeast: [1, 1], southwest: [-1, 1] };
      const [dx, dz] = dirs[direction];
      const norm = Math.hypot(dx, dz);
      const s0 = await status();
      const start = s0.position!;
      const world = worldIdFromSeed(s0.hashedSeed ?? undefined);
      const home = world ? readHomes()[world]?.home : undefined;
      const isEntity = !!entityTypes[name];
      const started = Date.now();
      const look = async (): Promise<Pos | undefined> => {
        if (isEntity) {
          const r = await call<{ entities: EntityInfo[] }>('world.entities', { maxDistance: 96, type: name });
          return r.entities[0]?.position;
        }
        const r = await call<{ positions: Pos[] }>('world.findBlocks', { block: name, maxDistance: 96, count: 1 });
        return r.positions[0];
      };
      let found = await look();
      let travelled = 0;
      while (!found && travelled < maxDistance && Date.now() - started < timeoutMs) {
        travelled = Math.min(maxDistance, travelled + step);
        const stop = { x: Math.round(start.x + (dx / norm) * travelled), y: Math.round(start.y), z: Math.round(start.z + (dz / norm) * travelled) };
        const left = timeoutMs - (Date.now() - started);
        const r = await call<ProcessResult & { arrived: boolean; at: Pos }>('goto', { ...stop, xz: true, range: 8, timeoutMs: Math.min(left, 240_000) }, Math.min(left, 240_000) + 15_000);
        found = await look();
        if (!r.arrived && !found) {
          const here = (await status()).position!;
          const gone = Math.hypot(here.x - start.x, here.z - start.z);
          if (gone < travelled - step) { // stuck (ocean, cliff): stop rather than wander
            return factory.createErrorResponse(`Explored ${Math.round(gone)} blocks ${direction} and could not get further (stopped at ${fmt(floorPos(here))}); no ${name} seen.${home ? ` Home is ${Math.round(Math.hypot(home.x - here.x, home.z - here.z))} blocks away.` : ''}`);
          }
        }
      }
      const here = (await status()).position!;
      const homeNote = home ? ` Home is ${Math.round(Math.hypot(home.x - here.x, home.z - here.z))} blocks away (go-home).` : ' No home set.';
      if (!found) return factory.createResponse(`No ${name} within ${maxDistance} blocks ${direction} (now at ${fmt(floorPos(here))}).${homeNote}`);
      const dist = Math.round(Math.hypot(found.x - start.x, found.z - start.z));
      return factory.createResponse(`Found ${name} at ${fmt(floorPos(found))}, ${dist} blocks ${direction} of where the search began; the bot is at ${fmt(floorPos(here))}.${homeNote}`);
    }
  );

  register(
    'collect-items',
    'Pick up items lying on the ground: walks onto each drop within `radius` of a point (default: where the bot last died, if that was in the last 5 minutes, else around the bot), swimming to ones floating in water. Drops despawn 5 minutes after they fall.',
    {
      x: z.coerce.number().optional().describe('X of the centre (default: last death spot, else the bot)'),
      y: z.coerce.number().optional().describe('Y of the centre'),
      z: z.coerce.number().optional().describe('Z of the centre'),
      radius: z.coerce.number().min(1).max(32).optional().describe('How far around the centre (default: 8)'),
      timeoutMs: z.number().int().min(5000).optional().describe('Give up after this long (default: 90000)')
    },
    async ({ x, y, z: zz, radius = 8, timeoutMs = 90_000 }: { x?: number; y?: number; z?: number; radius?: number; timeoutMs?: number }) => {
      const s = await status();
      // (a death in another dimension than the bot's left its drops there: around the bot, then)
      const recentDeath = lastDeath && Date.now() - lastDeath.time < 5 * 60_000 && (lastDeath.dimension ?? s.dimension ?? 'overworld') === (s.dimension ?? 'overworld') ? lastDeath.at : undefined;
      const centre: Pos = x !== undefined && y !== undefined && zz !== undefined ? { x, y, z: zz } : recentDeath ?? s.position!;
      const why = x !== undefined ? '' : recentDeath ? ' (where the bot died)' : ' (around the bot)';
      const before = (await inventoryCounts()).counts;
      const started = Date.now();
      const tried = new Map<number, number>();
      if (Math.hypot(centre.x - s.position!.x, centre.z - s.position!.z) > radius) await goNear(centre, 2, 120_000).catch(() => undefined);
      while (Date.now() - started < timeoutMs) {
        const { entities } = await call<{ entities: EntityInfo[] }>('world.entities', { maxDistance: 64, type: 'item' });
        const next = entities.filter(e => Math.hypot(e.position.x - centre.x, e.position.y - centre.y, e.position.z - centre.z) <= radius && (tried.get(e.id) ?? 0) < 3)[0];
        if (!next) break;
        tried.set(next.id, (tried.get(next.id) ?? 0) + 1);
        const r = await goNear(next.position, 0, 15_000).catch(() => undefined);
        if (!r?.arrived) await call('steer', { ...next.position, timeoutMs: 6000 }, 12_000).catch(() => undefined);
      }
      const { entities: left } = await call<{ entities: EntityInfo[] }>('world.entities', { maxDistance: 64, type: 'item' });
      const remaining = left.filter(e => Math.hypot(e.position.x - centre.x, e.position.y - centre.y, e.position.z - centre.z) <= radius).length;
      const gained = gainedText(before, (await inventoryCounts()).counts);
      return factory.createResponse(`Collected around ${fmt(floorPos(centre))}${why}: ${gained || 'nothing'}.` +
        (remaining ? ` ${remaining} drop(s) there could not be reached.` : ''));
    }
  );

  register(
    'drop-item',
    'Throw items out of the inventory (to make room: Baritone picks up everything it digs). All of that item unless `count` is given.',
    {
      item: z.string().describe("Item to drop, e.g. 'diorite'"),
      count: z.coerce.number().int().positive().optional().describe('How many (default: all)')
    },
    async ({ item, count }: { item: string; count?: number }) => {
      const name = item.replace(/^minecraft:/, '');
      if (!((await inventoryCounts()).counts.get(name))) return factory.createErrorResponse(`No ${name} in the inventory`);
      const r = await call<{ dropped: number }>('item.drop', { name, ...(count ? { count } : {}) });
      return factory.createResponse(`Dropped ${r.dropped} ${name}`);
    }
  );

  register(
    'fish',
    'Fish with a fishing rod at open water: walks to the nearest open water source (or the one given), casts, reels in at each bite, and repeats. Fish are food (cook them in a furnace).',
    {
      times: z.coerce.number().int().min(1).max(64).optional().describe('How many bites to reel in (default: 5)'),
      x: z.coerce.number().optional().describe('X of a water block to fish in (default: nearest open water)'),
      y: z.coerce.number().optional().describe('Y of that water block'),
      z: z.coerce.number().optional().describe('Z of that water block'),
      timeoutMs: z.number().int().min(10000).optional().describe('Stop after this long (default: 300000)')
    },
    async ({ times = 5, x, y, z: zz, timeoutMs = 300_000 }: { times?: number; x?: number; y?: number; z?: number; timeoutMs?: number }) => {
      if (!(await inventoryCounts()).counts.get('fishing_rod')) return factory.createErrorResponse('No fishing_rod in the inventory (3 sticks and 2 string)');
      let water: Pos | undefined = x !== undefined && y !== undefined && zz !== undefined ? floorPos({ x, y, z: zz }) : undefined;
      if (!water) {
        // nearest pond, not a puddle: still water with still water on at least 6 of its 8 sides and air above, since a cast
        // flies a few blocks and overshot a 1x1 farm hole 59 times
        const found = await call<{ positions: Pos[] }>('world.findBlocks', { block: 'water', maxDistance: 64, count: 256, openAbove: true });
        // the middle of open water first (5x5 of still water: a cast that falls a little short still lands in it; a
        // 3x3 pool by the yard had the hook on the bank 17 casts in a row), then any small pond
        let small: Pos | undefined;
        for (const p of found.positions) {
          const { blocks } = await call<{ blocks: (string | null)[] }>('world.region', { x: p.x - 2, y: p.y, z: p.z - 2, width: 5, height: 2, length: 5 });
          if (blocks[12 + 25] !== 'air' || blocks[12] !== 'water[level=0]') continue;
          const still = blocks.slice(0, 25).filter(b => b === 'water[level=0]').length;
          const inner = [6, 7, 8, 11, 13, 16, 17, 18].filter(i => blocks[i] === 'water[level=0]').length;
          if (still === 25) { water = p; break; }
          if (!small && inner >= 6) small = p;
        }
        water ??= small;
      }
      if (!water) return factory.createErrorResponse('No pond (open still water, 3x3 or bigger) within 64 blocks');
      // stand on the shore, not in the pond (walking "near" the water put the bot in it: it ran out of air and the
      // casts failed): a dry block 2-4 blocks from the target with two air blocks above
      const box = { x: water.x - 4, y: water.y - 1, z: water.z - 4, width: 9, height: 4, length: 9 };
      const { blocks: around } = await call<{ blocks: (string | null)[] }>('world.region', box);
      const at = (dx: number, dy: number, dz: number) => around[dx + dz * 9 + dy * 81] ?? '';
      let shore: Pos | undefined;
      let best = Infinity;
      for (let dz = 0; dz < 9; dz++) for (let dx = 0; dx < 9; dx++) for (let dy = 0; dy < 2; dy++) {
        const ground = at(dx, dy, dz), feet = at(dx, dy + 1, dz), head = at(dx, dy + 2, dz);
        if (!ground || /water|lava|air|leaves|^short_grass|^tall_grass/.test(ground) || !/^(air|short_grass|leaf_litter)/.test(feet) || !/^air/.test(head)) continue;
        const d = Math.hypot(dx - 4, dz - 4);
        if (d < 2 || d > 4) continue;
        if (d < best) { best = d; shore = { x: box.x + dx, y: box.y + dy + 1, z: box.z + dz }; }
      }
      await goNear(shore ?? water, shore ? 0 : 3).catch(() => undefined);
      const r = await call<{ bites: number; casts: number; gained: Record<string, number>; seconds: number; recalled?: string; open?: number; letGo?: string[] }>('fish', { ...water, times, timeoutMs }, timeoutMs + 15_000);
      const gained = Object.entries(r.gained).map(([n, c]) => `${n} x${c}`).join(', ');
      const missed = r.casts > r.bites * 2 + 2 && r.recalled ? ` Casts that missed the water: ${r.recalled}.` : '';
      // (from the bridge that reads the game's open-water rule: treasure is fished up only there)
      const open = typeof r.open === 'number' && r.open >= 0 && r.bites ? ` ${r.open} of the bites in open water (treasure comes only from open water).` : '';
      const let_ = r.letGo?.length ? ` Let go of what the hook caught: ${r.letGo.join(', ')}.` : '';
      return factory.createResponse(`Fished at ${fmt(water)} for ${r.seconds}s: ${r.bites} bite(s) in ${r.casts} cast(s), caught ${gained || 'nothing'}.${open}${let_}${missed}`);
    }
  );

  register(
    'farm',
    'Harvest ripe crops around the bot (wheat, carrots, potatoes, beetroot, sweet berry bushes, melons, pumpkins, cocoa, nether wart) without destroying the plants, and replant with seeds from the inventory. Runs until nothing is left to do or the time limit. Reports what was gathered.',
    {
      range: z.coerce.number().int().min(4).max(128).optional().describe('How far around the bot to farm (default: 32)'),
      timeoutMs: z.number().int().min(5000).optional().describe('Stop after this long (default: 120000)'),
      seed: z.string().optional().describe("Replant with this seed first, e.g. 'wheat_seeds' (default: the first seed in the hotbar)")
    },
    async ({ range = 32, timeoutMs = 120_000, seed }: { range?: number; timeoutMs?: number; seed?: string }) => {
      const before = (await inventoryCounts()).counts;
      const r = await call<ProcessResult & { gained: Record<string, number> }>('farm', { range, timeoutMs, ...(seed ? { seed } : {}) }, timeoutMs + 15_000);
      // harvested items take a moment to fly to the bot: counted right away, a harvest read "nothing ripe"
      await new Promise(res => setTimeout(res, FARM_SETTLE_MS));
      // Baritone harvested but left the farmland bare ("Farm failed"): plant what seeds there are on empty farmland
      const planted = await replant(range);
      const after = (await inventoryCounts()).counts;
      const gained = gainedText(before, after);
      const full = fullWarning((await call<Inventory>('inventory').catch(() => ({ items: [] }))).items);
      const head = r.reason === 'timeout' ? `Farmed for ${r.seconds}s (time limit)` : `Farmed for ${r.seconds}s`;
      const sown = planted.count ? ` Planted ${planted.count} (${planted.what.join(', ')}).` : planted.empty ? ` ${planted.empty} farmland left bare: no seeds.` : '';
      return factory.createResponse(`${head}: ${gained || 'nothing ripe to harvest'}.${sown}${full}${baritoneSaid(r.baritone)}`);
    }
  );

  register(
    'store-in-chest',
    'Put items from the inventory into a chest (or barrel) at x,y,z, walking to it first. Reports what the chest holds afterwards.',
    {
      x: z.coerce.number().describe('X of the chest'),
      y: z.coerce.number().describe('Y of the chest'),
      z: z.coerce.number().describe('Z of the chest'),
      item: z.string().describe("Item to store, e.g. 'iron_ingot'"),
      count: z.coerce.number().int().positive().optional().describe('How many (default: all of them)')
    },
    async ({ x, y, z: zz, item, count }: { x: number; y: number; z: number; item: string; count?: number }) => {
      const at = floorPos({ x, y, z: zz });
      const name = item.replace(/^minecraft:/, '');
      const have = (await inventoryCounts()).counts.get(name) ?? 0;
      if (!have) return factory.createErrorResponse(`No ${name} in the inventory`);
      const block = await call<{ name?: string }>('world.block', { ...at });
      if (!/chest|barrel/.test(block.name ?? '')) return factory.createErrorResponse(`No chest at ${fmt(at)} (found ${block.name ?? 'nothing'})`);
      try {
        await openChest<ChestContents>(at);
        const r = await call<ChestContents>('chest.deposit', { name, ...(count ? { count } : {}) });
        const holds = Object.entries(r.items).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing';
        const short = (r.moved ?? 0) < Math.min(count ?? have, have) ? ' (the chest is full)' : '';
        return factory.createResponse(`Stored ${r.moved} ${name} in the chest at ${fmt(at)}${short}. It holds: ${holds}; ${r.free}/${r.slots} slots free.`);
      } finally {
        // outside the brain's run (chests.ts closeChest): a run given up refuses every call, and the chest stayed open
        await brainRun.exit(() => call('container.close')).catch(() => undefined);
      }
    }
  );

  register(
    'take-from-chest',
    'Take items out of a chest (or barrel) at x,y,z into the inventory, walking to it first. Reports what the chest holds afterwards.',
    {
      x: z.coerce.number().describe('X of the chest'),
      y: z.coerce.number().describe('Y of the chest'),
      z: z.coerce.number().describe('Z of the chest'),
      item: z.string().describe("Item to take, e.g. 'iron_ingot'"),
      count: z.coerce.number().int().positive().optional().describe('How many (default: all of them)'),
      slot: z.coerce.number().int().min(0).optional().describe("The chest's slot to take from (0 the top left): that stack, then only stacks the same as it (the same enchantments, the same potion). If it no longer holds the item, the first stack of it")
    },
    async ({ x, y, z: zz, item, count, slot }: { x: number; y: number; z: number; item: string; count?: number; slot?: number }) => {
      const at = floorPos({ x, y, z: zz });
      const name = item.replace(/^minecraft:/, '');
      const block = await call<{ name?: string }>('world.block', { ...at });
      if (!/chest|barrel/.test(block.name ?? '')) return factory.createErrorResponse(`No chest at ${fmt(at)} (found ${block.name ?? 'nothing'})`);
      try {
        const opened = await openChest<ChestContents>(at);
        let inside = opened.items[name] ?? 0;
        if (!inside) return factory.createErrorResponse(`The chest at ${fmt(at)} has no ${name}. It holds: ${Object.entries(opened.items).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing'}`);
        // `slot`: one stack (the enchanted book with mending, the potion of fire resistance), not the first of the name
        const r = await call<ChestContents>('chest.withdraw', { name, ...(count ? { count } : {}), ...(slot === undefined ? {} : { slot }) });
        const took = slot !== undefined && r.from !== undefined && r.from >= 0 ? r.from : undefined;
        // what that stack held (the same ones after it may add more): the rest of the name was never asked for
        const stack = took === undefined ? undefined : opened.stacks?.find(st => st.slot === took);
        if (stack) inside = stack.count;
        const holds = Object.entries(r.items).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing';
        const short = (r.moved ?? 0) < Math.min(count ?? inside, inside) ? ' (the inventory is full)' : '';
        const from = took === undefined ? '' : ` slot ${took} of`;
        const stale = took !== undefined && took !== slot ? ` (slot ${slot} held no ${name})` : '';
        // the slots, as store-in-chest says them: a take of whole stacks frees slots, and the brain's memory of a full
        // chest goes by this (chests.ts rememberReply); a jar that sends no count says none
        const room = Number.isFinite(r.free) && Number.isFinite(r.slots) ? `; ${r.free}/${r.slots} slots free` : '';
        return factory.createResponse(`Took ${r.moved} ${name} from${from} the chest at ${fmt(at)}${stale}${short}. It holds: ${holds}${room}.`);
      } finally {
        // (outside the brain's run, as store-in-chest's)
        await brainRun.exit(() => call('container.close')).catch(() => undefined);
      }
    }
  );

  register(
    'stop',
    'Stop whatever the bot is doing (walking, mining, building).',
    {},
    async () => {
      await call('cancel');
      return factory.createResponse('Stopped');
    }
  );

  // ---------------------------------------------------------------- the rails home (P5e)

  /** What stands at `p` as world.region writes it ("rail[shape=north_south,waterlogged=false]"), or undefined unread. */
  const stateAt = async (p: Pos): Promise<string | undefined> => {
    const b = await call<{ loaded: boolean; name?: string; properties?: Record<string, string> }>('world.block', { ...p }).catch(() => undefined);
    if (!b?.loaded || !b.name) return undefined;
    const props = Object.entries(b.properties ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
    return props ? `${b.name}[${props}]` : b.name;
  };
  /** Into reach of `p` by a careful walk (nothing placed or broken: the yard's fence, the line's own rails). */
  const carefulNear = (p: Pos) => call('goto', { ...p, range: 2, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => undefined);
  const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;

  const layRail = async (a: RailLay): Promise<RailPlaced> => {
    const p = floorPos(a.at);
    // the bot's own before it goes down (the dimension as last read, no call): a run cut short, the bot kicked or the
    // process killed between the bridge's answer and here must not leave a block down that the take-up refuses; taken
    // off again only when a read shows nothing of it there
    const dim = lastDimension;
    const had = protection.has(dim, p);
    if (!a.dryRun) protection.add(dim, [p]);
    // (a call that threw or timed out has no answer: the block may be down all the same, read after)
    let lost = false;
    const fail = (e: Error): RailPlaced => { lost = true; return { ok: false, placed: false, reason: e.message }; };
    const ask = async (): Promise<RailPlaced> => {
      if (a.item === 'cobblestone') {
        // the launch's stop: a plain block on the ground, as place-block puts one
        if (a.dryRun) return { ok: true, placed: false, dryRun: true };
        try { await call('item.select', { name: 'cobblestone' }); } catch { return { ok: false, placed: false, reason: 'no cobblestone carried' }; }
        const r = await call<{ placed: boolean; block?: string; reason?: string }>('place', { ...p, face: 'down' });
        return { ok: r.placed, placed: r.placed, ...(r.block ? { block: r.block } : {}), ...(r.reason ? { reason: r.reason } : {}) };
      }
      const where = { ...p, ...(a.inVillage ? { inVillage: true } : {}) };
      if (a.item === 'redstone_torch') {
        if (a.dryRun) return { ok: true, placed: false, dryRun: true };
        return call<RailPlaced>('rail.torch', { ...where, ...(a.lights ? { lights: floorPos(a.lights) } : {}) }, 15_000);
      }
      return call<RailPlaced>('rail.place', {
        ...where, item: a.item,
        ...(a.shape ? { shape: a.shape } : {}),
        ...(a.prev ? { prev: { ...floorPos(a.prev), shape: a.prev.shape } } : {}),
        ...(a.next ? { next: { ...floorPos(a.next), item: a.next.item ?? 'rail' } } : {}),
        ...(a.dryRun ? { dryRun: true } : {})
      }, 15_000);
    };
    const again = () => { lost = false; return ask().catch(fail); };
    let r = await again();
    if (!r.placed && /^too far/.test(r.reason ?? '')) {
      await carefulNear(p);
      r = await again();
    }
    if (!r.placed && r.reason === 'the bot is standing there') {
      await call('goto', { ...p, away: 2, careful: true, timeoutMs: 10_000 }, 20_000).catch(() => undefined);
      r = await again();
    }
    // (the Guardian's calm-time eat swapped the hand at the use, one begun before the call: over in under two seconds)
    if (!r.placed && /^the hand holds/.test(r.reason ?? '')) {
      await new Promise(res => setTimeout(res, HAND_WAIT_MS));
      r = await again();
    }
    if (!r.placed && lost && !a.dryRun) r = await downAfterAll(p, a, r);
    if (a.dryRun) return r;
    if (r.placed) {
      // the bot's own (since before the call), with the state it stands in (the rail before too, turned to its curve or
      // slope), and the client mod told before the next rail: rail.place turns only the bot's own rails, and the
      // courtesy scans skip them. A read that fails (the run cut short now) keeps the answer's block
      protection.add(dim, [p], [await stateAt(p) ?? r.block]);
      for (const t of r.turned ?? []) {
        if (same(t, p) || !protection.has(dim, t)) continue;
        const st = await stateAt(t);
        if (st) protection.add(dim, [t], [st]);
      }
      await status().catch(() => undefined);
    } else if (!had) {
      // not down: off again on a plain answer (or a call never sent: the run cut short before it), and on a lost reply
      // read so (something else there, or room); kept when unread or it stands there all the same (the brain's own
      // read-back keeps it in the record, and the take-up's read sees air as gone)
      const st = !lost || /^aborted:/.test(r.reason ?? '') ? 'air' : await stateAt(p);
      if (st !== undefined && st.replace(/\[.*$/, '') !== a.item) protection.remove(dim, p);
      else if (st !== undefined) protection.add(dim, [p], [st]);
    }
    return r;
  };

  /**
   * A lay whose call had no answer (a timeout, the bridge dropped), read: the block there all the same is the bot's (the
   * brain read the cell as room just before), `ok` when the rail before ends as asked and this one as asked with no rail
   * to come after it (one with a next is checked by the next's own lay), a torch's rail lit. Else the answer as it was.
   */
  const downAfterAll = async (p: Pos, a: RailLay, r: RailPlaced): Promise<RailPlaced> => {
    let st = await stateAt(p);
    // (a call that timed out is not called off: its use may wait on the client's ticks behind this first read, which
    // then sees room; read once more after a moment, the block down by then if it is to come)
    if (st !== undefined && st.replace(/\[.*$/, '') !== a.item && /timed out|connection closed/.test(r.reason ?? '')) {
      await new Promise(res => setTimeout(res, LOST_READ_MS));
      st = await stateAt(p);
    }
    const id = st?.replace(/\[.*$/, '');
    if (!st || id !== a.item) return r;
    const shapeIn = (state: string | undefined) => /shape=([a-z_]+)/.exec(state ?? '')?.[1];
    let ok = true;
    if (a.item === 'rail' || a.item === 'powered_rail') {
      if (a.prev && shapeIn(await stateAt(floorPos(a.prev))) !== a.prev.shape) ok = false;
      if (!a.next && a.shape && shapeIn(st) !== a.shape) ok = false;
    } else if (a.item === 'redstone_torch' && a.lights) ok = /powered=true/.test(await stateAt(floorPos(a.lights)) ?? '');
    const shape = shapeIn(st) as RailShape | undefined;
    return { ok, placed: true, block: id, ...(shape ? { shape } : {}), reason: `the reply was lost (${r.reason ?? 'no answer'}); read down after${ok ? '' : ', not as asked'}` };
  };

  /** The blocks the line is made of: nothing else is taken up. */
  const LINE_BLOCK = /^(rail|powered_rail|redstone_torch|cobblestone)$/;
  const takeUpRail = async (at: Pos, item?: string): Promise<RailTaken> => {
    const p = floorPos(at);
    const dim = await dimension();
    const name = (await stateAt(p))?.replace(/\[.*$/, '');
    if (!name) return { ok: false, dug: false, reason: 'not loaded' };
    // gone already (someone took it, a cart knocked a torch?): nothing to dig, nothing of the bot's there any more
    if (/^(air|cave_air)$/.test(name)) { protection.remove(dim, p); return { ok: true, dug: false, block: name, reason: 'nothing there' }; }
    if (!LINE_BLOCK.test(name)) return { ok: false, dug: false, block: name, reason: `not a block of the line: ${name}` };
    if (!protection.has(dim, p)) return { ok: false, dug: false, block: name, reason: `the bot did not put that ${name} there` };
    // (the bot's cell, but not the block it put there: someone broke the bot's rail and put their own cobblestone, rail or
    // torch in it; theirs, never dug, and the cell the bot's no more)
    // (the state kept when it was laid, if it names a block of the line: a read that lagged the lay is no answer)
    const kept = protection.stateOf(dim, p)?.replace(/\[.*$/, '');
    const was = item ?? (kept && LINE_BLOCK.test(kept) ? kept : undefined);
    if (was && was !== name) {
      protection.remove(dim, p);
      return { ok: false, dug: false, block: name, reason: `the bot did not put that ${name} there (its ${was} is gone)` };
    }
    const count = async () => (await inventoryCounts()).counts.get(name) ?? 0;
    const had = await count();
    const dig = () => call<{ dug?: boolean; reason?: string }>('dig.here', { ...p, timeoutMs: 15_000 }, 25_000).catch((e: Error) => ({ dug: false, reason: e.message }));
    let r = await dig();
    if (!r.dug && /out of reach|out of sight/.test(r.reason ?? '')) {
      await carefulNear(p);
      r = await dig();
    }
    if (!r.dug && r.reason !== 'air') return { ok: false, dug: false, block: name, reason: r.reason ?? 'not dug' };
    protection.remove(dim, p);
    await status().catch(() => undefined);
    // the drop: onto the cell, carefully (a rail's cell is walked over), for it to come in
    await call('goto', { ...p, range: 0, careful: true, timeoutMs: 8000 }, 15_000).catch(() => undefined);
    let got = (await count()) > had;
    if (!got) { await new Promise(res => setTimeout(res, 600)); got = (await count()) > had; }
    return { ok: true, dug: true, block: name, pickedUp: got };
  };

  const placeCart = async (at: Pos, opts: { inVillage?: boolean; newMovement?: boolean } = {}): Promise<CartPlaced> => {
    const p = floorPos(at);
    const ask = () => call<CartPlaced>('cart.place', { ...p, ...(opts.inVillage ? { inVillage: true } : {}), ...(opts.newMovement ? { newMovement: true } : {}) }, 15_000)
      .catch((e: Error): CartPlaced => ({ ok: false, reason: e.message }));
    let r = await ask();
    if (!r.ok && /^too far/.test(r.reason ?? '')) {
      await carefulNear(p);
      r = await ask();
    }
    return r;
  };

  const RAIL_SHAPES = ['north_south', 'east_west', 'ascending_north', 'ascending_south', 'ascending_east', 'ascending_west', 'north_east', 'north_west', 'south_east', 'south_west'] as const;
  const xyz = { x: z.coerce.number(), y: z.coerce.number(), z: z.coerce.number() };
  register(
    'lay-rail',
    "Lay one block of a minecart line (the rails home): a rail or powered rail with the shape it should end with, a redstone torch beside a powered rail (it lights it), or the cobblestone stop. A rail takes its shape from the rails beside it, not from the hand: lay the line in its order, each rail beside the last, and give the rail before (`prev`, with the shape it must end with) and the cell after (`next`): the rail is refused unless both come out as asked. The bot walks carefully into reach. Nothing goes down in someone's build unless `inVillage`.",
    {
      ...xyz,
      item: z.enum(['rail', 'powered_rail', 'redstone_torch', 'cobblestone']).describe('What to put down'),
      shape: z.enum(RAIL_SHAPES).optional().describe("The rail's shape once the rail at `next` is down (none: now)"),
      prev: z.object({ ...xyz, shape: z.enum(RAIL_SHAPES) }).optional().describe('The rail laid before this one, and the shape it must end with'),
      next: z.object({ ...xyz, item: z.enum(['rail', 'powered_rail']).optional() }).optional().describe("The line's next cell (laid after this one)"),
      lights: z.object(xyz).optional().describe('A torch: the powered rail it lights (checked lit after)'),
      inVillage: z.boolean().optional().describe("The village was judged free to take from: a cell inside its zone may be laid"),
      dryRun: z.boolean().optional().describe('Only look: what the rail would do')
    },
    async (args: RailLay & Pos) => {
      const at = floorPos({ x: args.x, y: args.y, z: args.z });
      const r = await layRail({ ...args, at });
      const turned = (r.turned ?? []).filter(t => !same(t, at)).map(t => ` the rail at ${fmt(t)} now ${t.to}`).join(';');
      if (r.dryRun && r.ok) {
        return factory.createResponse(`Would lay ${args.item} at ${fmt(at)}${r.predicted ? `: ${r.predicted} now${r.once && r.once !== r.predicted ? `, ${r.once} once the next rail is down` : ''}` : ''}${turned ? `;${turned}` : ''}`);
      }
      if (!r.ok) return factory.createErrorResponse(`${r.placed ? 'Laid, but not as asked' : 'Not laid'}: ${args.item} at ${fmt(at)}: ${r.reason ?? 'no answer'}`);
      if (args.item === 'redstone_torch') {
        return factory.createResponse(`Put a redstone torch at ${fmt(at)}${r.lights ? `: the rail at ${fmt(r.lights)} is ${r.lights.powered ? 'lit' : 'not lit'}` : ''}`);
      }
      if (args.item === 'cobblestone') return factory.createResponse(`Put the stop (cobblestone) at ${fmt(at)}`);
      return factory.createResponse(`Laid ${args.item} [${r.shape}] at ${fmt(at)}${r.powered ? ', powered' : ''}${turned ? `;${turned}` : ''}${r.newMovement ? ' (the server runs the minecart_improvements experiment)' : ''}`);
    }
  );

  register(
    'take-up-rail',
    'Take one block of a minecart line back up: a rail, powered rail, redstone torch or cobblestone the bot put down itself (never anyone else\'s), dug from where it stands after a careful walk into reach, and the drop picked up.',
    { ...xyz },
    async (args: Pos) => {
      const at = floorPos(args);
      const r = await takeUpRail(at);
      if (!r.ok) return factory.createErrorResponse(`Not taken up at ${fmt(at)}: ${r.reason ?? 'no answer'}`);
      if (!r.dug) return factory.createResponse(`Nothing to take up at ${fmt(at)} (${r.reason ?? 'gone'})`);
      return factory.createResponse(`Took up the ${r.block} at ${fmt(at)}${r.pickedUp ? '' : ' (the drop not picked up yet)'}`);
    }
  );

  register(
    'place-minecart',
    "Put a minecart on the rail at (x, y, z): it comes down still and takes no one there (a moving cart takes the first mob it runs into). It is the bot's own afterwards. Refused on a server running the minecart_improvements experiment unless `newMovement`.",
    {
      ...xyz,
      inVillage: z.boolean().optional().describe('The village was judged free to take from: a rail inside its zone may take a cart'),
      newMovement: z.boolean().optional().describe('Go on under the minecart_improvements experiment\'s rules')
    },
    async (args: Pos & { inVillage?: boolean; newMovement?: boolean }) => {
      const at = floorPos(args);
      const r = await placeCart(at, { inVillage: args.inVillage, newMovement: args.newMovement });
      if (!r.ok) return factory.createErrorResponse(`No minecart put on the rail at ${fmt(at)}: ${r.reason ?? 'no answer'}`);
      return factory.createResponse(`Put a minecart (${r.id}, uuid ${r.uuid}) on the rail at ${fmt(at)}${r.passengers?.length ? `; it took ${r.passengers.map(q => q.name ?? q.id).join(', ')}` : ''}`);
    }
  );

  return {
    rails: { lay: layRail, takeUp: takeUpRail, placeCart },
    actions: handlers,
    call,
    status,
    home: (st, name = 'home') => {
      const world = worldIdFromSeed(st.hashedSeed ?? undefined);
      return world ? readHomes()[world]?.[name] : undefined;
    },
    lastDeath: () => lastDeath,
    setManualHook: fn => { manualHook = fn; },
    setHomeZone: (yard, pens = []) => {
      zoneRect = yard ? { x1: yard.x1, z1: yard.z1, x2: yard.x2, z2: yard.z2 } : undefined;
      zonePens = yard ? pens.map(p => ({ x1: p.x1, z1: p.z1, x2: p.x2, z2: p.z2 })) : [];
    },
    setOwnPortals: portals => {
      ownPortals = portals.map(p => ({ dimension: p.dimension, x: p.x, y: p.y, z: p.z }));
    },
    builtNear: (center, radius) => protection.entries(lastDimension).filter(({ at }) =>
      Math.hypot(at.x - center.x, at.z - center.z) <= radius && Math.abs(at.y - center.y) <= radius),
    restoreBlock: async (at, item, facing) => {
      const p = floorPos(at);
      const why = await placeFacing(p, item, facing);
      // the bot's again (the state it was built with is kept: a torch put back on the floor is still the wall torch)
      if (!why) protection.add(await dimension(), [p]);
      return why;
    },
    protectBuilt: blocks => {
      if (blocks.length) protection.add(lastDimension, blocks.map(b => b.at), blocks.map(b => b.state.replace(/^minecraft:/, '')));
    },
    adoptStates: blocks => {
      const fresh = blocks.filter(b => !protection.stateOf(lastDimension, b.at));
      if (fresh.length) protection.add(lastDimension, fresh.map(b => b.at), fresh.map(b => b.state.replace(/^minecraft:/, '')));
    }
  };
}
