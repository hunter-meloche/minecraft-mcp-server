import { z } from "zod";
import mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';

const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker']);

export function registerFurnaceTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "smelt-item",
    "Smelt items using a furnace-like block. Waits for and collects all the output. If no matching input is in the inventory, collects what the furnace is already smelting.",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      inputItem: z.string().trim().min(1).describe("Name of item to smelt"),
      inputCount: z.number().int().positive().optional().describe("Amount of input to smelt (default: 1)"),
      fuelItem: z.string().trim().min(1).describe("Name of fuel item"),
      fuelCount: z.number().int().positive().optional().describe("Amount of fuel to use (default: 1)"),
      takeOutput: z.boolean().optional().describe("Whether to take output when ready (default: true)"),
      timeoutMs: z.number().int().positive().optional().describe("Timeout waiting for output in ms (default: 60000)")
    },
    async ({
      x,
      y,
      z,
      inputItem,
      inputCount = 1,
      fuelItem,
      fuelCount = 1,
      takeOutput = true,
      timeoutMs = 60000
    }: {
      x: number;
      y: number;
      z: number;
      inputItem: string;
      inputCount?: number;
      fuelItem: string;
      fuelCount?: number;
      takeOutput?: boolean;
      timeoutMs?: number;
    }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();

      const furnacePos = new Vec3(x, y, z);
      const furnaceBlock = bot.blockAt(furnacePos);

      if (!furnaceBlock || !FURNACE_BLOCKS.has(furnaceBlock.name)) {
        return factory.createResponse(`No furnace block found at (${x}, ${y}, ${z})`);
      }

      const items = bot.inventory.items();
      // exact name first: a substring match let "coal" pick charcoal
      const pick = (query: string) => {
        const q = query.toLowerCase().replace(/^minecraft:/, '');
        return items.find((item) => item.name === q) ?? items.find((item) => item.name.includes(q));
      };
      const input = pick(inputItem);
      const fuel = pick(fuelItem);

      const furnace = await bot.openFurnace(furnaceBlock);
      const cleanup = () => {
        try {
          furnace.close();
        } catch {
          // ignore
        }
      };

      try {
        const existingInput = furnace.inputItem();
        const existingOutput = furnace.outputItem();
        // No matching input left in the inventory: collect what this furnace is already smelting
        const collecting = !input && (!!existingInput || !!existingOutput);
        if (!input && !collecting) {
          return factory.createResponse(`Couldn't find any item matching '${inputItem}' in inventory`);
        }
        if (input && existingInput && existingInput.name !== input.name) {
          return factory.createResponse(`Furnace input slot is occupied by ${existingInput.name}`);
        }

        const existingFuel = furnace.fuelItem();
        const burning = (furnace as unknown as { fuel?: number }).fuel ?? 0;
        if (!fuel && !existingFuel && burning <= 0 && (input || existingInput)) {
          return factory.createResponse(`Couldn't find any fuel item matching '${fuelItem}' in inventory`);
        }
        // a different fuel already in the slot: use it rather than refusing (it can't be stacked with ours)
        const addFuel = fuel && !(existingFuel && existingFuel.name !== fuel.name) ? fuel : null;

        let resolvedInputCount = 0;
        if (input) {
          resolvedInputCount = Math.min(inputCount, input.count);
          if (addFuel) await furnace.putFuel(addFuel.type, addFuel.metadata ?? null, Math.min(fuelCount, addFuel.count));
          await furnace.putInput(input.type, input.metadata ?? null, resolvedInputCount);
        }

        if (!takeOutput) {
          return factory.createResponse(
            `Started smelting ${resolvedInputCount} ${input?.name ?? existingInput?.name}${addFuel ? ` with ${Math.min(fuelCount, addFuel.count)} ${addFuel.name}` : ''}`
          );
        }

        // Keep collecting until the input slot is empty: each item takes ~10 s, and the furnace holds the
        // results back in its output slot (before, only the first finished item was returned).
        const total = Math.max(1, resolvedInputCount + (existingInput?.count ?? 0));
        const waitMs = Math.max(timeoutMs, total * 10500 + 5000);
        const deadline = Date.now() + waitMs;
        const countInInventory = (name: string) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
        const pause = (ticks: number) => typeof bot.waitForTicks === 'function' ? bot.waitForTicks(ticks) : Promise.resolve();
        let takenName = '';
        let before = 0;
        let reported = 0;
        while (Date.now() < deadline) {
          const output = await waitForOutput(furnace, deadline - Date.now());
          if (!output) break;
          if (!takenName) { takenName = output.name; before = countInInventory(takenName); }
          const taken = await furnace.takeOutput();
          reported += taken.count;
          // let the server's slot update arrive, or the stack just taken is still in the model and gets "taken" twice
          await pause(2);
          if (!furnace.inputItem()) break;
        }
        // report what actually arrived in the inventory; takeOutput() can count a stack the server already moved
        const arrived = takenName ? countInInventory(takenName) - before : 0;
        const takenCount = arrived > 0 ? arrived : reported;
        if (takenCount === 0) {
          return factory.createResponse(`No output after ${waitMs}ms`);
        }
        const left = furnace.inputItem();
        return factory.createResponse(`Smelted ${takenCount} ${takenName}${left ? ` (${left.count} ${left.name} still in the furnace; out of time or fuel)` : ''}`);
      } finally {
        cleanup();
      }
    }
  );
}

async function waitForOutput(furnace: mineflayer.Furnace, timeoutMs: number): Promise<Item | null> {
  const existing = furnace.outputItem();
  if (existing) {
    return existing;
  }

  return new Promise((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const onUpdate = () => {
      const output = furnace.outputItem();
      if (output) {
        cleanup();
        resolve(output);
      }
    };

    const cleanup = () => {
      furnace.removeListener('update', onUpdate);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    furnace.on('update', onUpdate);

    timeoutId = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}
