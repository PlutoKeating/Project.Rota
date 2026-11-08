# API

> 契约的**类型定义**在 [`src/shared/types.ts`](../src/shared/types.ts)，本文件只描述路由与行为。
> 实现分布：`src/worker/api/*.ts`，统一挂在 `/api` 下。

## 通用约定

- JSON 一律 camelCase；数据库列是 snake_case，由 `lib/core.ts` 的 `camelize` 转换。
- 列表返回 `{ items: T[] }`；单资源直接返回对象。
- 错误：`{ "error": { "code": "...", "message": "..." } }`，`code` 取值 `bad_request` / `unauthorized` / `forbidden` / `not_found` / `conflict` / `internal`（存储与模型服务另有专用错误码）。
- 时间：ISO 8601 带偏移（`2026-10-07T10:00:00+08:00`）；日期用 `YYYY-MM-DD`。
- 鉴权：除健康检查和认证入口外，所有业务接口要求启用的管理员会话；`/admin/*` 要求 owner。写请求必须带与 `APP_ORIGIN` 一致的 Origin。生产禁止开发绕过。
- 写操作都会落 `audit_event`。

## 校历

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/terms` | 学期列表 |
| `POST` | `/terms` | 建学期，事务内生成节次与全部格子 |
| `GET` | `/terms/:id` | 详情 + 计数 |
| `PATCH` | `/terms/:id` | 改名 / 改状态 |
| `DELETE` | `/terms/:id` | 有课程时 409 |
| `GET` | `/terms/:id/periods` | 节次 |
| `GET` | `/terms/:id/slots?week=&weekday=` | 格子（可按周过滤） |

`POST /terms` 接收 `CreateTermInput`，返回 `TermDetail`。生成格子数 = `weekCount × 7 × periods.length`，最多 30 周（SQL batch 分批，每批 ≤ 100 条语句）。

## 人员与组织

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/persons?q=&orgId=&termId=` | 搜索；带 `termId` 时附 `freeMinutes` |
| `POST` | `/persons` | 新建 |
| `GET` | `/persons/:id?termId=` | 详情 + 成员关系 |
| `PATCH` | `/persons/:id` | 改资料 / 状态 |
| `DELETE` | `/persons/:id` | 有排班记录时 409 |
| `GET` | `/persons/:id/timetable?termId=&week=` | 周课表（含不可用标记） |
| `GET` | `/persons/:id/availability?termId=&week=` | 可用性格子 |
| `GET` | `/persons/:id/unavailability` | 请假 / 黑名单 |
| `POST` | `/persons/:id/unavailability` | 新建（`status=approved` 直接生效） |
| `DELETE` | `/unavailability/:id` | 删除 |
| `GET` | `/orgs` | 组织列表（含 parentId，前端自行建树） |
| `POST` | `/orgs` | 新建 |
| `PATCH` | `/orgs/:id` | 改名 / 改父级 |
| `DELETE` | `/orgs/:id` | 有成员时 409 |
| `GET` | `/roles?orgId=` | 角色 |
| `POST` | `/roles` | 新建 |
| `GET` | `/memberships?orgId=&personId=` | 成员关系（带组织名、角色名） |
| `POST` | `/memberships` | 加人入部门 |
| `PATCH` | `/memberships/:id` | 改角色 / 状态 / 结束日期 |
| `DELETE` | `/memberships/:id` | 软删（`ended`） |

