// Sanitize guard: one toggle that enables BOTH system-prompt sanitization and
// tool-schema sanitization on the final request body before dispatch.
//
// Modeled after the sanitization used by the codebuddy-china provider:
//   1. System prompt — when the client's system message is detected as an
//      agent/CLI/competing-client prompt, it is replaced with a neutral
//      assistant prompt.
//   2. Tool schema — JSON Schema is cleaned (strip meta keywords, resolve $ref
//      safely, ensure a usable object schema).
//
// The guard is format-aware (OpenAI chat, OpenAI Responses/instructions,
// Claude, Gemini/Vertex/Antigravity, Kiro) and fail-open: any error returns
// silently and leaves the body untouched — it must never break a request.

import { FORMATS } from "../translator/formats.js";
import {
  NEUTRAL_SYSTEM_PROMPT,
  AGENT_SYSTEM_PROMPT_PATTERNS,
  AGENT_SYSTEM_PROMPT_MAX_LENGTH,
  SYSTEM_PROMPT_REWRITES,
  FUNCTION_NAME_REPLACE_RE,
  FUNCTION_NAME_MAX_LENGTH,
  FUNCTION_NAME_START_RE,
  SCHEMA_META_KEYWORDS,
  UNSAFE_PATTERN_RE,
} from "./sanitizeRules.js";

// ---------------------------------------------------------------------------
// System-prompt sanitization
// ---------------------------------------------------------------------------

export function isAgentSystemPrompt(content) {
  if (typeof content !== "string" || !content.trim()) return false;
  // Identity markers are the primary signal.
  const hasMarker = AGENT_SYSTEM_PROMPT_PATTERNS.some((pattern) => pattern.test(content));
  if (hasMarker) return true;
  // Length is only a lower-confidence *amplifier*: a very long prompt is still
  // only replaced when it ALSO contains a weak agent/CLI marker. The weak
  // marker is deliberately narrower than "you are" (which appears in benign
  // prompts like "You are a support assistant") — it looks for agent/CLI
  // terminology, so legitimate long personas/guidelines are not wiped.
  if (content.length > AGENT_SYSTEM_PROMPT_MAX_LENGTH) {
    return /(?:agent|cli|command[- ]line|instructions? for (?:the )?assistant|cc_entrypoint)/i.test(content);
  }
  return false;
}

// Apply rewrite rules + strip known agent triggers, keeping other text intact.
// Used when we want to *edit* rather than fully replace a system prompt.
export function rewriteSystemText(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const { from, to } of SYSTEM_PROMPT_REWRITES) {
    try {
      out = out.replaceAll(from, to);
    } catch (_) { /* fail-open */ }
  }
  return out;
}

// Sanitize one system text blob: if it's an agent prompt, replace with the
// neutral prompt; otherwise apply conservative brand rewrites.
export function sanitizeSystemText(text) {
  if (typeof text !== "string" || !text.trim()) return text;
  if (isAgentSystemPrompt(text)) return NEUTRAL_SYSTEM_PROMPT;
  return rewriteSystemText(text);
}

// ---------------------------------------------------------------------------
// Tool-schema sanitization
// ---------------------------------------------------------------------------

export function sanitizeFunctionName(name) {
  if (typeof name !== "string" || !name.trim()) return name;
  let s = name.replace(FUNCTION_NAME_REPLACE_RE, "_");
  if (!FUNCTION_NAME_START_RE.test(s)) s = "_" + s;
  return s.substring(0, FUNCTION_NAME_MAX_LENGTH);
}

function hasRefs(obj, seen = new Set()) {
  if (!obj || typeof obj !== "object") return false;
  if (seen.has(obj)) return false;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) if (hasRefs(item, seen)) return true;
    return false;
  }
  if ("$ref" in obj) return true;
  return Object.values(obj).some((value) => hasRefs(value, seen));
}

function resolveSchemaRefs(schema, defs, seen = new Set()) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((item) => resolveSchemaRefs(item, defs, seen));

  if (schema.$ref && typeof schema.$ref === "string") {
    const refPath = schema.$ref.replace(/^#\/\$defs\//, "").replace(/^#\/definitions\//, "");
    if (seen.has(refPath)) {
      return { type: "object", description: `(circular ref: ${refPath})` };
    }
    const resolved = defs[refPath];
    if (resolved) {
      const nextSeen = new Set(seen);
      nextSeen.add(refPath);
      return resolveSchemaRefs({ ...resolved }, defs, nextSeen);
    }
    return { type: "object", description: `(unresolved ref: ${refPath})` };
  }

  const clone = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$defs" || key === "definitions") continue;
    clone[key] = resolveSchemaRefs(value, defs, seen);
  }
  return clone;
}

