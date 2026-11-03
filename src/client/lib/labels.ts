import type {
  ImportJobStatus,
  ImportSourceKind,
  MembershipStatus,
  OrgKind,
  OrgStatus,
  PersonStatus,
  ShiftStatus,
  TaskKind,
  TaskStatus,
  TermStatus,
  WeekPatternKind,
  LlmProviderKind,
} from "../../shared/types";

/** Badge 的语义色，页面只传语义，不关心具体色号。 */
export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

export interface Option<T extends string> {
  value: T;
  label: string;
}

export function termStatusLabel(status: TermStatus): string {
  switch (status) {
    case "active":
      return "进行中";
    case "archived":
      return "已归档";
    case "planned":
    default:
      return "未开始";
  }
}

export function termStatusTone(status: TermStatus): Tone {
  switch (status) {
    case "active":
      return "success";
    case "planned":
      return "info";
    case "archived":
    default:
      return "neutral";
  }
}

export function personStatusLabel(status: PersonStatus): string {
  switch (status) {
    case "active":
      return "在册";
    case "leave":
      return "休学";
    case "graduated":
      return "已毕业";
    default:
      return status;
  }
}

export function personStatusTone(status: PersonStatus): Tone {
  switch (status) {
    case "active":
      return "success";
    case "leave":
      return "warning";
    default:
      return "neutral";
  }
}

export function membershipStatusLabel(status: MembershipStatus): string {
  switch (status) {
    case "active":
      return "在任";
    case "suspended":
      return "暂停";
    case "ended":
      return "已结束";
    default:
      return status;
  }
}

export function membershipStatusTone(status: MembershipStatus): Tone {
  switch (status) {
    case "active":
      return "success";
    case "suspended":
      return "warning";
    default:
      return "neutral";
  }
}

export function orgKindLabel(kind: OrgKind): string {
  switch (kind) {
    case "school":
      return "学校";
    case "college":
      return "学院";
    case "department":
      return "部门";
    case "club":
      return "社团";
    case "team":
      return "团队";
    default:
      return kind;
  }
}

export function orgStatusLabel(status: OrgStatus): string {
  return status === "archived" ? "已归档" : "正常";
}

export function taskKindLabel(kind: TaskKind): string {
  switch (kind) {
    case "oneoff":
      return "一次性";
    case "recurring":
      return "周期性";
    case "project":
      return "项目型";
    default:
      return kind;
  }
}

export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "draft":
      return "草稿";
    case "open":
      return "待排班";
    case "scheduled":
      return "已排班";
    case "done":
      return "已完成";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

export function taskStatusTone(status: TaskStatus): Tone {
  switch (status) {
    case "open":
      return "warning";
    case "scheduled":
      return "info";
    case "done":
      return "success";
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

export function shiftStatusLabel(status: ShiftStatus): string {
  switch (status) {
    case "open":
      return "待排";
    case "filled":
      return "已满";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

export function shiftStatusTone(status: ShiftStatus): Tone {
  switch (status) {
    case "filled":
      return "success";
    case "cancelled":
      return "danger";
    default:
      return "warning";
  }
}

export function importStatusLabel(status: ImportJobStatus): string {
  switch (status) {
    case "uploaded":
      return "已上传";
    case "parsing":
      return "解析中";
    case "needs_review":
      return "待确认";
    case "applied":
      return "已落库";
    case "failed":
      return "失败";
    default:
      return status;
  }
}

export function importStatusTone(status: ImportJobStatus): Tone {
  switch (status) {
    case "needs_review":
      return "warning";
    case "applied":
      return "success";
    case "failed":
      return "danger";
    case "parsing":
      return "info";
    default:
      return "neutral";
  }
}

export function importSourceLabel(kind: ImportSourceKind): string {
  switch (kind) {
    case "excel":
      return "Excel";
    case "csv":
      return "CSV";
    case "ics":
      return "ICS 日历";
    case "screenshot":
      return "课表截图";
    case "manual":
      return "手工";
    case "api":
      return "接口";
    default:
      return kind;
  }
}

export function providerKindLabel(kind: LlmProviderKind): string {
  switch (kind) {
    case "openai_compatible":
      return "OpenAI 兼容";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
    case "cloudflare_ai":
      return "Workers AI";
    default:
      return kind;
  }
}

/** 试排里被排除的原因。 */
export function exclusionLabel(reason: string): string {
  switch (reason) {
    case "cooldown":
      return "冷却期内";
    case "no_free_time":
      return "没有空闲时长";
    case "busy":
      return "该时段已有安排";
    case "role":
      return "不满足角色要求";
    case "skill":
      return "缺少所需技能";
    default:
      return reason;
  }
}

export const TERM_STATUS_OPTIONS: Option<TermStatus>[] = [
  { value: "planned", label: "未开始" },
  { value: "active", label: "进行中" },
  { value: "archived", label: "已归档" },
];

export const PERSON_STATUS_OPTIONS: Option<PersonStatus>[] = [
  { value: "active", label: "在册" },
  { value: "leave", label: "休学" },
  { value: "graduated", label: "已毕业" },
];

export const ORG_KIND_OPTIONS: Option<OrgKind>[] = [
  { value: "department", label: "部门" },
  { value: "team", label: "团队" },
  { value: "club", label: "社团" },
  { value: "college", label: "学院" },
  { value: "school", label: "学校" },
];

export const TASK_KIND_OPTIONS: Option<TaskKind>[] = [
  { value: "oneoff", label: "一次性" },
  { value: "recurring", label: "周期性" },
  { value: "project", label: "项目型" },
];

export const TASK_STATUS_OPTIONS: Option<TaskStatus>[] = [
  { value: "draft", label: "草稿" },
  { value: "open", label: "待排班" },
  { value: "scheduled", label: "已排班" },
  { value: "done", label: "已完成" },
  { value: "cancelled", label: "已取消" },
];

export const WEEK_PATTERN_OPTIONS: Option<WeekPatternKind>[] = [
  { value: "all", label: "每周" },
  { value: "odd", label: "单周" },
  { value: "even", label: "双周" },
  { value: "ranges", label: "指定周次" },
];

export const IMPORT_SOURCE_OPTIONS: Option<ImportSourceKind>[] = [
  { value: "excel", label: "Excel" },
  { value: "csv", label: "CSV" },
  { value: "ics", label: "ICS 日历" },
  { value: "screenshot", label: "课表截图" },
];

export const PROVIDER_KIND_OPTIONS: Option<LlmProviderKind>[] = [
  { value: "openai_compatible", label: "OpenAI 兼容" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
  { value: "cloudflare_ai", label: "Workers AI" },
];
