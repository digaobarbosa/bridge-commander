# Architecture

The server IS the harness: board state on disk is the canonical state of the world, and every
delivery to a lieutenant is a durable, at-least-once queue item. The conceptual API in
[docs/api/overview.md](docs/api/overview.md) is the DNA — the spec the implementation follows;
a disagreement between it and the code is a bug in one of them — change deliberately, never let
them drift.

Conversation links are persisted separately from worker records in `card.sessions`, with
`card.currentSession` selecting the current one. `server/sessions.js` validates identity and
owns checkpoint sync; the worker's stamp callback captures its conversation before teardown
and at turn-end. External companion cards have `execution: external`: their stage is mirrored
without harness lifecycle effects. The eye's navigation probes managed worker liveness on
demand and uses the saved link after the record is dropped. `skills/bridge-sync` uses a small
one-shot CLI model for checkpoint text and a deterministic HTTP helper for writes.

```
        captain (browser UI)                    agents (tmux sessions)
              │  clicks/drags = orders                ▲      ▲
              ▼                                       │      │ spawn/send/kill…
   ┌──────────────────────── server/server.js ────────┴──────┴───────────┐
   │  the harness: routes + SSE     harness port (harness/port.js)       │
   │  board.json  = canonical state    claude-tmux.js │ codex-tmux.js │ fake.js
   │  queue/*.jsonl = write-ahead, at-least-once delivery per lieutenant │
   │  supervision loop: dead lieutenant → resume; dead worker → flag     │
   │  PR watch: merged PR → archive card + release worktree + kill worker│
   │  the clock: schedules (board.json) → hook run → owner on a failure  │
   └──────────────────────────────────────────────────────────────────┬──┘
        ▲ bc-axi (CLI: drain/ack, cards, projects, worker verbs)       │
        │                                                              ▼
   lieutenant sessions (doctrine-launched, wake-driven)      worker worktrees
   first act of every turn: bc-axi drain → handle → ack      (treehouse/git, isolated)
```

- **Delivery is write-ahead and at-least-once**: every append lands in the durable queue
  first, then the server wakes the owning lieutenant — one coalesced
  `[bridge-commander] N pending item(s) — run: bc-axi drain` line typed into its live session,
  with the turn-end hook (`POST /api/turn-end`) re-nudging a lieutenant that ends a turn with
  items still unacked. A busy lieutenant gets at most one wake line per turn, and one the
  captain stopped (⏹, `POST /api/lieutenants/:id/interrupt`) gets none until a new item
  arrives — a queued wake would restart the stopped turn. Only ack removes; a dead session loses nothing; a server restart is a
  non-event. `server/delivery.js` owns all of it — queues, cursors, wakes, the owed projection —
  reading the queue files once at boot; the server is their only writer. What a drained item
  says to its reader — a head and a next-action hint per kind — is `server/feedtext.js`,
  rendered at drain time; `bc-axi drain` only prints it.
- **One door for board changes**: `server/store.js` holds the board in memory and is the only
  writer of `board.json` (temp file + rename). A change goes through `store.mutate(fn)`: the
  domain function validates before it touches the board, a refusal (`{error, code}`) writes
  nothing, anything else is saved once. The SSE board push is coalesced, so every change in one
  tick costs one rebuild of the served board. The router maps every domain result the same way:
  `{error, code}` answers `code`, anything else a 200.
- **The harness port** is the only seam to agent sessions — seven verbs (`spawn`, `send`,
  `alive`, `resumable`, `resume`, `kill`, `onTurnEnd`); see [harness/README.md](harness/README.md).
  Builtins: `claude` and `codex` over tmux, plus an in-memory `fake` for tests. server.js
  binds it once to the workspace's harness state dir and turn-end URL, so callers pass only
  real choices; harness file paths, the state key (`keyOf`) and tmux calls stay behind it.
- **Workers**: `bc-axi card start <id>` is ONE atomic op — isolated worktree
  (`treehouse get --lease` when available, else `git worktree add`), a real worker session
  launched with the card's brief — the card's playbook, a markdown file from
  `<workspace>/.bridge-commander/playbooks/`, rendered against the card as it stands at start —,
  session/worktree/branch bound to the card, card → Working. Workers report with
  `bc-axi worker signal|done`; the lieutenant verifies and hands off — nothing moves a card
  out of Working automatically — and the move that takes it out of Working is the worker's
  death: the session is killed and the worktree given back, so a card waiting on the captain
  pins neither (a playbook's `keep_worktree: true` holds both for a card reworked in place;
  a worktree still holding work is never released, though its session dies anyway) — running
  the playbook's `teardown` command in the checkout first, best effort, so nothing the run
  started outlives it. A server boot sweeps the leftovers the same way. The lifecycle is one
  module, `server/workers.js`: `transition(w, event)` is the only writer of a worker's flags,
  and `end(card, trigger)` — handoff, archive, merge, restart, sweep — the only way a worker
  ends, its rules one table (`END_OF_LIFE`). Its side effects are injected, so it is tested
  in-process against a stub harness and a fake clock.
- **The clock is a board object**: schedules live in `board.json` (so they travel with the
  repo, unlike host cron) and fire a NAMED HOOK through the same `hook run` every other caller
  uses. A schedule's cursor is the due time of the last window it handled, so a restart neither
  loses a window nor double-fires one; `overlap` and `catch-up` say what happens when a firing
  outlives its interval or the machine slept through one. A failed firing wakes the schedule's
  owner with the hook's output.
- **Supervision is infrastructure**: the server watches sessions, turn-ends, and PRs. Dead
  lieutenants are auto-respawned (resume), dead workers flag their owner, merged PRs archive
  the card, release the worktree, and kill the lingering worker session (never hand-archive
  merged work).

Lineage: UI and board mechanics evolve from
[bridge](https://github.com/tonylampada/claudegoodies); orchestration doctrine distills
firstmate.
