import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  mcVersion?: string;
  auth: 'offline' | 'microsoft';
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
    .help()
    .alias('help', 'h')
    .parseSync();
}
