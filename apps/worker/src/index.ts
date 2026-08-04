import { SessionDO } from "./do_session";

type MessageKind = "reflection" | "plan_request" | "other";

interface Intent {
  kind: MessageKind;
  mood: number;
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

interface AIClient {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  AI: AIClient;
  MODEL: string;
  VECTOR_INDEX: VectorizeIndex;
  SESSION_DO: DurableObjectNamespace;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["reflection", "plan_request", "other"],
    },
    mood: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
  },
  required: ["kind", "mood"],
  additionalProperties: false,
};

const PLAN_SCHEMA = {
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

const SYSTEM = `You are a pragmatic, conversational planner.
Respond naturally in plain-text paragraphs. Be concrete and realistic.
Do not claim to provide medical or mental-health treatment.`;

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function unwrapAIResponse(result: unknown): unknown {
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

export function getAIText(result: unknown): string {
  const value = unwrapAIResponse(result);
  return typeof value === "string" ? value.trim() : "";
}

export function parseIntentResponse(result: unknown): Intent {
  const parsed = parseObject(unwrapAIResponse(result));
  const kinds: MessageKind[] = ["reflection", "plan_request", "other"];
  const kind = kinds.includes(parsed?.kind as MessageKind)
    ? (parsed?.kind as MessageKind)
    : "other";
  const mood =
    typeof parsed?.mood === "number" && Number.isFinite(parsed.mood)
      ? Math.min(1, Math.max(0, parsed.mood))
      : 0.5;

  return { kind, mood };
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

async function handleMessage(req: Request, env: Env) {
  const { text, sessionId } = await readMessage(req);
  const id = env.SESSION_DO.idFromName(sessionId);
  const stub = env.SESSION_DO.get(id);
  const state = (await (await stub.fetch("https://do/load")).json()) as {
    persona: unknown;
    plan: unknown;
  };

  const classification = await env.AI.run(env.MODEL, {
    messages: [
      {
        role: "system",
        content:
          "Classify the request as a reflection, plan request, or other message.",
      },
      { role: "user", content: text },
    ],
    response_format: {
      type: "json_schema",
      json_schema: INTENT_SCHEMA,
    },
    max_tokens: 80,
    temperature: 0,
  });

  const intent = parseIntentResponse(classification);

  if (intent.kind === "reflection") {
    const embedding = (await env.AI.run("@cf/baai/bge-large-en-v1.5", {
      text,
    })) as { data?: number[][] };
    const values = embedding.data?.[0];
    if (!values) {
      throw new HttpError(
        502,
        "embedding_failed",
        "The reflection could not be saved right now.",
      );
    }

    await env.VECTOR_INDEX.upsert([
      {
        id: crypto.randomUUID(),
        values,
        metadata: { ts: Date.now(), mood: intent.mood, sessionId },
      },
    ]);

    const persona = isObject(state.persona) ? state.persona : {};
    await stub.fetch("https://do/save-persona", {
      method: "POST",
      body: JSON.stringify({ ...persona, mood: labelMood(intent.mood) }),
    });

    return json({
      kind: "reflection",
      text: "Got it — I’ve noted that reflection.",
    });
  }

  if (intent.kind === "plan_request") {
    const result = await env.AI.run(env.MODEL, {
      messages: [
        {
          role: "system",
          content:
            "Create a realistic plan from the supplied persona, previous plan, and request.",
        },
        {
          role: "user",
          content: JSON.stringify({
            persona: state.persona,
            previousPlan: state.plan,
            request: text,
          }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: PLAN_SCHEMA,
      },
      max_tokens: 900,
      temperature: 0.5,
    });

    const plan = parsePlanResponse(result);
    if (!plan) {
      throw new HttpError(
        502,
        "invalid_plan",
        "The planner returned an invalid plan. Please try again.",
      );
    }

    await stub.fetch("https://do/save-plan", {
      method: "POST",
      body: JSON.stringify(plan),
    });

    return json({
      kind: "plan_request",
      text: plan.summary,
      plan,
    });
  }

  const chatReply = await env.AI.run(env.MODEL, {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: text },
    ],
    max_tokens: 400,
    temperature: 0.7,
  });
  const replyText = getAIText(chatReply);
  if (!replyText) {
    throw new HttpError(
      502,
      "empty_ai_response",
      "The assistant did not return a response. Please try again.",
    );
  }

  return json({ kind: "other", text: replyText });
}

async function handleRequest(req: Request, env: Env) {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/api/message") {
    return handleMessage(req, env);
  }

  if (req.method === "GET" && url.pathname === "/api/plan") {
    const sessionId = validateSessionId(
      url.searchParams.get("sessionId") ?? "demo-user",
    );
    const id = env.SESSION_DO.idFromName(sessionId);
    const stub = env.SESSION_DO.get(id);
    const state = (await (await stub.fetch("https://do/load")).json()) as {
      plan?: unknown;
    };
    return json(state.plan ?? { note: "No plan yet. Ask for one to get started." });
  }

  if (url.pathname.startsWith("/api/")) {
    throw new HttpError(404, "not_found", "API route not found.");
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(req: Request, env: Env) {
    try {
      return await handleRequest(req, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.code, message: error.message }, error.status);
      }

      console.error("Unhandled request error", error);
      return json(
        {
          error: "internal_error",
          message: "The request could not be completed.",
        },
        500,
      );
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    console.log("Running scheduled plan refresh");

    const sessionId = "demo-user";
    const id = env.SESSION_DO.idFromName(sessionId);
    const stub = env.SESSION_DO.get(id);
    const { persona, plan } = (await (
      await stub.fetch("https://do/load")
    ).json()) as { persona: unknown; plan: unknown };

    // Phase 3 will replace this placeholder retrieval with embedded, user-scoped
    // reflection recall and configure the scheduler that invokes this handler.
    const result = await env.AI.run(env.MODEL, {
      messages: [
        {
          role: "system",
          content: "Refresh the user's practical seven-day plan.",
        },
        {
          role: "user",
          content: JSON.stringify({ persona, previousPlan: plan }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: PLAN_SCHEMA,
      },
      max_tokens: 900,
      temperature: 0.5,
    });

    const refreshedPlan = parsePlanResponse(result);
    if (!refreshedPlan) {
      console.error("Scheduled planner returned an invalid plan");
      return;
    }

    await stub.fetch("https://do/save-plan", {
      method: "POST",
      body: JSON.stringify(refreshedPlan),
    });
  },
};

async function readMessage(req: Request) {
  if (!req.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }

  if (!isObject(body) || typeof body.text !== "string") {
    throw new HttpError(400, "invalid_text", "A text message is required.");
  }

  const text = body.text.trim();
  if (!text || text.length > 4_000) {
    throw new HttpError(
      400,
      "invalid_text",
      "Text must contain between 1 and 4,000 characters.",
    );
  }

  const sessionId = validateSessionId(
    typeof body.sessionId === "string" ? body.sessionId : "demo-user",
  );
  return { text, sessionId };
}

function validateSessionId(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new HttpError(
      400,
      "invalid_session",
      "Session ID contains unsupported characters.",
    );
  }
  return value;
}

function parseObject(value: unknown): Record<string, any> | null {
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

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function labelMood(value: number) {
  if (value < 0.3) return "low";
  if (value < 0.7) return "ok";
  return "high";
}

export { SessionDO };
