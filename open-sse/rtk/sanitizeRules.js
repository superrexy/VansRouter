// Sanitize rules — shared constants for the one-toggle "Sanitize" guard
// (system-prompt + tool-schema sanitization). Logic is modeled after the
// CodeBuddy China provider sanitization (isAgentSystemPrompt + sanitizeToolSchema):
//   - isAgentSystemPrompt(): detect competing/agent CLI system prompts and
//     replace them with a neutral assistant prompt (prevents branding leaks and
//     prompt-injection from client system messages).
//   - sanitizeToolSchema(): strip JSON-Schema meta/unsupported keywords and
//     resolve $ref safely (no infinite recursion).

// Neutral replacement used when a system prompt is detected as an agent/CLI
// system prompt. Kept generic so it does not advertise any single vendor.
export const NEUTRAL_SYSTEM_PROMPT =
  "You are a helpful AI assistant that helps with software engineering tasks.";

// System prompts that are treated as "agent/CLI/system" prompts — replaced by
// the neutral prompt above. Mirrors isAgentSystemPrompt() in the CodeBuddy
// China provider (claude.*official.*cli / code.*official.*cli / "you are
// <brand>" identities, cc_entrypoint, agent-identity tags) and is
// intentionally identity-focused so ordinary prose that merely mentions a
// brand is NOT replaced (only rewritten).
//
// NOTE on scope: system-prompt sanitization ONLY replaces prompts that
// explicitly declare an agent/CLI/competing-client identity (markers below).
// Length is deliberately NOT used as a standalone signal — legitimate long
// system prompts (personas, coding guidelines) must never be silently wiped.
export const AGENT_SYSTEM_PROMPT_PATTERNS = [
  // Official CLI identities ("You are Claude Code, Anthropic's official CLI…")
  /claude.*official.*cli/i,
  /code.*official.*cli/i,
  // Agent-brand identity declarations ("You are Claude/OpenCode/Cursor/…")
  /you are (?:claude|opencode|cursor|windsurf|cline|aider|continue|copilot|cody|codex|zed|qwen|gemini|antigravity|hermes)/i,
  // Generic coding/ai agent declarations ("You are a Claude agent…",
  // "You are a coding agent…", "You are an AI agent…")
  /you are (?:an? )?(?:claude|code|coding|ai) agent/i,
  /cc_entrypoint/i,
  /ohmyopencode/i,
  /<agent-identity>/i,
  /hermes agent/i,
  /nous research/i,
];

// Lower-confidence signal: a system prompt longer than this is only replaced
// when it ALSO contains an identity marker above (never length alone).
export const AGENT_SYSTEM_PROMPT_MAX_LENGTH = 2000;

// Rewrite rules for brand/tool names that leak a competing client into the
// system prompt (kept upstream-safe). Pattern mirrors ANTIGRAVITY_PROMPT_REWRITES.
// Order matters: most-specific phrases ("Claude Code") must run before the bare
// word ("Claude"), or the pair is already partially replaced.
export const SYSTEM_PROMPT_REWRITES = [
  // OpenCode
  { from: /opencode/gi, to: (m) => (m === "OpenCode" ? "Code assistant" : m === "OPENCODE" ? "CODE ASSISTANT" : "code assistant") },
  // Claude Code (phrase first — bare "Claude" below would fragment it)
  { from: /claude code/gi, to: (m) => (m === "Claude Code" ? "Code assistant" : m === "CLAUDE CODE" ? "CODE ASSISTANT" : "code assistant") },
  // Claude Agent SDK identity leak
  { from: /claude agent sdk/gi, to: (m) => (m === "Claude Agent SDK" ? "the agent SDK" : m === "CLAUDE AGENT SDK" ? "THE AGENT SDK" : "the agent SDK") },
  // Bare Claude / Anthropic mentions (client identity on third-party upstreams)
  { from: /\bclaude\b/gi, to: (m) => (m === "Claude" ? "the assistant" : m === "CLAUDE" ? "THE ASSISTANT" : "the assistant") },
  { from: /\banthropic\b/gi, to: (m) => (m === "Anthropic" ? "the provider" : m === "ANTHROPIC" ? "THE PROVIDER" : "the provider") },
];

// JSON-Schema `pattern` strings using Unicode property escapes (\p{…}/\P{…}) are
// valid ECMA-262 but rejected with HTTP 400 by strict validators on several
// third-party Anthropic/OpenAI-compatible backends (GLM/Z.AI, DeepSeek — see
// anthropics/claude-code#92964: the Artifact tool's field pattern ships one).
// `pattern` is validation-only — it never affects tool execution — so any value
// containing this construct is stripped. Conservative: plain regex patterns are
// preserved.
export const UNSAFE_PATTERN_RE = /\\[pP]\{/;

// Function-name charset sanitization (Gemini style). Mirrors
// sanitizeFunctionName/sanitizeGeminiFunctionName in executors/translators.
export const FUNCTION_NAME_REPLACE_RE = /[^a-zA-Z0-9_.:\-]/g;
export const FUNCTION_NAME_MAX_LENGTH = 64;
export const FUNCTION_NAME_START_RE = /^[a-zA-Z_]/;

// JSON-Schema meta keywords that are never needed by upstream tool execution
// and can carry unsafe/undesired data — stripped recursively.
// NOTE: deliberately conservative — only unambiguous meta keywords (all start
// with "$" plus "definitions"). Plain words like "id"/"title"/"default" are NOT
// stripped because they commonly appear as property names/values inside
// properties (e.g. properties.id) and deleting them corrupts the schema.
export const SCHEMA_META_KEYWORDS = [
  "$schema",
  "$id",
  "$comment",
  "$defs",
  "definitions",
];
