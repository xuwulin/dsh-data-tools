/**
 * Client-bundle build for the data-tools browser half. Produces the CJS
 * `lib/client.js` the harness serves at /plugins/@xwl12/dsh-data-tools/client.js,
 * wrapped in the module-loader handoff the web shell expects. Every shared
 * module stays external and is answered by the shell's module table; nothing
 * else is imported, so the bundle is self-contained.
 */
import { defineConfig } from 'tsdown'

/** Package id stamped into the module-loader handoff and the served route. */
const ID = '@xwl12/dsh-data-tools'

/** The web shell's baseline module table keys (packages/client/web/src/platform.ts). */
const BASELINE_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  tsconfig: 'tsconfig.client.json',
  dts: false,
  sourcemap: true,
  // The backend half (lib/index.js) is emitted by tsc just before this run;
  // a default clean would wipe it.
  clean: false,
  deps: {
    neverBundle: (specifier: string) => BASELINE_EXTERNALS.has(specifier),
    alwaysBundle: (specifier: string) => !BASELINE_EXTERNALS.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
