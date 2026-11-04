import {
  fieldChecksSchema,
  type FieldChecks,
} from "../../shared/agent-import/calendar";
import {
  recordCoverage,
  completePages,
} from "../../shared/agent-import/coverage";
import { withoutImages } from "../../shared/agent-import/context";
import type { Job, Material } from "./store";
import { canonical } from "../../shared/agent-import/model";
import {
  proposalForModel,
  type TimetableProposal,
} from "../../shared/agent-import/timetable";
export const proposalSignature = (plan: TimetableProposal) =>
  canonical({
    verificationPolicy: 4,
    person: plan.person,
    term_name: plan.term_name,
    entries: plan.entries,
    sources: plan.sources,
    unresolved: plan.unresolved,
  });
export function needsVerification(job: Job, plan: TimetableProposal) {
  return (
    !job.excluded.includes(plan.person.id) &&
    job.timetableChecks?.[plan.id]?.signature !== proposalSignature(plan)
  );
}
export function sourceFiles(plan: TimetableProposal, files: Material[]) {
  const paths = new Set(plan.sources.map((e) => e.source));
  return files.filter(
    (f) =>
      paths.has(f.path) &&
      !files.some((child) => child.path.startsWith(f.path + "!/")),
  );
}
export const verificationCandidate = (job: Job, files: Material[]) =>
  Object.values(job.timetables ?? {}).find(
    (p) =>
      needsVerification(job, p) &&
      sourceFiles(p, files).every((f) => Boolean(f.status)),
  );
export function startVerification(job: Job, files: Material[]) {
  if (job.verification || job.unrecordedReads?.length || job.pending.length)
    return false;
  const plan = verificationCandidate(job, files);
  if (!plan) return false;
  job.verification = {
    id: plan.id,
    workMessages: withoutImages(job.messages),
    required: sourceFiles(plan, files).map((f) => ({
      path: f.path,
      pages: f.totalPages ?? 1,
    })),
    seen: {},
  };
  job.messages = [
    {
      role: "user",
      content:
        "现在执行同一 Agent 的逐人原件复核。以下已存草稿可能漏课、错字或串行，不要假设正确。重新读取列出的全部来源，与草稿逐格/逐行对照。单周截图明确第 N 周时，weeks 必须为 [N]，不是 null，也不能扩展为整学期。标题/身份修正可用 revise_timetable 的 term_name/person 字段。教师和地点也必须逐字核对原图，每条均检查，疑字放大查看；无法确定的字段置 null 并注明原文疑点，禁止用相似人名补齐。检查表头总课程数与可见课程数是否一致、周末/底部是否缺失；coverage=complete 仅表示材料确实覆盖完整课表，单周截图、裁剪、遮挡及缺图须标 partial/missing。确认时 checks.checked_entries 必须覆盖修正后所有条目索引；checks.calendar 写明日期/教学周/钟点，返回主任务后 save_calendar 汇总。尤其是边缘、跨页、周次、单双周、相邻行及底部附注。逐条核对 weeks 与来源原文，既查漏周也查多周；不能只核对课程名称。修改 entries 使用返回的 index，不要凭记忆数数组位置。用 revise_timetable 只修正差异，避免重复抄写。来源确实看不清的字段保持待定并列明，不能补造。完成后 confirm_timetable_check。只核对当前人，不处理其他人。\n" +
        JSON.stringify({
          plan: proposalForModel(plan),
          requiredSources: job.verification.required,
        }),
    },
  ];
  job.progress = undefined;
  return true;
}
export function recordVerificationRead(job: Job, path: string, result: any) {
  const v = job.verification;
  if (!v || !v.required.some((f) => f.path === path)) return;
  const info = result?.content ?? result;
  const coverage = ((v.coverage ??= {})[path] ??= {});
  recordCoverage(coverage, info?.coverage ?? []);
  v.seen[path] = completePages(coverage);
}
export function confirmVerification(
  job: Job,
  id: string,
  summary: string,
  files: Material[],
  checks: FieldChecks,
) {
  const v = job.verification,
    plan = job.timetables?.[id];
  if (!v || v.id !== id || !plan) throw Error("仅能确认当前逐人复核的课表");
  v.required = sourceFiles(plan, files).map((f) => ({
    path: f.path,
    pages: f.totalPages ?? 1,
  }));
  if (!v.required.length)
    throw Error("须为课表提供可回看的实际文件来源，目录推断不能代替课程原件");
  const missing = v.required.filter((f) =>
    Array.from({ length: f.pages }, (_, i) => i + 1).some(
      (page) => !v.seen[f.path]?.includes(page),
    ),
  );
  if (missing.length)
    throw Error(
      "须在本次复核中完整覆盖来源：图片不能遗漏区域，表格须覆盖 extent 全部行列，文本须读完全部分段。去掉 range 可读取完整小表；大表按 extent 分块补齐：" +
        missing.map((f) => f.path).join("，"),
    );
  checks = fieldChecksSchema.parse(checks);
  const indexes = new Set(checks.checked_entries);
  if (
    indexes.size !== plan.entries.length ||
    [...indexes].some((i) => !plan.entries[i])
  )
    throw Error("逐字段核对必须覆盖当前全部课程索引，不能只核对名称和周次");
  if (checks.coverage !== "complete" && !plan.unresolved.length)
    throw Error("材料不完整时须在方案 unresolved 保存具体缺项，再确认");
  (job.timetableChecks ??= {})[id] = {
    signature: proposalSignature(plan),
    summary,
    checks,
    at: Date.now(),
  };
  v.complete = true;
  job.unrecordedReads = [];
  job.unrecordedImageViews = {};
}
