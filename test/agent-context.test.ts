import { it, expect } from "vitest";
import { withoutImages } from "../src/shared/agent-import/context";
it("archives text evidence without retaining image bytes", () => {
  const messages = withoutImages([
    {
      role: "user",
      content: [
        { type: "text", text: "source.png" },
        { type: "image", image: "data:image/png;base64,SECRET" },
      ],
    },
  ]);
  expect(JSON.stringify(messages)).toContain("source.png");
  expect(JSON.stringify(messages)).not.toContain("SECRET");
});
