import { consistencyReviewSchema } from "./consistency";
import { z } from "zod";
import { timetableProposalSchema } from "./timetable";
import { calendarSchema, fieldChecksSchema } from "./calendar";
/** Approved structured business evidence, excluding original files, model history and credentials. */
export const reviewArtifactSchema = z
  .object({
    version: z.literal(1),
    timetables: z.array(timetableProposalSchema).max(200),
    calendars: z.array(calendarSchema).max(100),
    checks: z.record(z.string(), fieldChecksSchema).default({}),
    consistency_review: z.array(consistencyReviewSchema).max(300).default([]),
    unresolved: z.array(z.string().max(3000)).max(2000),
  })
  .refine(
    (v) => JSON.stringify(v).length <= 2_000_000,
    "结构化审核结果超过 2 MB",
  );
