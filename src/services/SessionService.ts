import type { App } from "obsidian";
import type { LockedNode } from "./LockedNodesService";
import type { QueryOptions } from "../types";

const LOG_PREFIX = "[SessionService]";
const SESSIONS_DIR = ".obsidian/plugins/vault-rag-explorer/sessions";

export interface Session {
  id: string;
  createdAt: number;
  queryText: string;
  queryOptions: QueryOptions;
  lockedNodes: LockedNode[];
  graphPositions: Record<string, { x: number; y: number }>;
}

export class SessionService {
  constructor(private app: App) {}

  private getSessionPath(id: string): string {
    return `${SESSIONS_DIR}/${id}.json`;
  }

  async ensureDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(SESSIONS_DIR);
    if (!exists) {
      await adapter.mkdir(SESSIONS_DIR);
      console.log(`${LOG_PREFIX} Created sessions directory`);
    }
  }

  async save(session: Session): Promise<void> {
    await this.ensureDir();
    const path = this.getSessionPath(session.id);
    await this.app.vault.adapter.write(path, JSON.stringify(session, null, 2));
    console.log(`${LOG_PREFIX} Session saved id=${session.id}`);
  }

  async load(sessionId: string): Promise<Session | null> {
    const path = this.getSessionPath(sessionId);
    const exists = await this.app.vault.adapter.exists(path);
    if (!exists) {
      console.warn(`${LOG_PREFIX} Session not found id=${sessionId}`);
      return null;
    }

    const content = await this.app.vault.adapter.read(path);
    try {
      const session = JSON.parse(content) as Session;
      console.log(`${LOG_PREFIX} Session loaded id=${sessionId}`);
      return session;
    } catch (e) {
      console.error(`${LOG_PREFIX} Failed to parse session id=${sessionId}`, e);
      return null;
    }
  }

  async list(): Promise<{ id: string; createdAt: number; queryText: string }[]> {
    await this.ensureDir();
    const listed = await this.app.vault.adapter.list(SESSIONS_DIR);
    const results = [];

    for (const file of listed.files) {
      if (!file.endsWith(".json")) continue;

      try {
        const content = await this.app.vault.adapter.read(file);
        const parsed = JSON.parse(content) as Session;
        results.push({
          id: parsed.id,
          createdAt: parsed.createdAt,
          queryText: parsed.queryText
        });
      } catch (e) {
        console.warn(`${LOG_PREFIX} Failed to read summary for session file=${file}`);
      }
    }

    console.log(`${LOG_PREFIX} Listed ${results.length} sessions`);
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }
}
