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

协议模式为 discover/person/verify/consistency/reconcile。协调器可分派人员和维护公共组织/日历；人员仅获得来源阅读、write_person、amend_timetable 和 finish_person。Worker 返回调用及参数校验错误，由浏览器按对象权限执行；新旧协议不可混用，前后端同步发布。详见根目录 `docs/API.md` 与 `docs/AGENT_IMPORT.md`。

保留 OpenAI Compatible、Responses、Google、Anthropic 与 Workers AI 适配；Responses 由 params.api 显式选择。供应商按能力、全局排序和本批成功模型选择；保留 OpenCode 会话头、禁止重定向、内联图像检查、超时与脱敏诊断。SDK 隐式重试关闭，每候选最多 90 秒、候选窗口最多 120 秒。真实材料只经已配置模型读取，密钥不下发。

正式提交继续校验差异、引用、租约和排班冲突，派生数据与审核记录同事务写入。review 最大 2 MB 并纳入幂等摘要；已提交列表与报告检查批次归属，不保存原件或对话。仍要求既有 0005 迁移，本次无新增依赖、Secret 或业务迁移。

验证使用 `pnpm check`、`pnpm build`；浏览器对象协议由 `pnpm test:agent-browser` 覆盖。本地真实模型验收脚本隔离业务写入，历史旧架构成绩不代表新版准确率与耗时。

复核工具 `finish_person.checks` 使用显式数组，每项包含课表 `key` 和字段核对结果；不使用动态键字典，以确保 Google 工具 schema 保留核对字段。对象持久化与正式审核报告仍按课表键保存检查结果，无新增依赖、环境变量或数据库迁移。

Google 导入请求支持供应商 params.reasoningEffort（或 reasoning_effort）的 low / medium / high，传递为原生 thinkingConfig.thinkingLevel；未配置时保留模型默认。隔离 Vertex 验收固定使用 gemini-4-argon 与 low，避免默认思考强度影响计时。本次无需新增依赖、迁移或部署参数。

人员复核 checks 新增必填 source_person_names：列出本课表原件明确印出的姓名（没有姓名时为空数组，教师对照材料不算本人课表）。有课程的方案若与目标姓名不符，运行时拒绝完成，须纠正身份或将误分派材料交回协调器；仅写文字冲突说明不能放行。已有完成检查点不追溯升级，验收须新建批次。工具协议变更要求前后端同步发布，无新增依赖、环境变量或迁移。

人员工具新增 amend_timetable，仅按当前人员的课表 key 和原课程 index 局部修正字段，或更新 replace_weeks / unresolved。未提及字段不应用创建默认值，整份候选课表校验成功后才替换，非法索引不留下前半份改动；修正清空旧检查，仍须 finish_person 逐项复核。短课表 key 使用 main / fall 等标识，最多 30 字符。协议需前后端同步发布，无新增依赖、环境变量或数据库迁移。

跨人核对新增 consistency 模式：待核对差异不少于两组时，按既有每批最多5组/通常8份来源划分，最多4个独立读取对象并行。各对象只可读取、保存本批核对结论或向本批涉及人员提出返工；不能修改日历、分派人员或交付导入。结论完成异步来源检查后合并检查点，避免并发覆盖。所有读取结束后按人合并返工说明、来源与重查索引；任一要求全量复核则合并为全量，不截断说明。部分失败保留已完成结论、待返工意见与未完成上下文，恢复不重跑已完成批次；暂停须等待在途请求结束，未执行工具可在刷新后继续。当前事实签名变化时丢弃过时读取任务，操作员新意见取消旧待执行意见。最终仍由协调器核对全局身份、日历、全部差异和提交条件，不减少检查组或放宽来源门槛。材料缺失/错放说明保留在各批上下文，避免遗漏跨目录证据。无新增依赖、环境变量、配置或迁移；前后端工具协议须同步构建发布。

## Kimi Code 的 Worker 出站兼容

2026-11-07实测同一已保存密钥：真实Cloudflare Worker调用`api.kimi.com/coding/v1/chat/completions`返回Cloudflare HTML 403，调用官方海外端点`api.kimi.ai/coding/v1/chat/completions`返回200。服务端统一解析供应商时，将官方HTTPS国内Coding根地址（`/coding`或`/coding/v1`）映射到官方海外同路径；连接测试与Agent SDK共用此解析，不改数据库配置或要求重新录入密钥。非默认端口、带查询/片段/用户信息、相似域名、其他路径及Moonshot开放平台地址不重写，不跟随重定向、不伪装客户端身份。

`kimi-for-coding`在官方Coding端点仅接受temperature=1，旧连接测试固定0导致400；传统网关对该模型使用1，实际Agent调用保持不指定采样参数、由供应商采用默认值。自定义供应商即使使用同名模型也不覆盖采样设置。不切换模型、套餐或开放平台，不新增依赖、Secret、配置项或迁移；更新Worker即可使已有配置生效。

