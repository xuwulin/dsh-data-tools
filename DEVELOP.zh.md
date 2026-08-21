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
| `src/index.ts` | 组合根：配置 Schema、连接解析、工具注册、settings 命名空间 |
| `src/sql/` | 方言抽象（`dialect.ts`）、MySQL 实现（`mysql.ts`）、五个 `db_*` 工具（`tools.ts`） |
| `src/client/` | 浏览器端：**数据源**设置页（React），打包为 `lib/client.js` |
| `scripts/db-smoke.mjs` | 仅开发用的连接冒烟测试（读 `dev.patch.yml`，绝不打印密码） |
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

这一行是组合 *base*。实际部署通过设置文档（**数据源**设置页，实时写入 `$DSH_HOME/settings.yaml`）或 id 定向的 `--patch` 覆盖层来覆盖它——**切勿**再发一个同 id 的 `insert`：loader 会拒绝重复条目 id（`duplicate loader entry id: data-tools`）。

## 构建与类型检查

```sh
npm install          # 或 pnpm install
npm run typecheck
npm run build        # tsc（后端 lib/）+ tsc（客户端类型）+ tsdown（lib/client.js）
```

`npm run build` 产出两半：Node 半（`lib/index.js`——工具 + settings 注册）和浏览器半（`lib/client.js`——设置页）。`lib/` 被 git 忽略；npm tarball 会携带它（`prepare` 脚本 `npm run build` 会在发布和 git 安装时自动重建）。

**版本对齐**：插件把 `@deepseek-ai/dsh-settings`、`dsh-tools`、`dsh-credentials` 锁定在 `0.1.1-rc.1`，与目标 harness 一致。如果对接到其它 rc 版本的 harness，请先同步 peer/dev 依赖——版本不一致时插件会从自己的 `node_modules` 加载不匹配的副本，可能在运行时失败。

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
