import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_TASK_DATABASE = "db/tasks.sqlite";

function taskDatabasePath(env = process.env, baseDir = process.cwd()) {
  const configured = String(env.WORKER_TASK_DB || DEFAULT_TASK_DATABASE).trim() || DEFAULT_TASK_DATABASE;
  return configured === ":memory:" ? configured : path.resolve(baseDir, configured);
}

function parseTask(row) {
  if (!row) return null;
  try {
    return JSON.parse(row.task_json);
  } catch {
    return null;
  }
}

function createTaskStore({ env = process.env, baseDir = process.cwd() } = {}) {
  const databasePath = taskDatabasePath(env, baseDir);
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000");
  if (databasePath !== ":memory:") database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      task_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON tasks(created_at DESC);
    CREATE INDEX IF NOT EXISTS tasks_state_idx ON tasks(state);
  `);

  const saveStatement = database.prepare(`
    INSERT INTO tasks (task_id, message_id, state, created_at, updated_at, task_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      message_id = excluded.message_id,
      state = excluded.state,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      task_json = excluded.task_json
  `);
  const recentStatement = database.prepare(`
    SELECT task_json FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?
  `);
  const incompleteStatement = database.prepare(`
    SELECT task_json FROM tasks WHERE state IN ('submitted', 'working') ORDER BY created_at ASC
  `);
  const taskStatement = database.prepare("SELECT task_json FROM tasks WHERE task_id = ?");
  const messageStatement = database.prepare("SELECT task_json FROM tasks WHERE message_id = ?");

  return {
    path: databasePath,
    save(task) {
      const now = new Date().toISOString();
      saveStatement.run(
        task.taskId,
        task.messageId,
        task.state,
        task.createdAt || now,
        now,
        JSON.stringify(task),
      );
    },
    listRecent(limit = 50) {
      return recentStatement.all(Math.max(1, Math.floor(limit))).map(parseTask).filter(Boolean);
    },
    listIncomplete() {
      return incompleteStatement.all().map(parseTask).filter(Boolean);
    },
    findByTaskId(taskId) {
      return parseTask(taskStatement.get(taskId));
    },
    findByMessageId(messageId) {
      return parseTask(messageStatement.get(messageId));
    },
    close() {
      database.close();
    },
  };
}

export { createTaskStore, taskDatabasePath };
