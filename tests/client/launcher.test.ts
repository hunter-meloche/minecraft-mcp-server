import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { prepareLaunch } from '../../src/client/launcher.js';
import { BARITONE_JAR, BRIDGE_JAR } from '../../src/client/install.js';

function fakeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-launch-'));
  const mc = path.join(root, 'mc');
  fs.mkdirSync(path.join(mc, 'versions', '26.3'), { recursive: true });
  fs.writeFileSync(path.join(mc, 'versions', '26.3', '26.3.json'), JSON.stringify({
    mainClass: 'net.minecraft.client.main.Main', assetIndex: { id: '34' },
    libraries: [{ name: 'a', downloads: { artifact: { path: 'org/a/a.jar' } } }]
  }));
  const mod = path.join(root, 'client-mod');
  fs.mkdirSync(path.join(mod, 'libs'), { recursive: true });
  fs.mkdirSync(path.join(mod, 'dist'), { recursive: true });
  for (const f of ['fabric-loader-0.20.1.jar', BARITONE_JAR]) fs.writeFileSync(path.join(mod, 'libs', f), 'jar');
  fs.writeFileSync(path.join(mod, 'dist', BRIDGE_JAR), 'jar');
  const java = path.join(root, 'java', 'bin');
  fs.mkdirSync(java, { recursive: true });
  const gameDir = path.join(root, 'game');
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'mods', 'claudebridge-0.1.0.jar'), 'old');
  return { mc, mod, java, gameDir };
}

test('prepareLaunch installs the mods, writes a token, and joins the server offline', (t) => {
  const f = fakeInstall();
  const plan = prepareLaunch({ minecraftDir: f.mc, javaBin: f.java, gameDir: f.gameDir, username: 'ClaudeBot', server: 'localhost:25565', bridgePort: 25599, offline: true }, f.mod);
  t.deepEqual(fs.readdirSync(path.join(f.gameDir, 'mods')).sort(), [BARITONE_JAR, BRIDGE_JAR].sort()); // old bridge jar replaced
  t.is(fs.readFileSync(plan.tokenFile, 'utf8'), plan.token);
  t.regex(plan.token, /^[0-9a-f]{48}$/);
  t.true(plan.args.includes('-Dclaudebridge.offline=true'));
  t.true(plan.args.includes(`-Dclaudebridge.tokenFile=${plan.tokenFile}`));
  const cp = plan.args[plan.args.indexOf('-cp') + 1].split(path.delimiter);
  t.true(cp[0].endsWith('fabric-loader-0.20.1.jar'));
  t.false(cp.some(p => p.endsWith(BARITONE_JAR))); // Baritone loads as a mod, not from the classpath
  t.true(cp.at(-1)!.endsWith(path.join('versions', '26.3', '26.3.jar')));
  t.deepEqual(plan.args.slice(plan.args.indexOf('--quickPlayMultiplayer'), plan.args.indexOf('--quickPlayMultiplayer') + 2), ['--quickPlayMultiplayer', 'localhost:25565']);
  t.is(plan.args[plan.args.indexOf('--uuid') + 1], '313c66c6-e732-3e25-9fbc-ee84b2e331bc');
  t.true(fs.readFileSync(path.join(f.gameDir, 'options.txt'), 'utf8').includes('pauseOnLostFocus:false'));
});

test('prepareLaunch explains what is missing', (t) => {
  const f = fakeInstall();
  fs.rmSync(path.join(f.mod, 'dist', BRIDGE_JAR));
  t.throws(() => prepareLaunch({ minecraftDir: f.mc, javaBin: f.java, gameDir: f.gameDir, username: 'B', server: 's:1', bridgePort: 1, offline: true }, f.mod),
    { message: /client mod not built/ });
});
