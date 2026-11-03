# 架构

> 先读 [`ONTOLOGY.md`](./ONTOLOGY.md) 了解数据模型；这里讲系统怎么跑起来。

## 1. 定位与非目标

**定位**：一个学生组织内部的排班系统。读入课表 → 计算可用性 → 给"活"排人 → 记账保公平。

**非目标**（v1 明确不做）：

- 通用排课系统（不改教务课表，只读）
- 跨校多租户 SaaS
- 全局最优求解（不用 CP-SAT，见 ADR-004）
- 原生 App（响应式 Web 即可）

## 2. 技术选型

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Cloudflare Workers | 全 Serverless，一个 Worker 同时出前端与 API，无服务器运维 |
| 前端 | React 19 + Tailwind CSS 4 | 响应式，手机/桌面同一套布局 |
| API | Hono | 轻、类型友好、Workers 原生 |
| 数据库 | D1（SQLite） | 与 Workers 同源，<300 人量级完全够用 |
| 文件 | R2 | 课表 Excel / 截图原文件 |
| 配置缓存 | KV | 模型供应商配置的版本号与热更新 |
| Schema | LinkML | 一份源生成 DDL / JSON Schema / ER 图 |
| 构建 | Vite 7 + `@cloudflare/vite-plugin` | 官方推荐的 Workers + SPA 一体化构建 |

## 3. 分层

```
┌─────────────────────────────────────────────┐
│ 界面层  src/client   React + Tailwind        │
├─────────────────────────────────────────────┤
│ 接口层  src/worker/api  Hono 路由 / 鉴权      │
├─────────────────────────────────────────────┤
│ 领域层  src/worker/domain                    │
│    time.ts    校历网格、周次展开              │
│    assign.ts  硬过滤 + 公平打分 + 贪心        │
│    （待建）availability.ts / ledger.ts       │
├─────────────────────────────────────────────┤
│ 存储层  src/worker/db   D1 查询               │
├─────────────────────────────────────────────┤
│ 本体层  schema/rota.yaml → migrations/*.sql  │
└─────────────────────────────────────────────┘
```

**约束**：领域层不 import 任何 Hono / D1 类型，只吃普通对象。这样打分逻辑可以在 Node 里跑单元测试，也可以整体替换成求解器。

## 4. 请求路径

`wrangler.jsonc` 里 `assets.run_worker_first: ["/api/*"]`：

```
GET /                → 静态资源（SPA fallback → index.html）
GET /api/health      → Worker → Hono
GET /api/terms       → Worker → Hono → D1
```

除 `/api/*` 外都交给 assets，Worker 不参与前端路由，避免 SPA 的 404 处理与 API 抢路径。

## 5. 三条主流程

### 5.1 课表导入

```
上传(Excel/CSV/ICS/截图)
  → R2 存原件
  → ImportJob(status=parsing)
  → 解析：结构化格式走解析器；截图 / 非固定格式走视觉模型
  → ImportJob(status=needs_review, parsed_json=…)
  → 管理员在界面逐条确认
  → 落 Course / CourseMeeting，展开 CourseOccurrence
```

**关键点**：模型解析结果**永不直接落库**，必须先经过 `needs_review`。课表错一格，后面所有排班都是错的。

### 5.2 排班

```
部门选任务与时段
  → 生成 Shift（一次性直接建；周期任务由 ShiftPattern 展开）
  → 硬过滤：课表占用 / 请假 / 跨部门已排 / 角色技能 / 冷却
  → 打分排序（assign.ts）
  → 贪心分配：候选最少的班次优先排，避免"好排的排完、难排的没人"
  → 写 Assignment + reason，更新 FairnessStat
  → 导出 / 通知
```

### 5.3 公平结转

每次分配后更新 `fairness_stat`。窗口滚动时把 `shift_count` 折算进 `carry_over`，新窗口从结转值起算。重算必须幂等（按 `(person, org, window_key)` upsert）。

## 6. 目录结构

