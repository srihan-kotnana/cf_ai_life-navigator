const chat = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");

// const API = "http://127.0.0.1:8787"; // local worker URL
const API = "https://life-navigator.kotnana-srihan.workers.dev/";

function addMessage(role, text, meta = "") {
  const div = document.createElement("div");
  div.className = role;

  // meta tag like "reflection logged" or "plan created"
  if (meta) {
    const tag = document.createElement("div");
    tag.className = "meta";
    tag.textContent = meta;
    div.appendChild(tag);
  }

  // convert \n to <br>
  const body = document.createElement("div");
  body.className = "text";
  body.innerHTML = (text || "").replace(/\n/g, "<br>");
  div.appendChild(body);

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

async function tryParseJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text }; // fallback for plain text responses
  }
}

async function fetchPlan() {
  try {
    const res = await fetch(`${API}/api/plan`);
    const data = await tryParseJson(res);

    if (data?.weekStart) {
      addMessage("system", `📅 current plan loaded (${data.weekStart})`);
      renderPlan(data);
    } else {
      addMessage("system", data.note || data.text || "no plan yet — ask for one.");
    }
  } catch (err) {
    addMessage("system", `error loading plan: ${err.message}`);
  }
}

function renderPlan(plan) {
  const pretty = JSON.stringify(plan, null, 2);
  const div = document.createElement("pre");
  div.className = "plan";
  div.textContent = pretty;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  addMessage("user", text);
  input.value = "";

  try {
    const res = await fetch(`${API}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, sessionId: "demo-user" }),
    });

    const data = await tryParseJson(res);

    const meta =
      data.kind === "reflection"
        ? "🪞 emotion logged"
        : data.kind === "plan_request"
        ? "📅 plan generated"
        : "";

    addMessage("bot", data.text || "(no response)", meta);

    if (data.plan) renderPlan(data.plan);
  } catch (err) {
    addMessage("bot", `⚠️ error: ${err.message}`);
  }
});

fetchPlan();
