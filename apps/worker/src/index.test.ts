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

interface StoredReflection extends Record<string, unknown> {
  id: string;
}

interface TestState {
  persona: Record<string, unknown>;
  plan: unknown;
  reflections: StoredReflection[];
}

function createEnvironment(
  aiResponses: unknown[],
  options: {
    allowApi?: boolean;
    allowAi?: boolean;
    recordReflectionStatus?: number;
  } = {},
) {
  let state: TestState = {
    persona: { mood: "neutral" },
    plan: null,
    reflections: [],
  };

  const stub = {
    async fetch(input: string | Request, init?: RequestInit) {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/load") return Response.json(state);
      if (url.pathname === "/export") {
        return Response.json({ ...state, exportedAt: new Date().toISOString() });
      }
      if (url.pathname === "/reset") {
        state = { persona: { mood: "neutral" }, plan: null, reflections: [] };
        return Response.json({ ok: true });
      }
      if (url.pathname === "/vector-ids") {
        return Response.json({
          vectorIds: state.reflections.map((item: { id: string }) => item.id),
        });
      }

      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.pathname === "/save-persona") state.persona = body;
      if (url.pathname === "/save-plan") state.plan = body;
      if (url.pathname === "/record-reflection") {
        if (options.recordReflectionStatus) {
          return Response.json(
            { error: "persistence_failed" },
            { status: options.recordReflectionStatus },
          );
        }
        state.reflections.push(body as StoredReflection);
        return Response.json({ pendingVectorIds: [] });
      }
      return Response.json({ ok: true });
    },
  };

  const run = vi.fn(async (_model: string, _input: Record<string, unknown>) =>
    aiResponses.shift(),
  );
  const upsert = vi.fn(async (_vectors: VectorizeVector[]) => ({
    mutationId: "upsert",
  }));
  const deleteByIds = vi.fn(async (_ids: string[]) => ({
    mutationId: "delete",
  }));
  const query = vi.fn(async () => ({
    matches: state.reflections.map((item: { id: string }) => ({
      id: item.id,
      score: 0.9,
    })),
    count: state.reflections.length,
  }));
  const idFromName = vi.fn((_name: string) => "test-id");
  const apiLimit = vi.fn(async () => ({ success: options.allowApi ?? true }));
  const aiLimit = vi.fn(async () => ({ success: options.allowAi ?? true }));
  const env = {
    AUTH_MODE: "development",
    DEV_USER_ID: "test-user",
    AI: { run },
    MODEL: "test-model",
    VECTOR_INDEX: { upsert, deleteByIds, query },
    API_RATE_LIMITER: { limit: apiLimit },
    AI_RATE_LIMITER: { limit: aiLimit },
    SESSION_DO: {
      idFromName,
      get: vi.fn(() => stub),
    },
  } as unknown as Env;

  return {
    env,
    run,
    upsert,
    deleteByIds,
    query,
    idFromName,
    apiLimit,
    aiLimit,
    getState: () => state,
  };
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

