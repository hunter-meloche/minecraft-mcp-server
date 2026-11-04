import type mineflayer from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Item } from 'prismarine-item';
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { collectDrops } from './drops.js';
import { chooseFood, foodsFor } from './food.js';
import { countCover, describeShelter, wallIn } from './bunker.js';

const { goals } = pathfinderPkg;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- who is who

// minecraft-data files some monsters under "mob" (slime, ghast, ...) rather than "hostile"
const HOSTILE_MOBS = new Set(['slime', 'magma_cube', 'ghast', 'phantom', 'shulker', 'ender_dragon']);
const LIVING_TYPES = new Set(['hostile', 'mob', 'animal', 'passive', 'water_creature', 'ambient']);
/** Mobs that hurt from a distance: worth raising a shield against. */
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'parched', 'pillager', 'blaze', 'ghast', 'witch', 'breeze', 'shulker', 'drowned']);

// plain strings: prismarine-entity's EntityType union lacks types the data uses, like 'animal'
interface EntityKind { type: string; name?: string }

export function isHostile(entity: EntityKind): boolean {
  return entity.type === 'hostile' || HOSTILE_MOBS.has(entity.name ?? '');
}

/**
 * Not picked by 'hostile' (they can still be attacked by name): neutral until provoked, so attacking them starts a
 * fight that wasn't there (endermen, piglins), or not winnable with early gear (warden, creaking, bosses).
 */
const NOT_PICKED_AS_HOSTILE = new Set([
  'enderman', 'piglin', 'zombified_piglin', 'warden', 'creaking', 'wither', 'ender_dragon', 'elder_guardian', 'giant'
]);

/** Does `entity` match what the caller asked to attack? Players only when asked for by name. */
export function matchesTarget(entity: EntityKind, query: string): boolean {
  const q = query.toLowerCase().replace(/^minecraft:/, '');
  if (q === 'hostile') return isHostile(entity) && !NOT_PICKED_AS_HOSTILE.has(entity.name ?? '');
  if (q === 'mob') return LIVING_TYPES.has(entity.type);
  if (q === 'player') return entity.type === 'player';
  if (entity.type === 'player' || !LIVING_TYPES.has(entity.type)) return false;
  return entity.name === q;
}

export function describe(entity: { name?: string; type: string }): string {
  return entity.name ?? entity.type;
}

const alive = (bot: mineflayer.Bot, e: Entity) => !!bot.entities[e.id] && e.isValid !== false;

/** Hostiles within `range`, nearest first. */
export function hostilesNear(bot: mineflayer.Bot, range: number): Entity[] {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.isValid !== false && isHostile(e) && e.position.distanceTo(me) <= range)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
}

// ---------------------------------------------------------------- gear

const WEAPON_KIND: Record<string, { score: number; cooldownMs: number }> = {
  sword: { score: 10, cooldownMs: 650 }, // attack speed 1.6
  axe: { score: 8, cooldownMs: 1050 }, // 0.8 - 1.0
  pickaxe: { score: 4, cooldownMs: 850 }, // 1.2
  shovel: { score: 3, cooldownMs: 1000 }, // 1.0
};
const TIER: Record<string, number> = { wooden: 0, golden: 0, stone: 1, copper: 1.5, iron: 2, diamond: 3, netherite: 4 };
export const FIST_COOLDOWN_MS = 300; // attack speed 4

function weaponInfo(name: string): { score: number; cooldownMs: number } | null {
  const m = /^([a-z]+)_(sword|axe|pickaxe|shovel)$/.exec(name);
  if (!m || !(m[1] in TIER)) return null;
  const kind = WEAPON_KIND[m[2]];
  return { score: kind.score + TIER[m[1]], cooldownMs: kind.cooldownMs };
}

/** The inventory item that hits hardest per second, swords first. null = nothing better than a fist. */
export function bestWeapon(items: Pick<Item, 'name'>[]): { item: Pick<Item, 'name'>; cooldownMs: number } | null {
  let best: { item: Pick<Item, 'name'>; score: number; cooldownMs: number } | null = null;
  for (const item of items) {
    const info = weaponInfo(item.name);
    if (info && (!best || info.score > best.score)) best = { item, ...info };
  }
  return best && { item: best.item, cooldownMs: best.cooldownMs };
}

/** Make sure the best weapon is in hand; returns the swing cooldown to respect. */
export async function holdWeapon(bot: mineflayer.Bot): Promise<number> {
  const weapon = bestWeapon(bot.inventory.items());
  if (weapon && bot.heldItem?.name !== weapon.item.name) {
    const stack = bot.inventory.items().find(i => i.name === weapon.item.name);
    if (stack) await bot.equip(stack, 'hand');
  }
  return weapon?.cooldownMs ?? FIST_COOLDOWN_MS;
}

