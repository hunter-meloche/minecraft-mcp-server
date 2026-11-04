import { z } from "zod";
import type mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { ToolFactory } from '../tool-factory.js';
import { settleInventory } from '../inventory-sync.js';
import { fight, armorInfo } from '../combat.js';
import { ALWAYS_EDIBLE, chooseFood, foodsFor } from '../food.js';
import { autoDefendEnabled, setAutoDefend } from '../auto-defend.js';
import { countCover, describeShelter, wallIn } from '../bunker.js';

export { isHostile, matchesTarget, bestWeapon } from '../combat.js';
export { chooseFood } from '../food.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function vitals(bot: mineflayer.Bot): string {
  return `Health ${Math.round(bot.health * 10) / 10}/20, food ${bot.food}/20`;
}

export function registerSurvivalTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "attack-entity",
    "Fight the nearest matching entity: a mob name like 'zombie' or 'cow', 'mob' for any creature, or 'hostile' to fight every monster in range until none are left (skips neutral mobs like endermen and piglins). Puts on the best armor and a shield first, re-equips the best weapon before each swing, raises the shield against ranged mobs, backs off from creepers after each hit, and picks up drops. At low health it stops, runs from the nearest threats and eats.",
    {
      target: z.string().describe("Entity to attack: a name like 'zombie', 'cow', 'skeleton', or 'hostile' / 'mob'"),
      maxDistance: z.coerce.number().finite().optional().describe("How far to look for targets (default: 16)"),
      timeoutMs: z.number().int().min(1000).optional().describe("Give up after this long (default: 30000)"),
      minHealth: z.coerce.number().finite().optional().describe("Stop fighting when health drops to this (default: 6 = three hearts)"),
      retreat: z.boolean().optional().describe("When stopping at low health, run from threats and eat (default: true)")
    },
    async ({ target, maxDistance = 16, timeoutMs = 30000, minHealth = 6, retreat = true }) => {
      const bot = getBot();
      const r = await fight(bot, target, { maxDistance, timeoutMs, minHealth, retreat });
      if (r.outcome === 'none') return factory.createResponse(`No ${target} within ${maxDistance} blocks`);

      const swings = r.hits
        ? `${r.hits} swing(s), ${r.landed} landed (${[...r.swungWith].map(([n, c]) => `${n} x${c}`).join(', ')})`
        : 'no swings';
      const lines: string[] = [];
      if (r.wore.length) lines.push(`Put on ${r.wore.join(', ')}.`);
      const killed = r.kills.length ? `Killed ${r.kills.join(', ')}` : '';
      switch (r.outcome) {
        case 'done': lines.push(`${killed} with ${swings} in ${r.seconds.toFixed(1)}s.` + (r.unreachable.length ? ` Couldn't get to ${r.unreachable.join(', ')}.` : '')); break;
        case 'low_health': lines.push(`${killed ? killed + '. ' : ''}Stopped fighting ${r.target} after ${swings}: health is low.` + (r.retreat ? ` Then ${r.retreat}.` : '')); break;
        case 'lost': lines.push(`${killed ? killed + '. ' : ''}Lost track of ${r.target} after ${swings}.`); break;
        case 'unreachable': lines.push(`Couldn't get to ${r.unreachable.join(', ')} (no way through, or not getting closer).`); break;
        default: lines.push(`${killed ? killed + '. ' : ''}${r.target} still alive after ${r.seconds.toFixed(1)}s and ${swings}.`);
      }
      lines.push(vitals(bot) + '.');
      if (r.threats.length) lines.push(`Hostiles nearby: ${r.threats.join(', ')}.` + (r.outcome === 'low_health' ? ' Wall yourself in or keep away until health recovers.' : ''));
      return factory.createResponse(lines.join(' '));
    }
  );

  factory.registerTool(
    "wall-in",
    "Shelter on the spot: put blocks on all four sides at feet and head height and a roof over the bot (dirt, cobblestone and similar first, planks last). Stops melee and arrows while health recovers, e.g. at night or when outnumbered. Needs up to 10 blocks; dig out with dig-block afterwards.",
    {},
    async () => {
      const bot = getBot();
      if (countCover(bot.inventory.items()) === 0) return factory.createResponse(`No blocks to wall in with (dirt, cobblestone, stone, planks, ...)`);
      return factory.createResponse(describeShelter(await wallIn(bot)));
    }
  );

  factory.registerTool(
    "set-auto-defend",
    "Turn the auto-defend reflex on or off. When on (the default), the bot hits any hostile within reach, and anything that just hurt it, while other tools run, and walls itself in if health drops to 6 while still under attack (when it has 5+ blocks). It doesn't chase; use attack-entity for that.",
    {
      enabled: z.boolean().describe("true to fight back automatically, false to never attack on its own")
    },
    async ({ enabled }) => {
      setAutoDefend(getBot(), enabled);
      return factory.createResponse(`Auto-defend ${enabled ? 'on' : 'off'}`);
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

      const foods = foodsFor(bot);
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
    "Get the bot's health, hunger, armor, time of day (and how long until night), dimension, game mode and whether auto-defend is on",
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
        `Dimension ${bot.game.dimension}, game mode ${bot.game.gameMode}, difficulty ${bot.game.difficulty}`,
        `Armor: ${armorWorn(bot)}; auto-defend ${autoDefendEnabled(bot) ? 'on' : 'off'}`
      ];
      return factory.createResponse(lines.join('\n'));
    }
  );
}

function armorWorn(bot: mineflayer.Bot): string {
  const worn = [5, 6, 7, 8, 45].map(slot => bot.inventory?.slots?.[slot]).filter((i): i is Item => !!i && (!!armorInfo(i.name) || i.name === 'shield'));
  return worn.length ? worn.map(i => i.name).join(', ') : 'none';
}