## 课程与课表

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/courses?termId=&personId=` | 课程列表 |
| `POST` | `/courses` | 建课 + 选课 + 多条上课规则，事务内展开 occurrence |
| `GET` | `/courses/:id` | 课程 + 规则（含展开次数） |
| `DELETE` | `/courses/:id` | 连带 meeting / occurrence / enrollment |
| `POST` | `/courses/:id/enroll` | 追加选课人 |
| `POST` | `/courses/:id/meetings` | 追加一条上课规则并展开 |
| `DELETE` | `/meetings/:id` | 删规则及其 occurrence |
| `GET` | `/courses/:id/occurrences` | 具体上课时段，含周次/节次/status |
| `PATCH` | `/occurrences/:id` | `{slotId?,status?,note?}`；只可移到同学期格子，status 为 scheduled/cancelled/moved |
| `POST` | `/terms/:id/recompute-occurrences` | 全量重算（幂等） |

`POST /courses` 接收 `CreateCourseInput`：同一门课可被多人选（`personIds`），规则只存一份，展开时按人复制？

调课影响本课程全部选课人；停课不产生占用。重算 occurrence 会按原规则重新生成并覆盖单次调课，请先确认再执行。

**不复制。** `course_meeting` 属于课程，`occurrence` 也属于课程；某个人的占用 = 他 `enrollment` 的课程的 occurrence。这样 30 个人选同一门课只存一份规则、一份 occurrence。

## 任务与班次

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/tasks?orgId=` | 任务列表 |
| `POST` | `/tasks` | 新建 |
| `PATCH` | `/tasks/:id` | 改标题 / 状态 |
| `DELETE` | `/tasks/:id` | 有班次时 409 |
| `GET` | `/tasks/:id/shifts` | 班次（含已排人） |
| `POST` | `/tasks/:id/shifts` | 加一个具体班次 |
| `POST` | `/tasks/:id/shifts/generate` | 按周规则批量生成，幂等（同一时段不重复建） |
| `DELETE` | `/shifts/:id` | 有分配时 409 |

## 排班

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/shifts?from=&to=&orgId=&status=` | 班次看板 |
| `POST` | `/shifts/:id/preview` | **只算不写**：候选 + 打分明细 + 被排除原因 |
| `POST` | `/shifts/:id/assign` | 指定人或自动选最高分；事务写 assignment + 公平账本 |
| `POST` | `/tasks/:id/auto-assign` | 整任务贪心排：候选最少的班次优先，填满 requiredHeadcount；assigned 为成功人次，skipped 为未填席位 |
| `DELETE` | `/assignments/:id` | 撤销，回滚账本 |

`preview` 请求体（均可选）：`{ "cooldownDays": 3, "weights": {...} }`，缺省读 `/admin/settings`。

## 公平

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/fairness?orgId=&windowKey=` | 账本，按次数升序（最亏的在前） |
| `POST` | `/fairness/recompute` | 从 `assignment` 重算，幂等 |

`windowKey` 规则：`<termName>-W<周次>`。不传时返回所有窗口。`carryOver` 为该周开始前同组织的历史有效分配次数；试排计入跨窗口历史。

## 旧单文件导入兼容接口

新导入界面使用下文浏览器 Agent API，不调用此固定解析流程。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/imports` | `multipart/form-data`：`file` + `sourceKind` + `termId` + `personId?` |
| `GET` | `/imports` | 最近 50 条 |
| `GET` | `/imports/:id` | 状态与解析结果 |
| `POST` | `/imports/:id/apply` | 把解析结果落成课程；可选覆盖 |
| `DELETE` | `/imports/:id` | 删除任务与 存储原件 |

解析优先级：`excel` / `csv` → SheetJS；`ics` → 自研 VEVENT 解析；`screenshot` → 视觉模型。识别结果进 `needs_review`，**不自动落库**。

`apply` 请求体（均可选）：

```json
{
  "parsed": { "courses": [ ... ] },
  "replace": false,
  "termId": "01J...",
  "personId": "01J..."
}
```

- 传 `parsed` 时用它覆盖库里的原始解析结果（前端确认页改过的内容）。
- `replace: true` 允许覆盖已应用的任务；`overwrite` 作为同义字段兼容。
- 未传 `termId` / `personId` 时用导入时记录的值。
- 一次确认 1–100 门课程，先校验整单，再用一个数据库事务写入；失败保留 needs_review，不留下部分课程。重复课程名/教师组合需先合并。

## 管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/admin/settings` | 权重、冷却、导入默认 provider |
| `PUT` | `/admin/settings` | 覆盖写 |
| `GET` | `/admin/llm-providers` | 列表（密钥只回名字） |
| `POST` | `/admin/llm-providers` | 新增 |
| `PATCH` | `/admin/llm-providers/:id` | 改配置，写 SQLite 设置版本号即时生效 |
| `DELETE` | `/admin/llm-providers/:id` | 删除 |
| `POST` | `/admin/llm-providers/:id/test` | 发一条最小请求探测 |
| `GET` | `/admin/audit?limit=` | 审计 |
| `GET` | `/admin/users` | 管理员名单 |
| `POST` | `/admin/users` | 按 `{oidcSubject,fullName,role}` 授权，role 为 admin 或 owner |
| `PATCH` | `/admin/users/:id` | 修改 role/enabled，同时撤销该账号会话；禁止修改自己 |

