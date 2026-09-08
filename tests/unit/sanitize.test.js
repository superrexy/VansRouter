import { describe, it, expect } from "vitest";
import {
  sanitizeRequest,
  sanitizeSystemText,
  sanitizeToolSchema,
  sanitizeFunctionName,
  isAgentSystemPrompt,
} from "../../open-sse/rtk/sanitize.js";
import { NEUTRAL_SYSTEM_PROMPT } from "../../open-sse/rtk/sanitizeRules.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("sanitizeSystemText / isAgentSystemPrompt", () => {
  it("replaces detected agent/CLI system prompts with neutral prompt", () => {
    const agentPrompts = [
      "You are Claude Code, Anthropic's official CLI for Claude.",
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      "You are Cursor, an AI-powered code editor agent.",
      "<agent-identity>You are a coding agent</agent-identity>",
    ];
    for (const p of agentPrompts) {
      expect(sanitizeSystemText(p)).toBe(NEUTRAL_SYSTEM_PROMPT);
      expect(isAgentSystemPrompt(p)).toBe(true);
    }
  });

  it("does not replace long prompts without an agent marker (length is not a signal)", () => {
    const longBenign = ("You are a customer support assistant. " + "Be kind and thorough. ".repeat(150)).slice(0, 2500);
    expect(longBenign.length).toBeGreaterThan(2000);
    expect(isAgentSystemPrompt(longBenign)).toBe(false);
    expect(sanitizeSystemText(longBenign)).toBe(longBenign);
  });

  it("leaves normal system prompts intact (only brand rewrite applies)", () => {
    const normal = "You are a helpful assistant.";
    expect(sanitizeSystemText(normal)).toBe(normal);
  });

  it("rewrites leaking brand names conservatively", () => {
    // "You are OpenCode, ..." is caught by the agent detector → full replace.
    // This sentence mentions OpenCode but is not an agent identity prompt, so it
    // should go through the conservative brand rewrite instead.
    const out = sanitizeSystemText("Please run OpenCode to fix the bug.");
    expect(out).toMatch(/code assistant/i);
    expect(out).not.toContain("OpenCode");
  });

  it("handles non-string / empty input without throwing", () => {
    expect(sanitizeSystemText(null)).toBe(null);
    expect(sanitizeSystemText("")).toBe("");
    expect(sanitizeSystemText(undefined)).toBe(undefined);
    expect(isAgentSystemPrompt(123)).toBe(false);
  });
});

describe("sanitizeFunctionName", () => {
  it("normalizes invalid characters and enforces charset/start", () => {
    expect(sanitizeFunctionName("my.tool-fn_2")).toBe("my.tool-fn_2");
    expect(sanitizeFunctionName("123abc")).toBe("_123abc");
    expect(sanitizeFunctionName("bad name!")).toBe("bad_name_");
    expect(sanitizeFunctionName("a".repeat(100)).length).toBe(64);
  });

  it("handles non-string names", () => {
    expect(sanitizeFunctionName(null)).toBe(null);
    expect(sanitizeFunctionName(undefined)).toBe(undefined);
  });
});

describe("sanitizeToolSchema", () => {
  it("strips meta keywords without touching property names", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        id: { type: "string", description: "record id" },
        title: { type: "string" },
        default: { type: "string" },
      },
    };
    const out = sanitizeToolSchema(schema);
    expect(out.$schema).toBeUndefined();
    // property names id/title/default survive
    expect(out.properties.id).toBeDefined();
    expect(out.properties.title).toBeDefined();
    expect(out.properties.default).toBeDefined();
  });

  it("resolves $defs refs and guards against circular refs", () => {
    const schema = {
      type: "object",
      $defs: {
        Node: {
          type: "object",
          properties: { child: { $ref: "#/$defs/Node" }, value: { type: "string" } },
        },
      },
      properties: { root: { $ref: "#/$defs/Node" } },
    };
    const out = sanitizeToolSchema(schema);
    // No infinite recursion; circular ref replaced with safe placeholder
    expect(JSON.stringify(out).length).toBeLessThan(2000);
    expect(out.$defs).toBeUndefined();
    expect(out.properties.root.properties.value.type).toBe("string");
  });

  it("returns usable object schema for null/empty input", () => {
    expect(sanitizeToolSchema(null)).toEqual({ type: "object", properties: {} });
    expect(sanitizeToolSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(sanitizeToolSchema("nope")).toEqual({ type: "object", properties: {} });
  });

  it("does not mutate the input schema (non-mutating)", () => {
    const schema = { $defs: { A: { type: "string" } }, type: "object", properties: { a: { $ref: "#/$defs/A" } } };
    const snapshot = JSON.stringify(schema);
    sanitizeToolSchema(schema);
    expect(JSON.stringify(schema)).toBe(snapshot);
  });
});

