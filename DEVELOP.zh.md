# 开发指南

面向开发者和贡献者的开发、测试与发布说明。使用者请阅读 [README.md](README.md)（或 [中文版](README.zh.md)）；本文件面向需要构建、测试或发布插件的人。

## 环境要求

- Node.js 22.19+ / 24+
- npm（主要包管理器）或 pnpm
- 用于本地测试的 DeepSeek Harness checkout。本项目**不需要全局安装 dsh**——从 checkout 里直接跑 CLI 即可：

  ```sh
  # 在 harness checkout 根目录下
  pnpm dsh --help
  # 等价写法（没有 pnpm 时）：
  node --import tsx/esm apps/cli/src/bin.ts --help
  ```

## 项目结构

| 路径 | 作用 |
|---|---|
| `src/index.ts` | 组合根：配置 Schema（`.volatile()` 字段）、连接解析、工具注册、配置页策略 |
| `src/sql/` | 方言抽象（`dialect.ts`）、MySQL 实现（`mysql.ts`）、五个 `db_*` 工具（`tools.ts`） |
| `src/client/` | 浏览器端：插件自己的配置页（React），打包为 `lib/client.js` |
| `scripts/db-smoke.mjs` | 仅开发用的连接冒烟测试（读 `dev.patch.yml`，绝不打印密码） |
| `scripts/conn-smoke.mjs` | 仅开发用的连接冒烟测试，按组合层（bundle → profile → `dev.patch.yml`）取配置 |
| `scripts/plugin-smoke.mjs` | 仅开发用的契约测试：volatile 配置热更新、被拒保存的处理、配置页策略注册（不需要 host 和数据库） |
| `scripts/contract/` | 编译期探针：浏览器端的本地服务类型必须仍然匹配当前 harness 的客户端包 |
| `cordis.patch.yml` | bundle 默认配置层（安装时自动插入） |

## bundle 默认配置（`cordis.patch.yml`）

插件自带一个默认配置层 `cordis.patch.yml`，插入带占位连接的 `data-tools` 行；作为 bundle 安装时自动生效：

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

这一行是组合 *base*。实际部署从插件自己的**配置页**（**插件 → `@xwl12/dsh-data-tools` → 配置**，保存会写入当前 profile 的 `cordis.patch.yml`）或显式的 id 定向 `--patch` 覆盖层来覆盖它——**切勿**再发一个同 id 的 `insert`：loader 会拒绝重复条目 id（`duplicate loader entry id: data-tools`）。

## 为什么配置字段是 `.volatile()`

`connections`、`defaultMaxRows`、`defaultTimeoutMs` 在 Config Schema 上声明为 `.volatile()`。Loader 会把它们解析成稳定的**引用**而不是普通值，于是：

- `apply(ctx, config)` 拿到的是 `config.connections.get()` / `config.defaultMaxRows.get()` / `config.defaultTimeoutMs.get()`，类型由 Schema 推导（`ReturnType<typeof Config>`）；
- 配置页的一次保存会**就地提交进这些引用**——插件不重启；`lib/index.js` 的 `refresh()` 在引用身份变化时重新解析连接表，每个工具的入口都会先调用它；
- Schema 拒绝的保存根本到不了插件；被我们自己的逐类检查拒绝的保存（重名、某类必须给 `user`、不支持的 kind）会保留上一次的连接并记录原因。

配置页本身走 harness 的配置表单服务：用 `ctx.configForms.get('data-tools')` 读值、用 `ctx.configForms.whileServed(['data-tools'], …)` 让页面只在条目被服务时存在，并注册到 Plugins 页的 `plugins.row.config` 槽位，键为 `@xwl12/dsh-data-tools#data-tools`。

## 构建与类型检查

```sh
npm install          # 或 pnpm install
npm run typecheck    # 后端 + 客户端 + harness 契约探针
npm run build        # tsc（后端 lib/）+ tsc（客户端类型）+ tsdown（lib/client.js）
node scripts/plugin-smoke.mjs   # 构建后运行：volatile 配置契约，不需要 host
```

`npm run build` 产出两半：Node 半（`lib/index.js`——工具 + 配置页策略）和浏览器半（`lib/client.js`——配置页）。`lib/` 被 git 忽略；npm tarball 会携带它（`prepare` 脚本 `npm run build` 会在发布和 git 安装时自动重建）。

**版本对齐**：插件把 `@deepseek-ai/dsh-settings`、`dsh-tools`、`dsh-credentials` 锁定在 `0.2.0-rc.2`（当前桌面版），并且需要 schemastery `^3.18.4` 才有 `.volatile()`。如果对接到其它 rc 版本的 harness，请先同步 peer/dev 依赖并**优先**跑 `npm run typecheck`：客户端契约探针和后端 Schema 类型会在 API 变动处直接报错，而不是留下一个静默不挂载的页面。

## 本地安装到 dsh profile

先构建，再把本地 checkout 加进 profile：

```sh
npm run build        # 先生成 lib/
```

```sh
dsh plugin --profile web add /绝对路径/dsh-data-tools
# 用 checkout 内的 CLI：
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add D:/路径/dsh-data-tools
```

确认配置合成后启动（`--patch` 覆盖层按需添加——见 README 配置节的 id 定向覆盖写法）：

```sh
dsh --profile web --patch <overlay.yml> --dump-config
pnpm dsh web --patch ../dsh-data-tools/dev.patch.yml
```

**安装后必须重启 dsh**（改动 `exports` / `dsh.client` 后也一样）：浏览器半在启动时被发现，且发现结果在进程生命周期内缓存——运行中的实例不会加载新加的客户端插件。客户端发现通过 `require.resolve('<包名>/package.json')` 解析，所以包必须保留 `./package.json` 导出（`package.json` 里已声明，请勿移除）。

然后让 Agent 试，例如：*"用 db_connections，再用 db_list_tables 和 db_table_schema 看 `orders` 表，然后写一条和 `customers` 联表的查询。"*
