/**
 * Builds the text Jev judges. Fixed section headers so the mock judge, the eval
 * harness and a human reading the decision log all see the same shape.
 * Budget: Jev accepts ~32k tokens. We reserve most of it for the response and
 * the last user message, and trim the system prompt and history first.
 */

export interface Exchange {
  systemPrompt: string;
  /** Prior turns, oldest first, excluding the last user message. */
  history?: { role: "user" | "assistant"; text: string }[];
  userMessage: string;
  response: string;
  forbiddenTopics?: string[];
}

export interface StateBudget {
  maxChars: number;      // total; ~4 chars per token
  systemChars: number;
  historyChars: number;
}

export const DEFAULT_BUDGET: StateBudget = { maxChars: 100_000, systemChars: 12_000, historyChars: 20_000 };

const TRUNC = "\n[...truncated by tripwire...]";

function clip(s: string, max: number, fromStart = false): string {
  if (s.length <= max) return s;
  return fromStart ? TRUNC + s.slice(s.length - max + TRUNC.length) : s.slice(0, max - TRUNC.length) + TRUNC;
}

export function buildState(x: Exchange, budget: StateBudget = DEFAULT_BUDGET): string {
  const sys = clip(x.systemPrompt.trim() || "(none)", budget.systemChars);
  const hist = (x.history ?? []).map((m) => `${m.role.toUpperCase()}: ${m.text}`).join("\n");
  const history = clip(hist, budget.historyChars, true); // keep the most recent history
  const forbidden = (x.forbiddenTopics ?? []).map((t) => `- ${t}`).join("\n") || "- none";

  const fixed = `SYSTEM PROMPT:\n${sys}\n\nFORBIDDEN TOPICS:\n${forbidden}\n\n` + (history ? `HISTORY:\n${history}\n\n` : "");
  const remaining = Math.max(4_000, budget.maxChars - fixed.length - 60);
  // Split what is left between user message and response, response first.
  const respMax = Math.floor(remaining * 0.7);
  const response = clip(x.response, respMax);
  const user = clip(x.userMessage, remaining - response.length);

  return `${fixed}USER MESSAGE:\n${user}\n\nASSISTANT RESPONSE:\n${response}`;
}
