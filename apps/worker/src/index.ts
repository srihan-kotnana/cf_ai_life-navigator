import { SessionDO } from "./do_session";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: any, status = 200) {
  const headers = new Headers({ "content-type": "application/json", ...CORS });
  return new Response(JSON.stringify(body), { status, headers });
}

export interface Env {
  AI: any;
  MODEL: string;
  VECTOR_INDEX: VectorizeIndex;
  SESSION_DO: DurableObjectNamespace<typeof SessionDO>;
}

const SYSTEM = `you are a pragmatic, conversational planner.
respond naturally in plain text paragraphs — not JSON or code unless explicitly asked.
if you include a structured plan, put it at the end in a code block like:
\`\`\`json
{ "weekStart": "Monday", "days": [...] }
\`\`\`
otherwise just respond conversationally.`;

export default {
  async fetch(req: Request, env: Env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(req.url);
    console.log("request:", req.method, url.pathname);

    // POST /api/message
    if (req.method === "POST" && url.pathname === "/api/message") {
      const { text, sessionId = "demo-user" } = await req.json();
      const id = env.SESSION_DO.idFromName(sessionId);
      const stub = env.SESSION_DO.get(id);
      const state = await (await stub.fetch("https://do/load")).json();

      console.log("=== classifier section running ===");

      // classify
      const cls = await env.AI.run(env.MODEL, {
        messages: [
          {
            role: "system",
            content:
              "you are a strict JSON classifier. output ONLY JSON, no text, no markdown.",
          },
          {
            role: "user",
            content: `return JSON {"kind":"reflection"|"plan_request"|"other","mood":float_0_to_1}. classify="${text}"`,
          },
        ],
        max_tokens: 60,
        temperature: 0,
      });

      const outputText =
        cls?.output_text ??
        (typeof cls === "string" ? cls : JSON.stringify(cls, null, 2));

      console.log("RAW_CLASSIFY_OUTPUT:", outputText);
      const parsed = safeJson(outputText);
      const intent = parsed?.response ?? parsed ?? { kind: "other", mood: 0.5 };

      // 🪞 reflection
      if (intent.kind === "reflection") {
        const emb = await env.AI.run("@cf/baai/bge-large-en-v1.5", { text });
        await env.VECTOR_INDEX.upsert([
          {
            id: crypto.randomUUID(),
            values: emb.data[0],
            metadata: { ts: Date.now(), mood: intent.mood, sessionId },
          },
        ]);

        const next = { ...state.persona, mood: labelMood(intent.mood) };
        await stub.fetch("https://do/save-persona", {
          method: "POST",
          body: JSON.stringify(next),
        });

        return json({
          kind: "reflection",
          text: "got it — I’ve noted that reflection.",
        });
      }

      // 📅 plan_request
      if (intent.kind === "plan_request") {
        const draft = await env.AI.run(env.MODEL, {
          messages: [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: `persona=${JSON.stringify(state.persona)}
last_plan=${JSON.stringify(state.plan)}
user_request="${text}"`,
            },
          ],
          max_tokens: 900,
          temperature: 0.7,
        });

        const raw = draft?.output_text || draft?.response || "";
        const plan = extractJsonBlock(raw);

        if (plan) {
          await stub.fetch("https://do/save-plan", {
            method: "POST",
            body: JSON.stringify(plan),
          });
          console.log("✅ saved plan JSON");
        }

        return json({
          kind: "plan_request",
          text: raw.trim(),
          plan: plan || null,
        });
      }

      // 🧠 fallback chat
      const chatReply = await env.AI.run(env.MODEL, {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text },
        ],
        max_tokens: 400,
        temperature: 0.7,
      });

      const replyText = chatReply?.output_text ?? "noted.";
      return json({
        kind: "other",
        text: replyText,
      });
    }

    // GET /api/plan
    if (req.method === "GET" && url.pathname === "/api/plan") {
      const sessionId = url.searchParams.get("sessionId") ?? "demo-user";
      const id = env.SESSION_DO.idFromName(sessionId);
      const stub = env.SESSION_DO.get(id);
      const { plan } = await (await stub.fetch("https://do/load")).json();
      return json(plan ?? { note: "no plan yet. ask for a plan." });
    }

    return new Response("ok", { headers: CORS });
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  console.log("⏰ running scheduled daily plan refresh");

  const sessionId = "demo-user"; // later can be multi-user
  const id = env.SESSION_DO.idFromName(sessionId);
  const stub = env.SESSION_DO.get(id);

  const { persona, plan } = await (await stub.fetch("https://do/load")).json();

  // summarize last few reflections from vector memory
  const recent = await env.VECTOR_INDEX.query({
    topK: 10,
    query: "summarize reflections for weekly planning",
  });

  const reflections = JSON.stringify(recent.matches ?? []);
  const prompt = `persona=${JSON.stringify(persona)}
last_plan=${JSON.stringify(plan)}
reflections=${reflections}
generate a refreshed 7-day plan that fits current mood and habits.
wrap it in a JSON code block.`;

  const result = await env.AI.run(env.MODEL, {
    messages: [
      { role: "system", content: "you are a pragmatic planner who produces structured plans in JSON format." },
      { role: "user", content: prompt },
    ],
    max_tokens: 900,
    temperature: 0.5,
  });

  const planJson = extractJsonBlock(result.output_text);
  if (planJson) {
    await stub.fetch("https://do/save-plan", {
      method: "POST",
      body: JSON.stringify(planJson),
    });
    console.log("✅ nightly plan refreshed");
  } else {
    console.log("⚠️ failed to parse plan output");
  }
},
};

// --- helpers ---
function safeJson(s: any) {
  if (!s || typeof s !== "string") return null;
  try {
    return JSON.parse(s);
  } catch {
    const match = s.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractJsonBlock(s: string) {
  const match = s.match(/```json([\s\S]*?)```/i);
  if (!match) return safeJson(s);
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function labelMood(v: number) {
  if (v < 0.3) return "low";
  if (v < 0.7) return "ok";
  return "high";
}

export { SessionDO };
