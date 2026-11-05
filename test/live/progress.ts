import type { AgentState, ImportSession } from "../../src/shared/agent-import/person-workspace";
import { withoutImages } from "../../src/shared/agent-import/context";

/** Observe progress without transporting image bytes across the browser/test bridge. */
export function progressSnapshot<T extends { session?: ImportSession }>(job: T): T {
  const agent = (value: AgentState): AgentState => ({
    ...value,
    messages: withoutImages(value.messages),
    pendingImages: value.pendingImages.map((image) => ({ ...image, image: "[图像保留在浏览器检查点]" })),
  });
  if (!job.session) return { ...job };
  return {
    ...job,
    session: {
      ...job.session,
      coordinator: agent(job.session.coordinator),
      people: Object.fromEntries(Object.entries(job.session.people).map(([key, person]) =>
        [key, { ...person, agent: agent(person.agent) }])),
      consistencyWorkers: job.session.consistencyWorkers?.map((worker) => ({ ...worker, agent: agent(worker.agent) })),
    },
  };
}
