'use strict'
// Minecraft 26.3 datatypes, installed into minecraft-protocol as src/datatypes/mc-26.3-datatypes.js
// by patch-mc-26.3.cjs. Each entry is [read, write, sizeOf].
const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const { PartialReadError } = require('protodef').utils

/*
 * entityMoveDelta: ClientboundMoveEntityPacket delta.
 * Wire: varint props (bit 0 = onGround, props >>> 1 = step count), then either
 *   step count 0: i16 dx, i16 dy, i16 dz
 *   step count n: n x (varint ticks, i16 dx, i16 dy, i16 dz)  -- each step relative to the previous one
 * Value: { onGround, dX, dY, dZ, steps? } where dX/dY/dZ is the total delta (sum of the steps).
 */
function readEntityMoveDelta (buffer, offset) {
  const start = offset
  const props = readVarInt(buffer, offset)
  offset += props.size
  const onGround = (props.value & 1) === 1
  const count = props.value >>> 1
  if (count === 0) {
    if (offset + 6 > buffer.length) throw new PartialReadError()
    const value = { onGround, dX: buffer.readInt16BE(offset), dY: buffer.readInt16BE(offset + 2), dZ: buffer.readInt16BE(offset + 4) }
    return { value, size: offset + 6 - start }
  }
  const steps = []
  let dX = 0, dY = 0, dZ = 0
  for (let i = 0; i < count; i++) {
    const ticks = readVarInt(buffer, offset)
    offset += ticks.size
    if (offset + 6 > buffer.length) throw new PartialReadError()
    const step = { ticks: ticks.value, dX: buffer.readInt16BE(offset), dY: buffer.readInt16BE(offset + 2), dZ: buffer.readInt16BE(offset + 4) }
    offset += 6
    dX += step.dX; dY += step.dY; dZ += step.dZ
    steps.push(step)
  }
  return { value: { onGround, dX, dY, dZ, steps }, size: offset - start }
}

function writeEntityMoveDelta (value, buffer, offset) {
  const steps = value.steps && value.steps.length ? value.steps : null
  offset = writeVarInt((value.onGround ? 1 : 0) | ((steps ? steps.length : 0) << 1), buffer, offset)
  for (const s of steps || [value]) {
    if (steps) offset = writeVarInt(s.ticks, buffer, offset)
    buffer.writeInt16BE(s.dX, offset)
    buffer.writeInt16BE(s.dY, offset + 2)
    buffer.writeInt16BE(s.dZ, offset + 4)
    offset += 6
  }
  return offset
}

function sizeOfEntityMoveDelta (value) {
  const steps = value.steps && value.steps.length ? value.steps : null
  const size = sizeOfVarInt((value.onGround ? 1 : 0) | ((steps ? steps.length : 0) << 1))
  if (!steps) return size + 6
  return steps.reduce((n, s) => n + sizeOfVarInt(s.ticks) + 6, size)
}

/*
 * bitSetLongs: ByteBufCodecs.BIT_SET, which 26.3 sends as BitSet.toByteArray() (varint length +
 * little-endian bytes) instead of 26.1's long array. The value keeps the old shape -- an array of
 * i64 as [high, low] int32 pairs -- so existing consumers (prismarine-chunk light masks) still work.
 */
function readBitSetLongs (buffer, offset) {
  const len = readVarInt(buffer, offset)
  const start = offset + len.size
  if (start + len.value > buffer.length) throw new PartialReadError()
  const longs = []
  for (let i = 0; i < len.value; i += 8) {
    const b = Buffer.alloc(8)
    buffer.copy(b, 0, start + i, Math.min(start + i + 8, start + len.value))
    longs.push([b.readInt32LE(4), b.readInt32LE(0)])
  }
  return { value: longs, size: len.size + len.value }
}

function bitSetBytes (value) {
  const b = Buffer.alloc(value.length * 8)
  value.forEach(([hi, lo], i) => { b.writeInt32LE(lo, i * 8); b.writeInt32LE(hi, i * 8 + 4) })
  let n = b.length
  while (n > 0 && b[n - 1] === 0) n-- // BitSet.toByteArray() drops trailing zero bytes
  return b.subarray(0, n)
}

function writeBitSetLongs (value, buffer, offset) {
  const b = bitSetBytes(value)
  offset = writeVarInt(b.length, buffer, offset)
  b.copy(buffer, offset)
  return offset + b.length
}

function sizeOfBitSetLongs (value) {
  const n = bitSetBytes(value).length
  return sizeOfVarInt(n) + n
}

module.exports = {
  entityMoveDelta: [readEntityMoveDelta, writeEntityMoveDelta, sizeOfEntityMoveDelta],
  bitSetLongs: [readBitSetLongs, writeBitSetLongs, sizeOfBitSetLongs]
}
