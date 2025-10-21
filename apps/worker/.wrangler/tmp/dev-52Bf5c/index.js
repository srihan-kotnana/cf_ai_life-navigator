var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/do_session.ts
var SessionDO = class {
  static {
    __name(this, "SessionDO");
  }
  state;
  storage;
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/load")) {
      const persona = await this.storage.get("persona") ?? defaultPersona();
      const plan = await this.storage.get("plan") ?? null;
      return Response.json({ persona, plan });
    }
    if (url.pathname.endsWith("/save-persona")) {
      const p = await req.json();
      await this.storage.put("persona", p);
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/save-plan")) {
      const plan = await req.json();
      await this.storage.put("plan", plan);
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/reset")) {
      await this.storage.deleteAll();
      return Response.json({ ok: true, reset: true });
    }
    return new Response("noop");
  }
};
function defaultPersona() {
  return {
    energy: 0.5,
    focus: 0.5,
    mood: "neutral",
    goals: [],
    preferences: {}
  };
}
__name(defaultPersona, "defaultPersona");

// src/index.ts
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
function json(body, status = 200) {
  const headers = new Headers({ "content-type": "application/json", ...CORS });
  return new Response(JSON.stringify(body), { status, headers });
}
__name(json, "json");
var SYSTEM = `you are a pragmatic, conversational planner.
respond naturally in plain text paragraphs \u2014 not JSON or code unless explicitly asked.
if you include a structured plan, put it at the end in a code block like:
\`\`\`json
{ "weekStart": "Monday", "days": [...] }
\`\`\`
otherwise just respond conversationally.`;
var src_default = {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(req.url);
    console.log("request:", req.method, url.pathname);
    if (req.method === "POST" && url.pathname === "/api/message") {
      const { text, sessionId = "demo-user" } = await req.json();
      const id = env.SESSION_DO.idFromName(sessionId);
      const stub = env.SESSION_DO.get(id);
      const state = await (await stub.fetch("https://do/load")).json();
      console.log("=== classifier section running ===");
      const cls = await env.AI.run(env.MODEL, {
        messages: [
          {
            role: "system",
            content: "you are a strict JSON classifier. output ONLY JSON, no text, no markdown."
          },
          {
            role: "user",
            content: `return JSON {"kind":"reflection"|"plan_request"|"other","mood":float_0_to_1}. classify="${text}"`
          }
        ],
        max_tokens: 60,
        temperature: 0
      });
      const outputText = cls?.output_text ?? (typeof cls === "string" ? cls : JSON.stringify(cls, null, 2));
      console.log("RAW_CLASSIFY_OUTPUT:", outputText);
      const parsed = safeJson(outputText);
      const intent = parsed?.response ?? parsed ?? { kind: "other", mood: 0.5 };
      if (intent.kind === "reflection") {
        const emb = await env.AI.run("@cf/baai/bge-large-en-v1.5", { text });
        await env.VECTOR_INDEX.upsert([
          {
            id: crypto.randomUUID(),
            values: emb.data[0],
            metadata: { ts: Date.now(), mood: intent.mood, sessionId }
          }
        ]);
        const next = { ...state.persona, mood: labelMood(intent.mood) };
        await stub.fetch("https://do/save-persona", {
          method: "POST",
          body: JSON.stringify(next)
        });
        return json({
          kind: "reflection",
          text: "got it \u2014 I\u2019ve noted that reflection."
        });
      }
      if (intent.kind === "plan_request") {
        const draft = await env.AI.run(env.MODEL, {
          messages: [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: `persona=${JSON.stringify(state.persona)}
last_plan=${JSON.stringify(state.plan)}
user_request="${text}"`
            }
          ],
          max_tokens: 900,
          temperature: 0.7
        });
        const raw = draft?.output_text || draft?.response || "";
        const plan = extractJsonBlock(raw);
        if (plan) {
          await stub.fetch("https://do/save-plan", {
            method: "POST",
            body: JSON.stringify(plan)
          });
          console.log("\u2705 saved plan JSON");
        }
        return json({
          kind: "plan_request",
          text: raw.trim(),
          plan: plan || null
        });
      }
      const chatReply = await env.AI.run(env.MODEL, {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text }
        ],
        max_tokens: 400,
        temperature: 0.7
      });
      const replyText = chatReply?.output_text ?? "noted.";
      return json({
        kind: "other",
        text: replyText
      });
    }
    if (req.method === "GET" && url.pathname === "/api/plan") {
      const sessionId = url.searchParams.get("sessionId") ?? "demo-user";
      const id = env.SESSION_DO.idFromName(sessionId);
      const stub = env.SESSION_DO.get(id);
      const { plan } = await (await stub.fetch("https://do/load")).json();
      return json(plan ?? { note: "no plan yet. ask for a plan." });
    }
    return new Response("ok", { headers: CORS });
  },
  async scheduled(event, env, ctx) {
    console.log("\u23F0 running scheduled daily plan refresh");
    const sessionId = "demo-user";
    const id = env.SESSION_DO.idFromName(sessionId);
    const stub = env.SESSION_DO.get(id);
    const { persona, plan } = await (await stub.fetch("https://do/load")).json();
    const recent = await env.VECTOR_INDEX.query({
      topK: 10,
      query: "summarize reflections for weekly planning"
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
        { role: "user", content: prompt }
      ],
      max_tokens: 900,
      temperature: 0.5
    });
    const planJson = extractJsonBlock(result.output_text);
    if (planJson) {
      await stub.fetch("https://do/save-plan", {
        method: "POST",
        body: JSON.stringify(planJson)
      });
      console.log("\u2705 nightly plan refreshed");
    } else {
      console.log("\u26A0\uFE0F failed to parse plan output");
    }
  }
};
function safeJson(s) {
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
__name(safeJson, "safeJson");
function extractJsonBlock(s) {
  const match = s.match(/```json([\s\S]*?)```/i);
  if (!match) return safeJson(s);
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}
__name(extractJsonBlock, "extractJsonBlock");
function labelMood(v) {
  if (v < 0.3) return "low";
  if (v < 0.7) return "ok";
  return "high";
}
__name(labelMood, "labelMood");

// ../../../.nvm/versions/node/v20.19.5/lib/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../.nvm/versions/node/v20.19.5/lib/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-yMNqZk/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../.nvm/versions/node/v20.19.5/lib/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-yMNqZk/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  SessionDO,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