describe("authenticated message API", () => {
  it("isolates reflection vectors with the authenticated user ID", async () => {
    const { env, upsert, idFromName, getState } = createEnvironment([
      { response: { kind: "reflection", mood: 0.1 } },
      { data: [[0.1, 0.2]] },
    ]);

    const response = await worker.fetch(
      postMessage({ text: "I felt drained today", sessionId: "attacker" }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "reflection" });
    const userId = idFromName.mock.calls[0][0];
    expect(userId).toMatch(/^u_[A-Za-z0-9_-]{43}$/);
    expect(userId).not.toBe("attacker");
    expect(upsert.mock.calls[0][0][0]).toMatchObject({ namespace: userId });
    expect(getState().persona).toMatchObject({ mood: "low" });
  });

  it("removes a new vector when Durable Object persistence fails", async () => {
    const context = createEnvironment(
      [{ response: { kind: "reflection", mood: 0.1 } }, { data: [[0.1, 0.2]] }],
      { recordReflectionStatus: 503 },
    );

    const response = await worker.fetch(
      postMessage({ text: "This write should be compensated" }),
      context.env,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "reflection_persistence_failed",
      message: "The reflection could not be saved right now.",
    });
    const vectorId = context.upsert.mock.calls[0][0][0].id;
    expect(context.deleteByIds).toHaveBeenCalledWith([vectorId]);
    expect(context.getState().reflections).toEqual([]);
    expect(context.getState().persona).toEqual({ mood: "neutral" });
  });

  it("generates and saves a schema-backed plan", async () => {
    const { env, getState } = createEnvironment([
      { response: { kind: "plan_request", mood: 0.5 } },
      { response: SAMPLE_PLAN },
    ]);
    const response = await worker.fetch(postMessage({ text: "Plan my week" }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "plan_request",
      text: SAMPLE_PLAN.summary,
      plan: SAMPLE_PLAN,
    });
    expect(getState().plan).toEqual(SAMPLE_PLAN);
  });

  it("retrieves the user's reflection text for plan generation", async () => {
    const context = createEnvironment([
      { response: { kind: "reflection", mood: 0.3 } },
      { data: [[0.1, 0.2]] },
      { response: { kind: "plan_request", mood: 0.5 } },
      { data: [[0.3, 0.4]] },
      { response: SAMPLE_PLAN },
    ]);

    await worker.fetch(
      postMessage({ text: "I need time for a private family commitment" }),
      context.env,
    );
    const planResponse = await worker.fetch(
      postMessage({ text: "Plan around my commitments" }),
      context.env,
    );

    expect(planResponse.status).toBe(200);
    expect(context.query).toHaveBeenCalledWith(
      [0.3, 0.4],
      expect.objectContaining({ namespace: expect.stringMatching(/^u_/) }),
    );
    expect(JSON.stringify(context.run.mock.calls[4]?.[1])).toContain(
      "private family commitment",
    );
  });

  it("returns normalized conversational replies", async () => {
    const { env } = createEnvironment([
      { response: { kind: "other", mood: 0.5 } },
      { response: "Let’s work through that together." },
    ]);
    const response = await worker.fetch(postMessage({ text: "Help me think" }), env);
    expect(await response.json()).toEqual({
      kind: "other",
      text: "Let’s work through that together.",
    });
  });

  it("fails closed when production authentication is not configured", async () => {
    const { env } = createEnvironment([]);
    env.AUTH_MODE = "access";
    delete env.TEAM_DOMAIN;
    delete env.POLICY_AUD;

    const response = await worker.fetch(
      new Request("https://example.com/api/plan"),
      env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "auth_not_configured" });
  });

  it("requires a Cloudflare Access JWT in access mode", async () => {
    const { env } = createEnvironment([]);
    env.AUTH_MODE = "access";
    env.TEAM_DOMAIN = "https://example.cloudflareaccess.com";
    env.POLICY_AUD = "audience";

    const response = await worker.fetch(
      new Request("https://example.com/api/plan"),
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "authentication_required",
    });
  });

  it("enforces general and AI-specific per-user rate limits", async () => {
    const general = createEnvironment([], { allowApi: false });
    const generalResponse = await worker.fetch(
      new Request("https://example.com/api/plan"),
      general.env,
    );
    expect(generalResponse.status).toBe(429);
    expect(generalResponse.headers.get("retry-after")).toBe("60");

    const ai = createEnvironment([], { allowAi: false });
    const aiResponse = await worker.fetch(postMessage({ text: "hello" }), ai.env);
    expect(aiResponse.status).toBe(429);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("exports and deletes only the authenticated user's stored data", async () => {
    const context = createEnvironment([
      { response: { kind: "reflection", mood: 0.4 } },
      { data: [[0.1, 0.2]] },
    ]);
    await worker.fetch(postMessage({ text: "A private reflection" }), context.env);
    const vectorId = context.upsert.mock.calls[0][0][0].id;

    const exported = await worker.fetch(
      new Request("https://example.com/api/data"),
      context.env,
    );
    expect(exported.status).toBe(200);
    expect(
      ((await exported.json()) as { reflections: unknown[] }).reflections,
    ).toHaveLength(1);

    const deleted = await worker.fetch(
      new Request("https://example.com/api/data", { method: "DELETE" }),
      context.env,
    );
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(context.deleteByIds).toHaveBeenCalledWith([vectorId]);
    expect(context.getState().reflections).toEqual([]);
  });

  it("keeps storage intact when vector deletion fails so deletion can be retried", async () => {
    const context = createEnvironment([
      { response: { kind: "reflection", mood: 0.4 } },
      { data: [[0.1, 0.2]] },
    ]);
    await worker.fetch(
      postMessage({ text: "Keep this until deletion succeeds" }),
      context.env,
    );
    context.deleteByIds.mockRejectedValueOnce(new Error("temporary failure"));

    const failed = await worker.fetch(
      new Request("https://example.com/api/data", { method: "DELETE" }),
      context.env,
    );
    expect(failed.status).toBe(500);
    expect(context.getState().reflections).toHaveLength(1);

    const retried = await worker.fetch(
      new Request("https://example.com/api/data", { method: "DELETE" }),
      context.env,
    );
    expect(retried.status).toBe(200);
    expect(context.getState().reflections).toEqual([]);
  });

  it("returns explicit validation and routing errors", async () => {
    const { env } = createEnvironment([]);
    const invalidJson = await worker.fetch(postMessage("{"), env);
    expect(invalidJson.status).toBe(400);
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
