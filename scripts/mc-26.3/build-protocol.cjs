'use strict'
/*
 * Builds the minecraft-data protocol.json for Java 26.3 (protocol 777) from the 26.1 one (775).
 *
 * Every change below was found by diffing the vanilla 26.1.2 and 26.3 client jars (both are
 * unobfuscated): packet ids come from the game's own packet report, registry-backed id tables from
 * its registry report (both in registry-inputs.json), and field-level changes from the packet
 * classes' StreamCodecs. Usage: buildProtocol(protocol26_1) -> protocol26_3 (input is not mutated).
 */
const INPUTS = require('./registry-inputs.json')

// 26.3 packets that have no 26.1 counterpart, keyed by "<state>.<direction>" and Mojang name
const NEW_PACKET_NAMES = {
  'configuration.clientbound': { post_effects: 'post_effects' },
  'play.clientbound': { add_transient_block: 'add_transient_block', post_effects: 'post_effects', swing_animation: 'swing_animation' },
  'play.serverbound': { punch: 'punch', spectator_action: 'spectator_action' }
}
const STATES = { configuration: 'configuration', play: 'play', login: 'login', status: 'status' }
const DIRS = { clientbound: 'toClient', serverbound: 'toServer' }

const clone = (x) => JSON.parse(JSON.stringify(x))
const hex = (i) => '0x' + i.toString(16).padStart(2, '0')
const fieldsOf = (container) => container[1]
const field = (container, name) => {
  const f = fieldsOf(container).find(x => x.name === name)
  if (!f) throw new Error(`field ${name} not found`)
  return f
}
const insertBefore = (container, name, def) => {
  const i = fieldsOf(container).findIndex(x => x.name === name)
  if (i < 0) throw new Error(`field ${name} not found`)
  fieldsOf(container).splice(i, 0, def)
}
const mapper = (names) => Object.fromEntries(names.map((n, i) => [String(i), n]))

function remapPackets (P) {
  for (const [key, newNames] of Object.entries(INPUTS.packets['26.3'])) {
    const [st, dir] = key.split('.')
    if (!STATES[st]) continue
    const ns = P[STATES[st]][DIRS[dir]]
    const pkt = ns.types.packet
    const ids = pkt[1][0].type[1].mappings
    const sw = pkt[1][1].type[1].fields
    const oldMd = Object.entries(ids).sort((a, b) => parseInt(a[0]) - parseInt(b[0])).map(e => e[1])
    const oldMojang = INPUTS.packets['26.1.2'][key]
    if (oldMd.length !== oldMojang.length) throw new Error(`${key}: 26.1 has ${oldMd.length} packets, 26.1.2 report ${oldMojang.length}`)
    const toMd = Object.fromEntries(oldMojang.map((n, i) => [n, oldMd[i]]))
    const extra = NEW_PACKET_NAMES[key] || {}
    const md = newNames.map(n => toMd[n] ?? extra[n] ?? (() => { throw new Error(`${key}: no name for new packet ${n}`) })())
    const newIds = {}, newSw = {}
    // keep each existing packet's type reference (shared packets point at types.packet_common_*)
    md.forEach((n, i) => { newIds[hex(i)] = n; newSw[n] = sw[n] ?? 'packet_' + n })
    for (const gone of oldMd.filter(n => !md.includes(n))) if (sw[gone] === 'packet_' + gone) delete ns.types['packet_' + gone]
    pkt[1][0].type[1].mappings = newIds
    pkt[1][1].type[1].fields = newSw
  }
}

