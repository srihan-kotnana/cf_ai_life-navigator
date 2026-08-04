import { describe, expect, it, vi } from "vitest";
import worker, {
  getAIText,
  parseIntentResponse,
  parsePlanResponse,
  type Env,
} from "./index";

const SAMPLE_PLAN = {
  summary: "A balanced week with three focused priorities.",
  weekStart: "Monday",
  days: [
    {
      day: "Monday",
      focus: "Start deliberately",
      tasks: ["Review priorities", "Take a short walk"],
    },
  ],
};

function createEnvironment(aiResponses: unknown[]) {
  let state: Record<string, unknown> = {
    persona: { mood: "neutral" },
    plan: null,
  };

  const stub = {
    async fetch(input: string | Request, init?: RequestInit) {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/load") return Response.json(state);

      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.pathname === "/save-persona") state.persona = body;
      if (url.pathname === "/save-plan") state.plan = body;
      return Response.json({ ok: true });
    },
  };

  const run = vi.fn(async () => aiResponses.shift());
  const upsert = vi.fn(async () => ({ count: 1 }));
  const env = {
    AI: { run },
    MODEL: "test-model",
    VECTOR_INDEX: { upsert },
    SESSION_DO: {
      idFromName: vi.fn(() => "test-id"),
      get: vi.fn(() => stub),
    },
  } as unknown as Env;

  return { env, run, upsert, getState: () => state };
}

function postMessage(body: unknown, contentType = "application/json") {
  return new Request("https://example.com/api/message", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("AI response parsing", () => {
  it("normalizes Workers AI response text", () => {
    expect(getAIText({ response: "  hello  " })).toBe("hello");
    expect(getAIText({ output_text: "fallback" })).toBe("fallback");
    expect(getAIText("direct")).toBe("direct");
  });

  it("accepts object and JSON-string intent responses", () => {
    expect(
      parseIntentResponse({ response: { kind: "reflection", mood: 0.2 } }),
    ).toEqual({ kind: "reflection", mood: 0.2 });
    expect(
      parseIntentResponse({
        response: '{"kind":"plan_request","mood":0.8}',
      }),
    ).toEqual({ kind: "plan_request", mood: 0.8 });
  });

  it("rejects malformed plans", () => {
    expect(parsePlanResponse({ response: SAMPLE_PLAN })).toEqual(SAMPLE_PLAN);
    expect(parsePlanResponse({ response: { weekStart: "Monday" } })).toBeNull();
  });
});

describe("message API", () => {
  it("stores a reflection when the classifier returns reflection", async () => {
    const { env, upsert, getState } = createEnvironment([
      { response: { kind: "reflection", mood: 0.1 } },
      { data: [[0.1, 0.2]] },
    ]);

    const response = await worker.fetch(
      postMessage({ text: "I felt drained today", sessionId: "person-1" }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "reflection" });
    expect(upsert).toHaveBeenCalledOnce();
    expect(getState().persona).toMatchObject({ mood: "low" });
  });

  it("generates and saves a schema-backed plan", async () => {
    const { env, getState } = createEnvironment([
      { response: { kind: "plan_request", mood: 0.5 } },
      { response: SAMPLE_PLAN },
    ]);

    const response = await worker.fetch(
      postMessage({ text: "Plan my week", sessionId: "person-1" }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "plan_request",
      text: SAMPLE_PLAN.summary,
      plan: SAMPLE_PLAN,
    });
    expect(getState().plan).toEqual(SAMPLE_PLAN);
  });

  it("returns normalized conversational replies", async () => {
    const { env } = createEnvironment([
      { response: { kind: "other", mood: 0.5 } },
      { response: "Let’s work through that together." },
    ]);

    const response = await worker.fetch(
      postMessage({ text: "Help me think", sessionId: "person-1" }),
      env,
    );

    expect(await response.json()).toEqual({
      kind: "other",
      text: "Let’s work through that together.",
    });
  });

  it("returns explicit validation and routing errors", async () => {
    const { env } = createEnvironment([]);

    const invalidJson = await worker.fetch(postMessage("{"), env);
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ error: "invalid_json" });

    const wrongType = await worker.fetch(
      postMessage({ text: "hello" }, "text/plain"),
      env,
    );
    expect(wrongType.status).toBe(415);

    const missingRoute = await worker.fetch(
      new Request("https://example.com/api/missing"),
      env,
    );
    expect(missingRoute.status).toBe(404);
  });
});
