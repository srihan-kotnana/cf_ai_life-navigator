export class SessionDO {
  state: DurableObjectState;
  storage: DurableObjectStorage;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(req: Request) {
    const url = new URL(req.url);

    // load current persona + plan
    if (url.pathname.endsWith("/load")) {
      const persona = (await this.storage.get("persona")) ?? defaultPersona();
      const plan = (await this.storage.get("plan")) ?? null;
      return Response.json({ persona, plan });
    }

    // save persona
    if (url.pathname.endsWith("/save-persona")) {
      const p = await req.json();
      await this.storage.put("persona", p);
      return Response.json({ ok: true });
    }

    // save plan
    if (url.pathname.endsWith("/save-plan")) {
      const plan = await req.json();
      await this.storage.put("plan", plan);
      return Response.json({ ok: true });
    }

    // clear stored state (debug helper)
    if (url.pathname.endsWith("/reset")) {
      await this.storage.deleteAll();
      return Response.json({ ok: true, reset: true });
    }

    return new Response("noop");
  }
}

// default persona values if nothing stored yet
function defaultPersona() {
  return {
    energy: 0.5,
    focus: 0.5,
    mood: "neutral",
    goals: [],
    preferences: {},
  };
}

// universal extractor for model responses
export function getText(aiResult: any): string {
  if (!aiResult) return "";
  return (
    aiResult.output_text ??
    aiResult.response ??
    aiResult.text ??
    aiResult.result ??
    (typeof aiResult === "string" ? aiResult : "")
  );
}
