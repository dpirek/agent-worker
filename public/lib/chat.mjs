export function initChat() {
  const feed = document.getElementById("chat-feed"), messages = document.getElementById("chat-messages");
  const older = document.getElementById("chat-older"), state = document.getElementById("chat-state");
  let first = null, last = 0, busy = false, olderBusy = false;
  const ids = new Set();

  function render(entries, prepend) {
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    const previousHeight = feed.scrollHeight;
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      if (ids.has(entry.id)) continue;
      ids.add(entry.id);
      first = first === null ? entry.id : Math.min(first, entry.id);
      last = Math.max(last, entry.id);
      const row = document.createElement("article");
      row.className = `chat-message ${entry.direction}`;
      const label = document.createElement("div");
      label.className = "chat-meta";
      label.textContent = `${entry.direction === "incoming" ? "↓ Incoming" : "↑ Outgoing"} · ${entry.source} · ${new Date(entry.createdAt).toLocaleString()}${entry.state ? ` · ${entry.state}` : ""}`;
      const body = document.createElement("div");
      body.className = "chat-text";
      body.textContent = entry.text;
      row.append(label, body);
      if (entry.taskId || entry.messageId) {
        const context = document.createElement("div");
        context.className = "chat-context";
        context.textContent = entry.taskId || entry.messageId;
        row.append(context);
      }
      fragment.append(row);
    }
    if (prepend) messages.prepend(fragment); else messages.append(fragment);
    document.getElementById("chat-empty").hidden = ids.size > 0;
    if (prepend) feed.scrollTop += feed.scrollHeight - previousHeight;
    else if (atBottom) feed.scrollTop = feed.scrollHeight;
  }

  async function load(previous = false) {
    if (previous ? olderBusy : busy) return;
    if (previous) olderBusy = true; else busy = true;
    older.disabled = olderBusy;
    try {
      const query = previous ? `?before=${first}` : last ? `?after=${last}` : "";
      const response = await fetch(`/api/messages${query}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load chat");
      const initial = first === null;
      render(data.messages, previous);
      if (initial || previous) older.hidden = !data.hasMore;
      state.textContent = "Office + REPL";
    } catch (error) { state.textContent = error.message; }
    finally { if (previous) olderBusy = false; else busy = false; older.disabled = olderBusy; }
  }
  older.addEventListener("click", () => load(true));
  void load();
  return { refresh: () => load() };
}
