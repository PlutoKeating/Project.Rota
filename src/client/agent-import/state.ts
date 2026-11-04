import type {
  CalendarProposal,
  FieldChecks,
} from "../../shared/agent-import/calendar";
import type { CoverageState } from "../../shared/agent-import/coverage";
import type { TimetableProposal } from "../../shared/agent-import/timetable";
import type { TurnMetrics } from "../../shared/agent-import/context";
import type { ImportSession } from "../../shared/agent-import/person-workspace";
import type { Evidence, Snapshot } from "../../shared/agent-import/model";
export interface Material {
  path: string;
  blob: Blob;
  origin: string;
  inspected?: boolean;
  totalPages?: number;
  pagesRead?: number[];
  readCoverage?: CoverageState;
  status?: "done" | "irrelevant" | "blocked";
  reason?: string;
}
export interface PendingCall {
  id: string;
  name: string;
  args: unknown;
  validationError?: string;
}
export interface Job {
  id: string;
  owner: string;
  title: string;
  status: "paused" | "running" | "review" | "applied" | "cancelled";
  createdAt: number;
  expiresAt: number | null;
  base: Snapshot;
  draft: Snapshot;
  evidence: Record<string, Evidence[]>;
  notes: Record<string, string>;
  session?: ImportSession;
  log: { at: number; text: string }[];
  summary: string;
  unresolved: string[];
  revision: number;
  validatedRevision: number;
  checkedRevision?: number;
  turns: number;
  model: string;
  error?: string;
  excluded: string[];
  harnessVersion?: number;
  timetables?: Record<string, TimetableProposal>;
  calendars?: Record<string, CalendarProposal>;
  importCheck?: {
    consistency_review?: import("../../shared/agent-import/consistency").ConsistencyReview[];
    signature: string;
    calendar_review: string;
    identity_review: string;
    unresolved: string[];
  };
  timetableChecks?: Record<
    string,
    { signature: string; summary: string; at: number; checks?: FieldChecks }
  >;
  preferredProvider?: string;
  cooldowns?: Record<string, number>;
  metrics?: TurnMetrics[];
  phase?: string;
  requestStartedAt?: number;
}
