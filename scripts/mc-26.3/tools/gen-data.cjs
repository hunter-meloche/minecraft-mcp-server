// Build minecraft-data style files for a version from the game's own data.
// node gen-data.cjs <dump.json> <reportsDir> <extractDir(lang+tags)> <outDir>
// Metadata that cannot be derived from the game (enchantCategories, repairWith, entity "type"/"category",
// loot drops, recipes, materials) is carried over from minecraft-data 26.1 by name, with ids remapped.
const fs = require('fs'), path = require('path')
const [dumpFile, reportsDir, extractDir, outDir] = process.argv.slice(2)
const BASE = path.join(__dirname, '../../../node_modules/minecraft-data/minecraft-data/data/pc/26.1') + '/'
const base = (f) => JSON.parse(fs.readFileSync(BASE + f + '.json', 'utf8'))
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const D = read(dumpFile)
const REG = read(path.join(reportsDir, 'registries.json'))
const BR = read(path.join(reportsDir, 'blocks.json'))
const LANG = read(path.join(extractDir, 'assets/minecraft/lang/en_us.json'))
const compDir = path.join(reportsDir, 'minecraft/components/item')
const comps = (name) => { try { return read(path.join(compDir, name + '.json')).components } catch { return {} } }
const reg = (k) => Object.entries(REG['minecraft:' + k].entries).sort((a, b) => a[1].protocol_id - b[1].protocol_id).map(([n, v]) => ({ id: v.protocol_id, name: n.replace('minecraft:', '') }))
const write = (f, d) => fs.writeFileSync(path.join(outDir, f + '.json'), JSON.stringify(d, null, 2) + '\n')
fs.mkdirSync(outDir, { recursive: true })

// ---- tags
const tagDir = path.join(extractDir, 'data/minecraft/tags/block')
const tagCache = {}
function tag (t) {
  if (tagCache[t]) return tagCache[t]
  const set = new Set()
  tagCache[t] = set
  let j
  try { j = read(path.join(tagDir, t + '.json')) } catch { return set }
  for (let v of j.values) {
    if (typeof v === 'object') v = v.id
    v = v.replace('minecraft:', '')
    if (v.startsWith('#')) for (const x of tag(v.slice(1).replace('minecraft:', ''))) set.add(x); else set.add(v)
  }
  return set
}

// ---- items
const baseItems = base('items'), baseItemByName = Object.fromEntries(baseItems.map(i => [i.name, i]))
const baseItemNameById = Object.fromEntries(baseItems.map(i => [i.id, i.name]))
const items = D.items.map(i => {
  const c = comps(i.name), b = baseItemByName[i.name]
  const nameKey = c['minecraft:item_name']?.translate
  const o = { id: i.id, name: i.name, displayName: b?.displayName ?? LANG[`item.minecraft.${i.name}`] ?? LANG[nameKey] ?? LANG[`block.minecraft.${i.name}`] ?? b?.displayName ?? i.name, stackSize: c['minecraft:max_stack_size'] ?? 64 }
  if (b?.enchantCategories) o.enchantCategories = b.enchantCategories
  if (b?.repairWith) o.repairWith = b.repairWith
  if (c['minecraft:max_damage'] !== undefined) o.maxDurability = c['minecraft:max_damage']
  return o
})
const itemByName = Object.fromEntries(items.map(i => [i.name, i]))
const remapItem = (oldId) => { const n = baseItemNameById[oldId]; const i = n && itemByName[n]; return i ? i.id : undefined }
write('items', items)

