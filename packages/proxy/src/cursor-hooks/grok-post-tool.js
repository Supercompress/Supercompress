/**
 * Grok PostToolUse result replacement helpers.
 * Grok discards UserPromptSubmit additionalContext; the mid-turn path is
 * updatedToolOutput on PostToolUse (keep toolResult shape).
 */

/** Grok renders updatedToolOutput up to 64KB; stay under that. */
const GROK_REPLACE_CAP = Number(process.env.SUPERCOMPRESS_GROK_REPLACE_CAP || 60_000);

function isGrokAgent(name) {
  return /grok/i.test(String(name || ""));
}

/**
 * Clone toolResult and swap the main text field with the digest body.
 * If the payload was truncated to a plain string, replacement is not allowed
 * by Grok — callers should send additionalContext only.
 */
function buildGrokUpdatedToolOutput(toolResult, body) {
  if (toolResult == null) return body;
  if (typeof toolResult === "string") return body;
  if (typeof toolResult !== "object" || Array.isArray(toolResult)) return body;
  let out;
  try {
    out = JSON.parse(JSON.stringify(toolResult));
  } catch {
    return body;
  }
  const preferred = [
    "output_for_prompt",
    "output",
    "stdout",
    "content",
    "text",
    "result",
  ];
  for (const key of preferred) {
    if (typeof out[key] === "string") {
      out[key] = body;
      return out;
    }
  }
  let bestKey = null;
  let bestLen = -1;
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string" && value.length > bestLen) {
      bestKey = key;
      bestLen = value.length;
    }
  }
  if (bestKey) {
    out[bestKey] = body;
    return out;
  }
  if (out.type) {
    out.output_for_prompt = body;
    return out;
  }
  return body;
}

function buildGrokDigestBody(toolName, meta, compressed) {
  return [
    `[SuperCompress auto] Compressed ${toolName || "tool"} output (~${meta}).`,
    "Prefer this digest over the raw dump:",
    "",
    compressed,
  ]
    .join("\n")
    .slice(0, GROK_REPLACE_CAP);
}

function buildGrokHookResponse({
  toolResult,
  toolResultTruncated,
  toolName,
  meta,
  compressed,
}) {
  const body = buildGrokDigestBody(toolName, meta, compressed);
  const note = `[SuperCompress auto] Compressed ${toolName || "tool"} (~${meta}). Model sees replaced tool output; full digest also in ~/.supercompress/inbox/.`.slice(
    0,
    9_500
  );

  if (toolResultTruncated) {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: note,
      },
    };
  }

  const updatedToolOutput = buildGrokUpdatedToolOutput(toolResult, body);
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: note,
      updatedToolOutput,
      updatedMCPToolOutput: body,
    },
  };
}

module.exports = {
  GROK_REPLACE_CAP,
  isGrokAgent,
  buildGrokUpdatedToolOutput,
  buildGrokDigestBody,
  buildGrokHookResponse,
};
