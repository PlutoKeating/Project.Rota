# Worker 边界

生产 `APP_ORIGIN` 为 `https://rota.plutokeating.beer`，授权请求与换取令牌共同使用由它生成的 `/api/auth/callback`；写请求来源校验也使用同一配置。登录/注册共用 OIDC 授权回调，账号系统仍为 `https://id.plutokeating.beer/`。

- `/work` 在写入前验证日期、人数、部门和每次重复所在学期，单个 batch 提交 task、shift 与审计，失败不留下空任务。
- `/persons/import` 限制 1–300 人，必填姓名/学号；重复学号整批拒绝。人员、可选部门成员关系与审计一次提交。
- `llm/catalog.ts` 从固定 HTTPS models.dev/api.json 获取目录，按一小时缓存，支持手动刷新。刷新失败返回带 stale 标记的上次成功目录；首次失败返回可重试错误。未知 SDK 协议不出现在可选列表，不假设全部兼容 OpenAI。
- `llm/secrets.ts` 用独立 Worker Secret 中的 32 字节 base64 密钥执行 AES-GCM；每条密钥使用新的随机 12 字节 IV。密文存在 provider.params.encryptedKey，公开视图移除密文，只提供 hasKey。参数更新保留已有密文，不能通过 params 注入密文。旧 Worker Secret 名称配置兼容。
- `llm:order` 保存配置 ID 顺序。网关逐请求读取，跳过停用条目；图片输入跳过明确标记不支持图片的条目。明确指定 providerId 时使用指定模型。此版本没有跨供应商自动失败转移。
- 上游模型请求禁止重定向；普通业务错误不回显上游正文。owner 连接测试返回完整脱敏正文及 HTTP 状态、错误代码和类型；实际 API 密钥（包括 URL 编码/JSON 转义形式）及认证字段被遮蔽，诊断正文不写入审计。连接测试与真实识别使用同一网关。

配置/API 仍要求 owner；普通业务仍允许 admin。密钥明文不得进入日志、审计、浏览器存储或公开响应。

## OpenCode 会话适配

官方 HTTPS `opencode.ai` 的 `/zen/` 与 `/inference/` 请求自动携带 `User-Agent: Project.Rota/0.1.0` 和 `x-opencode-session`，适用于测试连接与实际识别。每个截图识别任务生成独立随机 ID，解析重试复用该 ID；不使用账号、密钥或全局固定值作为会话。其他域名不发送这组专用头，即使 catalogId 被设置为 opencode-go。无需修改或重新保存已有供应商。

依据：[Go 客户端要求](https://opencode.ai/v2/docs/console/go/)、[Console 接入说明](https://opencode.ai/v2/docs/console/harnesses)。官方免费层客户端、账号、地区及额度限制仍然生效；本实现不伪装成 OpenCode 客户端。当前修复针对缺失会话头的 HTTP 400，不保证所有免费模型或历史端点可用。


### 模型配置草稿与排序

`model-config` 使用真实数据服务现有的 `app_kv` 表，与 provider 在同一 SQLite 事务中读快照和写配置；快照版本包括条目 id/updatedAt 和原始顺序。写入前检查版本，事务首条 NOT NULL 条件断言再次检查，避免检查后并发写入。所有配置项采用单调更新时间戳，密钥沿用服务端密文；更改地址必须重新填写密钥。事务还包含审计，只记录条目 ID。旧 API 保留兼容，网关仍通过 CONFIG 读取同表顺序。


### 上游模型错误诊断

已知错误分类发生在 `complete` 的非 2xx 分支，连接测试和真实识别复用同一实现。真实上游对比发现：同一密钥与 Go OpenAI 端点下，minimax-m3.1-flash 返回 200，而 minimax-m3.1-flash-free、step-5-preview-free 返回 400 / Model is unavailable。此记录仅代表诊断时的结果，不作为永久模型白名单；不自动替换型号、改换服务端点或改变计费。测试复用捕获的错误结构，并断言响应不含上游敏感字段。

OpenCode Go 可选型号取 models.dev 与官方 `https://opencode.ai/inference/go/v1/models` 的交集。官方目录不可达时保留上次验证过的型号；首次失败暂不提供 Go 新增选项并返回提示，不影响其他供应商或已有配置。目录缓存升级为 `llm:catalog:v2`，避免继续使用未校验的旧列表；无需数据库迁移。官方目录仅证明型号存在，不保证账号、地区和额度权限。

## 人员对象导入边界

`api/agent-import.ts` 负责鉴权快照、批次、租约、原值校验和原子提交；`llm/agent.ts` 是 AI SDK 单轮凭据代理。协调器与 m 个人员子智能体都在浏览器执行，Worker 不解包、不识别文档、不运行 Agent 循环。

协议模式为 discover/person/verify/reconcile。协调器可分派人员和维护公共组织/日历；人员仅获得来源阅读、write_person 和 finish_person。Worker 返回调用及参数校验错误，由浏览器按对象权限执行；新旧协议不可混用，前后端同步发布。详见根目录 `docs/API.md` 与 `docs/AGENT_IMPORT.md`。

保留 OpenAI Compatible、Responses、Google、Anthropic 与 Workers AI 适配；Responses 由 params.api 显式选择。供应商按能力、全局排序和本批成功模型选择；保留 OpenCode 会话头、禁止重定向、内联图像检查、超时与脱敏诊断。SDK 隐式重试关闭，每候选最多 90 秒、候选窗口最多 120 秒。真实材料只经已配置模型读取，密钥不下发。

正式提交继续校验差异、引用、租约和排班冲突，派生数据与审核记录同事务写入。review 最大 2 MB 并纳入幂等摘要；已提交列表与报告检查批次归属，不保存原件或对话。仍要求既有 0005 迁移，本次无新增依赖、Secret 或业务迁移。

验证使用 `pnpm check`、`pnpm build`；浏览器对象协议由 `pnpm test:agent-browser` 覆盖。本地真实模型验收脚本隔离业务写入，历史旧架构成绩不代表新版准确率与耗时。
