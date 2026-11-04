import { z } from "zod";
import type mineflayer from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Item } from 'prismarine-item';
import minecraftData from 'minecraft-data';
import pathfinderPkg from 'mineflayer-pathfinder';
import { ToolFactory } from '../tool-factory.js';
import { settleInventory } from '../inventory-sync.js';

const { goals } = pathfinderPkg;

// minecraft-data files some monsters under "mob" (slime, ghast, ...) rather than "hostile"
const HOSTILE_MOBS = new Set(['slime', 'magma_cube', 'ghast', 'phantom', 'shulker', 'ender_dragon']);
const LIVING_TYPES = new Set(['hostile', 'mob', 'animal', 'passive', 'water_creature', 'ambient']);

// plain strings: prismarine-entity's EntityType union lacks types the data uses, like 'animal'
interface EntityKind { type: string; name?: string }

export function isHostile(entity: EntityKind): boolean {
  return entity.type === 'hostile' || HOSTILE_MOBS.has(entity.name ?? '');
}

/** Does `entity` match what the caller asked to attack? Players only when asked for by name. */
export function matchesTarget(entity: EntityKind, query: string): boolean {
  const q = query.toLowerCase().replace(/^minecraft:/, '');
  if (q === 'hostile') return isHostile(entity);
  if (q === 'mob') return LIVING_TYPES.has(entity.type);
  if (q === 'player') return entity.type === 'player';
  if (entity.type === 'player' || !LIVING_TYPES.has(entity.type)) return false;
  return entity.name === q;
}

const WEAPON_KIND: Record<string, { score: number; cooldownMs: number }> = {
  sword: { score: 10, cooldownMs: 650 }, // attack speed 1.6
  axe: { score: 8, cooldownMs: 1050 }, // 0.8 - 1.0
  pickaxe: { score: 4, cooldownMs: 850 }, // 1.2
  shovel: { score: 3, cooldownMs: 1000 }, // 1.0
};
const TIER: Record<string, number> = { wooden: 0, golden: 0, stone: 1, copper: 1.5, iron: 2, diamond: 3, netherite: 4 };
const FIST_COOLDOWN_MS = 300; // attack speed 4

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

