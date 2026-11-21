import test from 'ava';
import fs from 'fs';
import path from 'path';

// The bridge's "in the portal" reads the player's box as the server does (client-mod Portal.java serverBox). Live Nov
// 20-21: ways back from nether (-78, 90, 259), feet a block below its portal's bottom, timed out "in the portal (20 s in
// it)" with "in the portal: yes": the box pushed against the obsidian sill stopped with maxZ exactly on the portal's
// plane (259.7 + 0.3 = 260.0), BlockPos.containing(260.0) took in the portal cell above the sill, the walk stood still,
// and the server (26.3 Entity.checkInsideBlocks: makeBoundingBox().deflate(9.99e-6), checked against the 26.3 jar with
// javap) never had it in. Deflated like the server's, the box flush with the cell is out, and the steer in goes on (a
// jump onto the sill).

const read = (f: string): string => fs.readFileSync(path.join(process.cwd(), 'client-mod', f), 'utf8');

test('the portal\'s inside checks read the box deflated as the server does, never the raw box', (t) => {
  const java = read('src/claudebridge/Portal.java');
  t.regex(java, /static AABB serverBox\(LocalPlayer p\) \{\s*return p\.getBoundingBox\(\)\.deflate\(1\.0E-5\);/);
  for (const fn of ['inside(LocalPlayer p)', 'insideOf(LocalPlayer p, Shape s)']) {
    const at = java.indexOf(`static boolean ${fn}`);
    t.true(at >= 0, fn);
    t.regex(java.slice(at, at + 200), /AABB box = serverBox\(p\);/, fn);
  }
  t.notRegex(java, /AABB box = p\.getBoundingBox\(\);/);
});

test('a box flush with the portal\'s plane: the raw one reaches the portal cell, the server\'s does not', (t) => {
  // the cell a max edge falls in, as BlockPos.containing (a floor)
  const cell = (v: number) => Math.floor(v);
  const z = 259.7, half = 0.3;
  t.is(cell(z + half), 260);
  t.is(cell(z + half - 1.0e-5), 259);
});
