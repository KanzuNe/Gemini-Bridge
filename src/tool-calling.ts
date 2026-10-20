import { randomUUID } from "node:crypto";

import { InvalidRequestError } from "./errors.js";

export type ChatToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
};

export type ToolChoice = "auto" | "none" | "required" | {
  type?: string;
  function?: {
    name?: string;
  };
};

export type ParsedToolDecision =
  | {
      type: "message";
      content: string;
    }
  | {
      type: "tool_calls";
      content?: string;
      toolCalls: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };

export type OpenAiToolCall = Extract<ParsedToolDecision, { type: "tool_calls" }>["toolCalls"][number];

export type ResponseFunctionCall = {
  id: string;
  callId: string;
  name: string;
  argumentsText: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeToolName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeChatTools(value: unknown): ChatToolDefinition[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new InvalidRequestError("tools must be an array.", "invalid_tools");
  }

  return value
    .map((tool, index): ChatToolDefinition | null => {
      if (!isRecord(tool)) {
        throw new InvalidRequestError(`tools[${index}] must be an object.`, "invalid_tool");
      }
      if (tool.type !== "function") {
        return null;
      }
      if (!isRecord(tool.function)) {
        throw new InvalidRequestError(`tools[${index}].function must be an object.`, "invalid_tool");
      }

      const name = normalizeToolName(tool.function.name);
      if (!name) {
        throw new InvalidRequestError(`tools[${index}].function.name is required.`, "invalid_tool");
      }

      return {
        type: "function",
        function: {
          name,
          description: typeof tool.function.description === "string" ? tool.function.description : undefined,
          parameters: tool.function.parameters,
        },
      };
    })
    .filter((tool): tool is ChatToolDefinition => Boolean(tool));
}

export function shouldUseToolPlanner(tools: ChatToolDefinition[], toolChoice: unknown): boolean {
  if (tools.length === 0) {
    return false;
  }
  return toolChoice !== "none";
}

function getForcedToolName(toolChoice: unknown): string | null {
  if (!isRecord(toolChoice)) {
    return null;
  }
  if (toolChoice.type && toolChoice.type !== "function") {
    return null;
  }
  return isRecord(toolChoice.function) ? normalizeToolName(toolChoice.function.name) || null : null;
}

export function buildToolPlanningPrompt(params: {
  promptText: string;
  tools: ChatToolDefinition[];
  toolChoice?: unknown;
}): string {
  const forcedToolName = getForcedToolName(params.toolChoice);
  const toolNames = new Set(params.tools.map((tool) => tool.function.name));
  if (forcedToolName && !toolNames.has(forcedToolName)) {
    throw new InvalidRequestError(`tool_choice requested unknown tool: ${forcedToolName}`, "invalid_tool_choice");
  }

  const toolSpecs = params.tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    parameters: tool.function.parameters ?? { type: "object", properties: {} },
  }));

  const choiceInstruction = forcedToolName
    ? `You must call the tool "${forcedToolName}".`
    : params.toolChoice === "required"
      ? "You must call one or more of the available tools."
      : "If external tools are needed to satisfy the user request, call them. Otherwise, answer the user directly.";

  return [
    "You are an assistant with access to the following external tools:",
    choiceInstruction,
    "",
    "# How to Call Tools:",
    "When you need to execute tools, wrap each tool call inside <tool_call> XML tags like this:",
    "<tool_call>",
    "{\"name\": \"tool_name\", \"arguments\": {\"param\": \"value\"}}",
    "</tool_call>",
    "",
    "Rules:",
    "1. You may provide natural language reasoning or explanations before, between, or after tool calls.",
    "2. You can call MULTIPLE tools in parallel by outputting multiple <tool_call>...</tool_call> blocks.",
    "3. The content inside <tool_call> must be a valid JSON object with \"name\" (string) and \"arguments\" (object).",
    "4. If no tools are required, answer directly in normal natural language or markdown without any <tool_call> tags.",
    "",
    "# Available Tools:",
    JSON.stringify(toolSpecs, null, 2),
    "",
    "# User Request & Context:",
    params.promptText,
  ].join("\n");
}

