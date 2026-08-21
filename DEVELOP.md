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
| `src/index.ts` | Composition root: config schema, connection resolution, tool registration, settings namespace |
| `src/sql/` | Dialect seam (`dialect.ts`), MySQL implementation (`mysql.ts`), the five `db_*` tools (`tools.ts`) |
| `src/client/` | Browser half: the **Data sources** settings page (React), bundled to `lib/client.js` |
| `scripts/db-smoke.mjs` | Dev-only connectivity smoke test (reads `dev.patch.yml`, never prints passwords) |
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

This row is the composition *base*. Real deployments override it through the settings document (the **Data sources** settings page, which writes `$DSH_HOME/settings.yaml` live) or an id-targeted `--patch` overlay — **never** by shipping a second `insert` with the same id: the loader rejects duplicate entry ids (`duplicate loader entry id: data-tools`).

## Build & typecheck

```sh
npm install          # or pnpm install
npm run typecheck
npm run build        # tsc (backend lib/) + tsc (client types) + tsdown (lib/client.js)
```

`npm run build` produces both halves: the Node half (`lib/index.js` — tools + settings registration) and the browser half (`lib/client.js` — the Settings page). `lib/` is git-ignored; the npm tarball ships it (the `prepare` script, `npm run build`, rebuilds it on publish and on git installs).

**Version alignment**: the plugin pins `@deepseek-ai/dsh-settings`, `dsh-tools`, and `dsh-credentials` at `0.1.1-rc.1` to match the harness checkout it targets. If you point it at a harness with different rc versions, sync the peer/dev dependencies first — a mismatched copy loaded from the plugin's own `node_modules` can fail at runtime.

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
