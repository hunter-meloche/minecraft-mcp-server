import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import {
  BARITONE_JAR, BRIDGE_JAR, clientModDir, findLauncherJava, gameJar, gameLibraries, MC_VERSION, FABRIC_LOADER, offlineUuid, readVersionJson
} from './install.js';

/**
 * Starts the official Minecraft client from the installed game files, with Fabric, Baritone and the bridge mod, as
 * the bot. Only reads the install; everything the client writes goes to `gameDir`.
 */

export interface LaunchOptions {
  minecraftDir: string;
  /** bin directory of a Java 25 runtime; default: the one the launcher installed */
  javaBin?: string;
  /** the client's own game directory (options, logs, mods, schematics) */
  gameDir: string;
  username: string;
  /** "host:port" to join on start */
  server: string;
  bridgePort: number;
  /** offline account: no session join (servers that verify logins will refuse the bot) */
  offline: boolean;
  /** the game window opens minimized and ignores the user's mouse and keyboard (default true) */
  passive?: boolean;
  width?: number;
  height?: number;
}

export interface LaunchPlan {
  java: string;
  args: string[];
  cwd: string;
  token: string;
  tokenFile: string;
}

const OPTIONS = [
  'renderDistance:6', 'simulationDistance:5', 'maxFps:30', 'graphicsMode:0', 'soundCategory_master:0.0',
  'onboardAccessibility:false', 'skipMultiplayerWarning:true', 'joinedFirstServer:true', 'tutorialStep:none',
  'pauseOnLostFocus:false', 'narrator:0'
];

/** Copy the mods in, write options and the bridge token, and work out the java command. */
export function prepareLaunch(opts: LaunchOptions, modDir = clientModDir()): LaunchPlan {
  const javaBin = opts.javaBin ?? findLauncherJava(opts.minecraftDir);
  if (!javaBin) throw new Error('No Java 25 runtime found (start Minecraft 26.3 once from the official launcher, or pass --java)');
  const java = path.join(javaBin, process.platform === 'win32' ? 'java.exe' : 'java');

  const libs = path.join(modDir, 'libs');
  const bridgeJar = path.join(modDir, 'dist', BRIDGE_JAR);
  const baritoneJar = path.join(libs, BARITONE_JAR);
  if (!fs.existsSync(baritoneJar)) throw new Error('client mod libraries missing: run `node client-mod/fetch.mjs`');
  if (!fs.existsSync(bridgeJar)) throw new Error('client mod not built: run `npm run build && node client-mod/build.mjs`');

  const mods = path.join(opts.gameDir, 'mods');
  fs.mkdirSync(mods, { recursive: true });
  for (const f of fs.readdirSync(mods)) {
    if (/^(baritone-.*|claudebridge.*)\.jar$/.test(f)) fs.rmSync(path.join(mods, f));
  }
  fs.copyFileSync(baritoneJar, path.join(mods, BARITONE_JAR));
  fs.copyFileSync(bridgeJar, path.join(mods, BRIDGE_JAR));
  fs.mkdirSync(path.join(opts.gameDir, 'schematics'), { recursive: true });

  const optionsFile = path.join(opts.gameDir, 'options.txt');
  if (!fs.existsSync(optionsFile)) {
    const size = [`overrideWidth:${opts.width ?? 854}`, `overrideHeight:${opts.height ?? 480}`];
    fs.writeFileSync(optionsFile, [...OPTIONS, ...size].join('\n') + '\n');
  }

  const token = crypto.randomBytes(24).toString('hex');
  const tokenFile = path.join(opts.gameDir, 'claudebridge.token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });

  const version = readVersionJson(opts.minecraftDir);
  const fabricLibs = fs.readdirSync(libs).filter(f => f.endsWith('.jar') && f !== BARITONE_JAR).map(f => path.join(libs, f));
  const classpath = [...fabricLibs, ...gameLibraries(opts.minecraftDir, version), gameJar(opts.minecraftDir)].join(path.delimiter);
  const natives = path.join(opts.gameDir, 'natives');
  fs.mkdirSync(natives, { recursive: true });

  const args = [
    // macOS: the window (SDL) must run on the process's first thread, as the official launcher arranges
    ...(process.platform === 'darwin' ? ['-XstartOnFirstThread'] : []),
    '-Xmx2G', '-XX:StackShadowPages=32', '--enable-native-access=ALL-UNNAMED', '--add-exports', 'java.base/jdk.internal.misc=ALL-UNNAMED',
    `-Djava.library.path=${natives}`, `-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives}`, `-Djna.tmpdir=${natives}`,
    `-Dio.netty.native.workdir=${natives}`, `-Dfabric.gameVersion=${MC_VERSION}`,
    `-Dclaudebridge.port=${opts.bridgePort}`, `-Dclaudebridge.tokenFile=${tokenFile}`,
    ...(opts.offline ? ['-Dclaudebridge.offline=true'] : []),
    ...(opts.passive !== false ? ['-Dclaudebridge.passive=true'] : []),
    '-cp', classpath, 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    '--username', opts.username, '--version', `fabric-loader-${FABRIC_LOADER}-${MC_VERSION}`, '--gameDir', opts.gameDir,
    '--assetsDir', path.join(opts.minecraftDir, 'assets'), '--assetIndex', version.assetIndex.id,
    '--uuid', offlineUuid(opts.username), '--accessToken', '0', '--userType', 'legacy', '--versionType', 'release',
    '--quickPlayMultiplayer', opts.server
  ];
  return { java, args, cwd: opts.gameDir, token, tokenFile };
}

/** Start the client. Its output goes to `<gameDir>/client-stdout.log`. */
export function launchClient(plan: LaunchPlan): ChildProcess {
  const log = fs.openSync(path.join(plan.cwd, 'client-stdout.log'), 'w');
  return spawn(plan.java, plan.args, { cwd: plan.cwd, stdio: ['ignore', log, log], windowsHide: false });
}
