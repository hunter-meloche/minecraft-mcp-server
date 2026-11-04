import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements } = pathfinderPkg;
import minecraftData from 'minecraft-data';
import type { Block } from 'prismarine-block';
import { bestHarvestTool } from './best-tool.js';
import { installBuildProtection, jsonFileStore, worldIdFromSeed } from './build-protection.js';
import { installAutoDefend, rememberRegistry } from './auto-defend.js';
import { applyMovementSafety } from './movement-safety.js';

const SUPPORTED_MINECRAFT_VERSION = '26.3';

type ConnectionState = 'connected' | 'connecting' | 'disconnected';

interface BotConfig {
  host: string;
  port: number;
  username: string;
  mcVersion?: string;
  auth?: 'offline' | 'microsoft';
}

interface ConnectionCallbacks {
  onLog: (level: string, message: string) => void;
  onChatMessage: (username: string, message: string) => void;
}

export class BotConnection {
  private bot: mineflayer.Bot | null = null;
  private state: ConnectionState = 'disconnected';
  private config: BotConfig;
  private callbacks: ConnectionCallbacks;
  private isReconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectDelayMs: number;

  constructor(config: BotConfig, callbacks: ConnectionCallbacks, reconnectDelayMs = 2000) {
    this.config = config;
    this.callbacks = callbacks;
    this.reconnectDelayMs = reconnectDelayMs;
  }

  getBot(): mineflayer.Bot | null {
    return this.bot;
  }

  getState(): ConnectionState {
    return this.state;
  }

  getConfig(): BotConfig {
    return this.config;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  connect(): void {
    const botOptions = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      auth: this.config.auth ?? 'offline',
      ...(this.config.mcVersion ? { version: this.config.mcVersion } : {}),
      plugins: { pathfinder },
    };

    this.bot = mineflayer.createBot(botOptions);
    this.state = 'connecting';
    this.isReconnecting = false;

    this.registerEventHandlers(this.bot);
  }

