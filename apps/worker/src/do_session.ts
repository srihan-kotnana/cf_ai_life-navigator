const MAX_REFLECTIONS = 50;
const REFLECTION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

interface ReflectionRecord {
  id: string;
  createdAt: number;
}

export class SessionDO {
  state: DurableObjectState;
  storage: DurableObjectStorage;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(req: Request) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname.endsWith("/load")) {
      return Response.json(await this.loadState());
    }

    if (req.method === "POST" && url.pathname.endsWith("/save-persona")) {
      await this.storage.put("persona", await req.json());
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && url.pathname.endsWith("/save-plan")) {
      await this.storage.put("plan", await req.json());
      return Response.json({ ok: true });
    }

    if (req.method === "POST" && url.pathname.endsWith("/record-reflection")) {
      const body = (await req.json()) as Partial<ReflectionRecord>;
      if (
        typeof body.id !== "string" ||
        !body.id ||
        typeof body.createdAt !== "number" ||
        !Number.isFinite(body.createdAt)
      ) {
        return Response.json({ error: "invalid_record" }, { status: 400 });
      }

      const records = await this.getReflectionRecords();
      const cutoff = Date.now() - REFLECTION_RETENTION_MS;
      const retained: ReflectionRecord[] = [];
      const expiredVectorIds: string[] = [];

      for (const record of records) {
        if (record.createdAt < cutoff) expiredVectorIds.push(record.id);
        else retained.push(record);
      }

      retained.push({ id: body.id, createdAt: body.createdAt });
      retained.sort((left, right) => left.createdAt - right.createdAt);
      while (retained.length > MAX_REFLECTIONS) {
        const expired = retained.shift();
        if (expired) expiredVectorIds.push(expired.id);
      }

      await this.storage.put("reflectionRecords", retained);
      const pendingVectorIds = [
        ...new Set([
          ...(await this.getPendingVectorDeletes()),
          ...expiredVectorIds,
        ]),
      ];
      await this.storage.put("pendingVectorDeletes", pendingVectorIds);
      return Response.json({
        pendingVectorIds,
      });
    }

    if (req.method === "POST" && url.pathname.endsWith("/ack-vector-deletes")) {
      const body = (await req.json()) as { ids?: unknown };
      if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) {
        return Response.json({ error: "invalid_ids" }, { status: 400 });
      }
      const acknowledged = new Set(body.ids);
      const pending = (await this.getPendingVectorDeletes()).filter(
        (id) => !acknowledged.has(id),
      );
      await this.storage.put("pendingVectorDeletes", pending);
      return Response.json({ ok: true });
    }

    if (req.method === "GET" && url.pathname.endsWith("/vector-ids")) {
      const records = await this.getReflectionRecords();
      const pending = await this.getPendingVectorDeletes();
      return Response.json({
        vectorIds: [
          ...new Set([...records.map((record) => record.id), ...pending]),
        ],
      });
    }

    if (req.method === "GET" && url.pathname.endsWith("/export")) {
      const state = await this.loadState();
      return Response.json({
        persona: state.persona,
        plan: state.plan,
        reflections: state.reflections.map((record) => ({
          createdAt: record.createdAt,
        })),
        privacy: {
          reflectionRetentionDays: 90,
          maximumStoredReflections: MAX_REFLECTIONS,
        },
        exportedAt: new Date().toISOString(),
      });
    }

    if (req.method === "DELETE" && url.pathname.endsWith("/reset")) {
      await this.storage.deleteAll();
      return Response.json({ ok: true });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async loadState() {
    const persona =
      (await this.storage.get("persona")) ?? defaultPersona();
    const plan = (await this.storage.get("plan")) ?? null;
    const reflections = await this.getReflectionRecords();
    return { persona, plan, reflections };
  }

  private async getReflectionRecords(): Promise<ReflectionRecord[]> {
    const value = await this.storage.get<ReflectionRecord[]>("reflectionRecords");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (record) =>
        record &&
        typeof record.id === "string" &&
        typeof record.createdAt === "number" &&
        Number.isFinite(record.createdAt),
    );
  }

  private async getPendingVectorDeletes(): Promise<string[]> {
    const value = await this.storage.get<unknown[]>("pendingVectorDeletes");
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === "string" && Boolean(id));
  }
}

function defaultPersona() {
  return {
    energy: 0.5,
    focus: 0.5,
    mood: "neutral",
    goals: [],
    preferences: {},
  };
}
