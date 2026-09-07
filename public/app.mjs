import { fetchStatus, fetchTask, submitTask } from "./lib/api.mjs";
import { createRenderer } from "./lib/render.mjs";

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
  sendButton: select("#send"),
  status: select("#status"),
  statusDialog: select("#status-dialog"),
  taskId: select("#task-id"),
  tasks: select("#tasks"),
  workspaceSummary: select("#workspace-summary"),
};
const renderer = createRenderer(elements);
let activeTask = null;

function resizePrompt() {
  elements.prompt.style.height = "auto";
  const maxHeight = Number.parseFloat(getComputedStyle(elements.prompt).maxHeight);
  const height = Math.min(elements.prompt.scrollHeight, maxHeight);
  elements.prompt.style.height = `${height}px`;
  elements.prompt.style.overflowY = elements.prompt.scrollHeight > maxHeight ? "auto" : "hidden";
}

async function refreshStatus() {
  try {
    renderer.renderStatus(await fetchStatus());
  } catch (error) {
    renderer.renderOffline(error);
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
      elements.sendButton.disabled = false;
      elements.runState.textContent = task.state;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = elements.prompt.value.trim();
  if (!prompt || activeTask) return;

  renderer.addMessage("user", prompt);
  elements.prompt.value = "";
  resizePrompt();
  elements.sendButton.disabled = true;
  elements.runState.textContent = "submitting";
  try {
    const data = await submitTask(prompt);
    activeTask = data.taskId;
    elements.taskId.textContent = `Task ${data.taskId}`;
    await watchTask(data.taskId);
  } catch (error) {
    renderer.addMessage("system", error.message, "error");
    activeTask = null;
    elements.sendButton.disabled = false;
    elements.runState.textContent = "error";
  }
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

refreshStatus();
setInterval(refreshStatus, 2500);
