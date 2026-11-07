import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findLauncherJava } from '../../src/client/install.js';

const make = (root: string, ...parts: string[]) => {
  const bin = path.join(root, ...parts);
  fs.mkdirSync(bin, { recursive: true });
  for (const exe of ['java', 'java.exe']) fs.writeFileSync(path.join(bin, exe), '');
  return bin;
};

test('findLauncherJava: the Windows and Linux layout, and the macOS JRE bundle', t => {
  const win = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-java-'));
  const plain = make(win, 'runtime', 'java-runtime-epsilon', 'windows-x64', 'java-runtime-epsilon', 'bin');
  t.is(findLauncherJava(win), plain);

  const mac = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-java-'));
  const bundle = make(mac, 'runtime', 'java-runtime-epsilon', 'mac-os-arm64', 'java-runtime-epsilon', 'jre.bundle', 'Contents', 'Home', 'bin');
  t.is(findLauncherJava(mac), bundle);
});