describe("sanitizeRequest — dispatch & fail-open", () => {
  it("returns null when disabled or body invalid", () => {
    expect(sanitizeRequest({ messages: [] }, FORMATS.OPENAI, { enabled: false })).toBe(null);
    expect(sanitizeRequest(null, FORMATS.OPENAI, { enabled: true })).toBe(null);
    expect(sanitizeRequest("x", FORMATS.OPENAI, { enabled: true })).toBe(null);
  });

  it("OpenAI chat: replaces agent system prompt and cleans tool schema (name untouched)", () => {
    const body = {
      messages: [
        { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude." },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "do thing", parameters: { $schema: "x", type: "object", properties: { a: { type: "string" } } } } }],
    };
    const stats = sanitizeRequest(body, FORMATS.OPENAI, { enabled: true });
    expect(body.messages[0].content).toBe(NEUTRAL_SYSTEM_PROMPT);
    // OpenAI-shaped names are NOT renamed (would break history/tool_choice contract)
    expect(body.tools[0].function.name).toBe("do thing");
    expect(body.tools[0].function.parameters.$schema).toBeUndefined();
    expect(stats.toolsCleaned).toBe(1);
  });

  it("OpenAI chat: keeps normal system prompts", () => {
    const body = { messages: [{ role: "system", content: "You are a helpful assistant." }] };
    sanitizeRequest(body, FORMATS.OPENAI, { enabled: true });
    expect(body.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("Claude: sanitizes system array and input_schema, leaves tool name untouched", () => {
    const body = {
      system: [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }],
      tools: [{ name: "myTool", input_schema: { $defs: {}, type: "object", properties: { x: { type: "string" } } } }],
    };
    sanitizeRequest(body, FORMATS.CLAUDE, { enabled: true });
    expect(body.system[0].text).toBe(NEUTRAL_SYSTEM_PROMPT);
    expect(body.tools[0].name).toBe("myTool");
    expect(body.tools[0].input_schema.$defs).toBeUndefined();
  });

  it("Responses: sanitizes instructions string", () => {
    const body = { instructions: "You are Claude Code.", input: [{ role: "user", content: "hi" }] };
    sanitizeRequest(body, FORMATS.OPENAI_RESPONSES, { enabled: true });
    expect(body.instructions).toBe(NEUTRAL_SYSTEM_PROMPT);
  });

  it("Gemini: sanitizes systemInstruction.parts and functionDeclarations", () => {
    const body = {
      systemInstruction: { parts: [{ text: "You are Gemini Code Assist." }] },
      contents: [],
      tools: [{ functionDeclarations: [{ name: "bad fn", parameters: { $schema: "x", type: "object", properties: {} } }] }],
    };
    sanitizeRequest(body, FORMATS.GEMINI, { enabled: true });
    expect(body.systemInstruction.parts[0].text).toBe(NEUTRAL_SYSTEM_PROMPT);
    expect(body.tools[0].functionDeclarations[0].name).toBe("bad_fn");
    expect(body.tools[0].functionDeclarations[0].parameters.$schema).toBeUndefined();
  });

  it("Antigravity: sanitizes body.request.systemInstruction", () => {
    const body = {
      request: { systemInstruction: { parts: [{ text: "You are a Claude agent." }] }, contents: [] },
    };
    sanitizeRequest(body, FORMATS.ANTIGRAVITY, { enabled: true });
    expect(body.request.systemInstruction.parts[0].text).toBe(NEUTRAL_SYSTEM_PROMPT);
  });

  it("Kiro: sanitizes top-level systemPrompt", () => {
    const body = { systemPrompt: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", conversationState: { currentMessage: { userInputMessage: { content: "task" } } } };
    sanitizeRequest(body, FORMATS.KIRO, { enabled: true });
    expect(body.systemPrompt).toBe(NEUTRAL_SYSTEM_PROMPT);
  });

  it("never throws on weird bodies (fail-open)", () => {
    expect(() => sanitizeRequest({ messages: [{ role: "system", content: "You are Claude Code." }] }, FORMATS.OPENAI, { enabled: true })).not.toThrow();
    expect(() => sanitizeRequest({}, FORMATS.OPENAI, { enabled: true })).not.toThrow();
    expect(() => sanitizeRequest({ messages: [{ content: null }] }, FORMATS.OPENAI, { enabled: true })).not.toThrow();
  });
});