// ---- blocks
const baseBlocks = base('blocks'), baseBlockByName = Object.fromEntries(baseBlocks.map(b => [b.name, b]))
const tools = ['pickaxe', 'axe', 'shovel', 'hoe']
const tiers = [['wooden', 'wooden'], ['copper', 'copper'], ['stone', 'stone'], ['golden', 'gold'], ['iron', 'iron'], ['diamond', 'diamond'], ['netherite', 'netherite']]
function harvestToolsFor (name) {
  const out = {}
  for (const t of tools) {
    if (!tag(`mineable/${t}`).has(name)) continue
    for (const [prefix, tierTag] of tiers) {
      const item = itemByName[`${prefix}_${t}`]
      if (item && !tag(`incorrect_for_${tierTag}_tool`).has(name)) out[item.id] = true
    }
  }
  return out
}
function materialFor (name) {
  const m = tools.filter(t => tag(`mineable/${t}`).has(name)).map(t => `mineable/${t}`)
  return m.length ? m.join(';') : 'default'
}
function statesFor (name) {
  const rb = BR['minecraft:' + name]
  const props = rb.properties || {}
  // order properties the way state ids are laid out: slowest-changing first
  const stride = (p) => { const s = rb.states, v0 = s[0].properties[p]; let i = 0; while (i < s.length && s[i].properties[p] === v0) i++; return i }
  return Object.entries(props).sort((a, b) => stride(b[0]) - stride(a[0])).map(([n, values]) => {
    if (values.length === 2 && values.includes('true') && values.includes('false')) return { name: n, type: 'bool', num_values: 2 }
    if (values.every(v => /^\d+$/.test(v))) return { name: n, type: 'int', num_values: values.length, values }
    return { name: n, type: 'enum', num_values: values.length, values }
  })
}
const blocks = D.blocks.map(d => {
  const b = baseBlockByName[d.name]
  const item = itemByName[d.item]
  const hasItem = d.item !== 'air' && item
  const o = {
    id: d.id,
    name: d.name,
    displayName: LANG[d.translationKey] ?? b?.displayName ?? d.name,
    hardness: d.hardness,
    resistance: d.resistance,
    stackSize: hasItem ? item.stackSize : 64,
    diggable: (b ? b.diggable : d.hardness >= 0) && !['air', 'water', 'lava'].includes(d.name), // fluids can't be mined
    material: b ? b.material : materialFor(d.name),
    transparent: !d.canOcclude,
    emitLight: d.emitLight,
    filterLight: d.filterLight,
    defaultState: d.defaultState,
    minStateId: d.states[0].id,
    maxStateId: d.states.at(-1).id,
    states: statesFor(d.name)
  }
  if (d.requiresTool) {
    o.harvestTools = b?.harvestTools
      ? Object.fromEntries(Object.keys(b.harvestTools).map(k => [remapItem(+k), true]).filter(([k]) => k !== undefined))
      : harvestToolsFor(d.name)
  }
  o.drops = b ? b.drops.map(remapItem).filter(x => x !== undefined) : (hasItem ? [item.id] : [])
  o.boundingBox = d.states.find(s => s.id === d.defaultState).shape.length ? 'block' : 'empty'
  return o
})
write('blocks', blocks)

// ---- collision shapes (same layout as minecraft-data: shared shape table, per-block id or per-state ids)
const shapeIds = new Map(), shapes = {}
const shapeId = (boxes) => {
  const key = JSON.stringify(boxes)
  if (!shapeIds.has(key)) { const id = shapeIds.size; shapeIds.set(key, id); shapes[id] = boxes }
  return shapeIds.get(key)
}
shapeId([]); shapeId([[0, 0, 0, 1, 1, 1]])
const shapeBlocks = {}
for (const d of D.blocks) {
  const ids = d.states.map(s => shapeId(s.shape))
  shapeBlocks[d.name] = ids.every(x => x === ids[0]) ? ids[0] : ids
}
write('blockCollisionShapes', { blocks: shapeBlocks, shapes })

// ---- entities: metadata keys derived from synched-data accessor fields along the class chain
const acc = D.accessors
const classBySimple = {}
for (const cn of Object.keys(acc)) classBySimple[cn.split('.').pop().replace(/\$.*/, '').toLowerCase()] = classBySimple[cn.split('.').pop().replace(/\$.*/, '').toLowerCase()] || cn
const keyName = (f) => f.replace(/^DATA_/, '').replace(/_ID$/, '').toLowerCase()
function metadataKeysFor (cls) {
  const chain = []
  for (let c = cls; c && acc[c]; c = acc[c].super) chain.push(c)
  // accessor ids are assigned base-class first; walk the supers that have no accessors too
  const fields = []
  let c = cls
  const seen = new Set()
  while (c && !seen.has(c)) { seen.add(c); if (acc[c]) fields.push(...acc[c].fields); c = acc[c]?.super ?? superOf[c] }
  return fields.sort((a, b) => a.id - b.id).map(f => keyName(f.field))
}
const superOf = {}
for (const [cn, v] of Object.entries(acc)) superOf[cn] = v.super
const baseEnts = base('entities'), baseEntByName = Object.fromEntries(baseEnts.map(e => [e.name, e]))
const ANALOG = { poplar_boat: 'oak_boat', poplar_chest_boat: 'oak_chest_boat', sulfur_cube: 'slime', cushion: 'interaction' }
const entities = D.entities.map(e => {
  const b = baseEntByName[e.name] || baseEntByName[ANALOG[e.name]]
  return {
    id: e.id, internalId: e.id, name: e.name,
    displayName: LANG[e.translationKey] ?? b?.displayName ?? e.name,
    width: e.width, height: e.height,
    type: b?.type ?? 'other', category: b?.category ?? 'UNKNOWN',
    metadataKeys: b?.metadataKeys ?? []
  }
})
// 26.3 class-hierarchy changes found by diffing synched-data accessors between 26.1.2 and 26.3:
// slimes/magma cubes now extend AgeableMob (baby, age_locked before size); new cushion and sulfur cube.
const ENTITY_OVERRIDES = {
  slime: (e) => ({ metadataKeys: [...baseEntByName.slime.metadataKeys.slice(0, 16), 'baby', 'age_locked', 'size'] }),
  magma_cube: (e) => ({ metadataKeys: [...baseEntByName.magma_cube.metadataKeys.slice(0, 16), 'baby', 'age_locked', 'size'] }),
  sulfur_cube: (e) => ({ type: 'hostile', category: 'Hostile mobs', metadataKeys: [...baseEntByName.slime.metadataKeys.slice(0, 16), 'baby', 'age_locked', 'size', 'max_fuse', 'from_bucket'] }),
  cushion: (e) => ({ type: 'other', category: 'Immobile', metadataKeys: [...baseEntByName.leash_knot.metadataKeys.slice(0, 8), 'color'] })
}
if (D.entities.some(e => e.name === 'sulfur_cube')) {
  for (const e of entities) if (ENTITY_OVERRIDES[e.name]) Object.assign(e, ENTITY_OVERRIDES[e.name](e))
}
write('entities', entities)

