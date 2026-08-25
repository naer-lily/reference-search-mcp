import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { SearchSession } from "../types.js";

/**
 * Owns search-session state: rounds (a, b, c...), seen-hash bookkeeping,
 * data dir layout, and TTL cleanup. Sessions are in-memory; artifacts
 * (grid images) live under dataDir/sessions/<id>/.
 */
export class SessionManager {
  private readonly sessions = new Map<string, SearchSession>();

  constructor(
    private readonly dataDir: string,
    private readonly ttlMs: number,
  ) {}

  create(query: string, keywords: string[], criteria?: string): SearchSession {
    const id = randomUUID().slice(0, 8);
    const session: SearchSession = {
      id,
      query,
      criteria,
      keywords,
      rounds: [],
      seenHashes: new Map(),
      collectedIds: [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.sessions.set(id, session);
    mkdirSync(this.roundDir(session), { recursive: true });
    return session;
  }

  get(id: string): SearchSession | undefined {
    const s = this.sessions.get(id);
    if (s) s.lastUsedAt = Date.now();
    return s;
  }

  /** Next round letter: a for the first round, then b, c... */
  nextLetter(session: SearchSession): string {
    return String.fromCharCode(97 + session.rounds.length);
  }

  gridPath(session: SearchSession, letter: string): string {
    return path.join(this.roundDir(session), `round-${letter}.png`);
  }

  roundDir(session: SearchSession): string {
    return path.join(this.dataDir, "sessions", session.id);
  }

  /** Remove expired sessions and their artifacts. */
  cleanup(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastUsedAt > this.ttlMs) {
        this.sessions.delete(id);
        rmSync(this.roundDir(s), { recursive: true, force: true });
      }
    }
  }

  listIds(): string[] {
    return [...this.sessions.keys()];
  }
}