// food that hurts (poison, hunger, nausea, random teleport) or that's too valuable to eat without being asked
const AVOID_UNLESS_ASKED = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit',
  'golden_apple', 'enchanted_golden_apple', 'golden_carrot'
]);
// the game lets you eat these with a full hunger bar
const ALWAYS_EDIBLE = new Set(['golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'milk_bucket', 'potion', 'honey_bottle']);

interface FoodInfo { foodPoints: number; saturation: number }

/** Pick what to eat: the safe food that restores the most without wasting much on a nearly full bar. */
export function chooseFood(items: Item[], foods: Record<string, FoodInfo>, food: number): Item | null {
  const missing = 20 - food;
  let best: { item: Item; score: number } | null = null;
  for (const item of items) {
    const info = foods[item.name];
    if (!info || AVOID_UNLESS_ASKED.has(item.name)) continue;
    const restored = Math.min(info.foodPoints, missing);
    const wasted = info.foodPoints - restored;
    const score = restored + info.saturation - wasted * 1.5;
    if (!best || score > best.score) best = { item, score };
  }
  return best?.item ?? null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function describe(entity: Entity): string {
  return entity.name ?? entity.type;
}

function vitals(bot: mineflayer.Bot): string {
  return `Health ${Math.round(bot.health * 10) / 10}/20, food ${bot.food}/20`;
}

export function registerSurvivalTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "attack-entity",
    "Attack the nearest matching entity until it dies: a mob name like 'zombie' or 'cow', 'hostile' for any monster, or 'mob' for any creature. Equips the best weapon, chases the target, backs off when health gets low, and picks up the drops.",
    {
      target: z.string().describe("Entity to attack: a name like 'zombie', 'cow', 'skeleton', or 'hostile' / 'mob'"),
      maxDistance: z.coerce.number().finite().optional().describe("How far to look for a target (default: 16)"),
      timeoutMs: z.number().int().min(1000).optional().describe("Give up after this long (default: 30000)"),
      minHealth: z.coerce.number().finite().optional().describe("Stop fighting when health drops to this (default: 6 = three hearts)")
    },
    async ({ target, maxDistance = 16, timeoutMs = 30000, minHealth = 6 }) => {
      const bot = getBot();
      const me = bot.entity.position;
      const victim = bot.nearestEntity(e => e !== bot.entity && matchesTarget(e, target) && e.position.distanceTo(me) <= maxDistance);
      if (!victim) return factory.createResponse(`No ${target} within ${maxDistance} blocks`);

      const weapon = bestWeapon(bot.inventory.items());
      if (weapon && bot.heldItem?.name !== weapon.item.name) await bot.equip(weapon.item as Item, 'hand');
      const cooldownMs = weapon?.cooldownMs ?? FIST_COOLDOWN_MS;

      const name = describe(victim);
      const startedAt = Date.now();
      let hits = 0;
      const swungWith = new Map<string, number>();
      let lastPosition = victim.position.clone();
      let outcome: 'killed' | 'timeout' | 'low_health' | 'lost' = 'timeout';

      bot.pathfinder.setGoal(new goals.GoalFollow(victim, 2), true);
      try {
        while (Date.now() - startedAt < timeoutMs) {
          if (!bot.entities[victim.id] || victim.isValid === false) { outcome = 'killed'; break; }
          if (bot.health <= minHealth) { outcome = 'low_health'; break; }
          lastPosition = victim.position.clone();
          const distance = bot.entity.position.distanceTo(victim.position);
          if (distance > maxDistance * 2) { outcome = 'lost'; break; }
          if (distance <= 3.2) {
            // chasing digs and climbs, and pathfinder equips a pickaxe or scaffolding blocks for that: take the
            // weapon back before every swing (in a cave fight 8 hits with dirt in hand didn't kill a zombie)
            if (weapon && bot.heldItem?.name !== weapon.item.name) {
              const again = bot.inventory.items().find(i => i.name === weapon.item.name);
              if (again) await bot.equip(again, 'hand');
            }
            await bot.lookAt(victim.position.offset(0, (victim.height ?? 1) * 0.8, 0), true);
            const held = bot.heldItem?.name ?? 'fist';
            bot.attack(victim);
            hits++;
            swungWith.set(held, (swungWith.get(held) ?? 0) + 1);
            await sleep(cooldownMs);
          } else {
            await sleep(100);
          }
        }
      } finally {
        bot.pathfinder.setGoal(null);
      }

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const hitText = `${hits} hit(s)` + (hits ? ` (${[...swungWith].map(([n, c]) => `${n} x${c}`).join(', ')})` : '');
      if (outcome === 'killed') {
        // walk over the spot so the drops get picked up
        try {
          await Promise.race([
            bot.pathfinder.goto(new goals.GoalNear(lastPosition.x, lastPosition.y, lastPosition.z, 1)),
            sleep(5000).then(() => { bot.pathfinder.setGoal(null); })
          ]);
          await sleep(500);
        } catch { /* drops out of reach: leave them */ }
        return factory.createResponse(`Killed ${name} with ${hitText} in ${seconds}s. ${vitals(bot)}`);
      }
      if (outcome === 'low_health') {
        // standing still here got the bot shot by a skeleton it wasn't fighting: say what else is around
        const threats = Object.values(bot.entities)
          .filter(e => e !== bot.entity && e.isValid !== false && isHostile(e) && e.position.distanceTo(bot.entity.position) <= 16)
          .map(e => `${describe(e)} ${e.position.distanceTo(bot.entity.position).toFixed(0)} blocks away`);
        return factory.createResponse(
          `Stopped attacking ${name} after ${hitText}: health is low. ${vitals(bot)}. ` +
          (threats.length ? `Hostiles nearby: ${threats.join(', ')}. Retreat or wall yourself in, then eat.` : 'No other hostiles within 16 blocks.')
        );
      }
      if (outcome === 'lost') {
        return factory.createResponse(`Lost track of ${name} after ${hitText}. ${vitals(bot)}`);
      }
      return factory.createResponse(`${name} still alive after ${seconds}s and ${hitText}. ${vitals(bot)}`);
    }
  );

  factory.registerTool(
    "eat",
    "Eat food from the inventory. Without `item`, picks the best safe food (skips rotten flesh, spider eyes, golden apples and the like).",
    {
      item: z.string().optional().describe("Food to eat, e.g. 'cooked_beef' (default: best available)")
    },
    async ({ item }) => {
      const bot = getBot();
      if (bot.game.gameMode === 'creative') return factory.createResponse(`No need to eat in creative mode`);

      const foods = minecraftData(bot.version).foodsByName as unknown as Record<string, FoodInfo>;
      const items = bot.inventory.items();
      let food: Item | null;
      if (item) {
        const wanted = item.toLowerCase().replace(/^minecraft:/, '');
        food = items.find(i => i.name === wanted) ?? null;
        if (!food) return factory.createResponse(`No ${wanted} in inventory`);
        if (!foods[food.name] && !ALWAYS_EDIBLE.has(food.name)) return factory.createResponse(`${food.name} isn't edible`);
      } else {
        food = chooseFood(items, foods, bot.food);
        if (!food) return factory.createResponse(`Nothing safe to eat in inventory. ${vitals(bot)}`);
      }

      if (bot.food >= 20 && !ALWAYS_EDIBLE.has(food.name)) {
        return factory.createResponse(`Not hungry. ${vitals(bot)}`);
      }

      const before = { food: bot.food, health: bot.health };
      await bot.equip(food, 'hand');
      await bot.consume();
      // the hunger update arrives just after the "finished eating" status
      await Promise.race([new Promise<void>(resolve => bot.once('health', () => resolve())), sleep(1000)]);
      await settleInventory(bot);
      return factory.createResponse(
        `Ate ${food.name}: food ${before.food} -> ${bot.food}, health ${Math.round(before.health * 10) / 10} -> ${Math.round(bot.health * 10) / 10}`
      );
    }
  );

  factory.registerTool(
    "get-status",
    "Get the bot's health, hunger, time of day (and how long until night), dimension and game mode",
    {},
    async () => {
      const bot = getBot();
      const timeOfDay = bot.time.timeOfDay;
      // monsters start spawning around tick 13000 and stop at 23000; a day is 24000 ticks = 20 minutes
      const night = timeOfDay >= 13000 && timeOfDay < 23000;
      const until = night ? 23000 - timeOfDay : (13000 - timeOfDay + 24000) % 24000;
      const minutes = (until / 20 / 60).toFixed(1);
      const lines = [
        vitals(bot) + `, saturation ${Math.round((bot.foodSaturation ?? 0) * 10) / 10}`,
        `Time of day ${timeOfDay} (${night ? `night; dawn in ${minutes} min` : `day; night in ${minutes} min`})`,
        `Dimension ${bot.game.dimension}, game mode ${bot.game.gameMode}, difficulty ${bot.game.difficulty}`
      ];
      return factory.createResponse(lines.join('\n'));
    }
  );
}
