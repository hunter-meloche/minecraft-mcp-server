#!/usr/bin/env node
// Compile the bridge mod against the installed Minecraft 26.3 + Fabric + Baritone and package client-mod/dist/claudebridge.jar.
// Uses the launcher's Java 25 (it includes javac); no Gradle. Run `node client-mod/fetch.mjs` first, and `npm run build`
// (this script uses the compiled install helpers).
//   node client-mod/build.mjs [--minecraft-dir <dir>] [--java <bin dir>]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BARITONE_JAR, BRIDGE_JAR, defaultMinecraftDir, findLauncherJava, gameJar, gameLibraries, readVersionJson
} from '../dist/client/install.js';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const minecraftDir = arg('--minecraft-dir') ?? defaultMinecraftDir();
const javaBin = arg('--java') ?? findLauncherJava(minecraftDir);
if (!javaBin) throw new Error('No Java 25 found; pass --java <bin dir of a JDK 25>');
const exe = name => path.join(javaBin, process.platform === 'win32' ? `${name}.exe` : name);

const libs = path.join(HERE, 'libs');
if (!fs.existsSync(path.join(libs, BARITONE_JAR))) throw new Error('client-mod/libs is empty: run node client-mod/fetch.mjs');
const version = readVersionJson(minecraftDir);
const classpath = [
  ...fs.readdirSync(libs).filter(f => f.endsWith('.jar')).map(f => path.join(libs, f)),
  ...gameLibraries(minecraftDir, version),
  gameJar(minecraftDir)
].join(path.delimiter);

const sources = [];
const walk = dir => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.java')) sources.push(p); } };
walk(path.join(HERE, 'src'));

const classes = path.join(HERE, 'build', 'classes');
fs.rmSync(classes, { recursive: true, force: true });
fs.mkdirSync(classes, { recursive: true });
try {
  execFileSync(exe('javac'), ['--release', '25', '-Xlint:-options', '-cp', classpath, '-d', classes, ...sources], { stdio: 'inherit' });
} catch {
  console.error('client mod: compilation failed (errors above)');
  process.exit(1);
}
for (const f of fs.readdirSync(path.join(HERE, 'resources'))) fs.copyFileSync(path.join(HERE, 'resources', f), path.join(classes, f));

const dist = path.join(HERE, 'dist');
fs.mkdirSync(dist, { recursive: true });
const jar = path.join(dist, BRIDGE_JAR);
fs.rmSync(jar, { force: true });
execFileSync(exe('jar'), ['--create', '--file', jar, '-C', classes, '.'], { stdio: 'inherit' });
console.log(`built ${jar} (${sources.length} sources)`);
