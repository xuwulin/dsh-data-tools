# dsh-data-tools

[English](README.md) | 中文 | [开发文档](DEVELOP.zh.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的只读数据源工具集（MySQL / PostgreSQL / Redis / Elasticsearch）：让 Agent 在写代码之前**先看到数据**——列出连接、发现表结构、执行受保护的 SELECT 查询与只读的 Redis/Elasticsearch 操作。

## 背景

AI 编程助手默认连不上你的数据库：看不到表结构、没有样本数据、无法验证 SQL。这个插件给 Agent 一扇安全、只读的窗口（MySQL / PostgreSQL / Redis / Elasticsearch），让它写出贴合真实数据结构的查询和代码。

## 工具

| 工具 | 用途 |
|---|---|
| `db_connections` | 列出已配置的连接（名称、数据库或"所有库"、主机、用户——绝不显示密码）。 |
| `db_list_databases` | 列出该连接账号能访问的所有数据库（排除系统库）。 |
| `db_list_tables` | 列出某数据库的表（可选 `database`，默认用连接的默认库），支持按名称关键字过滤。 |
| `db_table_schema` | 查看单张表的列、索引和样本数据（可选 `database`）。 |
| `db_query` | 执行只读语句（按方言放行：MySQL 为 SELECT / SHOW / DESCRIBE / EXPLAIN / WITH；PostgreSQL 为 SELECT / SHOW / EXPLAIN / WITH）；连接没有默认库/默认 schema 时用 `库.表` 全限定名。 |
| `redis_connections` | 列出已配置的 Redis 连接（名称、库索引、主机、端口、用户——绝不显示密码）。 |
| `redis_keys` | 用 SCAN（绝不用会阻塞的 KEYS）列出键，支持 glob 模式过滤，按 `limit` 限量。 |
| `redis_read` | 按类型读取一个键：string / list / hash / set / zset，集合读取有上限。 |
| `redis_info` | 紧凑的服务信息：版本、客户端数、内存、命令统计、各库键数。 |
| `es_connections` | 列出已配置的 Elasticsearch 连接（名称、基础 URL、用户——绝不显示密码）。 |
| `es_indices` | 列出索引（名称、健康、文档数、存储大小），支持模式过滤，按 `limit` 限量。 |
| `es_mapping` | 查看一个索引的 mapping（schema）：每个字段路径及类型，按 `limit` 限量。 |
| `es_search` | 用 JSON query body 搜索一个索引；命中数有上限；省略 query 返回样本文档。 |
| `es_info` | 紧凑的集群信息：名称、版本、标语。 |

## 安装

```sh
dsh plugin --profile web add @xwl12/dsh-data-tools@latest
```

> 要从源码构建或安装本地 checkout？见 [DEVELOP.zh.md](DEVELOP.zh.md)。

## 配置

配置在插件自己的**配置页**上：Web GUI 打开 **插件（Plugins）→ `@xwl12/dsh-data-tools` → 配置**，或者直接编辑 profile patch 里的 `data-tools` 行（见下文「配置的三个来源」）。页面上的**连接（JSON）**字段对应 `connections` 数组——每个 JSON 对象代表一个数据库连接：

```json
[
  {
    "name": "dev",
    "host": "10.0.0.10",
    "port": 3306,
    "database": "your_db",
    "user": "readonly_user",
    "passwordRef": "DEV_DB_PASSWORD"
  }
]
```

**顶层选项**

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `connections` | 连接对象数组 | 必填 | `db_*` 工具操作的具名 MySQL 连接列表。 |
| `defaultMaxRows` | number | `100` | 连接未单独设置时的结果行数上限。 |
| `defaultTimeoutMs` | number | `10000` | 连接未单独设置时的语句超时（毫秒）。 |

**每连接字段**（`connections` 数组的每个元素；标注 “mysql” / “postgres” / “redis” 的字段只对该类型生效）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `name` | string | 必填 | 连接唯一名称；`db_*` / `redis_*` 工具的 `connection` 参数引用它。 |
| `kind` | `'mysql' \| 'postgres' \| 'redis' \| 'elasticsearch'` | `'mysql'` | 后端判别器；未知类型在校验时报错。 |
| `host` | string | 必填 | 数据库服务器地址。 |
| `port` | number | `3306`（mysql）/ `5432`（postgres）/ `6379`（redis）/ `9200`（elasticsearch） | 服务器端口。 |
| `database` | string（mysql/postgres）或 number（redis） | 无 / `0` | mysql：可选默认库（省略表示 Agent 可通过 `db_list_databases` 看到该账号所有库）。postgres：要连接的数据库（省略用服务器默认）。redis：逻辑库**索引**（默认 0）。 |
| `user` | string | mysql/postgres 必填 | 数据库账号（建议只读权限）；redis 为可选 ACL 用户名（Redis 6+）；elasticsearch 为可选 basic-auth 用户名。 |
| `passwordRef` | string | 无 | 密码引用：环境变量名，每次操作通过 dsh 凭证 seam 解析（环境变量或 dsh 的 `.env` 文件）。优先于 `password`，机密不进配置/日志。 |
| `password` | string | 无 | 明文密码回退，仅临时本地用。`role('secret')`：传输脱敏、绝不回显（配置页 write-only）。 |
| `charset` | string | `'utf8mb4'` | 连接字符集（仅 mysql；其余类型忽略）。 |
| `ssl` | boolean | `false` | TLS 连接，接受自签名证书（postgres / redis / elasticsearch）。 |
| `schema` | string | `'public'` | 表工具未传 `database` 参数时的默认 schema（仅 postgres）。 |
| `maxRows` | number | 回退 `defaultMaxRows` | 本连接结果上限（SQL 为行数，Redis 为键/条数，Elasticsearch 为命中/字段数）。 |
| `timeoutMs` | number | 回退 `defaultTimeoutMs` | 本连接语句/命令/请求超时（毫秒）。 |

> **PostgreSQL 语义**：一个连接对应一个数据库，`db_list_tables` / `db_table_schema` 的列单位是库内的 **schema**。`db_list_databases` 返回所连数据库的非系统 schema；表工具的 `database` 参数实际传 schema 名（缺省回退到连接的 `schema`，默认 `public`）。

**完整示例**（所有字段，配置页 JSON 格式）：

```json
[
  {
    "name": "dev",
    "kind": "mysql",
    "host": "10.0.0.10",
    "port": 3306,
    "database": "your_db",
    "user": "readonly_user",
    "passwordRef": "DEV_DB_PASSWORD",
    "charset": "utf8mb4",
    "maxRows": 50,
    "timeoutMs": 5000
  },
  {
    "name": "analytics",
    "host": "10.0.0.11",
    "port": 3306,
    "user": "analytics_ro",
    "passwordRef": "ANALYTICS_DB_PASSWORD"
  },
  {
    "name": "warehouse",
    "kind": "postgres",
    "host": "10.0.0.20",
    "port": 5432,
    "database": "analytics",
    "schema": "public",
    "user": "warehouse_ro",
    "passwordRef": "WAREHOUSE_DB_PASSWORD",
    "ssl": true,
    "maxRows": 50,
    "timeoutMs": 5000
  },
  {
    "name": "cache",
    "kind": "redis",
    "host": "10.0.0.30",
    "port": 6379,
    "database": 0,
    "user": "ro",
    "passwordRef": "CACHE_DB_PASSWORD",
    "ssl": true,
    "maxRows": 200,
    "timeoutMs": 3000
  },
  {
    "name": "logs",
    "kind": "elasticsearch",
    "host": "10.0.0.40",
    "port": 9200,
    "user": "readonly",
    "passwordRef": "ES_DB_PASSWORD",
    "ssl": true,
    "maxRows": 50,
    "timeoutMs": 5000
  }
]
```

> **Redis 语义**：`database` 是逻辑库**索引**（默认 0）；`redis_keys` 用 SCAN（绝不用阻塞的 KEYS）；`redis_read` 的集合读取都按 `limit`/连接上限限量；键总数来自 `DBSIZE`。
>
> **Elasticsearch 语义**：基础 URL 为 `http(s)://host:port`（`ssl: true` 时为 https）；`es_mapping`/`es_search` 接受单个索引或模式；`es_search` 接受完整 JSON search body，`size` 始终被覆盖为上限值。

**配置的三个来源**（后者覆盖前者）：

1. **Bundle 默认**——插件自带的 `cordis.patch.yml`（安装即自动生效，组合基线）。该文件本身属开发侧内容，见 [DEVELOP.zh.md](DEVELOP.zh.md)。
2. **Patch 覆盖层**——profile 的 `cordis.patch.yml` 或 `--patch` 文件：对 `data-tools` 行的 id 定向覆盖（切勿再 `insert` 同名行）。
3. **配置页**——在 **插件 → `@xwl12/dsh-data-tools` → 配置** 页保存，会写入当前 profile 的 `cordis.patch.yml`（同一条 id 定向覆盖）。由于 `connections` / `defaultMaxRows` / `defaultTimeoutMs` 声明为 *volatile*，运行中的插件会在下一次工具调用时读到新值——无需重启。

## 安全约定

> ⚠️ **插件只读，不等于 Agent 只读。** 上面的 `db_*` 工具会拒绝 `INSERT/UPDATE/DELETE` 及一切写操作——但和你对话的 AI Agent 还能执行任意脚本：只要拿到本页配置的连接信息（`host`/`port`/`user`/密码），它就能绕过插件、直连同一台 MySQL（例如写个 `mysql2` 脚本或用 `mysql` 命令行客户端）执行写操作。插件既不能也不打算阻止这种行为。
>
> **真正的写屏障只有数据库账号**：给 Agent 配一个仅 `SELECT` 权限的 MySQL 账号。有了它，无论插件还是任何脚本都写不进去。

这个插件天生只读，采用纵深防御：

1. **第一道防线——数据库账号**：给 Agent 一个只读权限的 MySQL 账号（仅 `SELECT`）。插件不会绕过账号的任何限制。
2. **语句守卫**：只放行 `SELECT / SHOW / DESCRIBE / EXPLAIN / WITH`；拒绝 `INSERT/UPDATE/DELETE/DROP/ALTER/...`、`FOR UPDATE / FOR SHARE`、`INTO OUTFILE/DUMPFILE` 以及多语句字符串。
3. **结果有界**：无 LIMIT 的 SELECT 自动追加 `LIMIT maxRows`；单元格超过 60 字符截断；附截断提示。
4. **语句超时**：`SET SESSION MAX_EXECUTION_TIME`（MySQL 5.7.8+ / 8.0）加连接超时。
5. **机密保护**：密码来自凭证 seam，绝不出现在配置 dump 或模型可见的输出里。
6. **权限受限的发现**：`db_list_databases` 只显示只读账号有权限访问的库——"看到所有库"受账号授权范围约束。

已知限制：SQL 语句守卫基于关键字而非解析器——请把它当作纵深防御，而不是沙箱。MariaDB 没有 `MAX_EXECUTION_TIME`（超时优雅降级）。V1 支持 MySQL、PostgreSQL、Redis 与 Elasticsearch。