const ARMOR_TIER: Record<string, number> = { leather: 1, golden: 2, copper: 2.5, chainmail: 3, iron: 4, turtle: 4, diamond: 5, netherite: 6 };
const ARMOR_SLOT: Record<string, { dest: 'head' | 'torso' | 'legs' | 'feet'; slot: number }> = {
  helmet: { dest: 'head', slot: 5 }, chestplate: { dest: 'torso', slot: 6 }, leggings: { dest: 'legs', slot: 7 }, boots: { dest: 'feet', slot: 8 }
};

export function armorInfo(name: string): { piece: string; score: number } | null {
  const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(name);
  if (!m || !(m[1] in ARMOR_TIER)) return null;
  return { piece: m[2], score: ARMOR_TIER[m[1]] };
}

/** Wear the best armor the inventory holds, piece by piece. Returns what was put on. */
export async function equipBestArmor(bot: mineflayer.Bot): Promise<string[]> {
  const put: string[] = [];
  for (const [piece, { dest, slot }] of Object.entries(ARMOR_SLOT)) {
    const worn = bot.inventory.slots[slot];
    const wornScore = worn ? armorInfo(worn.name)?.score ?? 0 : 0;
    let best: Item | null = null;
    let bestScore = wornScore;
    for (const item of bot.inventory.items()) {
      const info = armorInfo(item.name);
      if (info?.piece === piece && info.score > bestScore) { best = item; bestScore = info.score; }
    }
    if (best) {
      await bot.equip(best, dest);
      put.push(best.name);
    }
  }
  return put;
}

/** Put a shield in the off-hand if there is one. */
export async function equipShield(bot: mineflayer.Bot): Promise<boolean> {
  if (bot.inventory.slots[45]?.name === 'shield') return true;
  const shield = bot.inventory.items().find(i => i.name === 'shield');
  if (!shield) return false;
  await bot.equip(shield, 'off-hand');
  return true;
}

// ---------------------------------------------------------------- fighting

/** Bots currently in a fight started by attack-entity; auto-defend leaves them alone. */
export const fighting = new WeakSet<mineflayer.Bot>();

export interface FightOptions {
  maxDistance?: number;
  timeoutMs?: number;
  minHealth?: number;
  /** keep going with the next match after a kill (default: true for 'hostile') */
  multiple?: boolean;
  /** take cover (wall in, or flee without blocks) and eat when stopping at low health (default: true) */
  retreat?: boolean;
}

export interface FightResult {
  outcome: 'none' | 'done' | 'timeout' | 'low_health' | 'lost';
  kills: string[];
  target?: string;
  hits: number;
  landed: number;
  swungWith: Map<string, number>;
  seconds: number;
  wore: string[];
  retreat?: string;
  threats: string[];
}

