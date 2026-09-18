import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Verdict } from "./verdict.ts";

/** One line per judged response. Bodies are hashed, never stored, unless `storeBodies` is set. */
export interface DecisionRecord {
  ts: string;
  id: string;
  judge: string;
  policy: string;
  verdict: Verdict["verdict"];
  checks: Verdict["checks"];
  latencyMs: number;
  inputTokens: number;
  stateHash: string;
  /** Filled in later by a human or a stronger judge. */
  label?: Verdict["verdict"];
  bodies?: { userMessage: string; response: string };
}

export interface DecisionLog {
  write(r: DecisionRecord): void;
}

export class JsonlLog implements DecisionLog {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  write(r: DecisionRecord) {
    appendFileSync(this.path, JSON.stringify(r) + "\n");
  }
}

export class MemoryLog implements DecisionLog {
  records: DecisionRecord[] = [];
  write(r: DecisionRecord) { this.records.push(r); }
}

export const noopLog: DecisionLog = { write() {} };

export function hashState(state: string): string {
  return new Bun.CryptoHasher("sha256").update(state).digest("hex").slice(0, 16);
}