依据：[Kimi官方协议与国内/海外端点](https://www.kimi.com/code/docs/en/)、[Cloudflare跨站Worker请求头](https://developers.cloudflare.com/fundamentals/reference/http-headers/)。回归覆盖测试连接、实际Agent工具请求、Anthropic路径及非官方端点隔离；真实验证仅发送简短测试输入，未上传人员材料。

本次修复以真实Worker预览运行当前网关与Agent代码、读取既有密钥进行验证：连接测试返回pong，Agent返回read_document工具调用；没有变更生产供应商记录。201项测试、SQLite服务测试、类型检查及构建通过。


## DeepSeek 思考模式下的工具调用

DeepSeek官方Chat接口默认开启思考模式，此时`tool_choice=required`或指定工具返回HTTP 400；思考模式的工具调用历史还必须回传`reasoning_content`。Agent对官方主机`api.deepseek.com`（OpenAI兼容Chat）保留思考、改用`tool_choice=auto`，未返回工具调用仍按协议失败切换下一个模型；由其他供应商产生、缺少推理内容的工具调用回合，仅在发给DeepSeek的副本中补占位推理，不改浏览器历史。配置`reasoning_effort: "none"`时关闭思考并继续强制工具调用。其他主机与自定义网关不变；无新增依赖、配置项或迁移。依据：[DeepSeek Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode)。回归见`test/integration/deepseek.test.ts`。

## 断开中止与 DeepSeek 推理深度（2026-11-08）

`wrangler.jsonc` 增加兼容标志 `enable_request_signal`。`/api/agent-imports/:id/turn` 把 `request.signal` 传入 `agentTurn`：浏览器超时或断开后，当前上游调用通过 `AbortSignal.any` 中止，不再尝试后续候选，避免无人接收的模型调用继续计费并占用供应商限流。DeepSeek 官方端点未配置 `reasoning_effort` 时，`person`（首轮提取）模式使用 `low` 以缩短思考延迟；`verify` 等复核模式保持默认深度。

## Worker CPU 与图片传输（2026-11-08）

生产在 1.3 MB 的 turn 请求上返回 Cloudflare 1102（Worker exceeded resource limits）。`agentTurn` 现在在校验后把图片 data URL 拆成 base64 与 mediaType 再交给 AI SDK，避免 SDK 对每张多 MB 的字符串执行 `new URL()` 与回写；上游收到的仍是相同的 data URL。若账户为 Workers 免费版（每请求约 10 ms CPU），大图请求仍可能偶发 1102，根治需升级 Workers Paid。

## 共享单轮执行（2026-11-08）

`agentTurn` 只负责读取启用的服务器模型、解密密钥并构造 Workers AI 绑定，单轮执行交给共享的 `src/shared/agent-import/turn.ts`（`runTurn`、`createChatModel`、`orderCandidates`、`TurnFailure`）。浏览器本机直连模式使用同一模块，因此两条路径的工具、回退与错误规则一致。

## 课表事件与时段的重叠计算（2026-11-08）

一次 19 人导入会产生约 1 万条 `timetable_event`，学期时段格子约 1500 个。人员列表的学期可排时长、单人可用性和批量可用性原先把每条事件与每个格子两两比较并反复解析日期，生产上触发 Cloudflare 1102（503）。现在统一用 `domain/availability.ts` 的 `forEachEventSlot`：格子只解析一次并按 UTC 日分桶，每条事件只比较相邻日期的格子；人员列表的空闲分钟按“全部格子时长减去占用格子时长”计算。结果与逐对比较一致，由 `test/integration/agent-import-scale.test.ts` 校验，本地该接口从约 4.4 秒降到约 35 毫秒。

## 共同空闲时段（2026-11-09）

`api/free-windows.ts` 校验人员（1–300，必到须在其中）、天数 1–28、个数 1–20、15 分钟对齐的每日窗口、星期与 0–120 分钟缓冲。`domain/free-windows.ts` 以人员 ID 的 JSON 数组绑定（同 300 人批量可用性），按 `julianday` 一次取回时间范围内的课程 occurrence、个人课表事件、已批准请假/黑名单与全部门有效排班，以及学期覆盖与「此人在该学期有无课表数据」；无覆盖或无数据的日子记为未知。计算交给 `src/shared/free-windows.ts`：15 分钟格、按格连续存放的状态与「下一次不空闲位置」、每个起点分桶求出各人群的最长时段，候选编码为数字键排序后贪心取不重叠时段（重叠者截短后放回堆中），同时输出热力图计数。只读接口不写审计；无新增依赖、迁移或环境变量。
