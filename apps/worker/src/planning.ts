export interface AIClient {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

interface PlanDay {
  day: string;
  focus: string;
  tasks: string[];
}

export interface Plan {
  summary: string;
  weekStart: string;
  days: PlanDay[];
}

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    weekStart: { type: "string" },
    days: {
      type: "array",
      minItems: 1,
      maxItems: 7,
      items: {
        type: "object",
        properties: {
          day: { type: "string" },
          focus: { type: "string" },
          tasks: {
            type: "array",
            items: { type: "string" },
            maxItems: 8,
          },
        },
        required: ["day", "focus", "tasks"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "weekStart", "days"],
  additionalProperties: false,
};

interface PlanContext {
  persona: unknown;
  previousPlan: unknown;
  reflections: Array<{
    text: string;
    mood: number;
    createdAt: number;
  }>;
  request: string;
}

export async function generatePlan(ai: AIClient, model: string, context: PlanContext) {
  const result = await ai.run(model, {
    messages: [
      {
        role: "system",
        content:
          "Create a realistic seven-day plan from the user's current context. Respect energy and mood, avoid over-scheduling, and never make medical claims.",
      },
      { role: "user", content: JSON.stringify(context) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: PLAN_SCHEMA,
    },
    max_tokens: 900,
    temperature: 0.5,
  });
  return parsePlanResponse(result);
}

export function parsePlanResponse(result: unknown): Plan | null {
  const value = parseObject(unwrapAIResponse(result));
  if (
    !value ||
    typeof value.summary !== "string" ||
    typeof value.weekStart !== "string" ||
    !Array.isArray(value.days) ||
    value.days.length === 0 ||
    value.days.length > 7
  ) {
    return null;
  }

  const days: PlanDay[] = [];
  for (const candidate of value.days) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.day !== "string" ||
      typeof candidate.focus !== "string" ||
      !Array.isArray(candidate.tasks) ||
      !candidate.tasks.every((task: unknown) => typeof task === "string")
    ) {
      return null;
    }
    days.push({
      day: candidate.day,
      focus: candidate.focus,
      tasks: candidate.tasks,
    });
  }

  return {
    summary: value.summary,
    weekStart: value.weekStart,
    days,
  };
}

function unwrapAIResponse(result: unknown): unknown {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return null;
  const response = result as Record<string, unknown>;
  return (
    response.response ??
    response.output_text ??
    response.text ??
    response.result ??
    null
  );
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (isObject(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? trimmed;
  try {
    const parsed: unknown = JSON.parse(fenced);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
