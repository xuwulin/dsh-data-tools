# dsh-data-tools

[English](README.md) | 中文 | [开发文档](DEVELOP.zh.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的只读 MySQL 工具集：让 Agent 在写代码之前**先看到数据库**——列出连接、发现表结构、执行受保护的 SELECT 查询。

## 背景

AI 编程助手默认连不上你的数据库：看不到表结构、没有样本数据、无法验证 SQL。这个插件给 Agent 一扇安全、只读的 MySQL 窗口，让它写出贴合真实表结构的查询和代码。

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

> 要从源码构建或安装本地 checkout？见 [DEVELOP.zh.md](DEVELOP.zh.md)。

## 配置

配置位于 `data-tools` settings 命名空间，在 Web GUI 的 **设置 → 数据源** 里实时编辑。页面上的**连接（JSON）**字段对应 `connections` 数组——每个 JSON 对象代表一个数据库连接：

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

**每连接字段**（`connections` 数组的每个元素）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `name` | string | 必填 | 连接唯一名称；`db_*` 工具的 `connection` 参数引用它。 |
| `kind` | `'mysql'` | `'mysql'` | 后端判别器。目前只实现 mysql；未知类型在校验时报错。 |
| `host` | string | 必填 | MySQL 服务器地址。 |
| `port` | number | `3306` | MySQL 端口。 |
| `database` | string | 无 | 可选默认库。省略（或 `null`/空）表示 Agent 可通过 `db_list_databases` 看到该账号所有库；表工具需传 `database` 参数，查询用 `库.表` 全限定名。 |
| `user` | string | 必填 | 数据库账号（建议只读权限）。 |
| `passwordRef` | string | 无 | 密码引用：环境变量名，每次操作通过 dsh 凭证 seam 解析（环境变量或 dsh 的 `.env` 文件）。优先于 `password`，机密不进配置/日志。 |
| `password` | string | 无 | 明文密码回退，仅临时本地用。`role('secret')`：传输脱敏、绝不回显（设置页 write-only）。 |
| `charset` | string | `'utf8mb4'` | 连接字符集。 |
| `maxRows` | number | 回退 `defaultMaxRows` | 本连接结果行数上限。 |
| `timeoutMs` | number | 回退 `defaultTimeoutMs` | 本连接语句超时（毫秒）。 |

**完整示例**（所有字段，设置页 JSON 格式）：

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
  }
]
```

**配置的三个来源**（后者覆盖前者）：

1. **Bundle 默认**——插件自带的 `cordis.patch.yml`（安装即自动生效，组合基线）。该文件本身属开发侧内容，见 [DEVELOP.zh.md](DEVELOP.zh.md)。
2. **Patch 覆盖层**——profile 的 `cordis.patch.yml` 或 `--patch` 文件：对 `data-tools` 行的 id 定向覆盖（切勿再 `insert` 同名行）。
3. **设置文档**——`$DSH_HOME` 下的 `settings.yaml`，通过**数据源**设置页（或直接编辑文件）修改，实时生效、无需重启。

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

已知限制：语句守卫基于关键字而非解析器——请把它当作纵深防御，而不是沙箱。MariaDB 没有 `MAX_EXECUTION_TIME`（超时优雅降级）。V1 仅支持 MySQL。