// ---- simple registries
write('particles', reg('particle_type'))
write('sounds', reg('sound_event').map(s => ({ id: s.id + 1, name: s.name })))
const camel = (s) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase())
write('attributes', D.attributes.sort((a, b) => a.id - b.id).map(a => ({ name: camel(a.resource.replace('minecraft:', '')), resource: a.resource, min: a.min, max: a.max, default: a.default })))
write('language', LANG)

// ---- foods (from the food component)
const foods = []
for (const i of items) {
  const f = comps(i.name)['minecraft:food']
  if (!f) continue
  const sat = Math.round(f.saturation * 1e6) / 1e6
  foods.push({ id: i.id, name: i.name, stackSize: i.stackSize, displayName: i.displayName, foodPoints: f.nutrition, saturation: sat, effectiveQuality: Math.round((f.nutrition + sat) * 1e6) / 1e6, saturationRatio: f.nutrition ? Math.round(sat / f.nutrition * 1e6) / 1e6 : 0 })
}
write('foods', foods)

// ---- recipes + materials: carry over, remapping item ids by name
const remapDeep = (v) => {
  if (Array.isArray(v)) return v.map(remapDeep)
  if (typeof v === 'number') return remapItem(v) ?? null
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = k === 'id' ? (remapItem(x) ?? null) : (k === 'count' || k === 'metadata' ? x : remapDeep(x)); return o }
  return v
}
const recipes = {}
for (const [k, list] of Object.entries(base('recipes'))) {
  const nk = remapItem(+k)
  if (nk === undefined) continue
  recipes[nk] = list.map(remapDeep)
}
write('recipes', recipes)
const materials = {}
for (const [m, tbl] of Object.entries(base('materials'))) {
  materials[m] = Object.fromEntries(Object.entries(tbl).map(([k, v]) => [remapItem(+k), v]).filter(([k]) => k !== undefined))
}
write('materials', materials)

// ---- biomes: 26.1 entries plus any new vanilla biome files, re-numbered in registry (alphabetical) order
const biomeDir = path.join(extractDir, 'data/minecraft/worldgen/biome')
if (fs.existsSync(biomeDir)) {
  const baseBiomes = Object.fromEntries(base('biomes').map(b => [b.name, b]))
  const NEW_BIOME_CATEGORY = { dappled_forest: 'forest', sulfur_caves: 'underground' }
  const names = fs.readdirSync(biomeDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort()
  write('biomes', names.map((n, id) => {
    if (baseBiomes[n]) return { ...baseBiomes[n], id }
    const j = read(path.join(biomeDir, n + '.json'))
    return { id, name: n, category: NEW_BIOME_CATEGORY[n] ?? 'none', temperature: j.temperature, has_precipitation: j.has_precipitation, dimension: 'overworld', displayName: LANG[`biome.minecraft.${n}`] ?? n, color: j.effects?.sky_color ?? 0 }
  }))
}

console.log(`blocks ${blocks.length} states ${blocks.at(-1).maxStateId + 1} items ${items.length} entities ${entities.length} shapes ${shapeIds.size} foods ${foods.length}`)
module.exports = { metadataKeysFor, classBySimple }