## 导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/export/schedule.csv?from=&to=&orgId=` | 班表 CSV（带 BOM，Excel 直接打开） |
| `GET` | `/export/fairness.csv?orgId=&windowKey=` | 公平账本 CSV |

## 认证

生产 API 基址为 `https://rota.plutokeating.beer/api`。账号系统登记的登录/注册授权回调为 `https://rota.plutokeating.beer/api/auth/callback`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/auth/me` | `{ authenticated, user, mode }`，未登录 user=null，生产 mode=oidc |
| `GET` | `/auth/login` | 创建一次性 state/nonce/PKCE，302 到身份提供方 |
| `GET` | `/auth/callback` | 交换并验证 ID Token，检查白名单，建立 8 小时会话并回到首页 |
| `POST` | `/auth/logout` | 校验 Origin、删除会话、清除 Cookie |

失败回到 `/?auth_error=invalid_state|expired|not_allowed|failed`。不把上游响应、令牌或授权码写入日志。会话 Cookie 为 `__Host-rota_session`，HttpOnly、Secure、SameSite=Lax；角色/停用状态每次从数据库读取。

## 健康检查

`GET /health`，实现见 `src/worker/index.ts`。

## 数据持久化

所有正式业务、身份会话、设置和旧单文件导入原件在 ECS 数据服务持久化；新浏览器 Agent 的原件、派生材料和对话保存在本机 IndexedDB，完成或取消 8 小时后清理。内部 SQL / 文件协议仅供 Worker，见 [数据服务架构](../storage/docs/ARCHITECTURE.md)。

## 简化操作 API

- `POST /work`：`{title,orgId,startsAt,endsAt,requiredHeadcount?,repeatWeeks?,location?}`，人数 1–300，重复 1–30 周。每个日期必须在已建学期内，成功 201 `{taskId,shiftIds}`；任务、全部班次与审计原子写入。
- `POST /persons/import`：`{items:[{fullName,studentNo}],orgId?}`，1–300 人，重复学号拒绝整批，成功 201 `{created}`。
- `GET /admin/model-catalog`：`{fetchedAt,stale,providers,error?}`；provider 包含 id/name/kind/baseUrl/models，model 包含 id/name/vision/context。缓存一小时。
- `POST /admin/model-catalog/refresh`：主动刷新同一目录；上游失败且有缓存时返回 stale=true，无缓存时 502。
- `GET /admin/model-order`：`{ids:string[]}`；`PUT` 同样格式，拒绝重复或未知 ID，排序立即影响默认首选。
- 模型新增/更新额外接收 `apiKey`（仅写）；返回 params.hasKey，永不返回明文或 encryptedKey。保留 apiKeySecret 兼容，已存加密密钥优先。修改普通参数不清除旧密钥。

批量排班预览由前端逐班调用 preview，不写分配。确认后调用既有 auto-assign，服务端重新计算冲突；候选数量是当前快照，不保证最终填满数量。

## OpenCode 会话适配

官方 HTTPS `opencode.ai` 的 `/zen/` 与 `/inference/` 请求自动携带 `User-Agent: Project.Rota/0.1.0` 和 `x-opencode-session`，适用于测试连接与实际识别。每个截图识别任务生成独立随机 ID，解析重试复用该 ID；不使用账号、密钥或全局固定值作为会话。其他域名不发送这组专用头，即使 catalogId 被设置为 opencode-go。无需修改或重新保存已有供应商。

依据：[Go 客户端要求](https://opencode.ai/v2/docs/console/go/)、[Console 接入说明](https://opencode.ai/v2/docs/console/harnesses)。官方免费层客户端、账号、地区及额度限制仍然生效；本实现不伪装成 OpenCode 客户端。当前修复针对缺失会话头的 HTTP 400，不保证所有免费模型或历史端点可用。


### 模型配置草稿与排序

`GET /admin/model-config`（owner）返回 `{ version, items: LlmProvider[] }`，items 按调用顺序排列。`PUT /admin/model-config` 接收 `{ expectedVersion, items }`（最多 200 项，每项包含稳定 id，可选 apiKey）；省略旧项即删除，数组顺序为调用顺序。保存模型、顺序、审计为单事务，密钥加密且不返回。版本冲突返回 409，参数错误 400，失败不产生部分配置。旧逐项 CRUD 和 model-order 接口仍兼容；前端整页保存应只调用新接口。


### 上游模型错误诊断

模型测试返回 `{ ok, message, status?, code?, type?, details? }`；真实调用仍使用 `llm_error`（HTTP 502）。`message` 根据上游状态与明确的错误标识分类：`Model is unavailable` 提示当前模型/端点不可用，`MissingSessionID` 提示会话头，普通 400/422 提示请求参数或协议。owner 测试接口的 details 保留完整上游错误正文（包含非 JSON），不截断；发送前脱敏实际 API 密钥及认证字段。status 为上游 HTTP 状态，code/type 为上游代码与类型；未提供时不伪造。普通业务 API 仍只返回固定中文分类，不公开诊断正文。

OpenCode Go 可选型号取 models.dev 与官方 `https://opencode.ai/inference/go/v1/models` 的交集。官方目录不可达时保留上次验证过的型号；首次失败暂不提供 Go 新增选项并返回提示，不影响其他供应商或已有配置。目录缓存升级为 `llm:catalog:v2`，避免继续使用未校验的旧列表；无需数据库迁移。官方目录仅证明型号存在，不保证账号、地区和额度权限。

