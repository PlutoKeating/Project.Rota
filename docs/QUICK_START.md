# 上手

## 环境要求

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 20 | 构建与运行 |
| pnpm | ≥ 10 | 包管理（仓库用 pnpm） |
| Python | ≥ 3.11 | 仅用于生成 LinkML 产物 |

## 1. 安装依赖

```bash
pnpm install
```

## 2. 本地跑起来

```bash
pnpm dev
```

Vite 会通过 `@cloudflare/vite-plugin` 在 workerd 里启动 Worker，前端与 `/api/*` 同端口。默认地址：

```
http://localhost:5173
```

访问 `/api/health` 应返回：

```json
{ "ok": true, "env": "development", "db": "down", "ts": "..." }
```

`db: "down"` 是正常的——还没建本地库。

> **Android / proot 环境**：workerd 需要 1 GB 对齐内存，在 proot 下会因 mmap 限制启动失败（tcmalloc 报 `MmapAligned() failed`）。此时 `pnpm dev` 不可用，改用 `pnpm test` / `pnpm typecheck` / `pnpm build` 做验证；要看真实页面就直接 `pnpm deploy` 到 Cloudflare。普通 Linux / macOS 不受影响。

## 3. 建本地数据库

```bash
pnpm db:local
```

它执行 `wrangler d1 migrations apply rota --local`，把 `migrations/0001_init.sql` 应用到 `.wrangler/state` 下的本地 D1。再次访问 `/api/health` 应变成 `db: "up"`。

## 4. 验证

```bash
pnpm test        # 46 个测试：单测 + 真实 SQL 的端到端流程
pnpm typecheck   # Worker 与 Client 两套 tsconfig
pnpm build       # 前端 + Worker 产物
```

## 5. 走一遍完整流程

打开界面后按这个顺序，十分钟能从空库排出一个班：

1. **学期** → 新建：`2026 秋`、开学日 `2026-09-07`、20 周、节次表（默认 12 节可直接用）。
2. **人员** → 新建两个人：张三、李四。
3. **组织** → 新建 `宣传部`；回到人员，给两人加成员关系（部门选宣传部）。
4. **课表** → 选张三 → 添加课程：高等数学、周一、第 1–2 节、每周。
5. **任务** → 新建 `迎新值班`（部门选宣传部）→ 加一个班次：`2026-09-07T08:00` 到 `08:45`。
6. **排班** → 点这个班次「试排」：张三因为周一第 1 节有课被排除，李四成为候选 → 确认分配。
7. **公平** → 李四计 1 次；**导出** → 班表 CSV。

课表也可以走 **导入**：上传教务导出的 Excel/CSV，或直接传课表截图（需先在设置里配一个支持视觉的模型供应商）。

## 6. 改本体

`schema/rota.yaml` 是唯一源。改完后：

```bash
python3 -m venv /root/venvs/linkml
/root/venvs/linkml/bin/pip install linkml

LINKML_BIN=/root/venvs/linkml/bin/linkml bash scripts/gen.sh
```

会重新生成：

- `migrations/0001_init.sql`（DDL）
- `docs/er.md`（ER 图）
- `schema/rota.schema.json`（JSON Schema）

> 已经上线过就不能改 `0001`，新增 `migrations/0002_xxx.sql`。

## 7. 部署

首次：

```bash
wrangler login
wrangler d1 create rota          # 把返回的 database_id 填进 wrangler.jsonc
wrangler r2 bucket create rota-files
wrangler kv namespace create CONFIG   # 把返回的 id 填进 wrangler.jsonc
pnpm db:remote
pnpm deploy
```

之后：

```bash
pnpm deploy
```

密钥不要写进 `wrangler.jsonc`：

```bash
wrangler secret put OIDC_CLIENT_SECRET
wrangler secret put LLM_API_KEY
```

## 常见问题

**`database_id` 报错 / 连不上 D1**
`wrangler.jsonc` 里的 `database_id` 是占位符，必须先 `wrangler d1 create rota` 换成真实 ID。

**`/api/terms` 返回 500**
本地没跑迁移，见第 3 步。

**pnpm 提示 ignored build scripts**
`pnpm-workspace.yaml` 里已放行 `esbuild` 与 `workerd`。若仍提示，执行 `pnpm rebuild`。

**端口被占用**
`pnpm dev --port 5174`。
