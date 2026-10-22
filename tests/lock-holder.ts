/**
 * Test helper — a Worker that holds the SQLite write lock, then releases it.
 *
 * It must run on its own thread: the busy handler blocks the whole event
 * loop while it waits, so a same-thread timer would never fire and the
 * blocked writer could never be rescued.
 */

import { Database } from 'bun:sqlite';

self.onmessage = (event: MessageEvent<{ file: string; holdMs: number }>) => {
  const { file, holdMs } = event.data;

  const db = new Database(file);
  db.run('PRAGMA busy_timeout = 5000');
  db.run('BEGIN IMMEDIATE');
  db.run("INSERT INTO meta (key, value) VALUES ('holder', 'x')");
  self.postMessage('locked');

  setTimeout(() => {
    db.run('COMMIT');
    db.close();
    self.postMessage('released');
  }, holdMs);
};
