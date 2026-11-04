#!/usr/bin/env node
/*
 * Adds Minecraft Java 26.3 support to the installed Prismarine stack.
 * Runs automatically after `npm install` (postinstall) and is idempotent.
 *
 * Why this is needed (as of early Nov 2026):
 *  - minecraft-data 3.119.0 knows the 26.3 protocol number (777) but ships no
 *    26.3 data entry. Upstream's own pc_26_3 data branch shows the 26.3 wire
 *    protocol is identical to 26.1, so 26.3 can reuse every 26.1 data file.
 *  - mineflayer refuses servers newer than the last entry in testedVersions.
 *  - The tick_end fix that 26.3 servers require lives on mineflayer master
 *    (PRs #4137, #4162), which package.json pins; it is not in 4.39.0.
 *
 * Delete this script and the overrides once mineflayer > 4.39.0 and a
 * minecraft-data release with 26.3 are on npm.
 */
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const NEW = '26.3'
const BASE = '26.1'
const PROTOCOL = 777
const root = path.resolve(__dirname, '..', 'node_modules')

function findPackages (name, dir = root, found = []) {
  if (!fs.existsSync(dir)) return found
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = path.join(dir, entry.name)
    if (entry.name === name && fs.existsSync(path.join(full, 'package.json'))) found.push(full)
    if (entry.name.startsWith('@')) findPackages(name, full, found)
    const nested = path.join(full, 'node_modules')
    if (fs.existsSync(nested)) findPackages(name, nested, found)
  }
  return found
}

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'))
const writeJson = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n')

function addToVersionList (file, after) {
  if (!fs.existsSync(file)) return false
  const src = fs.readFileSync(file, 'utf8')
  if (src.includes(`'${NEW}'`)) return false
  const out = src.replace(`'${after}']`, `'${after}', '${NEW}']`)
  if (out === src) throw new Error(`Could not find '${after}'] in ${file}; the patch needs updating`)
  fs.writeFileSync(file, out)
  return true
}

let changed = 0

for (const pkg of findPackages('minecraft-data')) {
  const data = path.join(pkg, 'minecraft-data', 'data')
  const dataPathsFile = path.join(data, 'dataPaths.json')
  if (!fs.existsSync(dataPathsFile)) continue
  const dataPaths = readJson(dataPathsFile)
  if (!dataPaths.pc[BASE]) throw new Error(`${pkg} has no ${BASE} data; install minecraft-data >= 3.114`)
  if (dataPaths.pc[NEW]) continue

  const verDir = path.join(data, 'pc', NEW)
  fs.mkdirSync(verDir, { recursive: true })
  writeJson(path.join(verDir, 'version.json'), {
    version: PROTOCOL, minecraftVersion: NEW, majorVersion: NEW, releaseType: 'release'
  })
  dataPaths.pc[NEW] = { ...dataPaths.pc[BASE], version: `pc/${NEW}` }
  writeJson(dataPathsFile, dataPaths)

  const versionsFile = path.join(data, 'pc', 'common', 'versions.json')
  const versions = readJson(versionsFile)
  if (!versions.includes(NEW)) {
    versions.splice(versions.indexOf(BASE) + 1, 0, NEW)
    writeJson(versionsFile, versions)
  }

  const pvFile = path.join(data, 'pc', 'common', 'protocolVersions.json')
  const pv = readJson(pvFile)
  if (!pv.some(v => v.minecraftVersion === NEW)) {
    const baseEntry = pv.find(v => v.minecraftVersion === BASE)
    pv.splice(pv.indexOf(baseEntry), 0, { ...baseEntry, minecraftVersion: NEW, majorVersion: NEW, version: PROTOCOL })
    writeJson(pvFile, pv)
  }

  execFileSync(process.execPath, [path.join(pkg, 'bin', 'generate_data.js')], { stdio: 'inherit' })
  console.log(`[mc-26.3] minecraft-data: added ${NEW} -> ${path.relative(root, pkg)}`)
  changed++
}

for (const pkg of findPackages('mineflayer')) {
  if (addToVersionList(path.join(pkg, 'lib', 'version.js'), BASE)) {
    console.log(`[mc-26.3] mineflayer: added ${NEW} to testedVersions -> ${path.relative(root, pkg)}`)
    changed++
  }
  const physics = fs.readFileSync(path.join(pkg, 'lib', 'plugins', 'physics.js'), 'utf8')
  if (!physics.includes("'tick_end'")) {
    console.warn(`[mc-26.3] WARNING: ${path.relative(root, pkg)} never sends tick_end; 26.3 servers will kick it. Use mineflayer master or > 4.39.0.`)
  }
}

for (const pkg of findPackages('minecraft-protocol')) {
  if (addToVersionList(path.join(pkg, 'src', 'version.js'), BASE)) {
    console.log(`[mc-26.3] minecraft-protocol: added ${NEW} to supportedVersions -> ${path.relative(root, pkg)}`)
    changed++
  }
}

// prismarine-chunk 1.41.0 maps chunk formats by major version; 26.3 uses the
// same format as 26.1 (its internals already gate on version >= 26.1).
for (const pkg of findPackages('prismarine-chunk')) {
  const file = path.join(pkg, 'src', 'index.js')
  const src = fs.readFileSync(file, 'utf8')
  if (src.includes(`'${NEW}':`)) continue
  const line = `    ${BASE}: require('./pc/1.18/chunk')`
  if (!src.includes(line)) throw new Error(`Unexpected prismarine-chunk layout in ${file}; the patch needs updating`)
  fs.writeFileSync(file, src.replace(line, `${line},\n    '${NEW}': require('./pc/1.18/chunk')`))
  console.log(`[mc-26.3] prismarine-chunk: mapped ${NEW} -> ${path.relative(root, pkg)}`)
  changed++
}

// prismarine-physics 1.11.1 lists feature versions explicitly; extend every
// feature that covers 26.1 to 26.3 (otherwise: "No liquid gravity settings").
for (const pkg of findPackages('prismarine-physics')) {
  const file = path.join(pkg, 'lib', 'features.json')
  if (!fs.existsSync(file)) continue
  const features = readJson(file)
  let touched = false
  for (const f of features) {
    if (f.versions.includes(BASE) && !f.versions.includes(NEW)) { f.versions.push(NEW); touched = true }
  }
  if (touched) {
    writeJson(file, features)
    console.log(`[mc-26.3] prismarine-physics: extended 26.1 features to ${NEW} -> ${path.relative(root, pkg)}`)
    changed++
  }
}

console.log(changed ? `[mc-26.3] done (${changed} change(s))` : '[mc-26.3] already patched')
