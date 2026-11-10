/**
 * 前后端共享契约。
 *
 * 约定：
 * - 所有 JSON 字段用 camelCase；数据库列是 snake_case，路由层用 camelize 转换。
 * - 列表统一 `{ items: T[] }`；单个资源直接返回对象。
 * - 错误统一 `{ error: { code, message } }`。
 * - 时间一律 ISO 8601 带偏移，如 `2026-10-07T10:00:00+08:00`。
 */

export type Id = string;

export type TermStatus = "planned" | "active" | "archived";
export type PersonStatus = "active" | "leave" | "graduated";
export type OrgKind = "school" | "college" | "department" | "club" | "team";
export type OrgStatus = "active" | "archived";
export type MembershipStatus = "active" | "suspended" | "ended";
export type WeekPatternKind = "all" | "odd" | "even" | "ranges";
export type OccurrenceStatus = "scheduled" | "cancelled" | "moved";
export type UnavailabilityKind = "leave" | "blacklist" | "other";
export type RequestStatus = "pending" | "approved" | "rejected";
export type TaskKind = "oneoff" | "recurring" | "project";
export type TaskStatus = "draft" | "open" | "scheduled" | "done" | "cancelled";
export type ShiftStatus = "open" | "filled" | "cancelled";
export type AssignmentStatus =
  "proposed" | "confirmed" | "declined" | "completed" | "no_show";
export type ImportSourceKind =
  "excel" | "csv" | "ics" | "screenshot" | "manual" | "api";
export type ImportJobStatus =
  "uploaded" | "parsing" | "needs_review" | "applied" | "failed";
export type LlmProviderKind =
  "openai_compatible" | "anthropic" | "google" | "cloudflare_ai";
export type EnrollmentStatus = "active" | "dropped";

export interface ListResponse<T> {
  items: T[];
}