## 浏览器 Agent 导入

这些接口要求已登录管理员，批次操作还检查创建者；所有写请求沿用同源校验。`GET /agent-imports/snapshot` 返回 `{version,data}`，data 仅包含白名单业务表，不含身份会话、模型密钥或审计正文。此内部草稿协议保留 SQL 字段的 snake_case；常规 API 仍使用 camelCase。

| 方法 | 路径 | 契约 |
| --- | --- | --- |
| POST | `/agent-imports` | 创建批次，返回 `{id}`，不写业务数据 |
| GET | `/agent-imports/:id` | 本人批次状态及提交摘要 |
| POST | `/agent-imports/:id/turn` | `{messages,context,mode?,preferredProvider?,cooldowns?}`；单轮模型调用，返回 `{messages,calls,text,model,providerId,usage,metrics}`，工具由浏览器执行 |
| POST | `/agent-imports/:id/lease` | `{changes}`；检查原值并取得/续期 180 秒相关数据锁 |
| POST | `/agent-imports/:id/apply` | `{changes,summary?}`；服务端重新校验，单事务提交，批次幂等 |
| POST | `/agent-imports/:id/release` | 释放本批租约 |
| POST | `/agent-imports/:id/cancel` | 取消尚未提交批次并释放租约 |

`changes` 每项为 `{entity,id,before,after,evidence}`；before/after 是完整原记录/新记录，新增 before=null，删除 after=null。evidence 为 `{source,locator,explanation,inferred}` 数组。实体及严格字段契约见 `src/shared/agent-import/model.ts`。不接受任意 SQL，不接受修改账号、模型、审计或其他非白名单数据。

`apply` 不接受已经过期的锁；相关记录原值不符、提交版本变化、约束冲突时 409，事务回滚。校验失败 400。成功 `{ok:true,id}`；重复相同批次/内容返回同一成功结果，内容不同则 409。租约也通过数据库触发器保护常规 CRUD。

人员 GET/PATCH/POST 增加 `className`、`major`；学号继续可空。独立课表通过 `timetable_profile` / `timetable_entry` / 派生的 `timetable_event` 表达，在人员页单独管理，派班按实际时间检查。详细格式、材料读取和清理边界见 [AGENT_IMPORT.md](AGENT_IMPORT.md)。

### 人员对象单轮协议

`POST /agent-imports/:id/turn` 接收 `{messages,context,mode?,preferredProvider?,cooldowns?}`。mode 为 discover（默认）、person、verify、consistency、reconcile；已删除 work/compact/checkpoint 模式。返回 `{messages,calls,model,providerId,metrics}`，合法 JSON 的工具参数错误返回 validationError，由浏览器反馈修正而不执行。

协调器工具负责材料分派、公共组织/日历和最终核对；人员模式仅开放本人来源阅读、write_person 与 finish_person。具体 schema 以 `src/shared/agent-import/tools.ts` 和 `person-workspace.ts` 为准。工具只写本地对象，正式写入继续使用上述 apply 事务接口。新旧前端/Worker 不能混用工具协议，须同步部署。