```
Project.Rota/
├── AGENTS.md              # Agent 开发规范
├── README.md
├── schema/rota.yaml       # 唯一 schema 源
├── migrations/            # 由 schema 生成，勿手改
├── docs/                  # 架构 / 本体 / API / 上手
├── scripts/gen.sh         # LinkML → DDL / ER / JSON Schema
├── src/worker/            # Hono API + 领域逻辑
├── src/client/            # React 界面
└── test/                  # 领域层单测
```

## 7. 鉴权

- 身份来源：`https://id.plutokeating.beer`（OIDC）。
- 只有 `admin_user` 表里的 subject 能登录后台；`role=owner` 可改模型配置与账号。
- 会话：HttpOnly + Secure + SameSite=Lax 的签名 Cookie，短期有效。
- 所有写接口要求 `role in (owner, admin)`，并记 `audit_event`。

> 当前代码尚未实现 OIDC 流程，`/api/*` 处于开放状态。上线前必须先补鉴权（见 API.md 的"待实现"）。

## 8. 模型网关

`llm_provider` 表存供应商配置（`kind` / `base_url` / `model` / `api_key_secret`），密钥放 Worker Secret，表里只存名字。

热更新的做法：

1. 后台改配置 → 写 D1 → `CONFIG.put("llm:version", Date.now())`。
2. 调用时读 KV 版本号，与进程内缓存比对，变了就重新加载。
3. 不需要重新部署 Worker。

调用统一走 OpenAI-compatible 协议；`cloudflare_ai` 走 Workers AI 绑定，不需要外部 key。

## 9. 部署

```bash
pnpm build          # 前端 + Worker
wrangler deploy     # 或 pnpm deploy
```

环境变量与绑定在 `wrangler.jsonc`；密钥用 `wrangler secret put`，不进仓库。

## 10. 容量与边界

- 目标规模：**单校区 <300 人**，一个学期 20 周。
- `slot` 行数：20 × 7 × 12 ≈ 1.7k / 学期，十年也就几万行。
- `assignment` 量级：每周几十到几百条，一年万级。
- D1 单库容量与并发上限见 Cloudflare 官方 limits，本项目远低于阈值。
- 真正的瓶颈不是数据量，是**冲突检测的查询次数**：一次排班要按人 × 时段查占用，必须批量查（一条 SQL 取整个窗口的占用），不能 N+1。

## 11. 决策记录

| 编号 | 决策 | 备选 | 理由 |
| --- | --- | --- | --- |
| ADR-001 | Cloudflare Worker 单体 | 前后端分离 / VPS | 用户指定；无运维、免费额度足够 |
| ADR-002 | LinkML 生成 DDL | 手写 ER / Prisma | 本体先行，且能同时产出 JSON Schema 与文档 |
| ADR-003 | 校历网格 + occurrence 物化 | 运行时展开 RRULE | 单双周在 SQL 里无法高效参与冲突检测 |
| ADR-004 | 规则打分，不上 CP-SAT | OR-Tools 全局求解 | 用户选择；可解释、可调、无额外运行时 |
| ADR-005 | 不引入 RDF / 图库 | Oxigraph / Neo4j | 事务与 D1 兼容性优先，本体价值在约束不在查询 |
| ADR-006 | Shift 用绝对时间，Slot 用格子 | 全部用格子 | 临时任务、跨学期边界用绝对时间更稳 |
| ADR-007 | 不引入 Docker | Docker Compose | 全 Serverless，无容器需求 |

## 12. 已知风险

1. **课表解析**是最大不确定性：教务导出的 Excel 格式各校不同，视觉模型也可能读错。缓解：先做"解析 → 人工确认"两步，不追求全自动。
2. **时区**：目前固定 `+08:00`。若出现跨时区成员，需要把 `timezone` 用起来（表里已留字段）。
3. **并发排班**：两个管理员同时排同一时段可能重复占人。缓解：分配走单条 SQL 事务 + 唯一键兜底。
4. **公平的口径争议**：权重是拍出来的，必须允许管理员调参并留痕。
