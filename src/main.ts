#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { ToolFactory } from './tool-factory.js';
import { MessageStore } from './message-store.js';
import { registerMineflayerTools } from './tools/register-all.js';
import os from 'os';
import path from 'path';
import { ClientConnection } from './client/client-connection.js';
import { registerClientTools } from './client/tools.js';
import { Brain } from './client/brain/brain.js';
import { registerBrainTools } from './client/brain/brain-tools.js';
import { jsonFileStore } from './build-protection.js';
import { defaultMinecraftDir } from './client/install.js';
import { takeAlerts } from './auto-defend.js';

setupStdioFiltering();

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

async function main() {
  const config = parseConfig();
  const messageStore = new MessageStore();
  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "2.0.4-mc26.3"
  });
  let cleanup: () => void;

  if (config.backend === 'client') {
    // the official game client with Baritone and the bridge mod (client-mod/) plays as the bot
    if (config.auth === 'microsoft') throw new Error('--backend client supports offline accounts only for now');
    const gameDir = config.clientDir ?? path.join(os.homedir(), '.minecraft-mcp-server', 'client');
    const connection = new ClientConnection(
      {
        minecraftDir: config.minecraftDir ?? defaultMinecraftDir(),
        javaBin: config.java,
        gameDir,
        username: config.username,
        server: `${config.host}:${config.port}`,
        bridgePort: config.bridgePort,
        offline: true,
        passive: !config.interactiveClient
      },
      { onLog: log, onChatMessage: (username, message) => messageStore.addMessage(username, message) }
    );
    connection.start();
    const factory = new ToolFactory(server, connection, () => (connection.isConnected() ? connection.alerts.take() : null));
    const dataDir = path.join(os.homedir(), '.minecraft-mcp-server');
    const runtime = registerClientTools(factory, connection.bridge, messageStore, {
      gameDir, protectionStore: jsonFileStore(), homesFile: path.join(dataDir, 'homes.json')
    });
    // the bot's own low-level AI: shelter at night, chores by day; steps back whenever the LLM acts
    const brain = new Brain(runtime, { memoryFile: path.join(dataDir, 'brain.json'), logFile: path.join(dataDir, 'brain.log') });
    runtime.setManualHook(tool => brain.manual(tool));
    registerBrainTools(factory, brain, runtime);
    if (config.autonomy) brain.setEnabled(true);
    cleanup = () => { brain.setEnabled(false); connection.cleanup(); };
  } else {
    const connection = new BotConnection(
      config,
      {
        onLog: log,
        onChatMessage: (username, message) => messageStore.addMessage(username, message)
      }
    );
    connection.connect();
    // every reply also says if the bot was hurt (or auto-defend fought) since the last call
    const factory = new ToolFactory(server, connection, () => {
      const bot = connection.getBot();
      return bot && connection.isConnected() ? takeAlerts(bot) : null;
    });
    registerMineflayerTools(factory, () => connection.getBot()!, messageStore);
    cleanup = () => connection.cleanup();
  }

  process.stdin.on('end', () => {
    cleanup();
    log('info', 'MCP Client has disconnected. Shutting down...');
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
