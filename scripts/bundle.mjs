// Prepares the published package (packages/mcp-server): the compiled server with the engine (packages/core) bundled
// in, the engine's catalog and versioning rules next to it (the code finds them at ../catalog and ../rules), and the
// README, LICENSE and NOTICE. Run after `npm run build`; npm runs it before `npm pack` / `npm publish` (prepack).
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'packages', 'mcp-server');
const core = join(root, 'packages', 'core');
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));

rmSync(join(pkg, 'bundle'), { recursive: true, force: true });
await build({
  entryPoints: [join(pkg, 'dist', 'index.js')],
  outfile: join(pkg, 'bundle', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // the published package's own dependencies stay ordinary npm dependencies; only the engine is bundled
  external: Object.keys(manifest.dependencies ?? {}),
  legalComments: 'none',
  logLevel: 'warning',
});
for (const dir of ['catalog', 'rules']) {
  rmSync(join(pkg, dir), { recursive: true, force: true });
  mkdirSync(join(pkg, dir), { recursive: true });
  cpSync(join(core, dir), join(pkg, dir), { recursive: true });
}
for (const f of ['README.md', 'LICENSE', 'NOTICE']) cpSync(join(root, f), join(pkg, f));
console.log('bundle ready: packages/mcp-server/bundle/index.js (+ catalog, rules, README, LICENSE, NOTICE)');
