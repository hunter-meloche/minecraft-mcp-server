import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileLock } from '../../src/client/instance-lock.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-lock-'));
const living = (pids: number[]) => (pid: number) => pids.includes(pid);

test('fileLock: the first copy takes it, a second sees who holds it, and gets it once released', t => {
  const d = dir();
  const a = fileLock(d, 100, living([100, 200]));
  const b = fileLock(d, 200, living([100, 200]));
  t.is(a.acquire(), null);
  t.is(b.acquire(), 100);
  t.is(a.acquire(), null, 'taking it again is fine');
  a.release();
  t.is(b.acquire(), null);
  t.is(a.acquire(), 200);
});

test('fileLock: a lock whose process is gone (killed, crashed) or that is garbage is taken over', t => {
  const d = dir();
  t.is(fileLock(d, 100, living([100])).acquire(), null);
  t.is(fileLock(d, 300, living([300])).acquire(), null, 'pid 100 is gone');
  fs.writeFileSync(path.join(d, 'client-backend.lock'), 'not json');
  t.is(fileLock(d, 400, living([400])).acquire(), null);
});

test('fileLock: release leaves a lock someone else took alone', t => {
  const d = dir();
  const a = fileLock(d, 100, living([200]));
  t.is(a.acquire(), null);
  fs.writeFileSync(path.join(d, 'client-backend.lock'), JSON.stringify({ pid: 200 }));
  a.release();
  t.true(fs.existsSync(path.join(d, 'client-backend.lock')));
});