模型凭据仍仅在 Worker。每候选最多90秒，候选窗口120秒；浏览器截止130秒加按100 KB/s估算的上传时间（最多再加170秒），SDK隐式重试关闭。turn 请求体超过 16 MB 时在解析前按 Content-Length 返回 413。浏览器放弃请求时（`enable_request_signal`）Worker 中止当前上游调用且不再尝试后续候选。DeepSeek 官方端点未配置 reasoning_effort 时，person 模式默认 low，其他模式保持默认。metrics 保存 requestId、purpose、durationMs、token用量与逐供应商尝试状态；浏览器另标记 actorId。网络错误独立退避，额度耗尽不立即重试。原始上游错误和密钥不返回。

人员查询和编辑支持 className、major。apply 可携带 `review: {version:1,timetables,calendars,checks,consistency_review?,unresolved}`，最大2MB，与业务数据同事务保存并纳入幂等摘要。`GET /agent-imports` 返回本人最近20个已提交批次；`GET /agent-imports/:id/report` 返回 review 或 null，仍检查批次归属。审核报告不包含原件、模型对话和凭据。

复核工具 `finish_person.checks` 使用显式数组，每项包含课表 `key` 和字段核对结果；不使用动态键字典，以确保 Google 工具 schema 保留核对字段。对象持久化与正式审核报告仍按课表键保存检查结果，无新增依赖、环境变量或数据库迁移。

复核完成时每份 checks 还须提交 `verified_entries`（逐条 index、名称、星期、节次、周次、教师、地点和无固定时段标记，不含备注）。运行时比较原件复核值与当前保存值，周次按集合比较，其余未知值不补猜；不一致先修正 A/B，不能只提交“已核对”说明。此契约仅影响模型工具，正式 HTTP API 不变。协调器在人员返工及人工复核恢复时保留对话与来源覆盖，最新 context 提供当前成果；自动预读记录 actor、mode、来源及工具结果，纳入本机工作日志。已有完成状态不会自动追溯复核，验证新门槛需重新导入或显式返工。

独立复核的 context 只提供课表元数据和课程名称/索引，隐藏首次提取的周次、节次、教师、地点等字段；模型须从原件生成复核值，避免复制首次识别错误。工具日志保留原始复核参数与不一致拒绝结果。名称及索引用于对齐，不构成识别准确率保证。

全批协调通过 `review_consistency` 每批保存最多 5 组结论；context 只展示最多 5 组未核对差异和剩余数量。结论通过实际教师变体、来源阅读门槛后保存事实签名，相关差异变化自动失效；`finish_import` 合并仍有效的检查点，继续要求全部差异有结论。避免在单次最终请求重复输出所有核对记录。新增状态为可选字段，旧人员对象批次恢复时从空检查点开始。

人员复核 checks 新增必填 source_person_names：列出本课表原件明确印出的姓名（没有姓名时为空数组，教师对照材料不算本人课表）。有课程的方案若与目标姓名不符，运行时拒绝完成，须纠正身份或将误分派材料交回协调器；仅写文字冲突说明不能放行。已有完成检查点不追溯升级，验收须新建批次。工具协议变更要求前后端同步发布，无新增依赖、环境变量或迁移。

人员工具新增 amend_timetable，仅按当前人员的课表 key 和原课程 index 局部修正字段，或更新 replace_weeks / unresolved。未提及字段不应用创建默认值，整份候选课表校验成功后才替换，非法索引不留下前半份改动；修正清空旧检查，仍须 finish_person 逐项复核。短课表 key 使用 main / fall 等标识，最多 30 字符。协议需前后端同步发布，无新增依赖、环境变量或数据库迁移。

finish_person 会一次反馈当前人员的课程事实、原件姓名、覆盖范围与缺失说明问题，存在任一问题时不保存完成检查；避免修完一层后才暴露下一层导致重复整表复核。校验规则不放宽，无新增依赖或部署参数。

人员复核新增必填 source_student_numbers，填写本人原件明确印出的学号；未印出时为空数组。他人对照材料的学号不纳入。verify 上下文隐藏首次提取的 student_no，有课程方案的原件学号与保存身份不一致时拒绝完成，须回看原件并通过 write_person 修正 information；不以固定学号位数猜测学校规则。前后端工具协议须同步发布，无新增依赖、配置或迁移。已有完成检查点不追溯验证，须重新导入或显式返工。

