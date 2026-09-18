import type { Answer, Judgment } from "./judge/types.ts";
import type { CheckId, Policy } from "./policy.ts";

export interface CheckResult {
  /** Did the check fire (i.e. find a problem)? */
  fired: boolean;
  severity: "hard" | "soft";
  confidence: number;
  /** Human-readable value: choice name, score, or probability. */
  value: string | number;
  detail?: string;
}

export interface Verdict {
  verdict: "pass" | "flag" | "block";
  checks: Partial<Record<CheckId, CheckResult>>;
  /** Which checks caused the verdict. */
  reasons: CheckId[];
  judge: string;
  latencyMs: number;
  inputTokens: number;
}

/**
 * Gate. A hard check that fires with confidence >= its threshold blocks.
 * A hard check that fires below threshold, or any soft check that fires, flags.
 * Everything else passes. Low confidence can never *suppress* a finding; it
 * only downgrades block to flag.
 */
export function decide(j: Judgment, policy: Policy): Verdict {
  const checks: Verdict["checks"] = {};
  const blockers: CheckId[] = [];
  const flaggers: CheckId[] = [];

  for (const [id, answer] of Object.entries(j.answers) as [CheckId, Answer][]) {
    const cfg = policy.checks[id];
    if (!cfg) continue;
    const conf = j.confidence[id] ?? 0;
    const r = interpret(id, answer, conf, cfg.severity);
    checks[id] = r;
    if (!r.fired) continue;
    if (r.severity === "hard" && conf >= cfg.threshold) blockers.push(id);
    else flaggers.push(id);
  }

  const verdict = blockers.length ? "block" : flaggers.length ? "flag" : "pass";
  return { verdict, checks, reasons: verdict === "block" ? blockers : flaggers, judge: j.judge, latencyMs: j.latencyMs, inputTokens: j.inputTokens };
}

/** Map a raw answer to fired/not-fired. Per-check semantics live here and nowhere else. */
function interpret(id: CheckId, a: Answer, confidence: number, severity: "hard" | "soft"): CheckResult {
  switch (id) {
    case "on_topic": {
      const p = (a as { probability: number }).probability;
      return { fired: p < 0.5, severity, confidence, value: round(p), detail: "P(on topic)" };
    }
    case "pii_leak":
    case "injection_complied": {
      const p = (a as { probability: number }).probability;
      return { fired: p >= 0.5, severity, confidence, value: round(p), detail: "P(true)" };
    }
    case "follows_system": {
      const s = (a as { score: number }).score; // 0..3
      return { fired: s < 2, severity, confidence, value: round(s), detail: "0 violates .. 3 fully complies" };
    }
    case "hallucination_risk": {
      const s = (a as { score: number }).score; // 0..2
      return { fired: s >= 1, severity, confidence, value: round(s), detail: "0 none .. 2 many" };
    }
    case "tone": {
      const c = (a as { choice: string }).choice;
      // `unsafe` keeps the configured (hard) severity; `rude` is always soft.
      if (c === "unsafe") return { fired: true, severity, confidence, value: c };
      if (c === "rude") return { fired: true, severity: "soft", confidence, value: c };
      return { fired: false, severity, confidence, value: c };
    }
    case "category": {
      const c = (a as { choice: string }).choice;
      return { fired: c !== "none", severity, confidence, value: c };
    }
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
