import type { GoalContext } from './goals.js';
import type { Pos } from './memory.js';
import { reservedSites } from './progress.js';

/**
 * A first chest or furnace, before the yard has its own: crafted if it isn't carried, and put on solid ground 2 to 4
 * blocks from home with room over it, clear of the sites the yard's projects keep (the storage house, the plot...).
 * A new bot's pockets filled before its storage house could be built, and it had no furnace to cook its meat.
 */
export async function placeNearHome(ctx: Pick<GoalContext, 'call' | 'act' | 's' | 'world'>, item: string): Promise<Pos | undefined> {
  const home = ctx.s.home!;
  if (!(ctx.s.counts.get(item) ?? 0)) {
    const r = await ctx.act('craft-item', { outputItem: item, amount: 1 });
    if (!r.ok) return undefined;
  }
  const box = { x: home.x - 4, y: home.y - 1, z: home.z - 4, width: 9, height: 3, length: 9 };
  const { blocks } = await ctx.call<{ blocks: (string | null)[] }>('world.region', box);
  const at = (x: number, y: number, z: number) => (blocks[(x - box.x) + (z - box.z) * 9 + (y - box.y) * 81] ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
  const OPEN = /^(air|cave_air|short_grass|tall_grass|fern|leaf_litter|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|wildflowers|pink_petals|snow)$/;
  const SOLID = /^(dirt|grass_block|coarse_dirt|podzol|stone|cobblestone|deepslate|cobbled_deepslate|sand|sandstone|.*_planks|andesite|diorite|granite|tuff|mud|moss_block)$/;
  // the yard's zones, and the sites the project has picked (the storage house's, before it stands; one set aside midway)
  const kept = [...Object.values(ctx.world.zones ?? {}).flat(), ...reservedSites(ctx.world.progress)].filter(b => b.width && b.length);
  const inSite = (x: number, z: number) => kept.some(b => x >= b.x && x < b.x + b.width! && z >= b.z && z < b.z + b.length!);
  const spots: (Pos & { d: number })[] = [];
  for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
    const d = Math.max(Math.abs(dx), Math.abs(dz));
    const x = home.x + dx, z = home.z + dz;
    if (d < 2 || inSite(x, z)) continue;
    if (OPEN.test(at(x, home.y, z)) && OPEN.test(at(x, home.y + 1, z)) && SOLID.test(at(x, home.y - 1, z))) spots.push({ x, y: home.y, z, d });
  }
  for (const p of spots.sort((a, b) => a.d - b.d).slice(0, 4)) {
    const r = await ctx.act('place-block', { x: p.x, y: p.y, z: p.z, item });
    if (r.ok && /^Placed/.test(r.text)) return { x: p.x, y: p.y, z: p.z };
  }
  return undefined;
}

/** The first chest (the stash puts things in it until the storage house stands). */
export const firstChest = (ctx: Pick<GoalContext, 'call' | 'act' | 's' | 'world'>) => placeNearHome(ctx, 'chest');
