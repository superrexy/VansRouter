import { describe, it, expect } from "vitest";
import { detectFormat, normalizeThinkingConfig } from "../../open-sse/services/provider.js";

describe("detectFormat", () => {
  it("detects Claude when the first content block is an image", () => {
    expect(detectFormat({
      model: "claude-opus-4-6-thinking",
      messages: [{
        role: "user",
        content: [{
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "x" },
        }],
      }],
    })).toBe("claude");
  });
});

describe("normalizeThinkingConfig", () => {
  it("keeps openai reasoning_effort on non-user turns", () => {
    const body = {
      messages: [{ role: "assistant", content: "ok" }],
      reasoning_effort: "xhigh",
      thinking: { type: "enabled" },
    };

    normalizeThinkingConfig(body);

    expect(body.reasoning_effort).toBe("xhigh");
    expect(body.thinking).toBeUndefined();
  });
});