function cleanJsonString(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  return cleaned.trim();
}

function safeParseJson(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return isRecord(raw) ? raw : {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim().startsWith("{")) {
    return fenced[1].trim();
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  return null;
}

export function parseToolDecision(text: string, tools: ChatToolDefinition[]): ParsedToolDecision {
  const validToolNames = new Set(tools.map((t) => t.function.name));
  const toolCalls: OpenAiToolCall[] = [];

  // 1. Try extracting <tool_call>...</tool_call> tags
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  let hasXmlMatch = false;

  while ((match = toolCallRegex.exec(text)) !== null) {
    hasXmlMatch = true;
    const rawInner = match[1]?.trim() ?? "";
    const cleaned = cleanJsonString(rawInner);
    try {
      const parsed = JSON.parse(cleaned);
      if (isRecord(parsed)) {
        const name = normalizeToolName(parsed.name || (parsed.function as Record<string, unknown> | undefined)?.name);
        if (validToolNames.has(name)) {
          const rawArgs = parsed.arguments ?? parsed.parameters ?? {};
          const args = isRecord(rawArgs)
            ? rawArgs
            : typeof rawArgs === "string"
              ? safeParseJson(rawArgs)
              : {};
          toolCalls.push({
            id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "function",
            function: {
              name,
              arguments: JSON.stringify(args),
            },
          });
        }
      }
    } catch {
      // ignore malformed inner block
    }
  }

  if (hasXmlMatch && toolCalls.length > 0) {
    const remainingText = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim();
    return {
      type: "tool_calls",
      content: remainingText,
      toolCalls,
    };
  }

  // 2. Fallback: Check if the whole text or a markdown block is a JSON tool call
  const jsonText = extractJsonObject(text);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      if (isRecord(parsed)) {
        if (parsed.type === "message") {
          return {
            type: "message",
            content: typeof parsed.content === "string" ? parsed.content : text,
          };
        }

        // Multiple tool calls in { "tool_calls": [...] }
        if (Array.isArray(parsed.tool_calls)) {
          for (const item of parsed.tool_calls) {
            if (isRecord(item)) {
              const name = normalizeToolName(item.name || (item.function as Record<string, unknown> | undefined)?.name);
              if (validToolNames.has(name)) {
                const rawArgs = item.arguments ?? item.parameters ?? {};
                const args = isRecord(rawArgs)
                  ? rawArgs
                  : typeof rawArgs === "string"
                    ? safeParseJson(rawArgs)
                    : {};
                toolCalls.push({
                  id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
                  type: "function",
                  function: {
                    name,
                    arguments: JSON.stringify(args),
                  },
                });
              }
            }
          }
          if (toolCalls.length > 0) {
            return {
              type: "tool_calls",
              toolCalls,
            };
          }
        }

        // Single tool call: { "type": "tool_call", "name": "...", "arguments": ... }
        // or direct tool call: { "name": "...", "arguments": ... }
        const name = normalizeToolName(parsed.name || (parsed.function as Record<string, unknown> | undefined)?.name);
        if (validToolNames.has(name)) {
          const rawArgs = parsed.arguments ?? parsed.parameters ?? {};
          const args = isRecord(rawArgs)
            ? rawArgs
            : typeof rawArgs === "string"
              ? safeParseJson(rawArgs)
              : {};
          return {
            type: "tool_calls",
            toolCalls: [
              {
                id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(args),
                },
              },
            ],
          };
        }
      }
    } catch {
      // fallback to message
    }
  }

  // 3. Fallback: Default to message
  return { type: "message", content: text };
}

export function toResponseFunctionCall(toolCall: OpenAiToolCall): ResponseFunctionCall {
  return {
    id: `fc_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    callId: toolCall.id,
    name: toolCall.function.name,
    argumentsText: toolCall.function.arguments,
  };
}
