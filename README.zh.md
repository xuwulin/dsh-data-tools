# dsh-data-tools

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的只读 MySQL 工具集：让 Agent 在写代码之前**先看到数据库**——列出连接、发现表结构、执行受保护的 SELECT 查询。

## 为什么

AI 编程助手默认连不上你公司的数据库：看不到表结构、没有样本数据、无法验证 SQL。这个插件给 Agent 一扇安全、只读的 MySQL 窗口，让它写出贴合真实表结构的查询和代码。

## 工具

| 工具 | 用途 |
|---|---|
| `db_connections` | 列出已配置的连接（名称、数据库或"所有库"、主机、用户——绝不显示密码）。 |
| `db_list_databases` | 列出该连接账号能访问的所有数据库（排除系统库）。 |
| `db_list_tables` | 列出某数据库的表（可选 `database`，默认用连接的默认库），支持按名称关键字过滤。 |
| `db_table_schema` | 查看单张表的列、索引和样本数据（可选 `database`）。 |
| `db_query` | 执行只读语句（SELECT / SHOW / DESCRIBE / EXPLAIN / WITH）；连接没有默认库时用 `数据库.表` 全限定名。 |

## 安装

```sh
dsh plugin --profile web add @xwl12/dsh-data-tools@latest
```

开发时安装本地 checkout：

```sh
pnpm build
dsh plugin --profile demo add ./path/to/dsh-data-tools
dsh --profile demo --dump-config   # 先确认配置层
dsh --profile demo                 # 启动并试用
```

## 配置

插件默认的 `cordis.patch.yml`（bundle 层，安装即自动生效；真实连接请用下面的 `--patch` 覆盖写法）：

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

- `passwordRef` 优先推荐：它引用一个环境变量，每次操作时通过 dsh 凭证 seam（环境变量或 dsh 的 `.env` 文件）解析，机密不会出现在配置或会话日志里。
- `password` 是明文回退，仅供一次性本地环境使用。
- `database` 可选：不填时 Agent 可以查看该账号能访问的所有数据库（用 `db_list_databases`），表工具需要传 `database` 参数，或在 `db_query` 里用 `数据库.表` 全限定名。
- 每个连接可以单独用 `maxRows` / `timeoutMs` 覆盖 `defaultMaxRows` / `defaultTimeoutMs`。
- **实时用户设置**：插件注册了 `data-tools` settings 命名空间——上面的 patch 层配置是组合 *base*；用户的覆盖写入 dsh 设置文档（`$DSH_HOME` 下的 `settings.yaml`）并实时生效，保存后工具立刻可见。日常修改请编辑设置文档，patch 层留给部署基线。`password` 是 `role('secret')` 字段：在传输层脱敏，绝不会回传给配置界面。
- **设置页**：包同时带有浏览器一半（`lib/client.js`），会在 Web GUI 的设置导航里、第三方"侧边卡片"条目下方增加一个"数据源"页面，编辑的是同一个 `data-tools` settings 命名空间。只有安装了插件才会显示（且需要重启 dsh，见"开发"）。
- **用 `--patch` 覆盖默认连接**：插件作为 bundle 安装后，它自带的 `cordis.patch.yml` 已经插入了 `data-tools` 这一行。如果再用 `--patch` 传覆盖文件（比如开发专用的 `dev.patch.yml`），**不要重复 `insert` 同名条目**——loader 会以 `duplicate loader entry id: data-tools` 拒绝启动。正确写法是 id 定向覆盖；补丁会**整体替换**该行的 `config`，所以请带上完整配置：
  ```yaml
  - id: data-tools
    config:
      defaultMaxRows: 100
      defaultTimeoutMs: 10000
      connections:
        - name: dev
          host: 10.0.0.10
          port: 3306
          user: readonly_user
          passwordRef: DEV_DB_PASSWORD
  ```

## 安全约定

这个插件天生只读，采用纵深防御：

1. **第一道防线——数据库账号**：给 Agent 一个只读权限的 MySQL 账号（仅 `SELECT`）。插件不会绕过账号的任何限制。
2. **语句守卫**：只放行 `SELECT / SHOW / DESCRIBE / EXPLAIN / WITH`；拒绝 `INSERT/UPDATE/DELETE/DROP/ALTER/...`、`FOR UPDATE / FOR SHARE`、`INTO OUTFILE/DUMPFILE` 以及多语句字符串。
3. **结果有界**：无 LIMIT 的 SELECT 自动追加 `LIMIT maxRows`；单元格超过 60 字符截断；附截断提示。
4. **语句超时**：`SET SESSION MAX_EXECUTION_TIME`（MySQL 5.7.8+ / 8.0）加连接超时。
5. **机密保护**：密码来自凭证 seam，绝不出现在配置 dump 或模型可见的输出里。
6. **权限受限的发现**：`db_list_databases` 只显示只读账号有权限访问的库——"看到所有库"受账号授权范围约束。

已知限制：语句守卫基于关键字而非解析器——请把它当作纵深防御，而不是沙箱。MariaDB 没有 `MAX_EXECUTION_TIME`（超时优雅降级）。V1 仅支持 MySQL。

## 开发

独立项目——请放在 harness monorepo 之外（或单独 `git init`）：

```sh
npm install          # 或 pnpm install
npm run build        # tsc（后端 lib/）+ tsc（客户端类型）+ tsdown（lib/client.js）
npm run typecheck
```

`npm run build` 会产出两半：Node 半（`lib/index.js`，工具 + settings 注册）和浏览器半（`lib/client.js`，设置页）。把构建好的包装进 profile，两半会一起加载：

```sh
dsh plugin --profile web add ./path/to/dsh-data-tools
```

然后按上文装进一个 profile，再让 Agent 试，例如：*"用 db_connections，再用 db_list_tables 和 db_table_schema 看 `orders` 表，然后写一条和 `customers` 联表的查询。"*

注意事项：

- **安装后需要重启 dsh**（改动 `exports` / `dsh.client` 后也一样）：浏览器半是在启动时发现的，且发现结果在进程生命周期内缓存——运行中的实例不会加载新加的客户端插件。
- **版本对齐**：插件把 `@deepseek-ai/dsh-settings`、`dsh-tools`、`dsh-credentials` 锁定在 `0.1.1-rc.1`，与目标 harness 一致。装到其它 rc 版本的 harness 时请先同步 peer/dev 依赖——版本不一致时插件会从自己的 `node_modules` 加载不匹配的副本，可能在运行时失败。

## 发布

```sh
pnpm pack           # 先检查 tarball 内容
pnpm publish        # 带 scope 的包加 --access public，或在 package.json 里设 publishConfig.access
```

用户可以从 npm 安装；也可以从 git 安装——需要在 profile 的 `pnpm-workspace.yaml` 里加 `allowBuilds` 条目（`prepare` 脚本会从源码构建）。

## 路线图

- V2：`db_explain`、schema 关键字搜索（`db_find`）、SQL Server / PostgreSQL 驱动、基于 `ctx.approval` 的写模式。
