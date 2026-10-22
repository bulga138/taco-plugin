/**
 * taco-plugin — OpenCode V2 plugin entry point.
 *
 * Register in opencode.json:
 *
 *   { "plugins": ["taco-plugin"] }
 *
 * Or from a local path during development:
 *
 *   { "plugins": ["/path/to/taco-plugin"] }
 *
 * The plugin writes to ~/.local/share/taco/plugin.db (Bun:sqlite, WAL mode).
 * TACO CLI reads that DB with better-sqlite3 / sql.js on Node.js.
 */

import { Plugin } from '@opencode/plugin';
import { setup } from './plugin.js';

export default Plugin.define({ id: 'taco-plugin', setup });
export { setup };
export { PLUGIN_DB_PATH } from './db/connection.js';
