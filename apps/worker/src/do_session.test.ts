import { describe, expect, it } from "vitest";
import { SessionDO } from "./do_session";

class MemoryStorage {
  values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown) {
    this.values.set(key, value);
  }

  async deleteAll() {
    this.values.clear();
  }
}

function createSession() {
  const storage = new MemoryStorage();
  const state = { storage } as unknown as DurableObjectState;
  return { session: new SessionDO(state), storage };
}

function reflectionRequest(id: string, createdAt: number) {
  return new Request("https://do/record-reflection", {
    method: "POST",
    body: JSON.stringify({ id, createdAt }),
  });
}

describe("SessionDO privacy lifecycle", () => {
  it("expires reflections older than 90 days", async () => {
    const { session } = createSession();
    const now = Date.now();
    await session.fetch(
      reflectionRequest("old", now - 91 * 24 * 60 * 60 * 1_000),
    );
    const response = await session.fetch(reflectionRequest("current", now));
    expect(await response.json()).toEqual({ pendingVectorIds: ["old"] });
  });

  it("caps reflection records and returns all IDs during deletion", async () => {
    const { session } = createSession();
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

    const loaded = await session.fetch(new Request("https://do/load"));
    expect(((await loaded.json()) as { reflections: unknown[] }).reflections).toEqual(
      [],
    );
  });
});
