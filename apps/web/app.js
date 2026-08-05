const chat = document.getElementById("chat");
const emptyState = document.getElementById("empty-state");
const form = document.getElementById("form");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");
const status = document.getElementById("app-status");
const statusText = document.getElementById("status-text");
const characterCount = document.getElementById("character-count");
const exportButton = document.getElementById("export-data");
const deleteButton = document.getElementById("delete-data");
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function setStatus(text, state = "ready") {
  status.dataset.state = state;
  statusText.textContent = text;
}

function clearEmptyState() {
  if (emptyState?.isConnected) emptyState.remove();
}

function scrollToLatest() {
  chat.scrollTo({
    top: chat.scrollHeight,
    behavior: prefersReducedMotion.matches ? "auto" : "smooth",
  });
}

function addMessage(role, text, meta = "") {
  clearEmptyState();

  const message = document.createElement("article");
  message.className = `message message-${role}`;

  if (meta) {
    const label = document.createElement("p");
    label.className = "message-meta";
    label.textContent = meta;
    message.appendChild(label);
  }

  const body = document.createElement("div");
  body.className = "message-text";
  body.textContent = text || "";
  message.appendChild(body);

  chat.appendChild(message);
  scrollToLatest();
}

function renderPlan(plan) {
  clearEmptyState();

  const section = document.createElement("section");
  section.className = "plan";
  section.setAttribute("aria-label", "Weekly plan");

  const header = document.createElement("div");
  header.className = "plan-header";

  const titleGroup = document.createElement("div");
  const kicker = document.createElement("p");
  kicker.className = "plan-kicker";
  kicker.textContent = plan.weekStart ? `Week starting ${plan.weekStart}` : "Your week";
  const title = document.createElement("h2");
  title.textContent = "A considered plan";
  titleGroup.append(kicker, title);

  const summary = document.createElement("p");
  summary.className = "plan-summary";
  summary.textContent = plan.summary || "A plan shaped around your current context.";
  header.append(titleGroup, summary);
  section.appendChild(header);

  if (Array.isArray(plan.days)) {
    const dayList = document.createElement("ol");
    dayList.className = "plan-days";

    for (const day of plan.days) {
      const item = document.createElement("li");
      item.className = "plan-day";

      const dayName = document.createElement("p");
      dayName.className = "plan-day-name";
      dayName.textContent = day.day || "Day";

      const focus = document.createElement("h3");
      focus.textContent = day.focus || "Keep the day intentional";
      item.append(dayName, focus);

      if (Array.isArray(day.tasks) && day.tasks.length > 0) {
        const tasks = document.createElement("ul");
        for (const task of day.tasks) {
          const taskItem = document.createElement("li");
          taskItem.textContent = String(task);
          tasks.appendChild(taskItem);
        }
        item.appendChild(tasks);
      }

      dayList.appendChild(item);
    }

    section.appendChild(dayList);
  }

  chat.appendChild(section);
  scrollToLatest();
}

async function tryParseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function requestJson(path, options) {
  const response = await fetch(path, options);
  const data = await tryParseJson(response);
  if (!response.ok) {
    throw new Error(data.message || `Request failed (${response.status}).`);
  }
  return data;
}

function updateComposer() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  characterCount.textContent = `${input.value.length.toLocaleString()} / 4,000`;
}

function setSending(isSending) {
  form.setAttribute("aria-busy", String(isSending));
  sendButton.disabled = isSending;
  sendButton.querySelector("span:first-child").textContent = isSending
    ? "Working"
    : "Send";
  if (isSending) setStatus("Thinking", "loading");
}

async function fetchPlan() {
  setStatus("Loading your context", "loading");
  try {
    const data = await requestJson("/api/plan");
    if (data?.weekStart) {
      addMessage("system", "Your latest plan is ready below.", "Current plan");
      renderPlan(data);
    }
    setStatus("Ready");
  } catch (error) {
    setStatus("Needs attention", "error");
    addMessage("system", error.message, "Could not load your plan");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || sendButton.disabled) return;

  addMessage("user", text, "You");
  input.value = "";
  updateComposer();
  setSending(true);

  try {
    const data = await requestJson("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

    const meta =
      data.kind === "reflection"
        ? "Reflection saved"
        : data.kind === "plan_request"
          ? "Plan generated"
          : "Navigator";

    addMessage(
      "assistant",
      data.plan ? "Your plan is ready." : data.text || "No response returned.",
      meta,
    );
    if (data.plan) renderPlan(data.plan);
    setStatus("Ready");
  } catch (error) {
    addMessage("system", error.message, "Request not completed");
    setStatus("Needs attention", "error");
  } finally {
    setSending(false);
    input.focus();
  }
});

input.addEventListener("input", updateComposer);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

for (const prompt of document.querySelectorAll("[data-prompt]")) {
  prompt.addEventListener("click", () => {
    input.value = prompt.dataset.prompt;
    updateComposer();
    input.focus();
  });
}

exportButton.addEventListener("click", async () => {
  exportButton.disabled = true;
  setStatus("Preparing export", "loading");
  try {
    const data = await requestJson("/api/data");
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "life-navigator-data.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
    setStatus("Export downloaded");
  } catch (error) {
    addMessage("system", error.message, "Export failed");
    setStatus("Needs attention", "error");
  } finally {
    exportButton.disabled = false;
  }
});

deleteButton.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Delete your persona, plan, and stored reflections? This cannot be undone.",
  );
  if (!confirmed) return;

  deleteButton.disabled = true;
  setStatus("Deleting data", "loading");
  try {
    await requestJson("/api/data", { method: "DELETE" });
    chat.replaceChildren();
    addMessage(
      "system",
      "Your stored Life Navigator data was deleted.",
      "Data deleted",
    );
    setStatus("Ready");
  } catch (error) {
    addMessage("system", error.message, "Deletion failed");
    setStatus("Needs attention", "error");
  } finally {
    deleteButton.disabled = false;
  }
});

updateComposer();
fetchPlan();
