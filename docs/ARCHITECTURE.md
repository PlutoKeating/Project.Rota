# 架构

## 1. 范围

单校区学生组织的排班系统：课表导入与确认、可用性计算、人工/自动分配、公平统计及 CSV 导出。v1 不做教务排课、跨校多租户、全局最优求解、原生 App 或邮件/短信通知。

## 2. 组件与边界

- `src/client`：React 19、Tailwind 4、hash 路由，排班/人员/导入三个日常入口及低频管理分区，旧路由兼容。登录门禁先请求 `/api/auth/me`；会话失效后回到登录页。
- `src/worker/api`：Hono 接口、权限、输入校验与审计。
- `src/worker/domain`：时间展开、可用性、评分及排班/账本服务。纯评分与时间函数不依赖运行时；排班和可用性服务使用 D1 兼容 SQL 接口访问 ECS SQLite。这与早期“所有领域代码不依赖 D1”的设计不同，以实际源码为准。
- `src/client/agent-import`：浏览器本地 Agent、文档 Worker、IndexedDB 检查点、隔离草稿与结构化复核。
- `src/shared/agent-import`：实体契约、工具定义、system prompt、纯数据展开与校验。
- `src/worker/import`：保留旧单文件接口的兼容实现；新导入窗口不调用固定解析器。
- `src/worker/llm`：OpenAI-compatible、Anthropic、Google 与 Workers AI 网关。配置每次从数据库读取，后台更新立即生效；不存在进程缓存。
- `src/worker/storage.ts`：通用 HTTPS 文件存储适配器。生产使用独立存储服务；测试或其他部署可提供 R2 兼容绑定。
- ECS 独立数据服务保存业务、管理员、会话、授权流程、应用设置及旧单文件导入原件；SQLite WAL 提供事务与持久化。Worker 不绑定 D1/KV/R2。数据服务地址和凭据仅通过 Worker Secrets 注入。详见 [数据服务架构](../storage/docs/ARCHITECTURE.md)。

`schema/rota.yaml` 定义领域模型，`0001_init.sql` 是初始生成结果。后续迁移增量维护：`0002_auth.sql` 定义运行时认证存储，`0003_assignment_guards.sql` 提供事务约束，`0004_admin_guard.sql` 防止停用最后一个所有者；`0005_browser_agent_import.sql` 提供浏览器 Agent 导入的业务表与事务保护。不得改写已部署迁移。

## 3. 请求路径

`/api/*` 先进入 Worker，其余路径由静态资源 SPA fallback 处理。公开 API 仅健康检查与认证入口；业务 API、原始导入数据、导出都要求登录。API 响应禁止缓存。

## 4. 认证与权限

生产前端与 API 统一使用 `https://rota.plutokeating.beer`，由 Wrangler 自定义域名路由绑定；禁用 Workers 临时入口与版本预览 URL。

身份来源为 `https://id.plutokeating.beer/` 的公开 OIDC 协议。使用 `oauth4webapi` 实现授权码 + PKCE S256、state、nonce、发现文档和 JWKS 验签，校验 issuer/audience/有效期。授权流程保存在 ECS SQLite，10 分钟有效，回调原子消费一次，并绑定浏览器 HttpOnly Cookie。

验证成功后只允许 `admin_user` 中启用的 subject 登录，不自动注册管理员、不以“第一个登录的人”为所有者。初始所有者通过私有部署操作加入数据库。后续由所有者在设置页维护名单。

会话为随机 opaque token，SQLite 只保存 SHA-256 摘要，8 小时有效。`__Host-` Cookie 为 HttpOnly、Secure、SameSite=Lax、Path=/。每次请求查询管理员启用状态与角色，退出删除服务端会话，角色变更撤销该账号全部会话。

- `admin`：业务数据读写与导出。
- `owner`：另可访问配置、供应商、审计和管理员授权。
- 非 GET/HEAD/OPTIONS 请求必须携带与 `APP_ORIGIN` 完全一致的 Origin。
- 本地绕过需同时设置 `APP_ENV=development|test` 与 `AUTH_DEV_BYPASS=true`；生产环境即使误设绕过开关也不放行。

公开仓库只记录标准客户端接口；身份服务的内部实现、账号清单、运维信息和真实秘密不得写入。

## 5. 导入与文件存储

当前导入入口采用浏览器本地 Agent，完整执行/锁/提交边界见 [AGENT_IMPORT.md](AGENT_IMPORT.md)。原件及对话保存在本机，完成或取消 8 小时后清理；ECS 仅承担既有数据持久化。`0005_browser_agent_import.sql` 新增独立课表、作息和实际占用，以及批次/租约/修订号表。新导入不调用下述旧解析流程。

### 旧单文件兼容接口

上传（上限 5 MiB）→ HTTPS 文件服务保存原件 → SQLite 导入任务 → 解析 → `needs_review` → 人工修改和确认 → 单个 SQL batch 提交所有课程、规则、选课、格子、任务状态与审计。

先完成全单校验与 SQL 计划，再开始写入，因此后续课程冲突不留下前半份导入。一次确认限制 1–100 门课程；重复的课程/教师组合要求先合并。共享课程仍有其他选课人时禁止 replace。

