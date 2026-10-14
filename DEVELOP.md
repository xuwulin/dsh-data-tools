# Development Guide

Development and publishing notes for contributors. Users should read [README.md](README.md) instead; this file is for people building, testing, or publishing the plugin.

## Prerequisites

- Node.js 22.19+ / 24+
- npm (primary package manager) or pnpm
- A DeepSeek Harness checkout to test against locally. This project does **not** require a global `dsh` install — run the CLI from the checkout:

  ```sh
  # from the harness checkout root
  pnpm dsh --help
  # equivalent, if pnpm is not available:
  node --import tsx/esm apps/cli/src/bin.ts --help
  ```

## Project layout

| Path | What |
|---|---|
| `src/index.ts` | Composition root: config schema (`.volatile()` fields), connection resolution, tool registration, configuration-page policy |
| `src/sql/` | Dialect seam (`dialect.ts`), MySQL implementation (`mysql.ts`), the five `db_*` tools (`tools.ts`) |
| `src/client/` | Browser half: the plugin's own configuration page (React), bundled to `lib/client.js` |
| `scripts/db-smoke.mjs` | Dev-only connectivity smoke test (reads `dev.patch.yml`, never prints passwords) |
| `scripts/conn-smoke.mjs` | Dev-only connectivity smoke test over the composed patch layers (bundle → profile → `dev.patch.yml`) |
| `scripts/plugin-smoke.mjs` | Dev-only contract test: volatile-config live updates, refused-save handling, page-policy registration (no host, no database) |
| `scripts/contract/` | Compile-time probe that the browser half's local service types still match the current harness client packages |
| `cordis.patch.yml` | Bundle default config layer (inserted automatically on install) |

## The bundle default config (`cordis.patch.yml`)

The package ships a default config layer, `cordis.patch.yml`, that inserts the `data-tools` row with a placeholder connection. It is applied automatically when the plugin is installed as a bundle:

```yaml
- insert:
    - id: data-tools
      name: '@xwl12/dsh-data-tools'
      config:
        defaultMaxRows: 100
        defaultTimeoutMs: 10000
        connections:
          - name: dev
            host: 10.0.0.10
            port: 3306
            database: your_db
            user: readonly_user
            passwordRef: DEV_DB_PASSWORD
```

This row is the composition *base*. Real deployments override it either from the plugin's own **Configure** page (**Plugins → `@xwl12/dsh-data-tools` → Configure**, which writes the id-targeted override into the active profile's `cordis.patch.yml`) or through an explicit id-targeted `--patch` overlay — **never** by shipping a second `insert` with the same id: the loader rejects duplicate entry ids (`duplicate loader entry id: data-tools`).

## Why the config fields are `.volatile()`

`connections`, `defaultMaxRows`, and `defaultTimeoutMs` are declared `.volatile()` on the Config schema. The Loader then resolves each of them to a stable **reference** rather than a plain value, so:

- `apply(ctx, config)` receives `config.connections.get()` / `config.defaultMaxRows.get()` / `config.defaultTimeoutMs.get()`, typed through the schema (`ReturnType<typeof Config>`);
- a save from the Configure page is committed **into those references in place** — the plugin is not restarted, and `lib/index.js`'s `refresh()` re-resolves the connection maps when a reference's identity changes, which every tool entry point calls first;
- a save the schema rejects never reaches the plugin, and one our own per-kind checks reject (duplicate names, a kind that needs `user`, an unsupported kind) keeps the previous connections and logs why.

The page itself uses the harness's configuration-form service: `ctx.configForms.get('data-tools')` for the values and `ctx.configForms.whileServed(['data-tools'], …)` so the page exists exactly while the entry does. It registers into the Plugins page's `plugins.row.config` slot, keyed `@xwl12/dsh-data-tools#data-tools`.

## Build & typecheck

```sh
npm install          # or pnpm install
npm run typecheck    # backend + client + the harness contract probe
npm run build        # tsc (backend lib/) + tsc (client types) + tsdown (lib/client.js)
node scripts/plugin-smoke.mjs   # after a build: volatile-config contract, no host needed
```

`npm run build` produces both halves: the Node half (`lib/index.js` — tools + page policy) and the browser half (`lib/client.js` — the configuration page). `lib/` is git-ignored; the npm tarball ships it (the `prepare` script, `npm run build`, rebuilds it on publish and on git installs).

**Version alignment**: the plugin pins `@deepseek-ai/dsh-settings`, `dsh-tools`, and `dsh-credentials` at `0.2.0-rc.2` (the current desktop release) and needs schemastery `^3.18.4` for `.volatile()`. If you point it at a harness with different rc versions, sync the peer/dev dependencies and run `npm run typecheck` FIRST: the client contract probe and the backend schema types fail loudly on a moved API, instead of leaving a page that silently never mounts.

## Local install into a dsh profile

Build first, then add the local checkout to a profile:

```sh
npm run build        # produce lib/ first
```

```sh
dsh plugin --profile web add /absolute/path/to/dsh-data-tools
# with the checkout-local CLI:
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add D:/path/to/dsh-data-tools
```

Verify the composed config, then boot (add `--patch` overlays as needed — see README's Config section for the id-targeted override pattern):

```sh
dsh --profile web --patch <overlay.yml> --dump-config
pnpm dsh web --patch ../dsh-data-tools/dev.patch.yml
```

**Restart is required** after installing the plugin (or after touching `exports` / `dsh.client` in `package.json`): the browser half is discovered at boot and the verdict is cached for the process lifetime — a running instance will not pick up a newly added client plugin. The client discovery resolves `require.resolve('<pkg>/package.json')`, so the package must keep exporting `./package.json` (already declared in `package.json`).

Then ask the agent, e.g.: *"Use db_connections, then db_list_tables and db_table_schema on the `orders` table, then write a query joining it to `customers`."*
