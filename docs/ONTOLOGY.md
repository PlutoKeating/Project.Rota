# 本体设计

> 这份文档回答一个问题：**为什么数据库长这样。**
> 机器可读的定义在 [`schema/rota.yaml`](../schema/rota.yaml)，ER 图在 [`er.md`](./er.md)。

## 1. 为什么先做本体

这个系统真正难的不是增删改查，而是三件事同时成立：

1. 一个人属于多个部门，且身份随时间和角色变化；
2. 每个人的空闲时间由一张每周都在变的课表决定；
3. 排班要"雨露均沾"，但公平是跨周、跨月累积的。

如果先写页面再倒推表结构，这三件事一定会被压扁成 `user.department_id`、`schedule` 一张大表和一段谁都读不懂的排班 if-else。所以先把**实体、关系、不变量**定死，再让代码去适配它。

做法：用 [LinkML](https://linkml.io/linkml/) 写唯一 schema 源，生成 SQLite DDL、JSON Schema、ER 图与文档。本体不是挂在墙上的 OWL 文件，而是能编译成数据库的那份定义。

## 2. 三个建模难点

### 2.1 一人多部门：把"归属"做成实体

错误做法是给 `person` 加 `department_id`。它只能表达"一个人属于一个部门"，一旦有人同时在宣传部和办公室，就只能复制一行人或加一个 `dept2_id`。

正解是 [W3C ORG](https://www.w3.org/TR/vocab-org/) 的模式：

```
Person ──< Membership >── Organization
                │
                └── Role（部长 / 干事 / 摄影）
```

`Membership` 自带 `valid_from` / `valid_to` / `is_primary`，于是"上学期在宣传部、这学期转到办公室"也只是两条记录，不需要改历史。

对应实现：`person`、`organization`、`role`、`membership` 四张表。组织通过 `parent_id` 自引用形成"校 → 院 → 部门 → 项目组"的树。

### 2.2 时间：网格 + 规则展开

课表的时间语义有三层，必须分开存：

| 层 | 表 | 例子 |
| --- | --- | --- |
| 校历 | `term` | 2026 秋，9 月 7 日开学，共 20 周 |
| 节次 | `class_period` | 第 3 节 10:00–10:45 |
| 格子 | `slot` | 第 5 周周三第 3 节，具体到 `2026-10-07T10:00+08:00` |

`slot` 是物化的：20 周 × 7 天 × 12 节 = 1680 行，一次生成、整学期查表。**匹配时只查表，不展开规则**——这是性能与正确性的分界线。

上课规则存在 `course_meeting` 里，用 `pattern_kind` + `week_ranges` 表达：

| 教务说法 | pattern_kind | week_ranges |
| --- | --- | --- |
| 每周都上 | `all` | — |
| 单周上 | `odd` | — |
| 双周上 | `even` | — |
| 第 1–8 周 | `ranges` | `1-8` |
| 第 1–8、10–16 周 | `ranges` | `1-8,10-16` |
| 第 3–5、7 周 | `ranges` | `3-5,7` |

这套表达与 iCalendar 的 `RRULE` 同构：`INTERVAL=2` 对应单双周，`UNTIL`/`COUNT` 对应周段。**但我们不存 RRULE 字符串**，而是在写库时展开成 `course_occurrence`（规则 × 周次 × 节次）。原因：RRULE 在 SQL 里没法参与冲突检测，展开后才能 `join slot` 做集合运算。

调课对应 `course_occurrence.status`：

- 停课 → `cancelled`（≡ EXDATE）
- 调课 → 原记录 `cancelled`，新增一条 `moved`（≡ RDATE）

### 2.3 公平：账本，而不是当场算

"雨露均沾"如果只在本次排班里算，会出现经典漂移：每周都从零开始，结果同一个人连续八周被排、另一个人八周没被排。

所以公平必须是**有状态的**：

```
fairness_stat(person, org, window_key) → shift_count, minutes, carry_over, last_assigned_at
```

`window_key` 形如 `2026-FALL-W40`（第 40 周）或 `2026-FALL-M10`（10 月）。每次分配后增量更新，下周排班时把 `carry_over` 带回评分。

这与 [Timefold 的 balance shift count](https://docs.timefold.ai/employee-shift-scheduling/latest/employee-resource-constraints/fairness/balance-shift-count) 是同一思路：把公平做成**软约束**，并允许把历史班次计入（`employeeToPublishedShiftCount`）。区别是我们不用求解器，用可解释的加权打分。

## 3. 实体清单

### 领域核心（`core`）

| 分组 | 实体 | 作用 |
| --- | --- | --- |
| 校历 | `term` / `class_period` / `slot` | 时间的坐标系 |
| 人员 | `person` / `organization` / `role` / `membership` | 谁、属于谁、什么身份 |
| 能力 | `skill` / `person_skill` | 班次门槛 |
| 课程 | `course` / `course_meeting` / `course_occurrence` | 课表与展开后的占用 |
| 可用性 | `unavailability` / `preference` | 请假、黑名单、偏好 |
| 任务 | `task` / `shift_pattern` / `shift` | 一件活、它的重复规则、它的具体时段 |
| 结果 | `assignment` / `fairness_stat` | 谁上了、为什么、累计多少 |

### 应用支撑（`support`）

| 实体 | 作用 |
| --- | --- |
| `admin_user` | 管理员，只认 OIDC subject，不存密码 |
| `llm_provider` | 模型供应商配置，可热切换 |
| `import_job` | 课表导入任务与解析结果 |
| `audit_event` | 审计流水 |

## 4. 不变量

数据库能表达的约束已经写进 DDL；下面这些必须在事务或应用层保证：

1. `slot` 唯一 `(term_id, week_index, weekday, period_index)`。
2. 同一个 `shift` 同一个人只能出现一次（`assignment` 唯一键）。
3. **同一个人在同一时刻最多一个 assignment**——跨部门冲突的核心；SQLite 无法用简单约束表达，必须在分配事务里做时间重叠检查。
4. `membership` 不物理删除，只置 `ended`，保证历史可追溯。
5. `fairness_stat` 的唯一键是 `(person_id, org_id, window_key)`，重算必须幂等。
6. 任何写操作都要落 `audit_event`。

## 5. 可用性怎么算

```
可用(person, slot) =
      slot 属于该学期
  AND 该 slot 不在该人的 course_occurrence 中
  AND 该 slot 不在该人的 unavailability（approved）中
  AND 该 slot 没有被该人在其他部门的 assignment 占用
```

`preference` 不参与上面这条判定，只进评分。这个区分很重要：偏好是软约束，缺勤是硬约束，混在一起会导致"系统觉得他应该有空"。

## 6. 怎么选出该排谁

`schema` 只定义"公平账本"，具体打分在 [`src/worker/domain/assign.ts`](../src/worker/domain/assign.ts)。

```
score = 0.45 × 公平缺口
      + 0.30 × 饥饿补偿
      + 0.15 × 偏好
      + 0.10 × 人工优先级
      − 0.20 × 近期连排惩罚
```

- **公平缺口**：`目标次数 − 已排次数`，目标按空闲时长分摊（空闲多的人多排）。归一化后约在 `[-1, 1]`。
- **饥饿补偿**：一次没排过、或超过 21 天没排过，直接 +1。这是"连着几个月没被排"的兜底。
- **冷却**：`last_assigned_at` 落在冷却期内直接排除，除非有人工优先级（`manualPriority > 0`）。
- **可复现**：同分时用 `(shiftId, personId)` 的 FNV-1a 哈希决定顺序，重跑结果一致。

每次打分都产出 `ScoreBreakdown`，写进 `assignment.reason`。公平争议时能回答"为什么是他"，也能回答"为什么不是他"。

## 7. 与标准词汇的映射

| 本项目 | 标准 | 说明 |
| --- | --- | --- |
| `person` | `org:Person` / `schema:Person` | — |
| `organization` | `org:Organization` | `parent_id` ↔ `org:subOrganizationOf` |
| `membership` | `org:Membership` | 关系即实体，带角色与任期 |
| `role` | `org:Role` | — |
| `course_occurrence` | `ical:VEVENT` | 展开后的单次事件 |
| `course_meeting.pattern_kind` | `RRULE` 的 `FREQ`/`INTERVAL`/`BYDAY` | 见 §2.2 对照表 |

不引入 RDF 三元组库的理由：本体的价值在于**约束建模**，不在于 SPARQL 查询。LinkML 已经能生成 OWL/SHACL 供需要时导出，而运行时用关系库的收益（事务、索引、D1 兼容）远大于三元组库。

## 8. 演进

- 当前 `pattern_kind` 只覆盖"整学期内按周重复"。若出现"每月第几个周一"这类规则，新增 `monthly` 类型，不改表结构。
- 若以后要做全局最优（换班、连轴限制），在 `domain/` 下加 `solver.ts`，输入仍是 `candidate[] + context`，打分函数不动。
- `assignment.reason` 是 JSON 文本，未来若要做"解释面板"，直接读它，不需要新表。