export async function fight(bot: mineflayer.Bot, query: string, opts: FightOptions = {}): Promise<FightResult> {
  const { maxDistance = 16, timeoutMs = 30000, minHealth = 6, retreat = true } = opts;
  const multiple = opts.multiple ?? query.toLowerCase() === 'hostile';
  const result: FightResult = { outcome: 'none', kills: [], hits: 0, landed: 0, swungWith: new Map(), seconds: 0, wore: [], threats: [] };
  const pick = () => bot.nearestEntity(e => e !== bot.entity && matchesTarget(e, query) && e.position.distanceTo(bot.entity.position) <= maxDistance);

  let victim = pick();
  if (!victim) return result;

  fighting.add(bot);
  const startedAt = Date.now();
  let shieldUp = false;
  const lowerShield = () => { if (shieldUp) { bot.deactivateItem(); shieldUp = false; } };
  // only our hits: arrows from other skeletons and creeper blasts hurt the target too
  const onHurt = (e: Entity | undefined, source: Entity | undefined) => {
    if (e && victim && e.id === victim.id && source?.id === bot.entity.id) result.landed++;
  };
  bot.on('entityHurt', onHurt);
  let dropsAt: Vec3 | null = null;

  try {
    result.wore = await equipBestArmor(bot);
    const hasShield = await equipShield(bot);
    bot.pathfinder.setGoal(new goals.GoalFollow(victim, 2), true);

    while (Date.now() - startedAt < timeoutMs) {
      if (!alive(bot, victim)) {
        result.kills.push(describe(victim));
        dropsAt = victim.position.floored();
        // only take on the next one while still in decent shape
        const next = multiple && bot.health >= Math.max(12, minHealth + 6) ? pick() : null;
        if (!next) { result.outcome = 'done'; break; }
        victim = next;
        bot.pathfinder.setGoal(new goals.GoalFollow(victim, 2), true);
        continue;
      }
      // outnumbered: stop a bit earlier, arrows from the others keep coming while we swing
      const stopAt = hostilesNear(bot, 12).length >= 2 ? minHealth + 4 : minHealth;
      if (bot.health <= stopAt) { result.outcome = 'low_health'; break; }
      const distance = bot.entity.position.distanceTo(victim.position);
      if (distance > maxDistance * 2) {
        const next = multiple ? pick() : null;
        if (!next) { result.outcome = 'lost'; break; }
        victim = next;
        bot.pathfinder.setGoal(new goals.GoalFollow(victim, 2), true);
        continue;
      }
      if (distance > 3.2) {
        lowerShield();
        await sleep(100);
        continue;
      }

      // swing: shield down, weapon in hand (chasing makes pathfinder swap in scaffolding or a pickaxe)
      lowerShield();
      const cooldownMs = await holdWeapon(bot);
      await bot.lookAt(victim.position.offset(0, (victim.height ?? 1) * 0.8, 0), true);
      const held = bot.heldItem?.name ?? 'fist';
      bot.attack(victim);
      result.hits++;
      result.swungWith.set(held, (result.swungWith.get(held) ?? 0) + 1);

      if (victim.name === 'creeper') {
        // knock it back and step out of its blast radius before it can finish swelling
        bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(victim, 6)), true);
        await sleep(cooldownMs);
        bot.pathfinder.setGoal(new goals.GoalFollow(victim, 2), true);
      } else if (hasShield && (RANGED.has(victim.name ?? '') || hostilesNear(bot, 4).some(e => e.name === 'creeper'))) {
        bot.activateItem(true);
        shieldUp = true;
        await sleep(cooldownMs);
      } else {
        await sleep(cooldownMs);
      }
    }
  } finally {
    lowerShield();
    bot.pathfinder.setGoal(null);
    bot.removeListener('entityHurt', onHurt);
    fighting.delete(bot);
  }

  result.target = describe(victim);
  if (result.outcome === 'none') result.outcome = 'timeout';
  result.seconds = (Date.now() - startedAt) / 1000;

  if (result.outcome === 'low_health') {
    if (retreat) result.retreat = await takeCover(bot);
  } else if (dropsAt && hostilesNear(bot, 6).length === 0) {
    await collectDrops(bot, dropsAt, { settleMs: 300, timeoutMs: 5000 });
  }
  result.threats = hostilesNear(bot, 16).map(e => `${describe(e)} ${e.position.distanceTo(bot.entity.position).toFixed(0)} blocks away`);
  return result;
}

/**
 * Get out of harm's way at low health: wall in where we stand if there are blocks for it (running from skeletons
 * at 10-12 blocks still got the bot shot), otherwise run. Then eat.
 */
export async function takeCover(bot: mineflayer.Bot): Promise<string> {
  if (countCover(bot.inventory.items()) >= 5) {
    const shelter = await wallIn(bot);
    const eaten = await eatSomething(bot);
    return [describeShelter(shelter).replace(/\.$/, ''), eaten].filter(Boolean).join(', ').replace(/^W/, 'w');
  }
  return fleeAndEat(bot);
}

/** Eat the best food there is; at low health rotten flesh is better than nothing. Returns what happened, or ''. */
export async function eatSomething(bot: mineflayer.Bot): Promise<string> {
  if (bot.food >= 20) return '';
  const items = bot.inventory.items();
  const food = chooseFood(items, foodsFor(bot), bot.food) ?? (bot.health <= 10 ? items.find(i => i.name === 'rotten_flesh') ?? null : null);
  if (!food) return 'no safe food to eat';
  try {
    await bot.equip(food, 'hand');
    await bot.consume();
    return `ate ${food.name}`;
  } catch (e) {
    return `couldn't eat ${food.name}: ${(e as Error).message}`;
  }
}

/** Run from the nearest hostiles (up to ~8 s), then eat if there is food. Says what happened. */
export async function fleeAndEat(bot: mineflayer.Bot, { fleeMs = 8000, safeDistance = 12 } = {}): Promise<string> {
  const parts: string[] = [];
  const threat = hostilesNear(bot, 16)[0];
  if (threat) {
    const started = Date.now();
    bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(threat, safeDistance)), true);
    while (Date.now() - started < fleeMs && hostilesNear(bot, safeDistance - 2).length > 0) await sleep(200);
    bot.pathfinder.setGoal(null);
    const still = hostilesNear(bot, safeDistance - 2).length;
    parts.push(still ? `fled but ${still} hostile(s) still close` : `fled from ${describe(threat)}`);
  }
  const eaten = await eatSomething(bot);
  if (eaten) parts.push(eaten);
  return parts.join(', ');
}
