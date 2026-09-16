// Claude helper functions for translator
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../config/defaultThinkingSignature.js";
import { ROLE, CLAUDE_BLOCK } from "../schema/index.js";
import { adjustMaxTokens } from "./maxTokens.js";
import { applyCloaking } from "../../utils/claudeCloaking.js";
import { resolveSessionId } from "../../utils/sessionManager.js";
import { isValidClaudeSignature } from "../../utils/claudeSignature.js";
import { PROVIDERS } from "../../providers/index.js";
import { getCapabilitiesForModel } from "../../providers/capabilities.js";
import { DEFAULT_MAX_TOKENS } from "../../config/runtimeConfig.js";

function normalizeMessageContent(msg) {
  const content = msg?.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    delete content.cache_control;
    msg.content = [content];
  }
  return msg;
}

function lastCacheableToolIndex(tools) {
  if (!Array.isArray(tools)) return -1;
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i]?.defer_loading !== true) return i;
  }
  return -1;
}

function countCacheControlBlocks(body) {
  let count = 0;
  for (const block of body?.system || []) if (block?.cache_control) count++;
  for (const tool of body?.tools || []) if (tool?.cache_control) count++;
  for (const message of body?.messages || []) {
    for (const block of message.content || []) if (block?.cache_control) count++;
  }
  return count;
}

function capCacheControlBlocks(body) {
  const marked = [];
  const heads = new Set();
  const system = Array.isArray(body.system) ? body.system : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (system.length) heads.add(system.at(-1));
  const lastTool = lastCacheableToolIndex(tools);
  if (lastTool >= 0) heads.add(tools[lastTool]);
  for (const block of system) if (block?.cache_control) marked.push(block);
  for (const tool of tools) if (tool?.cache_control) marked.push(tool);
  for (const message of body.messages || []) {
    for (const block of message.content || []) if (block?.cache_control) marked.push(block);
  }
  const head = marked.filter((block) => heads.has(block));
  const rest = marked.filter((block) => !heads.has(block));
  const keep = new Set([...head, ...rest.slice(-(4 - head.length))]);
  for (const block of marked) {
    if (!keep.has(block)) delete block.cache_control;
  }
}

export function anchorClaudeCache(body) {
  if (!body || typeof body !== "object") return body;
  for (const msg of body.messages || []) normalizeMessageContent(msg);
  for (const tool of body.tools || []) if (tool?.defer_loading === true) delete tool.cache_control;
  if (Array.isArray(body.system) && body.system.length) body.system.at(-1).cache_control = { type: "ephemeral", ttl: "1h" };
  const lastTool = lastCacheableToolIndex(body.tools);
  if (lastTool >= 0) body.tools[lastTool].cache_control = { type: "ephemeral", ttl: "1h" };
  if (countCacheControlBlocks(body) >= 4) {
    capCacheControlBlocks(body);
    return body;
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) for (const block of message.content || []) delete block.cache_control;
    const target = [...body.messages].reverse().find((m) => m.role === ROLE.ASSISTANT && Array.isArray(m.content)) || [...body.messages].reverse().find((m) => Array.isArray(m.content));
    const block = [...(target?.content || [])].reverse().find((b) => b && typeof b === "object" && ![CLAUDE_BLOCK.THINKING, CLAUDE_BLOCK.REDACTED_THINKING].includes(b.type));
    if (block) block.cache_control = { type: "ephemeral" };
  }
  return body;
}

// Check if message has valid non-empty content
export function hasValidContent(msg) {
  if (typeof msg.content === "string" && msg.content.trim()) return true;
  const content = msg.content && typeof msg.content === "object" && !Array.isArray(msg.content) ? [msg.content] : msg.content;
  if (Array.isArray(content)) {
    return content.some(block =>
      (block.type === CLAUDE_BLOCK.TEXT && block.text?.trim()) ||
      block.type === CLAUDE_BLOCK.TOOL_USE ||
      block.type === CLAUDE_BLOCK.TOOL_RESULT ||
      block.type === CLAUDE_BLOCK.IMAGE ||
      block.type === CLAUDE_BLOCK.DOCUMENT
    );
  }
  return false;
}

