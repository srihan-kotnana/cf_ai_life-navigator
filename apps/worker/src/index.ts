import {
  authenticateRequest,
  AuthError,
  type AuthEnv,
  type AuthenticatedUser,
} from "./auth";
import { SessionDO } from "./do_session";
import {
  EMBEDDING_MODEL,
  retrieveRelevantReflections,
  type ReflectionMemoryRecord,
} from "./memory";
import { generatePlan, parsePlanResponse, type AIClient, type Plan } from "./planning";

type MessageKind = "reflection" | "plan_request" | "other";

interface Intent {
  kind: MessageKind;
  mood: number;
}

export interface Env extends AuthEnv {
  AI: AIClient;
  MODEL: string;
  VECTOR_INDEX: VectorizeIndex;
  SESSION_DO: DurableObjectNamespace;
  API_RATE_LIMITER: RateLimit;
  AI_RATE_LIMITER: RateLimit;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
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
    mood: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["kind", "mood"],
  additionalProperties: false,
};

const SYSTEM = `You are a pragmatic, conversational planner.
Respond naturally in plain-text paragraphs. Be concrete and realistic.
Do not claim to provide medical or mental-health treatment.`;

function json(
  body: unknown,
  status = 200,
  additionalHeaders: Record<string, string> = {},
) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...additionalHeaders,
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

async function handleMessage(req: Request, env: Env, user: AuthenticatedUser) {
  await enforceRateLimit(env.AI_RATE_LIMITER, user.id, "ai");
  const { text } = await readMessage(req);
  const stub = getUserStub(env, user.id);
  const state = (await (await stub.fetch("https://do/load")).json()) as {
    persona: unknown;
    plan: unknown;
    reflections: ReflectionMemoryRecord[];
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
    const embedding = (await env.AI.run(EMBEDDING_MODEL, {
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

    const vectorId = crypto.randomUUID();
    const createdAt = Date.now();
    await env.VECTOR_INDEX.upsert([
      {
        id: vectorId,
        namespace: user.id,
        values,
        metadata: { createdAt, mood: intent.mood },
      },
    ]);

    const recordResult = (await (
      await stub.fetch("https://do/record-reflection", {
        method: "POST",
        body: JSON.stringify({
          id: vectorId,
          namespace: user.id,
          text,
          mood: intent.mood,
          createdAt,
        }),
      })
    ).json()) as { pendingVectorIds?: string[] };
    if (recordResult.pendingVectorIds?.length) {
      await env.VECTOR_INDEX.deleteByIds(recordResult.pendingVectorIds);
      await stub.fetch("https://do/ack-vector-deletes", {
        method: "POST",
        body: JSON.stringify({ ids: recordResult.pendingVectorIds }),
      });
    }

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
    const reflections = await retrieveRelevantReflections(
      env.AI,
      env.VECTOR_INDEX,
      user.id,
      text,
      state.reflections,
    );
    const plan = await generatePlan(env.AI, env.MODEL, {
      persona: state.persona,
      previousPlan: state.plan,
      reflections,
      request: text,
    });
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
    return json({ kind: "plan_request", text: plan.summary, plan });
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
  if (!url.pathname.startsWith("/api/")) {
    return new Response("Not found", { status: 404 });
  }

  const user = await authenticateRequest(req, env);
  await enforceRateLimit(env.API_RATE_LIMITER, user.id, "api");

  if (req.method === "POST" && url.pathname === "/api/message") {
    return handleMessage(req, env, user);
  }

  if (req.method === "GET" && url.pathname === "/api/plan") {
    const state = (await (
      await getUserStub(env, user.id).fetch("https://do/load")
    ).json()) as { plan?: unknown };
    return json(state.plan ?? { note: "No plan yet. Ask for one to get started." });
  }

  if (req.method === "GET" && url.pathname === "/api/data") {
    const response = await getUserStub(env, user.id).fetch("https://do/export");
    return json(await response.json());
  }

  if (req.method === "DELETE" && url.pathname === "/api/data") {
    const stub = getUserStub(env, user.id);
    const snapshot = (await (await stub.fetch("https://do/vector-ids")).json()) as {
      vectorIds?: string[];
    };
    if (snapshot.vectorIds?.length) {
      await env.VECTOR_INDEX.deleteByIds(snapshot.vectorIds);
    }
    await stub.fetch("https://do/reset", { method: "DELETE" });
    return json({ deleted: true });
  }

  throw new HttpError(404, "not_found", "API route not found.");
}

export default {
  async fetch(req: Request, env: Env) {
    try {
      return await handleRequest(req, env);
    } catch (error) {
      if (error instanceof AuthError || error instanceof HttpError) {
        return json(
          { error: error.code, message: error.message },
          error.status,
          error instanceof HttpError ? error.headers : {},
        );
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
};

function getUserStub(env: Env, userId: string) {
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(userId));
}

async function enforceRateLimit(
  limiter: RateLimit | undefined,
  userId: string,
  scope: string,
) {
  if (!limiter) {
    throw new HttpError(
      503,
      "rate_limit_not_configured",
      "Request protection is not configured.",
    );
  }
  const { success } = await limiter.limit({ key: `${scope}:${userId}` });
  if (!success) {
    throw new HttpError(
      429,
      "rate_limited",
      "Too many requests. Please wait before trying again.",
      { "retry-after": "60" },
    );
  }
}

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
  return { text };
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

function labelMood(value: number) {
  if (value < 0.3) return "low";
  if (value < 0.7) return "ok";
  return "high";
}

export { parsePlanResponse, SessionDO };
export type { Plan };
