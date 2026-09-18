/**
 * A policy says which checks run, how confident Jev must be before a check
 * counts, and what a `block` does to the response. Load from YAML/JSON or
 * build in code. Unknown keys are rejected so typos don't silently disable a check.
 */

export type CheckId =
  | "on_topic"
  | "follows_system"
  | "pii_leak"
  | "injection_complied"
  | "tone"
  | "hallucination_risk"
  | "category";

export type Severity = "hard" | "soft";

export interface CheckConfig {
  enabled: boolean;
  /** hard: can block. soft: can only flag. */
  severity: Severity;
  /** Confidence needed for a hard check to block; below it the check flags. */
  threshold: number;
}

export interface Policy {
  name: string;
  /** Short statement of what the assistant is for. Given to Jev alongside the system prompt. */
  purpose?: string;
  /** Topics the assistant must not discuss. Become `category` options. Max 254. */
  forbiddenTopics: string[];
  checks: Record<CheckId, CheckConfig>;
  /** What happens to the response on block. `annotate` leaves it untouched. */
  onBlock: "replace" | "throw" | "annotate";
  blockMessage: string;
  /** sync: judge before returning. async: return immediately, judge in the background. */
  mode: "sync" | "async";
  /** Streaming: passthrough judges after the stream ends; buffer holds the whole stream until judged. */
  stream: "passthrough" | "buffer";
}

const check = (severity: Severity, threshold = 0.8, enabled = true): CheckConfig => ({ enabled, severity, threshold });

export const DEFAULT_POLICY: Policy = {
  name: "default",
  forbiddenTopics: [],
  checks: {
    pii_leak: check("hard", 0.85),
    injection_complied: check("hard", 0.8),
    tone: check("hard", 0.85),          // only the `unsafe` option is hard; `rude` flags
    category: check("hard", 0.8),
    on_topic: check("soft"),
    follows_system: check("soft"),
    hallucination_risk: check("soft"),
  },
  onBlock: "replace",
  blockMessage: "I can't share that response. Please rephrase or contact support.",
  mode: "sync",
  stream: "passthrough",
};

const CHECK_IDS: CheckId[] = ["on_topic", "follows_system", "pii_leak", "injection_complied", "tone", "hallucination_risk", "category"];
const POLICY_KEYS = new Set(["name", "purpose", "forbiddenTopics", "checks", "onBlock", "blockMessage", "mode", "stream"]);

/** Deep-merge a partial policy over the default, validating as we go. */
export type PolicyInput = Omit<Partial<Policy>, "checks"> & { checks?: Partial<Record<CheckId, Partial<CheckConfig>>> };

export function definePolicy(partial: PolicyInput): Policy {
  for (const k of Object.keys(partial)) if (!POLICY_KEYS.has(k)) throw new Error(`policy: unknown key "${k}"`);
  const checks = { ...DEFAULT_POLICY.checks } as Record<CheckId, CheckConfig>;
  for (const [id, c] of Object.entries(partial.checks ?? {})) {
    if (!CHECK_IDS.includes(id as CheckId)) throw new Error(`policy: unknown check "${id}"`);
    checks[id as CheckId] = { ...checks[id as CheckId], ...c };
    const t = checks[id as CheckId].threshold;
    if (t < 0 || t > 1) throw new Error(`policy: ${id}.threshold must be in [0,1]`);
  }
  const p: Policy = { ...DEFAULT_POLICY, ...(partial as Partial<Policy>), checks };
  if (p.forbiddenTopics.length > 254) throw new Error("policy: max 254 forbidden topics (Jev choice cap is 255 incl. none)");
  if (!["replace", "throw", "annotate"].includes(p.onBlock)) throw new Error(`policy: bad onBlock "${p.onBlock}"`);
  if (!["sync", "async"].includes(p.mode)) throw new Error(`policy: bad mode "${p.mode}"`);
  if (!["passthrough", "buffer"].includes(p.stream)) throw new Error(`policy: bad stream "${p.stream}"`);
  return p;
}

/** Load a .yaml/.yml/.json policy file. Uses Bun's built-in YAML parser. */
export async function loadPolicy(path: string): Promise<Policy> {
  const text = await Bun.file(path).text();
  const raw = /\.ya?ml$/.test(path) ? (Bun as any).YAML.parse(text) : JSON.parse(text);
  return definePolicy(raw);
}
