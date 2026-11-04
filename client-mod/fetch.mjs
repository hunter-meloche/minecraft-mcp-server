#!/usr/bin/env node
// Download what the client mod builds and runs against into client-mod/libs, checking every file's SHA-1:
//   - Fabric Loader 0.20.1 and its libraries (maven.fabricmc.net), as listed by Fabric's launch profile for 26.3
//   - Baritone 1.20.0 api-fabric (GitHub release of cabaletta/baritone), checked against the release's checksums.txt
// Files already present with the right hash are kept.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const LIBS = path.join(HERE, 'libs');
const MC = '26.3';
const LOADER = '0.20.1';
const BARITONE = { tag: 'v1.20.0', file: 'baritone-api-fabric-1.20.0.jar' };

const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'minecraft-mcp-server client-mod fetch' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchChecked(url, dest, expectedSha1) {
  if (fs.existsSync(dest) && sha1(fs.readFileSync(dest)) === expectedSha1) return 'kept';
  const data = await get(url);
  const actual = sha1(data);
  if (actual !== expectedSha1) throw new Error(`${path.basename(dest)}: SHA-1 ${actual}, expected ${expectedSha1}`);
  fs.writeFileSync(dest, data);
  return 'downloaded';
}

fs.mkdirSync(LIBS, { recursive: true });

// Fabric: the profile lists maven coordinates; each artifact has a .sha1 next to it on the maven
const profile = JSON.parse((await get(`https://meta.fabricmc.net/v2/versions/loader/${MC}/${LOADER}/profile/json`)).toString());
for (const lib of profile.libraries) {
  const [group, artifact, version] = lib.name.split(':');
  const url = `${lib.url}${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
  const expected = (await get(`${url}.sha1`)).toString().trim().slice(0, 40);
  console.log(`${await fetchChecked(url, path.join(LIBS, `${artifact}-${version}.jar`), expected)}  ${artifact}-${version}.jar`);
}

// Baritone: checksums.txt in the release lists SHA-1 per asset
const base = `https://github.com/cabaletta/baritone/releases/download/${BARITONE.tag}`;
const sums = (await get(`${base}/checksums.txt`)).toString();
const line = sums.split('\n').find(l => l.trim().endsWith(BARITONE.file));
if (!line) throw new Error(`${BARITONE.file} not in checksums.txt`);
console.log(`${await fetchChecked(`${base}/${BARITONE.file}`, path.join(LIBS, BARITONE.file), line.trim().split(/\s+/)[0])}  ${BARITONE.file}`);
