# Worker

生产唯一入口为 `https://rota.plutokeating.beer`；`wrangler.jsonc` 配置自定义域名并禁用临时入口和版本预览 URL。OIDC 客户端登记回调为 `https://rota.plutokeating.beer/api/auth/callback`，身份服务侧须同步删除旧临时域名回调。

Hono 统一提供认证、业务 API、目录代理与模型网关。继续使用 ECS 数据服务的 SQL/KV 兼容接口，没有新增 Cloudflare 数据绑定；浏览器 Agent 导入需要增量迁移 0005。

新增能力：`POST /work` 原子创建任务与重复班次；`POST /persons/import` 原子导入人员与部门关系；管理端 models.dev 目录、模型优先顺序与加密 API 密钥。

验证：`pnpm check`（类型、真实 SQLite 集成测试及数据服务测试），`pnpm build`。生产发布命令与密钥配置见根目录 docs/QUICK_START.md。

OpenCode Go/Zen 已内建真实客户端标识与稳定会话头适配；既有配置即时生效，无新增依赖、环境变量或迁移。


### 模型配置草稿与排序

整页模型配置由 GET/PUT `/admin/model-config` 提供，要求 owner。PUT 验证整份输入、加密新密钥后，在同一 SQLite batch 中比较版本并保存模型、顺序和审计；冲突或错误保留原配置。


### 上游模型错误诊断

模型错误提示已区分不可用型号、会话头缺失、请求格式、鉴权、访问限制与限流。现有配置无需重存；无新增依赖、环境变量或数据库迁移，沿用现有构建与发布脚本。

OpenCode Go 可选型号取 models.dev 与官方 `https://opencode.ai/inference/go/v1/models` 的交集。官方目录不可达时保留上次验证过的型号；首次失败暂不提供 Go 新增选项并返回提示，不影响其他供应商或已有配置。目录缓存升级为 `llm:catalog:v2`，避免继续使用未校验的旧列表；无需数据库迁移。官方目录仅证明型号存在，不保证账号、地区和额度权限。


模型连接测试相互独立，不阻塞其他测试或配置编辑、排序、保存。测试使用已保存配置，结果位于对应模型卡片内；失败展示 HTTP 状态、上游代码/类型和可滚动的完整错误正文（敏感信息脱敏），不占用页面顶部错误区域。

## 浏览器 Agent 导入边界

`api/agent-import.ts` 提供鉴权业务快照、批次、租约、原子提交；`llm/agent.ts` 用 AI SDK 单轮适配模型协议，浏览器决定后续工具调用，服务端不运行 Agent 循环。按全局模型顺序过滤明确不支持视觉/工具的配置并尝试可用项；保留 OpenCode 客户端与会话头，禁止重定向。密钥只用于上游请求。

正式提交校验完整差异、原值、引用和派班冲突，派生数据及审计同事务写入。普通 CRUD 也受租约触发器保护，租约过期可恢复。独立课表实际时间纳入 availability、人员周课表/可用时长和 scheduler，支持全局节次之外的占用。新增迁移 `0005_browser_agent_import.sql`，无新增环境变量。详见 `docs/AGENT_IMPORT.md` 与 `docs/API.md`。

Agent 单轮代理新增 `work/compact/checkpoint/verify` 模式、批次内成功模型复用与短暂冷却、请求/候选耗时诊断。运行依赖和环境变量不变；新前端与 Worker 需同步发布。协议见根目录 `docs/API.md`。

### 导入实际材料回归修正

兼容模型使用 `@ai-sdk/openai-compatible` 2.x，与 AI SDK 6 对齐；保留并回传 reasoning_content，不在用户处理记录中展示模型思维链。响应返回前验证所有工具调用，损坏 JSON、未知工具及截断输出整轮拒绝并切换候选；合法 JSON 的契约错误保留为 validationError 反馈，浏览器禁止执行。MiniMax M3.1 默认 reasoning_effort=medium，供应商显式 params 设置优先。新增结构化课表和 OCR 工具在浏览器执行，Worker 不负责文件识别，未增加业务迁移或环境变量。

导入单轮代理支持 `work`、`compact`、`checkpoint`、`verify`：保存成果阶段仅提供持久化与查询工具，暂不提供新文件读取工具，返回调用须属于当轮开放工具集合。逐人复核继续使用同一 Agent，通过 `revise_timetable` 增量纠正、`confirm_timetable_check` 记录来源回看与方案签名。

`verify` 仅开放当前原件读取、课表查询/修订、核对确认及必要历史读取，不混入全局笔记、通用 CRUD 或新材料发现工具。

无进展冷却优先选择其他可用模型；只有一个候选或所有候选都在此类冷却中时保留纠错尝试，浏览器仍限制连续失败与空转次数。不是取消供应商的限流或超时处理。

params.api="responses" 可为 openai_compatible 选择原生 Responses（含管理页连接测试），默认保持 Chat Completions。额度耗尽单独脱敏分类；Retry-After 秒数进入诊断，浏览器不对已知额度耗尽立即重试。未新增依赖、环境变量或数据库迁移。

本地 Vertex 验收复用 agentTurn 与 Google SDK，OAuth 路由适配仅位于 test/live/vertex.ts，不进入生产 Worker。此模式不读取生产模型配置，亦不更改既有密钥/排序。测试代理在 Vertex 返回 401 时重新获取 gcloud token 并仅重试一次，避免缓存 token 提前到期导致长任务暂停。

导入代理新增日历证据保存/读取工具；verify/checkpoint 均开放，生成学期与全批确认只在 work 开放。Google 图像请求默认 HIGH 媒体分辨率（供应商 mediaResolution 可覆盖）。apply 可携带最大 2 MB 结构化 review，和业务修改原子存入 audit_event，纳入幂等摘要。新增已提交批次列表与 report 读取端点，均限制批次归属；不保存原件或模型对话。无新增依赖、环境变量或迁移。
