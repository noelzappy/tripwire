# Example: support bot

An Acme Bank support assistant built on the AI SDK, with tripwire as middleware. It runs three conversations (an ordinary question, a request for another customer's data, and a streamed prompt injection) and prints what the user would see plus each verdict.

```sh
cd examples/support-bot
bun install
bun start
```

With no keys it runs fully offline: a scripted model that misbehaves on cue, and tripwire's mock judge. Add keys to use the real thing:

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | answers come from `claude-sonnet-5` instead of the scripted model |
| `TYPESAFE_AI_API_KEY` | verdicts come from Jev instead of the mock judge |

A real model will usually refuse the bad requests on its own, so expect mostly `pass` verdicts in that mode. That's the normal case; tripwire is there for the times it doesn't.

## What to look at

- `policy.yaml`: which checks run, their thresholds, and `stream: buffer`, which holds streamed tokens until the judge has seen the whole answer.
- `index.ts`: `wrapLanguageModel({ model, middleware: tripwire(...) })` is the whole integration. The verdict is on `providerMetadata.tripwire`.
- `data/decisions.jsonl`: one line per judged response, with no message bodies.

This example depends on the repo checkout (`file:../..`) and runs with `--conditions=source`, so it uses tripwire's TypeScript source directly. In your own project:

```sh
npm install @noelzappy/tripwire ai
```