// Fix tool_use/tool_result ordering for Claude API
// 1. Assistant message with tool_use: remove text AFTER tool_use (Claude doesn't allow)
// 2. Merge consecutive same-role messages
function fixToolUseOrdering(messages) {
  if (messages.length <= 1) return messages;

  // Pass 1: Fix assistant messages with tool_use - remove text after tool_use
  for (const msg of messages) {
    if (msg.role === ROLE.ASSISTANT && Array.isArray(msg.content)) {
      const hasToolUse = msg.content.some(b => b.type === CLAUDE_BLOCK.TOOL_USE);
      if (hasToolUse) {
        // Keep only: thinking blocks + tool_use blocks (remove text blocks after tool_use)
        const newContent = [];
        let foundToolUse = false;

        for (const block of msg.content) {
          if (block.type === CLAUDE_BLOCK.TOOL_USE) {
            foundToolUse = true;
            newContent.push(block);
          } else if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) {
            newContent.push(block);
          } else if (!foundToolUse) {
            // Keep text blocks BEFORE tool_use
            newContent.push(block);
          }
          // Skip text blocks AFTER tool_use
        }

        msg.content = newContent;
      }
    }
  }

  // Pass 2: Merge consecutive same-role messages
  const merged = [];

  for (const msg of messages) {
    const last = merged[merged.length - 1];

    if (last && last.role === msg.role) {
      // Merge content arrays
      const lastContent = Array.isArray(last.content) ? last.content : [{ type: CLAUDE_BLOCK.TEXT, text: last.content }];
      const msgContent = Array.isArray(msg.content) ? msg.content : [{ type: CLAUDE_BLOCK.TEXT, text: msg.content }];

      // Put tool_result first, then other content
      const toolResults = [...lastContent.filter(b => b.type === CLAUDE_BLOCK.TOOL_RESULT), ...msgContent.filter(b => b.type === CLAUDE_BLOCK.TOOL_RESULT)];
      const otherContent = [...lastContent.filter(b => b.type !== CLAUDE_BLOCK.TOOL_RESULT), ...msgContent.filter(b => b.type !== CLAUDE_BLOCK.TOOL_RESULT)];

      last.content = [...toolResults, ...otherContent];
    } else {
      // Ensure content is array
      const content = Array.isArray(msg.content) ? msg.content : [{ type: CLAUDE_BLOCK.TEXT, text: msg.content }];
      merged.push({ role: msg.role, content: [...content] });
    }
  }

  return merged;
}

// Models that reject thinking.type "adaptive" + output_config.effort (Opus 4.5+/Sonnet 4.6+ only)
const ADAPTIVE_THINKING_UNSUPPORTED = /haiku/i;

function handlesThinkingBlocks(provider) {
  return provider === "claude" || provider?.startsWith("anthropic-compatible") || provider === "deepseek";
}

function buildThinkingPlaceholder(provider) {
  const block = {
    type: CLAUDE_BLOCK.THINKING,
    thinking: ".",
  };

  // DeepSeek's Anthropic-compatible endpoint requires a thinking block in
  // thinking mode, but it does not need Anthropic's signed-thinking fallback.
  if (provider !== "deepseek") {
    block.signature = DEFAULT_THINKING_CLAUDE_SIGNATURE;
  }

  return block;
}

// Normalize a native Claude passthrough body to match Anthropic Messages API spec.
// Newer Cowork/Claude Code clients emit beta-only shapes that OAuth endpoints reject:
// 1. thinking.type "adaptive" → unsupported on Haiku
// 2. output_config.effort → unsupported on Haiku
// 3. role "system" messages (mid-conversation-system beta) → only top-level system is allowed
export function normalizeClaudePassthrough(body, model = "") {
  if (!body || typeof body !== "object") return body;

  // 1. Downgrade adaptive thinking for models that don't support it
  if (body.thinking?.type === "adaptive" && ADAPTIVE_THINKING_UNSUPPORTED.test(model)) {
    body.thinking = { type: "enabled", budget_tokens: 10000 };
  }

  // 2. Strip effort param for models that don't support it (keep other output_config fields)
  if (ADAPTIVE_THINKING_UNSUPPORTED.test(model) && body.output_config?.effort != null) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }

  // 3. Normalize single content blocks before system-message processing.
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) normalizeMessageContent(msg);
  }

  // 2. Hoist mid-conversation system messages into the top-level system field
  if (Array.isArray(body.messages)) {
    const systemBlocks = [];
    const messages = [];
    for (const msg of body.messages) {
      if (msg.role === ROLE.SYSTEM) {
        const text = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map(b => (typeof b === "string" ? b : b?.text || "")).join("\n")
            : "";
        if (text.trim()) systemBlocks.push({ type: CLAUDE_BLOCK.TEXT, text });
        continue;
      }
      messages.push(msg);
    }

    if (systemBlocks.length > 0) {
      const existing = Array.isArray(body.system)
        ? body.system
        : typeof body.system === "string" && body.system.trim()
          ? [{ type: "text", text: body.system }]
          : [];
      body.system = [...existing, ...systemBlocks];
      body.messages = messages;
    }
  }

  // 3. Drop thinking blocks whose signature is not Claude's (combo mixes models,
  // so foreign signatures leak into history and Anthropic rejects them).
  const thinkingEnabled = body.thinking?.type === "enabled";
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role !== ROLE.ASSISTANT || !Array.isArray(msg.content)) continue;
      let hasToolUse = false;
      let hasKeptThinking = false;
      const kept = [];
      for (const block of msg.content) {
        if (block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING) {
          if (isValidClaudeSignature(block.signature)) {
            hasKeptThinking = true;
            kept.push(block);
          }
          continue;
        }
        if (block.type === CLAUDE_BLOCK.TOOL_USE) hasToolUse = true;
        kept.push(block);
      }
      msg.content = kept;
      if (thinkingEnabled && !hasKeptThinking && hasToolUse) {
        msg.content.unshift(buildThinkingPlaceholder("claude"));
      }
    }
  }

  return body;
}

