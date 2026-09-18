/**
 * Replays a labelled JSONL dataset through a judge and reports, per check,
 * precision/recall on the fired path, the verdict confusion matrix, and coverage
 * (share of items auto-decided) at several confidence thresholds. Run with the
 * mock to test the harness, with Jev to get real numbers.
 *
 *   bun run eval/run.ts                       # eval/dataset.jsonl, judge from env
 *   bun run eval/run.ts path/to/set.jsonl --judge=jev --policy=policies/default.yaml
 *
 * Record shape: { system, user, response, history?, labels: { <checkId>: boolean }, expected: pass|flag|block }
 */
import { buildQuestions } from "../src/checks.ts";
import { JevJudge } from "../src/judge/jev.ts";
import { MockJudge } from "../src/judge/mock.ts";
import type { Judge } from "../src/judge/types.ts";
import { loadPolicy, type CheckId, type Policy } from "../src/policy.ts";
import { buildState } from "../src/state.ts";
import { decide } from "../src/verdict.ts";

interface Row { id?: string; system: string; user: string; response: string; history?: { role: "user" | "assistant"; text: string }[]; labels: Partial<Record<CheckId, boolean>>; expected: "pass" | "flag" | "block" }

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=") as [string, string]));
const file = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "eval/dataset.jsonl";
const policy: Policy = await loadPolicy(args.policy ?? "policies/default.yaml");
const judgeName = args.judge ?? process.env.TRIPWIRE_JUDGE ?? (process.env.TYPESAFE_AI_API_KEY ? "jev" : "mock");
const judge: Judge = judgeName === "jev" ? new JevJudge() : new MockJudge();
const concurrency = Number(args.concurrency ?? 4);

const rows: Row[] = (await Bun.file(file).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const questions = buildQuestions(policy);
console.log(`tripwire eval | ${rows.length} items | judge=${judge.name} | policy=${policy.name} | checks=${Object.keys(questions).join(",")}\n`);

type Out = { row: Row; verdict: ReturnType<typeof decide>; latency: number };
const results: Out[] = [];
let i = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (i < rows.length) {
    const row = rows[i++]!;
    const state = buildState({ systemPrompt: row.system, userMessage: row.user, response: row.response, history: row.history, forbiddenTopics: policy.forbiddenTopics });
    const t0 = performance.now();
    const j = await judge.judge(state, questions);
    results.push({ row, verdict: decide(j, policy), latency: performance.now() - t0 });
  }
}));

/* ---------------------------------------------------------------- per-check */
console.log("Per check (fired vs label):");
console.log(pad("check", 20), pad("n", 5), pad("tp", 4), pad("fp", 4), pad("fn", 4), pad("prec", 6), pad("rec", 6));
for (const id of Object.keys(questions) as CheckId[]) {
  let tp = 0, fp = 0, fn = 0, n = 0;
  for (const { row, verdict } of results) {
    const label = row.labels[id];
    if (label === undefined) continue;
    n++;
    const fired = verdict.checks[id]?.fired ?? false;
    if (fired && label) tp++; else if (fired && !label) fp++; else if (!fired && label) fn++;
  }
  console.log(pad(id, 20), pad(n, 5), pad(tp, 4), pad(fp, 4), pad(fn, 4), pad(pct(tp / (tp + fp)), 6), pad(pct(tp / (tp + fn)), 6));
}

/* ------------------------------------------------------------------ verdict */
console.log("\nVerdict confusion (rows = expected, cols = got):");
const V = ["pass", "flag", "block"] as const;
console.log(pad("", 8), ...V.map((v) => pad(v, 7)));
for (const e of V) console.log(pad(e, 8), ...V.map((g) => pad(results.filter((r) => r.row.expected === e && r.verdict.verdict === g).length, 7)));
const exact = results.filter((r) => r.row.expected === r.verdict.verdict).length;
const blockPrec = ratio(results.filter((r) => r.verdict.verdict === "block" && r.row.expected === "block").length, results.filter((r) => r.verdict.verdict === "block").length);
const blockRec = ratio(results.filter((r) => r.verdict.verdict === "block" && r.row.expected === "block").length, results.filter((r) => r.row.expected === "block").length);
const missedBlocks = results.filter((r) => r.row.expected === "block" && r.verdict.verdict === "pass").length;
console.log(`\nexact verdict match ${pct(exact / results.length)} | block precision ${pct(blockPrec)} | block recall ${pct(blockRec)} | blocks that PASSED (worst case): ${missedBlocks}`);

/* ----------------------------------------------------------------- coverage */
console.log("\nCoverage of hard checks at confidence thresholds (share of fired hard checks that would block):");
for (const t of [0.6, 0.7, 0.8, 0.9, 0.95]) {
  let fired = 0, above = 0, wrongAbove = 0;
  for (const { row, verdict } of results) for (const [id, c] of Object.entries(verdict.checks) as [CheckId, NonNullable<typeof verdict.checks[CheckId]>][]) {
    if (!c.fired || c.severity !== "hard") continue;
    fired++;
    if (c.confidence >= t) { above++; if (row.labels[id] === false) wrongAbove++; }
  }
  console.log(`  T=${t.toFixed(2)}  auto-block ${pad(pct(above / fired), 6)} of fired   false blocks at T: ${wrongAbove}`);
}

const lat = results.map((r) => r.latency).sort((a, b) => a - b);
console.log(`\nlatency p50 ${lat[Math.floor(lat.length / 2)]?.toFixed(0)} ms  p95 ${lat[Math.floor(lat.length * 0.95)]?.toFixed(0)} ms  | input tokens/item avg ${Math.round(results.reduce((s, r) => s + r.verdict.inputTokens, 0) / results.length)}`);
if (judge.name === "mock") console.log("\nNOTE: mock judge. These numbers test the harness and the dataset, not Jev.");

function pad(v: unknown, w: number) { return String(v).padEnd(w); }
function pct(x: number) { return Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "-"; }
function ratio(a: number, b: number) { return b ? a / b : NaN; }
