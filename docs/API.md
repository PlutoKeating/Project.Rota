# API

> 与 `src/worker/index.ts` 保持同步。标注「待实现」的接口只有契约，没有代码。

## 约定

- 前缀：`/api`
- 编码：`application/json; charset=utf-8`
- 时间：ISO 8601 带偏移，如 `2026-10-07T10:00:00+08:00`
- 主键：ULID 字符串
- 错误统一为：

```json
{ "error": { "code": "not_found", "message": "学期不存在" } }
```

- 鉴权：`Cookie` 会话（OIDC 登录后下发）。除 `/api/health` 外均需登录。

## 状态

| 标记 | 含义 |
| --- | --- |
| ✅ | 已实现 |
| 🚧 | 待实现（契约已定） |

## 已实现

### `GET /api/health` ✅

连通性检查，同时探测 D1。

```json
{ "ok": true, "env": "development", "db": "up", "ts": "2026-11-03T07:00:00.000Z" }
```

`db` 为 `down` 时返回 `503`。

### `GET /api/terms` ✅

学期列表，按开学日期倒序。

```json
{
  "items": [
    { "id": "01J...", "name": "2026 秋", "start_date": "2026-09-07", "week_count": 20, "status": "active" }
  ]
}
```

未跑迁移时返回 `500` 与 `error` 字段（表不存在）。

## 待实现

### 校历

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/terms` | 建学期，自动生成 `class_period` 与 `slot` |
| `GET` | `/api/terms/:id/slots` | 查询格子，支持 `from` / `to` 过滤 |
| `POST` | `/api/terms/:id/periods` | 配置节次时间表 |

建学期请求体：

```json
{
  "name": "2027 春",
  "startDate": "2027-02-22",
  "weekCount": 20,
  "periods": [
    { "periodIndex": 1, "startTime": "08:00", "endTime": "08:45" }
  ]
}
```

### 人员与组织

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/persons?q=&orgId=` | 搜索 / 按部门筛选 |
| `POST` | `/api/persons` | 新建（支持批量导入） |
| `GET` | `/api/persons/:id/availability?termId=` | 返回可用格子与原因 |
| `GET` | `/api/orgs` | 组织树 |
| `POST` | `/api/orgs` | 新建组织 |
| `POST` | `/api/memberships` | 加人入部门（带角色与任期） |
| `PATCH` | `/api/memberships/:id` | 改角色 / 结束任期 |

可用性返回的关键结构：

```json
{
  "personId": "01J...",
  "freeSlotIds": ["01J..."],
  "blocked": [
    { "slotId": "01J...", "reason": "course", "refId": "01J..." },
    { "slotId": "01J...", "reason": "leave", "refId": "01J..." }
  ]
}
```

`reason` 取值：`course` / `leave` / `blacklist` / `cross_org` / `out_of_term`。

### 课表导入

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/imports` | 上传（`multipart/form-data`），返回 `importJobId` |
| `GET` | `/api/imports/:id` | 轮询状态与解析结果 |
| `POST` | `/api/imports/:id/apply` | 确认解析结果并落库 |
| `DELETE` | `/api/imports/:id` | 丢弃 |

上传体：`file` + `sourceKind`（`excel` / `csv` / `ics` / `screenshot`）+ `termId`。

状态机：

```
uploaded → parsing → needs_review → applied
                   ↘ failed
```

### 任务与排班

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/tasks` | 建任务（一次性 / 周期 / 项目） |
| `GET` | `/api/tasks?orgId=&status=` | 任务列表 |
| `POST` | `/api/tasks/:id/shifts` | 生成班次（周期任务按 `ShiftPattern` 展开） |
| `POST` | `/api/shifts/:id/preview` | **试排**：返回候选与打分，不落库 |
| `POST` | `/api/shifts/:id/assign` | 确认分配（可指定人，也可接受推荐） |
| `DELETE` | `/api/assignments/:id` | 撤销，回滚公平账本 |

试排返回（这是系统的核心输出）：

```json
{
  "shiftId": "01J...",
  "candidates": [
    {
      "personId": "01J...",
      "score": 0.62,
      "breakdown": { "fairness": 0.31, "starvation": 0.3, "preference": 0, "priority": 0, "recency": -0.05 },
      "excluded": null
    }
  ],
  "excluded": [{ "personId": "01J...", "reason": "cooldown" }]
}
```

### 公平

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/fairness?orgId=&window=` | 账本排行 |
| `POST` | `/api/fairness/recompute` | 幂等重算（管理员） |
| `PATCH` | `/api/fairness/:id` | 手动调整结转（必须留审计） |

### 管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/llm-providers` | 供应商列表（不返回密钥） |
| `POST` | `/api/admin/llm-providers` | 新增 |
| `PATCH` | `/api/admin/llm-providers/:id` | 改配置，立即生效 |
| `POST` | `/api/admin/llm-providers/:id/test` | 探测连通性 |
| `GET` | `/api/admin/audit?actor=&action=` | 审计查询 |

### 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/auth/login` | 302 到 `id.plutokeating.beer` 授权页 |
| `GET` | `/api/auth/callback` | 换 token，校验 `admin_user` 白名单 |
| `POST` | `/api/auth/logout` | 清 Cookie |

## 版本策略

当前无版本前缀。接口稳定前不承诺兼容；一旦有外部调用方，再引入 `/api/v1`。
