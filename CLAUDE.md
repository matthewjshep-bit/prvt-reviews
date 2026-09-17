# Shep Flips — offer generator

Real-estate wholesaling app: underwrites listings, sends offers to listing agents, and runs a conversation bot that texts real agents and investors through GoHighLevel (GHL). RUNBOOK.md is the operational spec; read the relevant section before changing a feature.

## Layout

- `shared/` — pure rules modules, the source of truth. The frontend imports them through the `@shared` Vite alias.
- `ghl-broker/` — Express backend (Render). Runs **vendored copies** in `ghl-broker/shared/`.
- `messaging-app/` — React + Vite frontend (Netlify).
- `cardgen/` — image render microservice (Render, Docker). No tests.

There is no root package.json. Each package installs on its own.

## Rules that bite

- **Edit `/shared`, never `ghl-broker/shared` or `cardgen/shared`.** Then run `node scripts/sync-shared.mjs` and commit the copies. A new shared module the broker imports must be added to the `ghl-broker` file list in that script. CI fails when the copies are stale.
- **Every push to `main` deploys to production** (Render + Netlify). There is no staging. Check a deploy with `GET /` on the broker, which prints the live commit.
- Pure logic goes in `shared/`; I/O goes in a `ghl-broker/` runner that takes `store` and `deps`. Tests stub the model and the network through `deps` and `globalThis.fetch`.
- Scheduled jobs hang off the 15-minute tick in `ghl-broker/broker.js` and keep durable state in `job_cursors`. Copy the gating in `ghl-broker/conversation-audit.js` (`maybeRunConversationAudit`): write the cursor before the run, retry a stale run, cap the daily tries.
- The store has two backends, Postgres and a JSON-file fallback, in `ghl-broker/store.js`. A new store method needs both. Schema lives in `ghl-broker/schema.pg.sql` and is applied on boot, so it must be additive and idempotent.
- `settings.conversationAi` is normalised by `normalizeConversationAi` in `shared/conversation-ai.js`. A new key needs a default and a normaliser branch or it is dropped on save.

## Never, without Matt saying so in the task

- Turn on or default-on any send or spend switch: `CARD_SENDS_ENABLED`, `OUTREACH_IMPORTS_ENABLED`, `DISPO_BLASTS_ENABLED`, `AUTO_UNDERWRITE_ENABLED`. New automation ships off by default.
- Loosen `NEVER_AUTO`, `GUARDED_AUTO`, `evaluateReplyGates`, the counter-band ceiling (`shared/auto-accept.js`), or the daily caps.
- Drop or rewrite a table or column.
- Put a contact's phone, email, full name, or message text in a log line, an error record, a commit, an issue, or a PR.
- `git add -A`. Stage the files you changed by name.

## Tests

```
cd ghl-broker && npm run test:all     # broker + shared, node:test, ~6s, no secrets
cd messaging-app && npm test          # vitest
cd messaging-app && npm run build
```

Tests sit beside their sources as `*.test.mjs`. Several bind a fixed localhost port; give a new one a port no other test file uses. A bug fix starts with a failing test named for what went wrong in plain words, in the style of `ghl-broker/reply-agent.test.mjs`.

## Commits

Conventional prefix, then a plain sentence saying what changed for the person using it: `fix(conversation): an agent who asks for it by email gets it by email`. No PRs are required for Matt's own work; agent work goes on a branch and opens a PR.
