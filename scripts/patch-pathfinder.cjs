#!/usr/bin/env node
/*
 * Fixes in mineflayer-pathfinder 2.4.x, applied to node_modules on npm install (idempotent).
 * Adapted from rmalde/minecraft-agent (patch-pathfinder.mjs), which found them on long survival runs.
 *
 * 1. Stale return target. After placing a scaffolding block, pathfinder remembers a position to step back to
 *    (returningPos) and walks there before following the path. Stopping or resetting the path did not clear it, so
 *    a cancelled move kept pulling the bot toward an old spot, and a placement finishing after a cancel could set
 *    it again. Clear it on stop/reset, and ignore placements from before the latest cancel (an epoch counter).
 *    This server cancels goals all the time: fights, drop pickup, wall-in, the emergency shelter.
 * 2. fullStop() re-centred the bot by rewriting its position and velocity. Moving the player without physics can
 *    put it over an edge or into a low ceiling (the server answers "standing on air - force-sending blocks
 *    below"). Stop with the normal controls only.
 *
 * If the pathfinder source no longer matches, nothing is changed and a warning is printed.
 */
const fs = require('fs');
const path = require('path');

const MARKER = 'navigationEpoch';

function patchSource(source) {
  if (source.includes(MARKER)) return { source, changed: false };
  const edits = [
    ['  let returningPos = null',
      '  let returningPos = null\n  let navigationEpoch = 0 // bumped on stop/reset: placements finishing later must not set returningPos'],
    ['  function resetPath (reason, clearStates = true) {',
      '  function resetPath (reason, clearStates = true) {\n    if (clearStates) { navigationEpoch++; returningPos = null }'],
    ['  function stop () {',
      '  function stop () {\n    navigationEpoch++\n    returningPos = null'],
    ["        bot.equip(block, 'hand')",
      "        const placementEpoch = navigationEpoch\n        bot.equip(block, 'hand')"],
    ['if (bot.pathfinder.LOSWhenPlacingBlocks && placingBlock.returnPos) returningPos = placingBlock.returnPos.clone()',
      'if (placementEpoch === navigationEpoch && bot.pathfinder.LOSWhenPlacingBlocks && placingBlock.returnPos) returningPos = placingBlock.returnPos.clone()']
  ];
  let out = source;
  for (const [from, to] of edits) {
    if (!out.includes(from)) throw new Error(`pathfinder source changed, missing: ${from.trim().slice(0, 60)}`);
    out = out.replace(from, to);
  }
  const start = out.indexOf('  function fullStop () {');
  const end = out.indexOf('\n  function moveToEdge', start);
  if (start < 0 || end < 0) throw new Error('pathfinder source changed: fullStop not found');
  out = out.slice(0, start) +
    '  function fullStop () {\n    // normal control stop; never rewrite the player position or velocity\n    bot.clearControlStates()\n  }\n' +
    out.slice(end);
  return { source: out, changed: true };
}

function main() {
  let file;
  try {
    file = require.resolve('mineflayer-pathfinder/index.js', { paths: [path.join(__dirname, '..')] });
  } catch {
    console.warn('[patch-pathfinder] mineflayer-pathfinder not installed; skipped');
    return;
  }
  try {
    const { source, changed } = patchSource(fs.readFileSync(file, 'utf8'));
    if (changed) {
      fs.writeFileSync(file, source);
      console.log('[patch-pathfinder] patched stale return target and fullStop in', file);
    }
  } catch (e) {
    console.warn(`[patch-pathfinder] not applied: ${e.message}`);
  }
}

if (require.main === module) main();
module.exports = { patchSource, MARKER };
