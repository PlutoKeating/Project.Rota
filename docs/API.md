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

`POST /agent-imports/:id/turn` 接收 `{messages,context,mode?,preferredProvider?,cooldowns?}`。mode 为 discover（默认）、person、verify、reconcile；已删除 work/compact/checkpoint 模式。返回 `{messages,calls,model,providerId,metrics}`，合法 JSON 的工具参数错误返回 validationError，由浏览器反馈修正而不执行。

协调器工具负责材料分派、公共组织/日历和最终核对；人员模式仅开放本人来源阅读、write_person 与 finish_person。具体 schema 以 `src/shared/agent-import/tools.ts` 和 `person-workspace.ts` 为准。工具只写本地对象，正式写入继续使用上述 apply 事务接口。新旧前端/Worker 不能混用工具协议，须同步部署。

模型凭据仍仅在 Worker。每候选最多90秒，候选窗口120秒；浏览器截止130秒，SDK隐式重试关闭。metrics 保存 requestId、purpose、durationMs、token用量与逐供应商尝试状态；浏览器另标记 actorId。网络错误独立退避，额度耗尽不立即重试。原始上游错误和密钥不返回。

人员查询和编辑支持 className、major。apply 可携带 `review: {version:1,timetables,calendars,checks,consistency_review?,unresolved}`，最大2MB，与业务数据同事务保存并纳入幂等摘要。`GET /agent-imports` 返回本人最近20个已提交批次；`GET /agent-imports/:id/report` 返回 review 或 null，仍检查批次归属。审核报告不包含原件、模型对话和凭据。

复核工具 `finish_person.checks` 使用显式数组，每项包含课表 `key` 和字段核对结果；不使用动态键字典，以确保 Google 工具 schema 保留核对字段。对象持久化与正式审核报告仍按课表键保存检查结果，无新增依赖、环境变量或数据库迁移。

复核完成时每份 checks 还须提交 `verified_entries`（逐条 index、名称、星期、节次、周次、教师、地点和无固定时段标记，不含备注）。运行时比较原件复核值与当前保存值，周次按集合比较，其余未知值不补猜；不一致先修正 A/B，不能只提交“已核对”说明。此契约仅影响模型工具，正式 HTTP API 不变。协调器在人员返工及人工复核恢复时保留对话与来源覆盖，最新 context 提供当前成果；自动预读记录 actor、mode、来源及工具结果，纳入本机工作日志。已有完成状态不会自动追溯复核，验证新门槛需重新导入或显式返工。

独立复核的 context 只提供课表元数据和课程名称/索引，隐藏首次提取的周次、节次、教师、地点等字段；模型须从原件生成复核值，避免复制首次识别错误。工具日志保留原始复核参数与不一致拒绝结果。名称及索引用于对齐，不构成识别准确率保证。

全批协调通过 `review_consistency` 每批保存最多 5 组结论；context 只展示最多 5 组未核对差异和剩余数量。结论通过实际教师变体、来源阅读门槛后保存事实签名，相关差异变化自动失效；`finish_import` 合并仍有效的检查点，继续要求全部差异有结论。避免在单次最终请求重复输出所有核对记录。新增状态为可选字段，旧人员对象批次恢复时从空检查点开始。

人员复核 checks 新增必填 source_person_names：列出本课表原件明确印出的姓名（没有姓名时为空数组，教师对照材料不算本人课表）。有课程的方案若与目标姓名不符，运行时拒绝完成，须纠正身份或将误分派材料交回协调器；仅写文字冲突说明不能放行。已有完成检查点不追溯升级，验收须新建批次。工具协议变更要求前后端同步发布，无新增依赖、环境变量或迁移。
