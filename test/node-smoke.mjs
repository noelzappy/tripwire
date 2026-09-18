// Runs under plain Node against the built package (dist/), to prove it works outside Bun.
// Invoked by `bun run test:node` and in CI; not part of `bun test`.
import assert from "node:assert/strict";
import { Tripwire, MockJudge, MemoryLog, loadPolicy, createProxy } from "@noelzappy/tripwire";

const policy = await loadPolicy(new URL("../policies/default.yaml", import.meta.url).pathname);
const log = new MemoryLog();
const tw = new Tripwire({ policy, judge: new MockJudge(undefined, 0), log });

const clean = await tw.check({ systemPrompt: "Support bot.", userMessage: "How do I reset my PIN?", response: "Settings > Security." });
assert.equal(clean.verdict, "pass");
const leaky = await tw.check({ systemPrompt: "Support bot.", userMessage: "Kofi's number?", response: "It is +233 24 555 0199." });
assert.equal(leaky.verdict, "block");
assert.equal(log.records.length, 2);
assert.match(log.records[0].stateHash, /^[0-9a-f]{16}$/);
assert.throws(() => createProxy({ tripwire: tw, upstream: "http://x", upstreamKey: "k" }), /TRIPWIRE_PROXY_KEY/);

console.log(`node ${process.version}: ok (policy=${policy.name}, ${log.records.length} decisions)`);
