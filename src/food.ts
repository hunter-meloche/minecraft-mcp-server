import type mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import minecraftData from 'minecraft-data';

// food that hurts (poison, hunger, nausea, random teleport) or that's too valuable to eat without being asked
export const AVOID_UNLESS_ASKED = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit',
  'golden_apple', 'enchanted_golden_apple', 'golden_carrot'
]);
// the game lets you eat these with a full hunger bar
export const ALWAYS_EDIBLE = new Set(['golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'milk_bucket', 'potion', 'honey_bottle']);

export interface FoodInfo { foodPoints: number; saturation: number }

export function foodsFor(bot: mineflayer.Bot): Record<string, FoodInfo> {
  return minecraftData(bot.version).foodsByName as unknown as Record<string, FoodInfo>;
}

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
