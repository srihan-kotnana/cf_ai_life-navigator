import { retrieveRelevantReflections, type ReflectionMemoryRecord } from "./memory";
import { generatePlan, type AIClient } from "./planning";

const MAX_REFLECTIONS = 50;
const REFLECTION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const PLAN_REFRESH_MS = 24 * 60 * 60 * 1_000;
const RETRY_REFRESH_MS = 15 * 60 * 1_000;

interface SessionEnv {
  AI: AIClient;
  MODEL: string;
  VECTOR_INDEX: VectorizeIndex;
}

export class SessionDO {
  state: DurableObjectState;
  storage: DurableObjectStorage;
  env: SessionEnv;

  constructor(state: DurableObjectState, env: SessionEnv) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
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
      const body = (await req.json()) as Partial<ReflectionMemoryRecord>;
      if (!isReflectionInput(body)) {
        return Response.json({ error: "invalid_record" }, { status: 400 });
      }

      const records = await this.getReflectionRecords();
      const existingNamespace = records.find((record) => record.namespace)?.namespace;
      if (existingNamespace && existingNamespace !== body.namespace) {
        return Response.json({ error: "namespace_mismatch" }, { status: 409 });
      }

      const { retained, expiredIds } = pruneRecords(records, Date.now());
      retained.push({
        id: body.id,
        namespace: body.namespace,
        text: body.text,
        mood: body.mood,
        createdAt: body.createdAt,
      });
      retained.sort((left, right) => left.createdAt - right.createdAt);
      while (retained.length > MAX_REFLECTIONS) {
        const expired = retained.shift();
        if (expired) expiredIds.push(expired.id);
      }

      await this.storage.put("reflectionRecords", retained);
      const pendingVectorIds = await this.queueVectorDeletes(expiredIds);
      await this.ensureAlarmScheduled();
      return Response.json({ pendingVectorIds });
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
        vectorIds: [...new Set([...records.map((record) => record.id), ...pending])],
      });
    }

    if (req.method === "GET" && url.pathname.endsWith("/export")) {
      const state = await this.loadState();
      return Response.json({
        persona: state.persona,
        plan: state.plan,
        reflections: state.reflections.map(({ text, mood, createdAt }) => ({
          text,
          mood,
          createdAt,
        })),
        privacy: {
          reflectionRetentionDays: 90,
          maximumStoredReflections: MAX_REFLECTIONS,
        },
        exportedAt: new Date().toISOString(),
      });
    }

    if (req.method === "DELETE" && url.pathname.endsWith("/reset")) {
      await this.storage.deleteAlarm();
      await this.storage.deleteAll();
      return Response.json({ ok: true });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async alarm() {
    let nextDelay = PLAN_REFRESH_MS;
    try {
      const allRecords = await this.getReflectionRecords();
      const { retained, expiredIds } = pruneRecords(allRecords, Date.now());
      await this.storage.put("reflectionRecords", retained);
      await this.queueVectorDeletes(expiredIds);
      await this.flushPendingVectorDeletes();

      const usableRecords = retained.filter((record) =>
        Boolean(record.namespace && record.text),
      );
      if (usableRecords.length === 0) {
        await this.storage.deleteAlarm();
        return;
      }

      const state = await this.loadState();
      const namespace = usableRecords[0].namespace;
      const reflections = await retrieveRelevantReflections(
        this.env.AI,
        this.env.VECTOR_INDEX,
        namespace,
        "Recent priorities, energy, mood, blockers, habits, and commitments for planning",
        usableRecords,
      );
      const plan = await generatePlan(this.env.AI, this.env.MODEL, {
        persona: state.persona,
        previousPlan: state.plan,
        reflections,
        request: "Refresh my practical seven-day plan using my recent reflections.",
      });
      if (!plan) throw new Error("Scheduled planner returned an invalid plan");
      await this.storage.put("plan", plan);
    } catch (error) {
      console.error("Scheduled plan refresh failed", error);
      nextDelay = RETRY_REFRESH_MS;
    }

    await this.storage.setAlarm(Date.now() + nextDelay);
  }

  private async loadState() {
    const persona = (await this.storage.get("persona")) ?? defaultPersona();
    const plan = (await this.storage.get("plan")) ?? null;
    const reflections = await this.getReflectionRecords();
    return { persona, plan, reflections };
  }

  private async getReflectionRecords(): Promise<ReflectionMemoryRecord[]> {
    const value = await this.storage.get<unknown[]>("reflectionRecords");
    if (!Array.isArray(value)) return [];

    const records: ReflectionMemoryRecord[] = [];
    for (const candidate of value) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      const record = candidate as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        typeof record.createdAt !== "number" ||
        !Number.isFinite(record.createdAt)
      )
        continue;
      records.push({
        id: record.id,
        namespace: typeof record.namespace === "string" ? record.namespace : "",
        text: typeof record.text === "string" ? record.text : "",
        mood:
          typeof record.mood === "number" && Number.isFinite(record.mood)
            ? record.mood
            : 0.5,
        createdAt: record.createdAt,
      });
    }
    return records;
  }

  private async getPendingVectorDeletes(): Promise<string[]> {
    const value = await this.storage.get<unknown[]>("pendingVectorDeletes");
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === "string" && Boolean(id));
  }

  private async queueVectorDeletes(ids: string[]) {
    const pending = [...new Set([...(await this.getPendingVectorDeletes()), ...ids])];
    await this.storage.put("pendingVectorDeletes", pending);
    return pending;
  }

  private async flushPendingVectorDeletes() {
    const pending = await this.getPendingVectorDeletes();
    if (pending.length === 0) return;
    await this.env.VECTOR_INDEX.deleteByIds(pending);
    await this.storage.put("pendingVectorDeletes", []);
  }

  private async ensureAlarmScheduled() {
    if ((await this.storage.getAlarm()) === null) {
      await this.storage.setAlarm(Date.now() + PLAN_REFRESH_MS);
    }
  }
}

function isReflectionInput(
  value: Partial<ReflectionMemoryRecord>,
): value is ReflectionMemoryRecord {
  return (
    typeof value.id === "string" &&
    Boolean(value.id) &&
    typeof value.namespace === "string" &&
    Boolean(value.namespace) &&
    value.namespace.length <= 64 &&
    typeof value.text === "string" &&
    Boolean(value.text.trim()) &&
    value.text.length <= 4_000 &&
    typeof value.mood === "number" &&
    Number.isFinite(value.mood) &&
    value.mood >= 0 &&
    value.mood <= 1 &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt)
  );
}

function pruneRecords(records: ReflectionMemoryRecord[], now: number) {
  const cutoff = now - REFLECTION_RETENTION_MS;
  const retained: ReflectionMemoryRecord[] = [];
  const expiredIds: string[] = [];
  for (const record of records) {
    if (record.createdAt < cutoff) expiredIds.push(record.id);
    else retained.push(record);
  }
  return { retained, expiredIds };
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