  private registerEventHandlers(bot: mineflayer.Bot): void {
    // the login packet carries the world's hashed seed, which keys the saved list of blocks the bot built
    let worldId: string | undefined;
    bot._client?.once('login', (packet: { worldState?: { hashedSeed?: unknown }; hashedSeed?: unknown }) => {
      worldId = worldIdFromSeed(packet.worldState?.hashedSeed ?? packet.hashedSeed);
    });

    // damage type names arrive during login; auto-defend uses them to say what hurt the bot
    bot._client?.on('registry_data', (packet: { id?: string; entries?: { key: string }[] }) => rememberRegistry(bot, packet));

    // Since 1.21.4 the protocol maps difficulty to a name ('easy'), but mineflayer indexes its name array with it
    // and stores undefined. Its listener is attached later (plugins load after a timeout), so set the name in a
    // microtask, after every listener for this packet has run.
    bot._client?.on('difficulty', (packet: { difficulty?: unknown }) => {
      if (typeof packet.difficulty !== 'string') return;
      const name = packet.difficulty as typeof bot.game.difficulty;
      queueMicrotask(() => { bot.game.difficulty = name; });
    });

    bot.once('spawn', async () => {
      this.state = 'connected';
      this.callbacks.onLog('info', 'Bot spawned in world');

      const mcData = minecraftData(bot.version);
      const defaultMove = new Movements(bot, mcData);
      // no digging next to lava, short drops only, no parkour, both sides clear on diagonals
      applyMovementSafety(bot, defaultMove as unknown as Parameters<typeof applyMovementSafety>[1]);
      bot.pathfinder.setMovements(defaultMove);
      // pathfinder equips its bestHarvestTool before digging along a path; its version picks the first
      // inventory item when nothing digs faster, which swapped e.g. an apple into the hand
      bot.pathfinder.bestHarvestTool = (block: Block) => bestHarvestTool(bot, block);
      // never dig through blocks the bot placed itself (it walked into a fresh hut through the wall)
      installBuildProtection(bot, defaultMove as unknown as Parameters<typeof installBuildProtection>[1],
        { store: jsonFileStore(), world: worldId });
      // hit back at mobs within reach while other tools run (set-auto-defend turns it off)
      installAutoDefend(bot, (err) => this.callbacks.onLog('warn', `auto-defend: ${this.formatError(err)}`));

      bot.chat('LLM-powered bot ready to receive instructions!');
      this.callbacks.onLog('info', `Bot connected successfully. Username: ${this.config.username}, Server: ${this.config.host}:${this.config.port}`);
    });

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this.callbacks.onChatMessage(username, message);
    });

    bot.on('kicked', (reason) => {
      this.callbacks.onLog('error', `Bot was kicked from server: ${this.formatError(reason)}`);
      this.state = 'disconnected';
      bot.quit();
    });

    bot.on('error', (err) => {
      const errorCode = (err as { code?: string }).code || 'Unknown error';
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.callbacks.onLog('error', `Bot error [${errorCode}]: ${errorMsg}`);

      if (errorCode === 'ECONNREFUSED' || errorCode === 'ETIMEDOUT') {
        this.state = 'disconnected';
      }
    });

    bot.on('login', () => {
      this.callbacks.onLog('info', 'Bot logged in successfully');
    });

    bot.on('end', (reason) => {
      this.callbacks.onLog('info', `Bot disconnected: ${this.formatError(reason)}`);

      // Also when the connection drops before spawn; otherwise the state stays 'connecting' forever
      // and checkConnectionAndReconnect never retries.
      if (this.bot === bot) {
        this.state = 'disconnected';
      }

      if (this.bot === bot) {
        try {
          bot.removeAllListeners();
          this.bot = null;
          this.callbacks.onLog('info', 'Bot instance cleaned up after disconnect');
        } catch (err) {
          this.callbacks.onLog('warn', `Error cleaning up bot on end event: ${this.formatError(err)}`);
        }
      }
    });
  }

  attemptReconnect(): void {
    if (this.isReconnecting || this.state === 'connecting') {
      return;
    }

    this.isReconnecting = true;
    this.state = 'connecting';
    this.callbacks.onLog('info', `Attempting to reconnect to Minecraft server in ${this.reconnectDelayMs}ms...`);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      if (this.bot) {
        try {
          this.bot.removeAllListeners();
          this.bot.quit('Reconnecting...');
          this.callbacks.onLog('info', 'Old bot instance cleaned up');
        } catch (err) {
          this.callbacks.onLog('warn', `Error while cleaning up old bot: ${this.formatError(err)}`);
        }
      }

      this.callbacks.onLog('info', 'Creating new bot instance...');
      this.connect();
    }, this.reconnectDelayMs);
  }

  async checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }> {
    const currentState = this.state;

    if (currentState === 'disconnected') {
      this.attemptReconnect();

      const maxWaitTime = this.reconnectDelayMs + 5000;
      const pollInterval = 100;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        if (this.state === 'connected') {
          return { connected: true };
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

      const errorMessage =
        `Cannot connect to Minecraft server at ${this.config.host}:${this.config.port}\n\n` +
        `Please ensure:\n` +
        `1. Minecraft server is running on ${this.config.host}:${this.config.port}\n` +
        `2. Server is accessible from this machine\n` +
        `3. Server version is compatible (latest supported: ${SUPPORTED_MINECRAFT_VERSION})\n\n` +
        `For setup instructions, visit: https://github.com/yuniko-software/minecraft-mcp-server`;

      return { connected: false, message: errorMessage };
    }

    if (currentState === 'connecting') {
      return { connected: false, message: 'Bot is connecting to the Minecraft server. Please wait a moment and try again.' };
    }

    return { connected: true };
  }

  cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.bot) {
      try {
        this.bot.quit('Server shutting down');
      } catch (err) {
        this.callbacks.onLog('warn', `Error during cleanup: ${this.formatError(err)}`);
      }
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
