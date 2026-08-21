# dsh-data-tools

English | [中文](README.zh.md)

Read-only MySQL tooling for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): let the agent **see the database before it writes code** — list connections, discover table schemas, and run guarded SELECT queries.

## Why

AI coding assistants cannot query your company database by default: no table structures, no sample data, no way to verify SQL. This plugin gives the agent a safe, read-only window into MySQL so it can write schema-accurate queries and code.

## Tools

| Tool | Purpose |
|---|---|
| `db_connections` | List configured connections (name, database or "all databases", host, user — never passwords). |
| `db_list_databases` | List databases the connection's user can access (system schemas omitted). |
| `db_list_tables` | List tables of a database (optional `database`, defaults to the connection's), with optional name filter. |
| `db_table_schema` | Columns, indexes, and sample rows for one table (optional `database`). |
| `db_query` | Execute a read-only statement (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH); qualify `database.table` when no default database is set. |

## Install

```sh
dsh plugin --profile web add @xwl12/dsh-data-tools@latest
```

Or install a local checkout while developing:

```sh
pnpm build
dsh plugin --profile demo add ./path/to/dsh-data-tools
dsh --profile demo --dump-config   # verify the layer
dsh --profile demo                 # boot and try it
```

## Config

Example `cordis.patch.yml` (adjust to your dev database):

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

- `passwordRef` is preferred: it names an environment variable resolved per operation through the dsh credentials seam (env or the dsh `.env` file), so secrets never sit in config or the session log.
- `password` is a plaintext fallback for throwaway local setups only.
- `database` is optional: omit it to let the agent see every database the account can access (`db_list_databases`); tools then take a `database` argument, or qualify `database.table` in `db_query`.
- Per-connection `maxRows` / `timeoutMs` override `defaultMaxRows` / `defaultTimeoutMs`.
- **Live user settings**: the plugin registers a `data-tools` settings namespace — the patch-layer config above is the composition *base*; user overrides land in the dsh settings document (`settings.yaml` under `$DSH_HOME`) and apply live, so a saved change is immediately visible to the tools. Use the settings document for day-to-day edits and the patch layer for the deployment baseline. `password` is a `role('secret')` field: it is redacted on the wire and never returned to configuration surfaces.
- **Settings page**: the package also ships a browser half (`lib/client.js`) that contributes a **Data sources** page to the web GUI's Settings navigation, below the third-party "sidebar cards" entry. Editing there writes the same `data-tools` settings namespace. It appears only while the plugin is installed.

## Safety contract

This plugin is read-only by design, with defense in depth:

1. **Primary boundary — the database account**: give the agent a MySQL user with read-only privileges (`SELECT` only). Nothing in the plugin bypasses the account.
2. **Statement guard**: only `SELECT / SHOW / DESCRIBE / EXPLAIN / WITH` pass; `INSERT/UPDATE/DELETE/DROP/ALTER/...`, `FOR UPDATE / FOR SHARE`, `INTO OUTFILE/DUMPFILE`, and multi-statement strings are refused.
3. **Bounded results**: unbounded SELECTs get an automatic `LIMIT maxRows`; cell values are truncated at 60 chars; a truncation note is appended.
4. **Statement timeout**: `SET SESSION MAX_EXECUTION_TIME` (MySQL 5.7.8+ / 8.0) plus a connection timeout.
5. **Secrets**: passwords come from the credentials seam, never from config dumps or model-visible output.
6. **Privilege-bounded discovery**: `db_list_databases` shows only the databases the read-only account can access — "all databases" is bounded by the account's grants.

Known limits: the statement guard is keyword-based, not a parser — treat it as defense in depth, not a sandbox. MariaDB lacks `MAX_EXECUTION_TIME` (timeout degrades gracefully). V1 is MySQL-only.

## Develop

Standalone project — keep it outside the harness monorepo (or `git init` it separately):

```sh
npm install          # or pnpm install
npm run build        # tsc (backend lib/) + tsc (client types) + tsdown (lib/client.js)
npm run typecheck
```

`npm run build` produces both halves: the Node half (`lib/index.js`, tools + settings registration) and the browser half (`lib/client.js`, the Settings page). Install the built package into a profile and both load together:

```sh
dsh plugin --profile web add ./path/to/dsh-data-tools
```

Then ask the agent, e.g.: *"Use db_connections, then db_list_tables and db_table_schema on the `orders` table, then write a query joining it to `customers`."*

## Publish

```sh
pnpm pack           # inspect the tarball first
pnpm publish        # --access public for scoped names, or set publishConfig.access
```

Users install from npm, or from git with an `allowBuilds` entry in the profile's `pnpm-workspace.yaml` (the `prepare` script builds from source).

## Roadmap

- V2: `db_explain`, schema keyword search (`db_find`), SQL Server / PostgreSQL drivers, write mode behind `ctx.approval`.