按操作员确认的规则，导入不要求固定学期总周数。公共日历的 week_count 可空，投影按关联课表明确的最大周次与已有覆盖范围计算存储范围；minimum_weeks 可直接作为已知课程范围使用。遇到更晚课程自动扩展范围，不截断课程，不缩短已有学期，也不改变已有首周日期。UI 显示覆盖周数而非声称学校学期总长；日期、节次钟点和课程自身周次未知仍不能猜造。本次沿用现有 term.week_count 存储与时间展开，无新增依赖、环境变量或数据库迁移，前后端同步构建发布。

人员独立复核支持事实复用：finish_person.checks 可设置 reuse_verified_entries=true，复用当前 AgentState 中的独立观察值，只补交其余索引及变化值，最终仍与整份课表逐字段比较。revise_person 可用 recheck_entries 明确课表 key 和需重查的 indices；仅当原对象已完成、来源集合未变、旧观察值与整表一致且已有完成检查时，保留范围外的独立观察值，移除指定重查索引。context.reusable_verified_indices 只公开可复用索引，不公开时段/教师/地点；漏交重查索引不能完成。新增来源、省略范围、未完成或过时的旧证据不复用；write_person 重写/追加/删除课表清除该课表缓存。来源重新读取、身份与覆盖检查继续完整执行；amend_timetable 不自动生成复核证据。无新增依赖、配置、环境变量或迁移，前后端工具协议须同步构建发布。

缺课表的人员对象若已通过独立来源复核（coverage=missing，零课程），允许只提交人员/归属和缺失报告，不要求为不存在的课程绑定学期作息；仍不清空已有课程。未核对空方案、实际含课但缺日历、缺少时段的课程继续阻止提交。无新增依赖、配置或迁移。

跨人核对支持 checked_variant_indices：引用当前 conflicts 组内显式 index，避免重复生成长课表ID。必须完整、唯一且有效，不能与 checked_variants 同时提交；运行时展开为真实课表ID和教师后执行原有来源门槛并保存完整审核证据。事实签名失效规则不变。无新增依赖、配置或迁移，前后端工具协议同步发布。

部分课表的未知时段处理：已通过独立复核、coverage=partial且有缺失说明的条目，可随完整审核报告提交，未知字段保持null、不改成no_fixed_time、不生成猜测占用。所有条目须对应已生成课程或可明确识别的时段缺失条目；其他不一致仍阻止提交。摘要与提交按钮说明仅导入已知内容，待补条目未计入占用，不能据此判断人员有空。含未知时段时仅更新相同已知课程/星期/节次的已知周次，保留其他现有课表；已有共享课程选课仍要求明确处理。待补条目、来源和缺失说明与业务数据在既有事务中持久保存到审核报告；不使用8小时本地缓存作为唯一记录。无新增依赖、配置或迁移。虚构材料 test/fixtures/live-partial-apply.txt 用于真实模型与隔离SQLite提交回读，不代表真实整包验收。

协调器首次发现前自动处理最多6个用户直接上传的文件：压缩包通过既有工具解包并记录容器元数据，其他材料预读首页/默认范围，减少纯读取的模型往返。嵌套内容不自动计为已读，PDF/表格其余范围仍由模型读取；来源失败保留错误，不标记成功。所有自动读取写入工具日志，业务身份、课表与日历仍由模型判断。无新增依赖、配置或迁移。

日历投影忽略未被课程引用且上下课时间均为空的纯布局节次（例如截图末尾空白行）；任何已有钟点或课程实际引用的节次都保留，实际使用但缺钟点仍阻止绑定。不推测空白行的钟点，无新增依赖、配置或迁移。

协调器一批调用若仅包含review_consistency与revise_person，运行时先按原顺序保存核对结论，再按原顺序派返工，避免先返工导致结论被未完成人员门槛拒绝。其他混合调用保持原序；返工改变事实后旧结论仍按签名失效，无新增依赖或迁移。

协调器核对按最多5组、通常最多8份不同来源选择当前批次（单组超过上限仍整组保留）。仅在当前组集合变化时移出无关历史图片载荷，保留原件、来源覆盖、文本和工具记录；后续组再次引用已移出的来源会自动重读。当前组内新请求的裁剪图片不提前移除。自动预读日志包含模式与轮次，能追溯重复加载。不会减少须核对的组或放宽校验，无新增依赖、配置或迁移。

