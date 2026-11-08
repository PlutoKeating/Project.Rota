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

## 人员对象导入边界

`api/agent-import.ts` 负责鉴权快照、批次、租约、原值校验和原子提交；`llm/agent.ts` 是 AI SDK 单轮凭据代理。协调器与 m 个人员子智能体都在浏览器执行，Worker 不解包、不识别文档、不运行 Agent 循环。

协议模式为 discover/person/verify/consistency/reconcile。协调器可分派人员和维护公共组织/日历；人员仅获得来源阅读、write_person 和 finish_person。Worker 返回调用及参数校验错误，由浏览器按对象权限执行；新旧协议不可混用，前后端同步发布。详见根目录 `docs/API.md` 与 `docs/AGENT_IMPORT.md`。

保留 OpenAI Compatible、Responses、Google、Anthropic 与 Workers AI 适配；Responses 由 params.api 显式选择。供应商按能力、全局排序和本批成功模型选择；保留 OpenCode 会话头、禁止重定向、内联图像检查、超时与脱敏诊断。SDK 隐式重试关闭，每候选最多 90 秒、候选窗口最多 120 秒。真实材料只经已配置模型读取，密钥不下发。

正式提交继续校验差异、引用、租约和排班冲突，派生数据与审核记录同事务写入。review 最大 2 MB 并纳入幂等摘要；已提交列表与报告检查批次归属，不保存原件或对话。仍要求既有 0005 迁移，本次无新增依赖、Secret 或业务迁移。

验证使用 `pnpm check`、`pnpm build`；浏览器对象协议由 `pnpm test:agent-browser` 覆盖。本地真实模型验收脚本隔离业务写入，历史旧架构成绩不代表新版准确率与耗时。

真实 Vertex 验收另支持 `pnpm test:agent-vertex-apply /private/input.zip /private/new-output`：从全新空快照开始，快照/批次/租约/提交/报告调用真实 Worker API，业务写入仅进入本进程隔离 SQLite；模型仍使用本机 Vertex。此模式拒绝快照文件与旧浏览器检查点，不继承远端存储环境变量。材料完整且客户端检查通过后自动提交到测试库，输出 applyMs、回读快照和审核报告，总耗时包含提交。缺少日历等条件时保持未提交并返回失败，不补造事实。默认 test:agent-vertex 仍禁止业务提交。可用 test/fixtures/live-apply.txt 做明确标注为虚构材料的提交链路冒烟测试；它不能证明真实压缩包的速度或准确率。无需新增依赖或迁移。

人员复核新增必填 source_student_numbers，填写本人原件明确印出的学号；未印出时为空数组。他人对照材料的学号不纳入。verify 上下文隐藏首次提取的 student_no，有课程方案的原件学号与保存身份不一致时拒绝完成，须回看原件并通过 write_person 修正 information；不以固定学号位数猜测学校规则。前后端工具协议须同步发布，无新增依赖、配置或迁移。已有完成检查点不追溯验证，须重新导入或显式返工。

按操作员确认的规则，导入不要求固定学期总周数。公共日历的 week_count 可空，投影按关联课表明确的最大周次与已有覆盖范围计算存储范围；minimum_weeks 可直接作为已知课程范围使用。遇到更晚课程自动扩展范围，不截断课程，不缩短已有学期，也不改变已有首周日期。UI 显示覆盖周数而非声称学校学期总长；日期、节次钟点和课程自身周次未知仍不能猜造。本次沿用现有 term.week_count 存储与时间展开，无新增依赖、环境变量或数据库迁移，前后端同步构建发布。

跨人核对新增 consistency 模式：待核对差异不少于两组时，按既有每批最多5组/通常8份来源划分，最多4个独立读取对象并行。各对象只可读取、保存本批核对结论或向本批涉及人员提出返工；不能修改日历、分派人员或交付导入。结论完成异步来源检查后合并检查点，避免并发覆盖。所有读取结束后按人合并返工说明、来源与重查索引；任一要求全量复核则合并为全量，不截断说明。部分失败保留已完成结论、待返工意见与未完成上下文，恢复不重跑已完成批次；暂停须等待在途请求结束，未执行工具可在刷新后继续。当前事实签名变化时丢弃过时读取任务，操作员新意见取消旧待执行意见。最终仍由协调器核对全局身份、日历、全部差异和提交条件，不减少检查组或放宽来源门槛。材料缺失/错放说明保留在各批上下文，避免遗漏跨目录证据。无新增依赖、环境变量、配置或迁移；前后端工具协议须同步构建发布。

2026-11-05本地真实整包验收（运行版本06bc2d0）：新批次从空库到实际提交回读517.079秒，2444次可辨识课程漏17次（0.6956%），满足整包600秒/2%门槛。尚有4项时段待补和3类已标注教师字段缺失，不能宣称逐人或全部字段通过。仅本地隔离SQLite，未发布；详见根目录 `docs/AGENT_IMPORT_ACCEPTANCE.md`，本次记录不改变依赖或部署配置。

## Kimi Code 的 Worker 出站兼容

2026-11-07实测同一已保存密钥：真实Cloudflare Worker调用`api.kimi.com/coding/v1/chat/completions`返回Cloudflare HTML 403，调用官方海外端点`api.kimi.ai/coding/v1/chat/completions`返回200。服务端统一解析供应商时，将官方HTTPS国内Coding根地址（`/coding`或`/coding/v1`）映射到官方海外同路径；连接测试与Agent SDK共用此解析，不改数据库配置或要求重新录入密钥。非默认端口、带查询/片段/用户信息、相似域名、其他路径及Moonshot开放平台地址不重写，不跟随重定向、不伪装客户端身份。

`kimi-for-coding`在官方Coding端点仅接受temperature=1，旧连接测试固定0导致400；传统网关对该模型使用1，实际Agent调用保持不指定采样参数、由供应商采用默认值。自定义供应商即使使用同名模型也不覆盖采样设置。不切换模型、套餐或开放平台，不新增依赖、Secret、配置项或迁移；更新Worker即可使已有配置生效。

依据：[Kimi官方协议与国内/海外端点](https://www.kimi.com/code/docs/en/)、[Cloudflare跨站Worker请求头](https://developers.cloudflare.com/fundamentals/reference/http-headers/)。回归覆盖测试连接、实际Agent工具请求、Anthropic路径及非官方端点隔离；真实验证仅发送简短测试输入，未上传人员材料。


## DeepSeek 思考模式下的工具调用

DeepSeek官方Chat接口默认开启思考模式，此时`tool_choice=required`或指定工具返回HTTP 400；思考模式的工具调用历史还必须回传`reasoning_content`。Agent对官方主机`api.deepseek.com`（OpenAI兼容Chat）保留思考、改用`tool_choice=auto`，未返回工具调用仍按协议失败切换下一个模型；由其他供应商产生、缺少推理内容的工具调用回合，仅在发给DeepSeek的副本中补占位推理，不改浏览器历史。配置`reasoning_effort: "none"`时关闭思考并继续强制工具调用。其他主机与自定义网关不变；无新增依赖、配置项或迁移。依据：[DeepSeek Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode)。回归见`test/integration/deepseek.test.ts`。