截图识别若所有课程时段均不合法，会重试一次，再失败则明确报告解析失败，不能把全部丢弃的课程当作成功。单节课的起止节次必须相同。

文件服务提供带认证的 PUT/DELETE；出站必须 HTTPS、使用 workerd 支持的 manual 模式拒绝重定向、30 秒超时，删除不存在的对象视为成功。文件服务与 SQLite 不构成分布式事务；上传后数据库创建失败会尽力清理原件，删除失败允许重试。

单次调课通过 occurrence 修改目标格子，停课使用 cancelled；全体选课人同步生效。重算 occurrence 会覆盖单次调整。

## 6. 排班

候选从有效任期的部门成员选取，排除课表、请假、跨部门占用、缺少技能与冷却期成员。请假与已排班按绝对时间检查，覆盖节次之外的任务。300 人查询使用 JSON 数组绑定，避免超出 D1 SQL 参数上限。

评分包含公平缺口、饥饿补偿、偏好、优先级和近期惩罚。同分以班次/人员稳定哈希打破。历史分配从 assignment 查询，跨周、跨月累计，冷却以目标班次时间和历史班次时间计算。自动排班优先处理候选少的班次，并填满人数；返回成功人次与未填席位数。

分配、账本与审计在单个 batch 内写入。数据库触发器在实际插入时再检查班次容量、关闭状态和同一人跨班次重叠，避免两个管理员同时确认造成超员或双重占用。

公平统计按周展示次数和分钟；API 的 `carryOver` 从之前窗口的有效分配计算，不把历史计数错误地在每周清零。重算采用单事务，避免先清空后部分重建。

## 7. 部署与验证

Cloudflare Worker 同时部署前端与 API，Workers AI 绑定见 `wrangler.jsonc`。GitHub Actions 执行检查和构建，可通过受限 SSH 更新 ECS 数据容器；Workers Builds 连接 GitHub main 自动发布 Worker。SQLite 迁移由数据容器启动时执行。具体步骤见 [QUICK_START.md](QUICK_START.md)。

私有数据存储的容器、持久卷、凭据、隧道与备份由私有运维记录管理，公开仓库只说明存储协议。

## 8. 已知边界

- 固定北京时间（UTC+08:00）；尚非任意时区产品。
- 解析器不支持所有教务导出变体、GBK、复杂合并单元格与非 WEEKLY 的 ICS 重复规则；确认页是必要步骤。
- 贪心算法不保证全局最优；先排某个任务会影响后续任务的候选。
- 课表/请假与排班的同时编辑不是跨请求的全局事务；变更后应重新试排并复核已有安排。
- 文件与数据库需分别备份，恢复时核对导入原件；首次上线前端验证不能替代真实用户的邮箱或第三方登录验证。

## 交互与模型配置更新

首页直接排班；班次、人员与初始化配置在侧栏完成。`POST /work` 将任务与显式日期班次合并为单事务写入；人员批量导入也整批校验、整批提交。

模型目录从 models.dev 获取，缓存一小时，手动刷新失败保留旧目录并提示过期。模型密钥可通过管理界面粘贴，以独立 Secret 加密后保存在现有 params JSON，密文不出 API。模型排序保存在设置存储并影响未指定 provider 的首选。已有 Secret 名称与默认模型配置兼容。详见 [Worker 模块架构](../src/worker/docs/ARCHITECTURE.md)。

OpenCode 网关出站补充客户端标识和每次逻辑操作的稳定会话头，识别重试复用会话；范围限定官方 HTTPS 主机，具体约定见 Worker 模块文档。


### 模型配置草稿与排序

模型配置新增 `/admin/model-config` 快照读写接口。Worker 直接在现有 SQLite `app_kv` 与 `llm_provider` 上执行同一事务，同时写入顺序和审计。事务内快照条件防止并发覆盖；没有新增迁移或环境变量。


### 上游模型错误诊断

LLM 网关把上游已知错误转换为固定中文诊断，保留当前模型和 HTTP 状态，不再把所有错误归因于密钥。仅识别确定的错误结构；原始响应不进入普通业务错误或日志；owner 连接测试单独返回脱敏的完整诊断，在对应模型卡片展示。

OpenCode Go 可选型号取 models.dev 与官方 `https://opencode.ai/inference/go/v1/models` 的交集。官方目录不可达时保留上次验证过的型号；首次失败暂不提供 Go 新增选项并返回提示，不影响其他供应商或已有配置。目录缓存升级为 `llm:catalog:v2`，避免继续使用未校验的旧列表；无需数据库迁移。官方目录仅证明型号存在，不保证账号、地区和额度权限。

浏览器导入执行器采用持久识别成果 + 外置工具历史 + 同 Agent 交接摘要，替代截断式上下文。原 IndexedDB 保持兼容，独立历史库与批次共同清理；Worker 仅提供有界的单轮模型代理。研究依据与故障恢复边界见 [AGENT_IMPORT.md](AGENT_IMPORT.md)。