export interface ErrorBody {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// 校历
// ---------------------------------------------------------------------------

export interface Term {
  id: Id;
  name: string;
  startDate: string;
  weekCount: number;
  timezone: string;
  status: TermStatus;
  createdAt: string;
}

export interface Period {
  id: Id;
  termId: Id;
  periodIndex: number;
  label: string | null;
  startTime: string;
  endTime: string;
}

export interface Slot {
  id: Id;
  termId: Id;
  weekIndex: number;
  weekday: number;
  periodIndex: number;
  startsAt: string;
  endsAt: string;
}

export interface PeriodInput {
  periodIndex: number;
  label?: string;
  startTime: string;
  endTime: string;
}

export interface CreateTermInput {
  name: string;
  startDate: string;
  weekCount: number;
  periods: PeriodInput[];
}

export interface TermDetail {
  term: Term;
  periods: Period[];
  counts: {
    persons: number;
    courses: number;
    memberships: number;
    tasks: number;
    slots: number;
  };
}

// ---------------------------------------------------------------------------
// 人员与组织
// ---------------------------------------------------------------------------

export interface Person {
  id: Id;
  studentNo: string | null;
  className?: string | null;
  major?: string | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: PersonStatus;
  createdAt: string;
}

export interface Org {
  id: Id;
  code: string | null;
  name: string;
  parentId: Id | null;
  kind: OrgKind;
  status: OrgStatus;
}

export interface Role {
  id: Id;
  code: string | null;
  name: string;
  orgId: Id | null;
  description: string | null;
}

export interface Membership {
  id: Id;
  personId: Id;
  orgId: Id;
  roleId: Id | null;
  status: MembershipStatus;
  validFrom: string | null;
  validTo: string | null;
  isPrimary: boolean;
}

export interface MembershipView extends Membership {
  orgName: string;
  roleName: string | null;
}

export interface PersonView extends Person {
  memberships: MembershipView[];
  /** 当前学期可排时长（分钟），未传 termId 时为 null */
  freeMinutes: number | null;
}

// ---------------------------------------------------------------------------
// 课程与课表
// ---------------------------------------------------------------------------

export interface Course {
  id: Id;
  termId: Id;
  code: string | null;
  name: string;
  teacher: string | null;
}

export interface CourseMeeting {
  id: Id;
  courseId: Id;
  termId: Id;
  weekday: number;
  periodFrom: number;
  periodTo: number;
  patternKind: WeekPatternKind;
  weekRanges: string | null;
  location: string | null;
}

export interface CourseMeetingView extends CourseMeeting {
  courseName: string;
  occurrenceCount: number;
}

export interface Enrollment {
  id: Id;
  personId: Id;
  courseId: Id;
  termId: Id;
  status: EnrollmentStatus;
}

/** 周课表格子：某天某节的占用。 */
export interface TimetableCell {
  slotId: Id;
  weekday: number;
  periodIndex: number;
  startsAt: string;
  endsAt: string;
  courses: { courseId: Id; courseName: string; location: string | null }[];
  unavailable?: { kind: UnavailabilityKind; reason: string | null };
}

export interface TimetableWeek {
  termId: Id;
  personId: Id;
  weekIndex: number;
  cells: TimetableCell[];
}

export interface CreateCourseInput {
  termId: Id;
  name: string;
  code?: string;
  teacher?: string;
  personIds: Id[];
  meetings: {
    weekday: number;
    periodFrom: number;
    periodTo: number;
    patternKind: WeekPatternKind;
    weekRanges?: string;
    location?: string;
  }[];
}

export interface Unavailability {
  id: Id;
  personId: Id;
  startsAt: string;
  endsAt: string;
  kind: UnavailabilityKind;
  status: RequestStatus;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// 任务与班次
// ---------------------------------------------------------------------------

export interface Task {
  id: Id;
  orgId: Id | null;
  title: string;
  description: string | null;
  kind: TaskKind;
  status: TaskStatus;
  windowStart: string | null;
  windowEnd: string | null;
  createdAt: string;
}

export interface Shift {
  id: Id;
  taskId: Id;
  startsAt: string;
  endsAt: string;
  requiredHeadcount: number;
  requiredRoleId: Id | null;
  requiredSkillId: Id | null;
  location: string | null;
  status: ShiftStatus;
}

export interface Assignment {
  id: Id;
  shiftId: Id;
  personId: Id;
  status: AssignmentStatus;
  score: number | null;
  reason: string | null;
  assignedAt: string | null;
  assignedBy: string | null;
}

export interface AssignmentView extends Assignment {
  personName: string;
}

export interface ShiftView extends Shift {
  taskTitle: string;
  orgId: Id | null;
  assignments: AssignmentView[];
}

export interface CreateTaskInput {
  orgId?: Id | null;
  title: string;
  description?: string;
  kind: TaskKind;
  windowStart?: string;
  windowEnd?: string;
}

export interface CreateShiftInput {
  startsAt: string;
  endsAt: string;
  requiredHeadcount?: number;
  requiredRoleId?: Id | null;
  location?: string;
}

export interface GenerateShiftsInput {
  weekday: number;
  periodFrom: number;
  periodTo: number;
  patternKind: WeekPatternKind;
  weekRanges?: string;
  requiredHeadcount?: number;
  requiredRoleId?: Id | null;
  location?: string;
}

// ---------------------------------------------------------------------------
// 排班与公平
// ---------------------------------------------------------------------------

export interface ScoreWeights {
  fairness: number;
  starvation: number;
  preference: number;
  priority: number;
  recency: number;
}

export interface ScoreBreakdown {
  target: number;
  deficit: number;
  fairness: number;
  starvation: number;
  preference: number;
  priority: number;
  recency: number;
  score: number;
}

export interface CandidateView {
  personId: Id;
  fullName: string;
  /** 本窗口可排分钟数 */
  freeMinutes: number;
  /** 已排次数（含结转） */
  assignedCount: number;
  score: number;
  breakdown: ScoreBreakdown;
  excluded: null;
}

export interface ExcludedView {
  personId: Id;
  fullName: string;
  reason: "cooldown" | "no_free_time" | "busy" | "role" | "skill";
}

export interface PreviewResult {
  shift: Shift;
  candidates: CandidateView[];
  excluded: ExcludedView[];
  appliedWeights: ScoreWeights;
  cooldownDays: number;
}

export interface AssignResult {
  assignment: AssignmentView;
  preview: PreviewResult;
}

export interface FairnessRow {
  personId: Id;
  fullName: string;
  orgId: Id | null;
  orgName: string | null;
  windowKey: string;
  shiftCount: number;
  minutes: number;
  carryOver: number;
  lastAssignedAt: string | null;
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

export interface ParsedMeeting {
  weekday: number;
  periodFrom: number;
  periodTo: number;
  patternKind: WeekPatternKind;
  weekRanges?: string | null;
  location?: string | null;
}

export interface ParsedCourse {
  name: string;
  teacher?: string | null;
  meetings: ParsedMeeting[];
  confidence?: number;
}

export interface ParsedTimetable {
  personId?: Id | null;
  personName?: string | null;
  courses: ParsedCourse[];
  warnings: string[];
}

export interface ImportJob {
  id: Id;
  sourceKind: ImportSourceKind;
  fileName: string | null;
  status: ImportJobStatus;
  parsed: ParsedTimetable | null;
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// 管理
// ---------------------------------------------------------------------------

export interface LlmProvider {
  id: Id;
  name: string;
  kind: LlmProviderKind;
  baseUrl: string | null;
  model: string;
  /** 只返回密钥名，不返回密钥本身 */
  apiKeySecret: string | null;
  enabled: boolean;
  params: Record<string, unknown> | null;
  updatedAt: string | null;
}

export interface LlmProviderInput {
  apiKey?: string;
  name: string;
  kind: LlmProviderKind;
  baseUrl?: string;
  model: string;
  apiKeySecret?: string;
  enabled?: boolean;
  params?: Record<string, unknown>;
}

export interface AuditEvent {
  id: Id;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface AppSettings {
  defaultCooldownDays: number;
  weights: ScoreWeights;
  /** 导入解析默认用哪个 provider */
  importProviderId: Id | null;
  /** 导出文件里是否包含手机号 */
  exportIncludePhone: boolean;
}

export interface HealthResponse {
  ok: boolean;
  env: string;
  db: "up" | "down";
  ts: string;
}

/** Owner-only connectivity diagnostics; response text has credentials redacted. */
export interface ProviderTestResult {
  ok: boolean;
  message: string;
  status?: number;
  code?: string;
  type?: string;
  details?: string;
}

// ---------------------------------------------------------------------------
// 共同空闲时段
// ---------------------------------------------------------------------------

/** 忙碌来源：课程/个人课表、请假、黑名单、已排班（任何部门）。 */
export type FreeWindowBusyReason = "course" | "leave" | "blacklist" | "assignment";

/** 无结果时的原因，参考 Graph findMeetingTimes 的 emptySuggestionsReason。 */
export type FreeWindowEmptyReason =
  | "no_days"
  | "window_too_short"
  | "required_unavailable"
  | "no_free_time";

export interface FreeWindowsInput {
  /** 参与统计的人员，1–300。 */
  personIds: Id[];
  /** 必到人员，须包含在 personIds 中；任一必到者没空的时段不返回。 */
  requiredPersonIds?: Id[];
  /** 从此刻起的天数（含今天剩余部分），1–28，默认 7。 */
  days?: number;
  /** 返回的不重叠时段数，1–20，默认 5。 */
  count?: number;
  /** 每日可用窗口，`HH:mm`，15 分钟对齐，默认 08:00–22:00。 */
  dayStart?: string;
  dayEnd?: string;
  /** 参与的星期（1=周一…7=周日），默认全选。 */
  weekdays?: number[];
  /** 每段忙碌前后的缓冲分钟数，0–120，默认 0。 */
  bufferMinutes?: number;
}

export interface FreeWindowPerson {
  id: Id;
  fullName: string;
  required: boolean;
}

export interface FreeWindowBusy {
  personId: Id;
  reason: FreeWindowBusyReason;
  label: string | null;
}

export interface FreeWindow {
  startsAt: string;
  endsAt: string;
  minutes: number;
  /** 整段全程有空的人。 */
  free: Id[];
  /** 时段内有安排的人，带第一条冲突原因。 */
  busy: FreeWindowBusy[];
  /** 当天没有学期覆盖或未导入课表，无法判断。 */
  unknown: Id[];
}

export interface FreeWindowHeatRow {
  date: string;
  /** 首格开始时间；每格 cellMinutes 分钟。 */
  startsAt: string;
  /** 每格整格有空的人数。 */
  free: number[];
  /** 每格数据未知的人数。 */
  unknown: number[];
}

export interface FreeWindowsResult {
  rangeStart: string;
  rangeEnd: string;
  cellMinutes: number;
  people: FreeWindowPerson[];
  windows: FreeWindow[];
  heatmap: FreeWindowHeatRow[];
  emptyReason: FreeWindowEmptyReason | null;
}
