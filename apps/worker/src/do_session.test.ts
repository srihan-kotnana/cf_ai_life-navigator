import { describe, expect, it, vi } from "vitest";
import { SessionDO } from "./do_session";

const SAMPLE_PLAN = {
  summary: "A refreshed plan.",
  weekStart: "Monday",
  days: [{ day: "Monday", focus: "Focus", tasks: ["One important task"] }],
};

class MemoryStorage {
  values = new Map<string, unknown>();
  alarmTime: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown) {
    this.values.set(key, value);
  }

  async deleteAll() {
    this.values.clear();
  }

  async getAlarm() {
    return this.alarmTime;
  }

  async setAlarm(timestamp: number) {
    this.alarmTime = timestamp;
  }

  async deleteAlarm() {
    this.alarmTime = null;
  }
}

function createSession(aiResponses: unknown[] = []) {
  const storage = new MemoryStorage();
  const state = { storage } as unknown as DurableObjectState;
  const run = vi.fn(async (_model: string, _input: Record<string, unknown>) =>
    aiResponses.shift(),
  );
  const query = vi.fn(async () => ({ matches: [], count: 0 }));
  const deleteByIds = vi.fn(async () => ({ mutationId: "delete" }));
  const env = {
    AI: { run },
    MODEL: "test-model",
    VECTOR_INDEX: { query, deleteByIds },
  } as unknown as ConstructorParameters<typeof SessionDO>[1];
  return {
    session: new SessionDO(state, env),
    storage,
    run,
    query,
    deleteByIds,
  };
}

function reflectionRequest(id: string, createdAt: number) {
  return new Request("https://do/record-reflection", {
    method: "POST",
    body: JSON.stringify({
      id,
      namespace: "u_test",
      text: `reflection ${id}`,
      mood: 0.5,
      createdAt,
    }),
  });
}

describe("SessionDO privacy lifecycle", () => {
  it("expires reflections older than 90 days", async () => {
    const { session } = createSession();
    const now = Date.now();
    await session.fetch(reflectionRequest("old", now - 91 * 24 * 60 * 60 * 1_000));
    const response = await session.fetch(reflectionRequest("current", now));
    expect(await response.json()).toEqual({ pendingVectorIds: ["old"] });
  });

  it("caps reflection records and returns all IDs during deletion", async () => {
    const { session, storage } = createSession();
    const now = Date.now();
    let expired: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      const response = await session.fetch(
        reflectionRequest(`reflection-${index}`, now + index),
      );
      expired = ((await response.json()) as { pendingVectorIds: string[] })
        .pendingVectorIds;
    }
    expect(expired).toEqual(["reflection-0"]);

    const exported = await session.fetch(
      new Request("https://do/export", { method: "GET" }),
    );
    const exportBody = (await exported.json()) as { reflections: unknown[] };
    expect(exportBody.reflections).toHaveLength(50);

    const vectorIds = await session.fetch(
      new Request("https://do/vector-ids", { method: "GET" }),
    );
    const vectorBody = (await vectorIds.json()) as { vectorIds: string[] };
    expect(vectorBody.vectorIds).toHaveLength(51);

    await session.fetch(
      new Request("https://do/ack-vector-deletes", {
        method: "POST",
        body: JSON.stringify({ ids: ["reflection-0"] }),
      }),
    );
    const acknowledged = await session.fetch(
      new Request("https://do/vector-ids", { method: "GET" }),
    );
    expect(
      ((await acknowledged.json()) as { vectorIds: string[] }).vectorIds,
    ).toHaveLength(50);

    await session.fetch(new Request("https://do/reset", { method: "DELETE" }));
    expect(storage.alarmTime).toBeNull();

    const loaded = await session.fetch(new Request("https://do/load"));
    expect(((await loaded.json()) as { reflections: unknown[] }).reflections).toEqual(
      [],
    );
  });

  it("refreshes the plan through a per-user alarm and reschedules", async () => {
    const { session, storage, query } = createSession([
      { data: [[0.2, 0.4]] },
      { response: SAMPLE_PLAN },
    ]);
    const now = Date.now();
    await session.fetch(reflectionRequest("reflection-for-plan", now));
    expect(storage.alarmTime).toBeGreaterThan(now);

    await session.alarm();

    expect(query).toHaveBeenCalledWith(
      [0.2, 0.4],
      expect.objectContaining({ namespace: "u_test" }),
    );
    expect(storage.values.get("plan")).toEqual(SAMPLE_PLAN);
    expect(storage.alarmTime).toBeGreaterThan(Date.now());
  });
});
