import type mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { MessageStore } from '../message-store.js';
import { registerPositionTools } from './position-tools.js';
import { registerInventoryTools } from './inventory-tools.js';
import { registerBlockTools } from './block-tools.js';
import { registerEntityTools } from './entity-tools.js';
import { registerChatTools } from './chat-tools.js';
import { registerFlightTools } from './flight-tools.js';
import { registerGameStateTools } from './gamestate-tools.js';
import { registerCraftingTools } from './crafting-tools.js';
import { registerFurnaceTools } from './furnace-tools.js';
import { registerSurvivalTools } from './survival-tools.js';

/** Every tool of the mineflayer backend. */
export function registerMineflayerTools(factory: ToolFactory, getBot: () => mineflayer.Bot, messageStore: MessageStore): void {
  registerPositionTools(factory, getBot);
  registerInventoryTools(factory, getBot);
  registerBlockTools(factory, getBot);
  registerEntityTools(factory, getBot);
  registerChatTools(factory, getBot, messageStore);
  registerFlightTools(factory, getBot);
  registerGameStateTools(factory, getBot);
  registerCraftingTools(factory, getBot);
  registerFurnaceTools(factory, getBot);
  registerSurvivalTools(factory, getBot);
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/**
 * The mineflayer backend's tools as definitions (name, description, schema), so the client backend can offer the
 * exact same surface. Registration never touches the bot, so none is needed.
 */
export function mineflayerToolDefinitions(): ToolDefinition[] {
  const defs: ToolDefinition[] = [];
  const capture = {
    registerTool: (name: string, description: string, schema: Record<string, unknown>) => { defs.push({ name, description, schema }); },
    createResponse: (text: string) => ({ content: [{ type: 'text', text }] }),
    createErrorResponse: (e: Error | string) => ({ content: [{ type: 'text', text: String(e) }], isError: true })
  } as unknown as ToolFactory;
  const noBot = (): mineflayer.Bot => { throw new Error('definitions only'); };
  registerMineflayerTools(capture, noBot, new MessageStore());
  return defs;
}
