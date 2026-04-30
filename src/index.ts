/**
 * taco-plugin — OpenCode plugin entry point.
 *
 * Register in opencode.json:
 *
 *   { "plugin": ["taco-plugin"] }
 *
 * Or from a local path during development:
 *
 *   { "plugin": ["/path/to/taco-plugin"] }
 *
 * The plugin writes to ~/.local/share/taco/plugin.db (Bun:sqlite, WAL mode).
 * TACO CLI reads that DB with better-sqlite3 / sql.js on Node.js.
 */

import type { PluginModule } from '@opencode-ai/plugin';
import { TacoPlugin } from './plugin.js';

const module_: PluginModule = {
  id: 'taco-plugin',
  server: TacoPlugin,
};

export default module_;
export { TacoPlugin };
export { PLUGIN_DB_PATH } from './db/connection.js';
