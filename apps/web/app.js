const chat = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const exportButton = document.getElementById("export-data");
const deleteButton = document.getElementById("delete-data");

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

  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text || "";
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

async function requestJson(path, options) {
  const res = await fetch(path, options);
  const data = await tryParseJson(res);
  if (!res.ok) {
    throw new Error(data.message || `request failed (${res.status})`);
  }
  return data;
}

async function fetchPlan() {
  try {
    const data = await requestJson("/api/plan");

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
    const data = await requestJson("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

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

exportButton.addEventListener("click", async () => {
  try {
    const data = await requestJson("/api/data");
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "life-navigator-data.json";
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (err) {
    addMessage("system", `error exporting data: ${err.message}`);
  }
});

deleteButton.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Delete your persona, plan, and stored reflections? This cannot be undone.",
  );
  if (!confirmed) return;

  try {
    await requestJson("/api/data", { method: "DELETE" });
    chat.replaceChildren();
    addMessage("system", "Your stored Life Navigator data was deleted.");
  } catch (err) {
    addMessage("system", `error deleting data: ${err.message}`);
  }
});

fetchPlan();
