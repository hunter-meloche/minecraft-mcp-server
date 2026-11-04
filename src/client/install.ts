import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

/**
 * Where the official Minecraft install keeps what the client backend needs: the version metadata, the game jar and
 * its libraries, assets, and a Java runtime. Everything here only reads the install.
 */

export const MC_VERSION = '26.3';
export const FABRIC_LOADER = '0.20.1';

export function defaultMinecraftDir(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft');
  return path.join(os.homedir(), '.minecraft');
}

export interface VersionJson {
  mainClass: string;
  assetIndex: { id: string };
  javaVersion?: { component: string; majorVersion: number };
  libraries: {
    name: string;
    downloads?: { artifact?: { path: string } };
    rules?: { action: 'allow' | 'disallow'; os?: { name?: string; arch?: string } }[];
  }[];
}

export function readVersionJson(minecraftDir: string, version = MC_VERSION): VersionJson {
  const file = path.join(minecraftDir, 'versions', version, `${version}.json`);
  if (!fs.existsSync(file)) throw new Error(`Minecraft ${version} is not installed in ${minecraftDir} (launch it once from the official launcher)`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as VersionJson;
}

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x86_64';

/** Does a library rule list allow this OS? Later rules override earlier ones, like the launcher. */
export function libraryAllowed(rules: VersionJson['libraries'][number]['rules'], osName = OS_NAME, arch = ARCH): boolean {
  if (!rules?.length) return true;
  return rules.reduce((ok, r) => {
    const matches = !r.os || ((!r.os.name || r.os.name === osName) && (!r.os.arch || r.os.arch === arch));
    return matches ? r.action === 'allow' : ok;
  }, false);
}

/** Game libraries for this OS, as absolute paths (natives for other architectures left out). */
export function gameLibraries(minecraftDir: string, version: VersionJson, osName = OS_NAME, arch = ARCH): string[] {
  const otherArch = arch === 'arm64' ? /natives-[a-z]+-(x86|x86_64)\.jar$/ : /natives-[a-z]+-(arm64|x86)\.jar$/;
  return version.libraries
    .filter(l => libraryAllowed(l.rules, osName, arch))
    .map(l => l.downloads?.artifact?.path)
    .filter((p): p is string => !!p && !otherArch.test(p))
    .map(p => path.join(minecraftDir, 'libraries', p));
}

export function gameJar(minecraftDir: string, version = MC_VERSION): string {
  return path.join(minecraftDir, 'versions', version, `${version}.jar`);
}

/**
 * The Java runtime the official launcher installed for this version (26.x needs Java 25, "java-runtime-epsilon"),
 * looked up in the places the launchers keep runtimes. Returns the bin directory, or null.
 */
export function findLauncherJava(minecraftDir: string, component = 'java-runtime-epsilon'): string | null {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const roots = [
    path.join(minecraftDir, 'runtime'),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime')] : []),
    'C:\\Program Files (x86)\\Minecraft Launcher\\runtime',
    'C:\\XboxGames\\Minecraft Launcher\\Content\\runtime'
  ];
  for (const root of roots) {
    const base = path.join(root, component);
    if (!fs.existsSync(base)) continue;
    for (const platformDir of fs.readdirSync(base)) {
      const bin = path.join(base, platformDir, component, 'bin');
      if (fs.existsSync(path.join(bin, exe))) return bin;
      const flat = path.join(base, platformDir, 'bin'); // some layouts skip the inner folder
      if (fs.existsSync(path.join(flat, exe))) return flat;
    }
  }
  return null;
}

/** The UUID a server gives an offline player of this name (same as Java's UUID.nameUUIDFromBytes). */
export function offlineUuid(name: string): string {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Folder of this repository's client mod (sources, fetched libraries, built jar). */
export function clientModDir(): string {
  // dist/client/install.js -> repo root; src/client/install.ts (tests) -> repo root
  return path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'client-mod');
}

export const BARITONE_JAR = 'baritone-api-fabric-1.20.0.jar';
export const BRIDGE_JAR = 'claudebridge.jar';
