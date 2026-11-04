import test from 'ava';
import path from 'path';
import { gameLibraries, libraryAllowed, offlineUuid, type VersionJson } from '../../src/client/install.js';

test('offlineUuid matches the UUID the server gave ClaudeBot', (t) => {
  t.is(offlineUuid('ClaudeBot'), '313c66c6-e732-3e25-9fbc-ee84b2e331bc');
});

test('libraryAllowed follows the launcher rule order', (t) => {
  t.true(libraryAllowed(undefined));
  t.true(libraryAllowed([{ action: 'allow', os: { name: 'windows' } }], 'windows'));
  t.false(libraryAllowed([{ action: 'allow', os: { name: 'osx' } }], 'windows'));
  t.false(libraryAllowed([{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }], 'windows'));
});

test('gameLibraries keeps this OS and architecture only', (t) => {
  const v = {
    mainClass: 'x', assetIndex: { id: '1' },
    libraries: [
      { name: 'a', downloads: { artifact: { path: 'org/a/a.jar' } } },
      { name: 'b', downloads: { artifact: { path: 'org/b/b-natives-windows.jar' } }, rules: [{ action: 'allow', os: { name: 'windows' } }] },
      { name: 'c', downloads: { artifact: { path: 'org/c/c-natives-windows-arm64.jar' } }, rules: [{ action: 'allow', os: { name: 'windows' } }] },
      { name: 'd', downloads: { artifact: { path: 'org/d/d-natives-macos.jar' } }, rules: [{ action: 'allow', os: { name: 'osx' } }] }
    ]
  } as VersionJson;
  const libs = gameLibraries('/mc', v, 'windows', 'x86_64').map(p => p.split(path.sep).join('/'));
  t.deepEqual(libs.map(p => p.replace(/^.*libraries\//, '')), ['org/a/a.jar', 'org/b/b-natives-windows.jar']);
});
