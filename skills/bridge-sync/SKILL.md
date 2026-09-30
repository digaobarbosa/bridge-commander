---
name: bridge-sync
description: Link the current Codex or Claude session to a Bridge Commander card and sync a recent development checkpoint with a lightweight model. Use for board-managed and independently started sessions, including planning, implementation, review, and peer review.
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

Resolve `scripts/sync.js` relative to this skill directory. Save a short recent checkpoint
(at most 12 KB) to a temporary UTF-8 file: purpose, work completed, evidence, current stage,
next action, and any blocker. Include only facts needed for the update, not the entire transcript.
Use a file/tool argument for content; do not interpolate conversation text into a shell command.

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

Checkpoints carry `summary`, `stage` (`planning`, `implementation`, `review`, `peer`),
`nextAction`, and `blocker`. Managed cards keep their orchestrator-owned column. External
companion cards can follow their stage without launching a worker. Completion and archival
remain deliberate board actions.

Explicit checkpoint fields supplied by the caller take precedence over the small model's
suggestions (for example `--stage planning`).

## Direct API input and hooks

For a prepared checkpoint, `--stdin` or `--input FILE` accepts JSON with `card`, `owner`,
`title`, `session: {provider, id, cwd, host, surface}`, and the checkpoint fields. This path
does not invoke a model. Claude hook JSON containing `session_id` and `cwd` is accepted with
`--provider claude`; hook installation is separate from invoking this skill.

Use the returned card/session to confirm the link and report the update briefly. The card's eye
can open/resume the original conversation across development stages. This skill is a checkpoint
command; it does not install a background watcher or continuously sync every message.
