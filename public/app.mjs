import "./components/index.mjs";
import { fetchStatus, fetchTask, submitTask } from "./lib/api.mjs";
import { initPanelMinimizing } from "./lib/panel-minimize.mjs";
import { initPanelResizing } from "./lib/panel-resize.mjs";
import { revealInitialText } from "./lib/retro-reveal.mjs";
import { createRenderer } from "./lib/render.mjs";
import { initWorkspaceBrowser } from "./lib/workspace-browser.mjs";
import { initChat } from "./lib/chat.mjs";

const select = (selector) => document.querySelector(selector);
const elements = {
  agentDescription: select("#agent-description"),
  agentInfo: select("#agent-info"),
  consoleNode: select("#console"),
  form: select("#repl-form"),
  healthDot: select("#health-dot"),
  healthText: select("#health-text"),
  logs: select("#logs"),
  prompt: select("#prompt"),
  queueBadge: select("#queue-badge"),
  runState: select("#run-state"),
  status: select("#status"),
  statusDialog: select("#status-dialog"),
  tasks: select("#tasks"),
  workspaceSummary: select("#workspace-summary"),
};
const renderer = createRenderer(elements);
let activeTask = null;
let submitting = false;
let officePending = false;
let officeEnabled = false;
const officeButton = select("#office-toggle");

let panelResizing;
initPanelMinimizing({ onChange: () => panelResizing?.refresh() });
panelResizing = initPanelResizing();
const workspaceBrowser = initWorkspaceBrowser({ onLayoutChange: () => panelResizing?.refresh() });
const chat = initChat();

function resizePrompt() {
  elements.prompt.style.height = "auto";
  const maxHeight = Number.parseFloat(getComputedStyle(elements.prompt).maxHeight);
  const height = Math.min(elements.prompt.scrollHeight, maxHeight);
  elements.prompt.style.height = `${height}px`;
  elements.prompt.style.overflowY = elements.prompt.scrollHeight > maxHeight ? "auto" : "hidden";
}

async function refreshStatus() {
  try {
    const data = await fetchStatus();
    renderer.renderStatus(data);
    officeEnabled = data.orchestration.enabled;
    officeButton.textContent = officePending ? "Please wait…" : officeEnabled ? "Disconnect" : "Connect";
    officeButton.disabled = officePending || !data.orchestration.configured;
    officeButton.title = !data.orchestration.configured ? "Set AI_HARNESS_OFFICE_URL to connect" : officeEnabled ? "Disconnect from Office and stop active Office tasks" : "Connect to Office";
    void chat.refresh();
  } catch (error) {
    renderer.renderOffline(error);
    officeButton.disabled = true;
  }
}

async function watchTask(taskId) {
  while (activeTask === taskId) {
    const { task } = await fetchTask(taskId);
    elements.runState.textContent = task.state;
    await refreshStatus();
    if (task.state === "completed" || task.state === "failed") {
      const text = task.result?.message?.parts?.[0]?.text || task.error || "Task ended without output.";
      renderer.addMessage("agent", text, task.state === "failed" ? "error" : "");
      activeTask = null;
      void workspaceBrowser.refresh();
      elements.runState.textContent = task.state;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = elements.prompt.value.trim();
  if (!prompt || activeTask || submitting) return;
  submitting = true;

  renderer.addMessage("user", prompt);
  elements.prompt.value = "";
  resizePrompt();
  elements.runState.textContent = "submitting";
  try {
    const data = await submitTask(prompt);
    activeTask = data.taskId;
    await watchTask(data.taskId);
  } catch (error) {
    renderer.addMessage("system", error.message, "error");
    activeTask = null;
    elements.runState.textContent = "error";
  } finally {
    submitting = false;
  }
});

officeButton.addEventListener("click", async () => {
  if (officePending) return;
  officePending = true;
  officeButton.disabled = true;
  officeButton.textContent = "Please wait…";
  try {
    const response = await fetch("/api/office/connection", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: officeEnabled ? "disconnect" : "connect" }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to change Office connection.");
  } catch (error) { renderer.addMessage("system", error.message, "error"); }
  finally { officePending = false; await refreshStatus(); }
});

elements.prompt.addEventListener("input", resizePrompt);
elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.form.requestSubmit();
  }
});

elements.tasks.addEventListener("click", (event) => {
  const row = event.target.closest(".task-row");
  if (row) renderer.toggleTask(row);
});

select("#open-status").addEventListener("click", () => elements.statusDialog.showModal());
select("#close-status").addEventListener("click", () => elements.statusDialog.close());
elements.statusDialog.addEventListener("click", (event) => {
  if (event.target === elements.statusDialog) elements.statusDialog.close();
});

async function initialize() {
  await refreshStatus();
  await revealInitialText();
  setInterval(refreshStatus, 2500);
}

void initialize();