// Recursively drop `pattern` keywords whose value contains a Unicode property
// escape (\p{…}). Non-mutating. `pattern` is validation-only, so removal never
// changes what a tool call can do — it only keeps strict backends from
// rejecting the whole request (fail-open philosophy).
function stripUnsafePatterns(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    for (const item of node) stripUnsafePatterns(item);
    return node;
  }
  if (typeof node.pattern === "string" && UNSAFE_PATTERN_RE.test(node.pattern)) {
    delete node.pattern;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") stripUnsafePatterns(value);
  }
  return node;
}

// Clean a JSON-Schema object (non-mutating): resolve $ref, strip meta keywords,
// ensure a usable object schema. Conservative — never touches property names.
export function sanitizeToolSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }

  const defs = { ...(schema.$defs || {}), ...(schema.definitions || {}) };
  let resolved = Object.keys(defs).length > 0 || hasRefs(schema)
    ? resolveSchemaRefs(schema, defs)
    : { ...schema };

  for (const key of SCHEMA_META_KEYWORDS) {
    delete resolved[key];
  }

  // Strip `pattern` values carrying Unicode property escapes (\p{…}) — several
  // third-party backends reject the whole request with 400 on them (e.g. the
  // Claude Code Artifact tool's field pattern; anthropics/claude-code#92964).
  stripUnsafePatterns(resolved);

  if (!resolved.type) resolved.type = "object";
  if (resolved.type === "object" && !resolved.properties) {
    resolved.properties = {};
  }
  if (resolved.required && !Array.isArray(resolved.required)) {
    delete resolved.required;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Format-aware body sanitization (dispatch)
// ---------------------------------------------------------------------------
function sanitizeChatSystemMessages(messages) {
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role !== "system" && message.role !== "developer") continue;
    const content = message.content;
    if (typeof content === "string") {
      message.content = sanitizeSystemText(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && typeof block.text === "string") {
          block.text = sanitizeSystemText(block.text);
        }
      }
    }
  }
}

// Claude: body.system (string or array of {type:"text", text}).
function sanitizeClaudeSystem(body) {
  const system = body.system;
  if (typeof system === "string") {
    body.system = sanitizeSystemText(system);
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (block && typeof block === "object" && typeof block.text === "string") {
        block.text = sanitizeSystemText(block.text);
      }
    }
  }
}

// Gemini/Vertex/Antigravity: body.systemInstruction (or nested body.request),
// parts[].text.
function sanitizeGeminiSystem(body, root) {
  const target = root && root.request && typeof root.request === "object" ? root.request : root;
  if (!target || typeof target !== "object") return;
  const system = target.systemInstruction || target.system_instruction;
  if (!system || typeof system !== "object") return;
  if (!Array.isArray(system.parts)) return;
  for (const part of system.parts) {
    if (part && typeof part === "object" && typeof part.text === "string") {
      part.text = sanitizeSystemText(part.text);
    }
  }
}

// OpenAI Responses: body.instructions (string) or body.input items with
// role system/developer (content string or [{type:"input_text",text}]).
function sanitizeResponsesSystem(body) {
  if (typeof body.instructions === "string") {
    body.instructions = sanitizeSystemText(body.instructions);
  }
  const input = body.input;
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "message" || (item.role !== "system" && item.role !== "developer")) continue;
    const content = item.content;
    if (typeof content === "string") {
      item.content = sanitizeSystemText(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && typeof block.text === "string") {
          block.text = sanitizeSystemText(block.text);
        }
      }
    }
  }
}

// Kiro: body.systemPrompt string.
function sanitizeKiroSystem(body) {
  if (typeof body.systemPrompt === "string") {
    body.systemPrompt = sanitizeSystemText(body.systemPrompt);
  }
}

// ---------------------------------------------------------------------------
// Tool sanitization per format
// ---------------------------------------------------------------------------