// Prepare request for Claude format endpoints
// - Cleanup cache_control
// - Filter empty messages
// - Add thinking block for Anthropic endpoint (provider === "claude")
// - Fix tool_use/tool_result ordering
// - Apply cloaking (billing header + fake user ID) for OAuth tokens
export function prepareClaudeRequest(body, provider = null, apiKey = null, connectionId = null, rawHeaders = null, sessionId = null) {
  // quirk: MiniMax's Claude-compatible endpoint rejects Anthropic's output_config (400 invalid params)
  if (PROVIDERS[provider]?.quirks?.dropOutputConfig) {
    delete body.output_config;
  }

  // Clamp max_tokens to the model's real output ceiling. Models whose caps
  // declare a higher maxOutput (e.g. Opus 4.8 / Sonnet 4.6 = 128000) are allowed
  // up to it, so max-effort thinking gets full budget; others fall back to the
  // conservative 64000 default.
  if (body.max_tokens) {
    const ceiling = getCapabilitiesForModel(provider, body.model).maxOutput || DEFAULT_MAX_TOKENS;
    if (body.max_tokens > ceiling) body.max_tokens = ceiling;

    // Reconcile against thinking budget. applyThinking (thinkingUnified.js) runs
    // AFTER adjustMaxTokens capped max_tokens, and the claude-budget format maps
    // max effort → budget_tokens 128000 — larger than the clamped max_tokens.
    // Anthropic requires max_tokens strictly greater than budget_tokens (else 400).
    // Prefer raising max_tokens to preserve the requested thinking depth; if the
    // budget alone meets/exceeds the ceiling, cap output and shrink the budget so
    // some tokens remain for the answer.
    if (body.thinking?.type === "enabled" && body.thinking.budget_tokens && body.thinking.budget_tokens >= body.max_tokens) {
      body.max_tokens = Math.min(body.thinking.budget_tokens + 1024, ceiling);
      if (body.thinking.budget_tokens >= body.max_tokens) {
        body.thinking.budget_tokens = Math.max(1024, body.max_tokens - 1024);
      }
    }
  }

  // 1. System: remove all cache_control, add only to last block with ttl 1h
  if (body.system && Array.isArray(body.system)) {
    body.system = body.system.map((block, i) => {
      const { cache_control, ...rest } = block;
      if (i === body.system.length - 1) {
        return { ...rest, cache_control: { type: "ephemeral", ttl: "1h" } };
      }
      return rest;
    });
  }

  // 2. Messages: process in optimized passes
  if (body.messages && Array.isArray(body.messages)) {
    const len = body.messages.length;
    let filtered = [];

    // Pass 1: remove cache_control + filter empty messages
    for (let i = 0; i < len; i++) {
      const msg = normalizeMessageContent(body.messages[i]);

      // Remove cache_control from content blocks
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          delete block.cache_control;
        }
      }

      // Keep final assistant even if empty, otherwise check valid content
      const isFinalAssistant = i === len - 1 && msg.role === "assistant";
      if (isFinalAssistant || hasValidContent(msg)) {
        filtered.push(msg);
      }
    }

    // Pass 1.5: Fix tool_use/tool_result ordering
    // Each tool_use must have tool_result in the NEXT message (not same message with other content)
    filtered = fixToolUseOrdering(filtered);

    body.messages = filtered;

    // Check if thinking is enabled AND last message is from user
    const lastMessage = filtered[filtered.length - 1];
    const lastMessageIsUser = lastMessage?.role === "user";
    const thinkingEnabled = body.thinking?.type === "enabled" && lastMessageIsUser;

    // Pass 2 (reverse): add cache_control to last assistant + handle thinking for Anthropic
    let lastAssistantProcessed = false;
    for (let i = filtered.length - 1; i >= 0; i--) {
      const msg = filtered[i];

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        // Add cache_control to last non-thinking block of first (from end) assistant with content
        // thinking/redacted_thinking blocks do not support cache_control
        if (!lastAssistantProcessed && msg.content.length > 0) {
          for (let j = msg.content.length - 1; j >= 0; j--) {
            const block = msg.content[j];
            if (block.type !== CLAUDE_BLOCK.THINKING && block.type !== CLAUDE_BLOCK.REDACTED_THINKING) {
              block.cache_control = { type: "ephemeral" };
              break;
            }
          }
          lastAssistantProcessed = true;
        }

        // Handle thinking blocks for Anthropic-compatible endpoints.
        if (handlesThinkingBlocks(provider)) {
          let hasToolUse = false;
          let hasKeptThinking = false;

          // Claude native: preserve valid signatures, drop invalid blocks.
          // anthropic-compatible: replace with default (safe fallback for lenient upstreams).
          // DeepSeek: keep existing thinking as-is; add an unsigned placeholder only if missing.
          const isClaudeNative = provider === "claude";
          const isDeepSeek = provider === "deepseek";
          const kept = [];
          for (const block of msg.content) {
            const isThinking = block.type === CLAUDE_BLOCK.THINKING || block.type === CLAUDE_BLOCK.REDACTED_THINKING;
            if (isThinking) {
              if (isClaudeNative) {
                if (isValidClaudeSignature(block.signature)) {
                  hasKeptThinking = true;
                  kept.push(block);
                }
              } else if (isDeepSeek) {
                hasKeptThinking = true;
                kept.push(block);
              } else {
                block.signature = DEFAULT_THINKING_CLAUDE_SIGNATURE;
                hasKeptThinking = true;
                kept.push(block);
              }
              continue;
            }
            if (block.type === CLAUDE_BLOCK.TOOL_USE) hasToolUse = true;
            kept.push(block);
          }
          msg.content = kept;

          // Add thinking block if thinking enabled + has tool_use but no thinking
          if (thinkingEnabled && !hasKeptThinking && hasToolUse) {
            msg.content.unshift(buildThinkingPlaceholder(provider));
          }
        }
      }
    }
  }

  // 3. Tools: filter built-in tools for non-Anthropic providers, then handle cache_control
  if (body.tools && Array.isArray(body.tools)) {
    // Strip built-in tools (e.g. web_search_20250305) and normalize to Anthropic-native shape
    // (drop `type` field, fold `function.{name,description,parameters}`) for non-Anthropic providers
    if (provider !== "claude") {
      const supportedTypes = PROVIDERS[provider]?.quirks?.claudeSupportedToolTypes;
      const hasWhitelist = Array.isArray(supportedTypes);
      body.tools = body.tools
        .filter(tool => {
          const type = tool?.type;
          if (!type || type === "function") return true;
          return hasWhitelist ? supportedTypes.includes(type) : false;
        })
        .map(tool => {
          if (tool.function) {
            return {
              name: tool.function.name,
              description: tool.function.description,
              input_schema: tool.function.parameters,
            };
          }
          if (hasWhitelist) return tool;
          const { type, ...rest } = tool;
          return rest;
        });
    }

    body.tools = body.tools.map((tool, i) => {
      const { cache_control, ...rest } = tool;
      if (i === body.tools.length - 1) {
        return { ...rest, cache_control: { type: "ephemeral", ttl: "1h" } };
      }
      return rest;
    });

    // Remove tools array and tool_choice if empty after filtering
    if (body.tools.length === 0) {
      delete body.tools;
      delete body.tool_choice;
    }
  }

  // Apply cloaking for OAuth tokens (billing header + fake user ID)
  // session_id in user_id must match X-Claude-Code-Session-Id for fingerprint consistency
  if ((provider === "claude" || provider?.startsWith("anthropic-compatible")) && apiKey) {
    const sid = sessionId || resolveSessionId({ headers: rawHeaders, body, connectionId, scope: "claude" });
    body = applyCloaking(body, apiKey, sid);
  }

  return body;
}
