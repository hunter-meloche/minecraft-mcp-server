import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  mcVersion?: string;
  auth: 'offline' | 'microsoft';
  /** mineflayer (default) or client: a modded game client with Baritone (see client-mod/) */
  backend: 'mineflayer' | 'client';
  minecraftDir?: string;
  java?: string;
  clientDir?: string;
  bridgePort: number;
  /** client backend: let the user's mouse and keyboard reach the bot's game window (default: passive) */
  interactiveClient: boolean;
}

export function parseConfig(): ServerConfig {
  return yargs(hideBin(process.argv))
    .option('host', {
      type: 'string',
      description: 'Minecraft server host',
      default: 'localhost'
    })
    .option('port', {
      type: 'number',
      description: 'Minecraft server port',
      default: 25565
    })
    .option('username', {
      type: 'string',
      description: 'Bot username',
      default: 'LLMBot'
    })
    .option('mc-version', {
      type: 'string',
      description: 'Minecraft version to use (e.g. 26.3). Auto-detected from the server ping if omitted'
    })
    .option('auth', {
      type: 'string',
      choices: ['offline', 'microsoft'] as const,
      description: 'offline for offline-mode/LAN servers, microsoft for online-mode servers',
      default: 'offline' as const
    })
    .option('backend', {
      type: 'string',
      choices: ['mineflayer', 'client'] as const,
      description: 'mineflayer: protocol bot (default). client: the official game client with Baritone and the bridge mod',
      default: 'mineflayer' as const
    })
    .option('minecraft-dir', {
      type: 'string',
      description: 'client backend: the official Minecraft install to launch from (default: the standard .minecraft folder)'
    })
    .option('java', {
      type: 'string',
      description: 'client backend: bin folder of a Java 25 runtime (default: the one the Minecraft launcher installed)'
    })
    .option('client-dir', {
      type: 'string',
      description: 'client backend: game folder of the bot client (default: ~/.minecraft-mcp-server/client)'
    })
    .option('bridge-port', {
      type: 'number',
      description: 'client backend: loopback port of the bridge mod',
      default: 25599
    })
    .option('interactive-client', {
      type: 'boolean',
      description: "client backend: let your mouse and keyboard control the bot's game window (by default it opens minimized and ignores them)",
      default: false
    })
    .help()
    .alias('help', 'h')
    .parseSync();
}