function buildProtocol (p261) {
  const P = clone(p261)
  remapPackets(P)
  const T = P.types, C = P.play.toClient.types, S = P.play.toServer.types

  // --- shared types
  // implemented in scripts/mc-26.3/datatypes.js, installed into minecraft-protocol by patch-mc-26.3.cjs
  T.entityMoveDelta = 'native'
  T.bitSetLongs = 'native'
  T.ResolvableInt = ['container', [{ name: 'isConstant', type: 'bool' }, { name: 'value', type: ['switch', { compareTo: 'isConstant', fields: { true: 'i32' }, default: 'string' }] }]]
  T.ResolvableFloat = ['container', [{ name: 'isConstant', type: 'bool' }, { name: 'value', type: ['switch', { compareTo: 'isConstant', fields: { true: 'f32' }, default: 'string' }] }]]
  T.SignText = ['container', [
    { name: 'messages', type: ['array', { count: 4, type: 'anonymousNbt' }] },
    { name: 'filteredMessages', type: ['array', { count: 4, type: 'anonymousNbt' }] },
    { name: 'color', type: 'DyeColor' },
    { name: 'hasGlowingText', type: 'bool' }
  ]]
  T.PositionPath = ['container', [
    { name: 'type', type: ['mapper', { type: 'varint', mappings: { 0: 'linear', 1: 'stepped' } }] },
    { name: 'data', type: ['switch', { compareTo: 'type', fields: { linear: 'vec3f64', stepped: ['array', { countType: 'varint', type: ['container', [{ name: 'position', type: 'vec3f64' }, { name: 'tickOffset', type: 'varint' }]] }] } }] }
  ]]

  // Particles: registry ids shifted (+11 types); geyser particles carry options
  const particle = T.Particle[1]
  particle[0].type[1].mappings = mapper(INPUTS.registries.particle_type['26.3'].map(n => n.replace('minecraft:', '')))
  Object.assign(particle[1].type[1].fields, {
    geyser: ['container', [{ name: 'waterBlocks', type: 'i32' }]],
    geyser_plume: ['container', [{ name: 'waterBlocks', type: 'i32' }]],
    geyser_base: ['container', [{ name: 'waterBlocks', type: 'i32' }, { name: 'burstImpulseBase', type: 'f32' }]],
    geyser_poof: ['container', [{ name: 'waterBlocks', type: 'i32' }, { name: 'burstImpulseBase', type: 'f32' }]]
  })

  // Data components: registry rebuilt (+14 / -2), new component codecs
  T.SlotComponentType[1].mappings = mapper(INPUTS.registries.data_component_type['26.3'].map(n => n.replace('minecraft:', '')))
  const comp = T.SlotComponent[1][1].type[1].fields
  const swing = comp.swing_animation
  delete comp.swing_animation
  delete comp.map_color
  Object.assign(comp, {
    attack_animation: swing,
    interact_animation: swing,
    block_transformer: 'varint',
    villager_food: ['container', [{ name: 'nutrition', type: 'varint' }]],
    sulfur_cube_content: 'ItemStackTemplate',
    compostable: ['container', [{ name: 'layers', type: 'ResolvableInt' }]],
    cooking_fuel: ['container', [{ name: 'burnTime', type: 'ResolvableInt' }, { name: 'speedMultiplier', type: 'ResolvableFloat' }]],
    brewing_fuel: ['container', [{ name: 'uses', type: 'ResolvableInt' }, { name: 'speedMultiplier', type: 'ResolvableFloat' }]],
    mob_visibility: ['container', [{ name: 'targetingEntityTypes', type: 'IDSet' }, { name: 'visibility', type: 'f32' }]],
    provides_pottery_pattern: 'varint',
    sign_text_front: 'SignText',
    sign_text_back: 'SignText',
    waxed: 'void',
    'cushion/color': 'DyeColor'
  })
  // PotDecorations: was a list of item ids, now four Optional<ItemStackTemplate> (back, left, right, front)
  comp.pot_decorations = ['container', ['back', 'left', 'right', 'front'].map(name => ({ name, type: ['option', 'ItemStackTemplate'] }))]
  // StatePropertiesPredicate$RangedMatcher: min/max are Optional<String> (already so in 26.1.2; minecraft-data had plain strings)
  const ranged = T.ItemBlockProperty[1].find(f => f.name === 'value').type[1].fields.false[1]
  for (const f of ranged) if (f.name === 'minValue' || f.name === 'maxValue') f.type = ['option', 'string']
  insertBefore(T.InstrumentData, 'description', { name: 'durabilityDamage', type: 'varint' })
  T.ArmorTrimMaterial = ['container', [{ name: 'assetName', type: 'string' }, { name: 'description', type: 'anonymousNbt' }]]
  C.SlotDisplay[1][1].type[1].fields.tag = 'IDSet'

  // Entity metadata: new DYE_COLOR serializer (id 43)
  const meta = T.entityMetadataEntry[1]
  meta[1].type[1].mappings['43'] = 'dye_color'
  meta[2].type[1].fields.dye_color = 'DyeColor'

  // Command argument parsers: registry rebuilt (+6 / -1, all new ones are property-less)
  const parsers = INPUTS.registries.command_argument_type
  const nodeParser = JSON.stringify(T.command_node).includes('brigadier:bool') && findMapper(T.command_node, 'brigadier:bool')
  if (!nodeParser) throw new Error('command_node parser mapper not found')
  const old = Object.values(nodeParser.mappings)
  if (old.length !== parsers['26.1.2'].length) throw new Error('26.1 parser table does not match the 26.1.2 registry')
  // keep minecraft-data's names where they differ from the registry (e.g. minecraft:nbt for nbt_compound_tag)
  nodeParser.mappings = mapper(parsers['26.3'].map(n => { const i = parsers['26.1.2'].indexOf(n); return i >= 0 ? old[i] : n }))

  // Attributes: registry rebuilt (+5, every id shifted); keep minecraft-data's legacy names
  const attrMapper = findMapper(C.packet_entity_update_attributes, 'generic.armor')
  const oldAttrNames = Object.values(attrMapper.mappings)
  const oldAttrs = INPUTS.registries.attribute['26.1.2']
  attrMapper.mappings = mapper(INPUTS.registries.attribute['26.3'].map(r => {
    const i = oldAttrs.indexOf(r)
    return i >= 0 ? oldAttrNames[i] : r.replace('minecraft:', '')
  }))

  // --- login: login_finished gained the session id
  P.login.toClient.types.packet_success[1].push({ name: 'sessionId', type: 'UUID' })

  // --- configuration / play: new post_effects packet
  const postEffects = ['container', [{ name: 'effects', type: ['array', { countType: 'varint', type: 'string' }] }]]
  P.configuration.toClient.types.packet_post_effects = postEffects
  C.packet_post_effects = clone(postEffects)

  // --- play clientbound
  // ByteBufCodecs.BIT_SET is now a byte array (was a long array): light masks and the chat filter mask
  const LONGS = JSON.stringify(['array', { countType: 'varint', type: 'i64' }])
  for (const pkt of [C.packet_map_chunk, C.packet_update_light]) {
    for (const f of fieldsOf(pkt)) if (/Mask$/.test(f.name) && JSON.stringify(f.type) === LONGS) f.type = 'bitSetLongs'
  }
  const filterMask = field(C.packet_player_chat, 'filterTypeMask').type[1].fields
  if (JSON.stringify(filterMask['2']) !== LONGS) throw new Error('unexpected player_chat filterTypeMask')
  filterMask['2'] = 'bitSetLongs'

  insertBefore(C.packet_login, 'enforcesSecureChat', { name: 'onlineMode', type: 'bool' })
  field(C.SpawnInfo, 'gamemode').type[1].type = 'varint' // GameType.STREAM_CODEC (id mapper)
  field(C.SpawnInfo, 'previousGamemode').type = 'optvarint' // GameType.OPTIONAL_STREAM_CODEC: 0 = none, else id + 1
  C.packet_explosion[1].push({ name: 'playSound', type: 'bool' })
  C.packet_sync_entity_position = ['container', [
    { name: 'entityId', type: 'varint' }, { name: 'path', type: 'PositionPath' },
    { name: 'yaw', type: 'f32' }, { name: 'pitch', type: 'f32' }, { name: 'onGround', type: 'bool' }
  ]]
  C.packet_rel_entity_move = ['container', [{ name: 'entityId', type: 'varint' }, { name: 'delta', type: 'entityMoveDelta' }]]
  C.packet_entity_move_look = ['container', [{ name: 'entityId', type: 'varint' }, { name: 'delta', type: 'entityMoveDelta' }, { name: 'yaw', type: 'i8' }, { name: 'pitch', type: 'i8' }]]
  C.packet_entity_look = ['container', [{ name: 'entityId', type: 'varint' }, { name: 'onGround', type: 'bool' }, { name: 'yaw', type: 'i8' }, { name: 'pitch', type: 'i8' }]]
  C.packet_world_particles = ['container', [
    { name: 'particle', type: 'Particle' },
    { name: 'longDistance', type: 'bool' }, { name: 'alwaysShow', type: 'bool' },
    { name: 'x', type: 'f64' }, { name: 'y', type: 'f64' }, { name: 'z', type: 'f64' },
    { name: 'offsetX', type: 'f32' }, { name: 'offsetY', type: 'f32' }, { name: 'offsetZ', type: 'f32' },
    { name: 'velocityOffset', type: 'f32' }, { name: 'velocityOffsetY', type: 'f32' }, { name: 'velocityOffsetZ', type: 'f32' },
    { name: 'amount', type: 'varint' },
    { name: 'randomization', type: ['mapper', { type: 'varint', mappings: { 0: 'default', 1: 'alternative', 2: 'alternative_with_speed' } }] }
  ]]
  // teams: prefix/suffix moved up, colour is now Optional<TeamColor>, flags last
  const teamSwitch = C.packet_teams[1].find(f => f.anon).type[1].fields
  for (const mode of ['add', 'change']) {
    const f = Object.fromEntries(teamSwitch[mode][1].map(x => [x.name, x]))
    teamSwitch[mode] = ['container', [f.name, f.prefix, f.suffix, f.nameTagVisibility, f.collisionRule, { name: 'formatting', type: ['option', 'varint'] }, f.flags]]
  }
  // advancements: x/y moved from the display data to each added entry
  const adv = field(C.packet_advancements, 'advancementMapping').type[1].type
  const display = field(field(adv, 'value').type, 'displayData').type[1]
  display[1] = display[1].filter(x => x.name !== 'xCord' && x.name !== 'yCord')
  adv[1].push({ name: 'xCord', type: 'f32' }, { name: 'yCord', type: 'f32' })
  C.packet_add_transient_block = ['container', [{ name: 'location', type: 'position' }, { name: 'blockState', type: 'varint' }]]
  C.packet_swing_animation = ['container', [
    { name: 'entityId', type: 'varint' },
    { name: 'hand', type: ['mapper', { type: 'varint', mappings: { 0: 'main_hand', 1: 'off_hand' } }] },
    { name: 'animation', type: swing }
  ]]

  // --- play serverbound
  S.packet_teleport_confirm = ['container', [
    { name: 'teleportId', type: 'varint' },
    { name: 'x', type: 'f64' }, { name: 'y', type: 'f64' }, { name: 'z', type: 'f64' },
    { name: 'yaw', type: 'f32' }, { name: 'pitch', type: 'f32' }
  ]]
  const sign = Object.fromEntries(S.packet_update_sign[1].map(x => [x.name, x]))
  // SignTextSlot is an id mapper (0 back, 1 front): same single byte as the old bool, now after the lines
  S.packet_update_sign = ['container', [sign.location, sign.text1, sign.text2, sign.text3, sign.text4, sign.isFrontText]]
  S.packet_punch = ['container', []]
  S.packet_spectator_action = ['container', [{ name: 'entityId', type: 'optvarint' }]]
  return P
}

function findMapper (root, someValue) {
  let found = null
  ;(function walk (v) {
    if (found || !v || typeof v !== 'object') return
    if (Array.isArray(v) && v[0] === 'mapper' && v[1] && Object.values(v[1].mappings).includes(someValue)) { found = v[1]; return }
    for (const x of Object.values(v)) walk(x)
  })(root)
  return found
}

module.exports = { buildProtocol }
