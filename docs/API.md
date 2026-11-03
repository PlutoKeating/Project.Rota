# API

> 契约的**类型定义**在 [`src/shared/types.ts`](../src/shared/types.ts)，本文件只描述路由与行为。
> 实现分布：`src/worker/api/*.ts`，统一挂在 `/api` 下。

## 通用约定

- JSON 一律 camelCase；数据库列是 snake_case，由 `lib/core.ts` 的 `camelize` 转换。
- 列表返回 `{ items: T[] }`；单资源直接返回对象。
- 错误：`{ "error": { "code": "...", "message": "..." } }`，`code` 取值 `bad_request` / `not_found` / `conflict` / `internal`。
- 时间：ISO 8601 带偏移（`2026-10-07T10:00:00+08:00`）；日期用 `YYYY-MM-DD`。
- 鉴权：**当前为占位模式**，所有请求视为 `owner`。接入 OIDC 后由 `src/worker/auth.ts` 接管。
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

`POST /terms` 接收 `CreateTermInput`，返回 `TermDetail`。生成格子数 = `weekCount × 7 × periods.length`，220 周内一次写入（D1 batch 分批，每批 ≤ 100 条语句）。

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
| `POST` | `/terms/:id/recompute-occurrences` | 全量重算（幂等） |

`POST /courses` 接收 `CreateCourseInput`：同一门课可被多人选（`personIds`），规则只存一份，展开时按人复制？

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
| `POST` | `/tasks/:id/auto-assign` | 整任务贪心排：候选最少的班次优先 |
| `DELETE` | `/assignments/:id` | 撤销，回滚账本 |

`preview` 请求体（均可选）：`{ "cooldownDays": 3, "weights": {...} }`，缺省读 `/admin/settings`。

## 公平

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/fairness?orgId=&windowKey=` | 账本，按次数升序（最亏的在前） |
| `POST` | `/fairness/recompute` | 从 `assignment` 重算，幂等 |

`windowKey` 规则：`<termName>-W<周次>` 或 `<termName>-M<月份>`。不传则用当前学期当前周。

## 导入

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/imports` | `multipart/form-data`：`file` + `sourceKind` + `termId` + `personId?` |
| `GET` | `/imports` | 最近 50 条 |
| `GET` | `/imports/:id` | 状态与解析结果 |
| `POST` | `/imports/:id/apply` | 把解析结果落成课程；可选覆盖 |
| `DELETE` | `/imports/:id` | 删除任务与 R2 原件 |

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

## 管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/admin/settings` | 权重、冷却、导入默认 provider |
| `PUT` | `/admin/settings` | 覆盖写 |
| `GET` | `/admin/llm-providers` | 列表（密钥只回名字） |
| `POST` | `/admin/llm-providers` | 新增 |
| `PATCH` | `/admin/llm-providers/:id` | 改配置，写 KV 版本号即时生效 |
| `DELETE` | `/admin/llm-providers/:id` | 删除 |
| `POST` | `/admin/llm-providers/:id/test` | 发一条最小请求探测 |
| `GET` | `/admin/audit?limit=` | 审计 |

## 导出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/export/schedule.csv?from=&to=&orgId=` | 班表 CSV（带 BOM，Excel 直接打开） |
| `GET` | `/export/fairness.csv?orgId=&windowKey=` | 公平账本 CSV |

## 认证（占位）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/auth/me` | 返回 `{ authenticated, user, mode }`，当前 `mode: "disabled"` |
| `GET` | `/auth/login` | 501，占位 |
| `GET` | `/auth/callback` | 501，占位 |
| `POST` | `/auth/logout` | 清 Cookie |

接入 `id.plutokeating.beer` 时只改 `src/worker/auth.ts` 与这三个路由，其余代码统一从 `c.get("user")` 取当前用户。

## 健康检查

`GET /health`，实现见 `src/worker/index.ts`。
