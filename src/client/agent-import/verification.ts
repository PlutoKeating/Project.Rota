import { canonical } from "../../shared/agent-import/model";
import type { TimetableProposal } from "../../shared/agent-import/timetable";
import type { Job } from "./state";
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