人员因连接/超时失败时，可加入队尾补跑一次，优先处理尚未分派的对象，不等待所有慢请求结束才利用空闲并发位。保留已提取课程和历史记录，补跑重新建立来源读取上下文与独立复核，已完成对象不重跑；仍遵守每请求重试上限，不递归补跑。额度耗尽、验证错误或非法模型输出不进入补跑，暂停请求继续生效。不保证供应商延迟，无新增依赖或迁移。

跨人核对新增 consistency 模式：待核对差异不少于两组时，按既有每批最多5组/通常8份来源划分，最多4个独立读取对象并行。各对象只可读取、保存本批核对结论或向本批涉及人员提出返工；不能修改日历、分派人员或交付导入。结论完成异步来源检查后合并检查点，避免并发覆盖。所有读取结束后按人合并返工说明、来源与重查索引；任一要求全量复核则合并为全量，不截断说明。部分失败保留已完成结论、待返工意见与未完成上下文，恢复不重跑已完成批次；暂停须等待在途请求结束，未执行工具可在刷新后继续。当前事实签名变化时丢弃过时读取任务，操作员新意见取消旧待执行意见。最终仍由协调器核对全局身份、日历、全部差异和提交条件，不减少检查组或放宽来源门槛。材料缺失/错放说明保留在各批上下文，避免遗漏跨目录证据。无新增依赖、环境变量、配置或迁移；前后端工具协议须同步构建发布。

人员全部完成后，跨人核对前检查已复核的零课程missing方案：仅当原件明确姓名唯一、对应已完成人员也唯一、来源属于该缺失方案且目标尚未读取时，将其作为补充来源送入目标人员的全量独立复核。不会转移课程、修改身份或填补缺失人员课表；无姓名、重名、多姓名或未完成检查仍交协调器处理。已分派来源不会循环返工，自动分派写入工具记录；目标新增来源不复用旧独立观察值。工具说明明确错放原件的实际姓名仍应填写，不能用目录名猜造。无新增依赖、配置、环境变量或迁移。

最终协调上下文新增紧凑的完成摘要：每份课表列出来源路径、已保存的无固定时段课程名称，以及已完成对象的独立复核覆盖、条目数、已读来源和原件姓名/学号；未完成对象不声明已验证。只提供事实签名仍有效的跨人结论key、处理结果和说明，帮助协调器识别已完成工作；不展开全部课程，不改变人员独立复核中隐藏首次识别值的规则。新证据或未解决矛盾仍可返工，最终检查门槛不变。无新增依赖、配置、环境变量或迁移。

当前教师差异按教学情境筛选，取代此前仅按课程同名触发复核的规则：已明确不同班级、不同绑定学期，或星期/节次/教学周明确不相交时，不因教师不同产生冲突。仅参与至少一对可比较教师差异的变体进入复核；班级或时段未知不能据此排除，重叠区间按实际交集检查。同一人员分时段由不同教师授课亦可合法。不会改写任何课程或统一教师，各人员仍逐项独立回看原件；候选差异继续需要来源核对和结论。变体包含课程时段事实，相关时段变化使旧检查点失效。只按已有结构字段判断，不解析目录名猜班级或学期别名；不凭未绑定的学期名称断定不同学期。无新增依赖、配置、环境变量或迁移。

独立复核的reuse_verified_entries标记在没有旧观察值时视为空的复用集合，仍保存本次提交的新观察值；随后继续检查所有索引、全部课程字段、身份和覆盖范围。缺项或不一致仍拒绝完成，但已读出的值可以用于下一次补交/修正，不再因不存在旧缓存而丢失。不会复制首次提取值、自动改课或放行部分检查；新来源仍清空旧轮观察值。无新增依赖、配置、环境变量或迁移。

Kimi Code连接测试沿用既有API：服务端将官方国内Coding端点解析为官方海外端点，且对`kimi-for-coding`使用temperature=1。已保存配置和返回配置内容不改写；实际Agent请求共用相同端点解析。自定义地址不改写，无新增HTTP字段、依赖或迁移，详见Worker模块架构。

DeepSeek官方端点的Agent请求在思考模式下使用`tool_choice=auto`并补齐跨供应商工具回合的推理字段；接口字段不变，详见Worker模块架构。

本机直连模型开启时，浏览器不调用 `POST /api/agent-imports/:id/turn`，而在本地以相同请求体执行单轮并直接请求供应商；该接口保持不变，供未开启直连的用户使用。
