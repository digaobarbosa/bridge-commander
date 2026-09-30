---
name: bridge-sync
description: Link the current Codex or Claude session to a Bridge Commander card and sync its problem, progress, and PR, Slack, Linear, or other references with a lightweight model. Use for board-managed and independently started sessions across development stages.
---

# Bridge sync

Keep a durable link from a card back to the **current development conversation**. A checkpoint
updates the card through `POST /api/sessions/sync`; the server deduplicates by host, provider,
and exact session UUID. Board-managed workers use the same link as independently started sessions.

## Capture identity before summarizing

- Codex: use the current `CODEX_THREAD_ID`, or an exact session ID supplied by the caller.
- Claude: use the exact `session_id` from the invoking hook/caller, or an explicit session ID.
  Never guess from the newest transcript or use `--continue`/`--last` as identity.
- Include the original conversation's absolute working directory, hostname, and `surface`
  (`app` for a desktop conversation, `cli` for a terminal conversation).
- If identity is unavailable, obtain the exact ID before writing a card. A summarizer's session
  ID is never the development session ID.

## Sync a checkpoint

Resolve `scripts/sync.js` relative to this skill directory. Save a short checkpoint (at most
12 KB) to a temporary UTF-8 file: the original problem and why it matters, agreed approach,
work completed, evidence, current stage, next action, blockers, and relevant source links.
Include the background needed to understand the task, not just the latest progress message.
Use a file/tool argument for content; do not interpolate conversation text into a shell command.

Before replacing an existing card's body, read its description and retain useful requirements,
notes, decisions, and references in the checkpoint. Gather source links from the conversation,
card brief, and current development artifacts. Include PR URLs and their purpose, the Slack
thread or Linear ticket that triggered the work, and relevant specs, issues, or commits when
available. Use scoped read-only lookups when a referenced item needs its exact URL or title;
do not search unrelated history. Never invent URLs, PRs, tickets, or claims about their status.

The small model writes both a short timeline summary and a Markdown card body. The body should
let someone understand the task without opening this conversation: explain the problem and
intended behavior, describe the approach, state progress and evidence, and give the next step.
Include a References section with descriptive clickable links when sources are known. Omit
empty sections and unsupported details; preserve exact URLs. A PR list alone is not a description.
Use `[short descriptive label](exact URL)` so long source URLs do not overwhelm the card.

Run the helper with the captured identity and `--checkpoint-file`:

```sh
node /absolute/path/to/bridge-sync/scripts/sync.js \
  --provider codex --session-id EXACT_UUID --cwd /absolute/project/path \
  --surface app --workspace /absolute/board/workspace \
  --checkpoint-file /absolute/checkpoint.txt
```

The helper runs a **separate one-shot lightweight model**, defaulting to `gpt-6-luna` for
Codex and `haiku` for Claude. It does not change the development conversation's model or
resume it. Configure `--model` or `BRIDGE_SYNC_MODEL` when a different small model is available.
If the small runner fails, report the failure; do not silently summarize with the development
model or claim that the card was updated.

The helper discovers the board by walking up from its invocation directory for
`.bridge-commander/config.json` or `board.json` (legacy `.bridge-command` also works).
Use `--workspace`, `--board-url`, or `BRIDGE_SYNC_URL` when the board is elsewhere.
It never initializes or restarts the board. Network calls time out after 10 seconds; model
calls after 120 seconds. Both limits are configurable with the helper's `--help` flags.

Pass `--card CARD_ID` to link an existing card. With no card, the server reuses the card already
holding this session, including a regular Commander worker. For a new session, provide
`--owner LIEUTENANT_ID --title "Task title"`; read `GET /api/board` if owner/card selection needs
discovery. Do not create a duplicate when a session belongs to an archived card: report the
server's refusal or use a caller-selected active target card.

Checkpoints carry `body` (Markdown), `summary`, `stage` (`planning`, `implementation`, `review`,
`peer`), `nextAction`, and `blocker`. A supplied body replaces the card description; leaving it
out preserves the existing description. Managed cards keep their orchestrator-owned column.
External companion cards can follow their stage without launching a worker. Completion and archival
remain deliberate board actions.

Explicit checkpoint fields supplied by the caller take precedence over the small model's
suggestions (for example `--stage planning`). Use `--body-file FILE` to supply an exact Markdown
description instead of the generated body.

## Direct API input and hooks

For a prepared checkpoint, `--stdin` or `--input FILE` accepts JSON with `card`, `owner`,
`title`, `session: {provider, id, cwd, host, surface}`, and the checkpoint fields, including
optional `body` (up to 20,000 characters). This path does not invoke a model.
Claude hook JSON containing `session_id` and `cwd` is accepted with
`--provider claude`; hook installation is separate from invoking this skill.

Use the returned card/session to confirm the link and report the update briefly. The card's eye
can open/resume the original conversation across development stages. This skill is a checkpoint
command; it does not install a background watcher or continuously sync every message.
