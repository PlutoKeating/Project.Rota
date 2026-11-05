import { expect, it } from "vitest";
import { progressSnapshot } from "./live/progress";
import { emptyAgent, emptySession, assignmentSchema } from "../src/shared/agent-import/person-workspace";

it("removes all actor image payloads before transport without modifying live state or tool records", () => {
  const session = emptySession(), agent = emptyAgent();
  agent.messages = [
    { role: "user", content: [{ type: "text", text: "source.png" }, { type: "image", image: "data:image/png;base64,private-bytes" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "view_image", input: { path: "source.png" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "view_image", output: { type: "json", value: { page: 1 } } }] },
  ];
  agent.pendingImages = [{ path: "source.png", image: "data:image/png;base64,pending-bytes" }];
  session.coordinator = structuredClone(agent);
  session.people.p = { ...assignmentSchema.parse({ key: "p", label: "人员", sources: ["source.png"] }),
    id: "workspace", personId: "person", timetables: {}, calendarEvidence: [], unresolved: [],
    status: "verifying", version: 1, agent: structuredClone(agent), checks: {},
  };
  session.consistencyWorkers = [{ id: "reviewer", keys: ["group"], signature: "facts", done: false, revisions: [], agent: structuredClone(agent) }];
  const job = { session, marker: "keep other job fields" }, before = structuredClone(job);
  const observed = progressSnapshot(job);
  expect(job).toEqual(before);
  expect(observed.marker).toBe(job.marker);
  expect(JSON.stringify(observed)).not.toContain("base64");
  expect(observed.session.people.p.status).toBe("verifying");
  for (const sanitized of [observed.session.coordinator, observed.session.people.p.agent, observed.session.consistencyWorkers![0].agent]) {
    expect(sanitized.messages.slice(1)).toEqual(agent.messages.slice(1));
    expect(sanitized.pendingImages[0].path).toBe("source.png");
  }
});