// OpenAI chat tools: tools[].function{name,description,parameters}
// OpenAI Responses tools: tools[]{type:"function", name, description, parameters}
// NOTE: function/tool NAMES are deliberately left untouched for OpenAI-shaped
// bodies. OpenAI accepts a broad charset, and renaming would break the
// client↔provider contract: prior assistant tool_calls in history, tool_choice,
// and the response toolNameMap all reference the ORIGINAL name. Only the
// parameters schema is cleaned. (Gemini-family bodies are handled separately —
// the translator already normalized names there consistently.)
// Returns the number of schemas cleaned.
function sanitizeOpenAITools(body) {
  let cleaned = 0;
  if (!Array.isArray(body.tools)) return 0;
  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") continue;
    const fn = tool.function;
    if (fn && typeof fn === "object") {
      if (fn.parameters) {
        fn.parameters = sanitizeToolSchema(fn.parameters);
        cleaned++;
      }
    } else if (tool.parameters) {
      // OpenAI Responses tool shape (name/parameters at top level)
      tool.parameters = sanitizeToolSchema(tool.parameters);
      cleaned++;
    }
  }
  return cleaned;
}

// Claude tools: tools[]{name,description,input_schema}
// NOTE: tool names are deliberately left untouched — renaming them would break
// tool_use_id/tool_call references in the conversation. Only the schema is cleaned.
// Returns the number of schemas cleaned.
function sanitizeClaudeTools(body) {
  let cleaned = 0;
  if (!Array.isArray(body.tools)) return 0;
  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.input_schema) {
      tool.input_schema = sanitizeToolSchema(tool.input_schema);
      cleaned++;
    }
  }
  return cleaned;
}

// Gemini/Vertex/Antigravity: body.tools[].functionDeclarations[] or
// body.request.tools[].functionDeclarations[] {name, parameters}
// Returns the number of schemas cleaned.
function sanitizeGeminiTools(body) {
  let cleaned = 0;
  const target = body.request && typeof body.request === "object" ? body.request : body;
  if (!target || typeof target !== "object" || !Array.isArray(target.tools)) return 0;
  for (const group of target.tools) {
    if (!group || typeof group !== "object" || !Array.isArray(group.functionDeclarations)) continue;
    for (const fn of group.functionDeclarations) {
      if (!fn || typeof fn !== "object") continue;
      if (typeof fn.name === "string") fn.name = sanitizeFunctionName(fn.name);
      if (fn.parameters) {
        fn.parameters = sanitizeToolSchema(fn.parameters);
        cleaned++;
      }
    }
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Entry point — fail-open, returns a small stats object or null
// ---------------------------------------------------------------------------

export function sanitizeRequest(body, format, { enabled } = {}) {
  if (!enabled) return null;
  if (!body || typeof body !== "object") return null;

  const stats = { toolsCleaned: 0 };
  try {
    // System prompt sanitization, format-aware. Dispatch order mirrors
    // systemInject.js: Kiro → Claude → Gemini/Vertex/Antigravity →
    // instructions (Responses) → messages[] (OpenAI chat / passthrough).
    const isKiroBody = typeof body.systemPrompt === "string"
      && !!body.conversationState && typeof body.conversationState === "object";
    if (isKiroBody || format === FORMATS.KIRO) {
      sanitizeKiroSystem(body);
    } else if (format === FORMATS.CLAUDE) {
      sanitizeClaudeSystem(body);
    } else if (format === FORMATS.GEMINI || format === FORMATS.GEMINI_CLI
      || format === FORMATS.VERTEX || format === FORMATS.ANTIGRAVITY) {
      sanitizeGeminiSystem(body, body);
    } else if (typeof body.instructions === "string") {
      sanitizeResponsesSystem(body);
    } else if (Array.isArray(body.messages)) {
      sanitizeChatSystemMessages(body.messages);
    } else if (Array.isArray(body.input)) {
      sanitizeResponsesSystem(body);
    }

    // Tool-schema sanitization, format-aware.
    const tools = body.tools || body.request?.tools;
    if (Array.isArray(tools) && tools.length > 0) {
      if (format === FORMATS.CLAUDE) {
        stats.toolsCleaned = sanitizeClaudeTools(body);
      } else if (format === FORMATS.GEMINI || format === FORMATS.GEMINI_CLI
        || format === FORMATS.VERTEX || format === FORMATS.ANTIGRAVITY) {
        stats.toolsCleaned = sanitizeGeminiTools(body);
      } else {
        // OpenAI chat / Responses / passthrough OpenAI-shaped bodies.
        stats.toolsCleaned = sanitizeOpenAITools(body);
      }
    }

    return stats;
  } catch (_) {
    // fail-open: never break a request because of sanitization
    return null;
  }
}