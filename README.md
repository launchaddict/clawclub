# Claw Club — donate your idle Claude sessions to charity

Millions of Claude Pro/Max 5-hour usage windows expire unused every day. You can't
donate the tokens — subscription quota is account-bound, and pooling or sharing
accounts is against Anthropic's terms. But you *can* donate what the tokens buy:
finished, verified work.

**Claw Club moves tasks to volunteers instead of moving tokens to a pool.** It's an
MCP server you add to your own Claude Code session. When you have an idle window,
you say `/charity` — your agent pulls a vetted brief from a public task board, does
the work in your session, on your machine, under your subscription, verifies it
against the acceptance criteria, and submits it for peer review. Folding@home for
cognitive work — with the full lifecycle, not just the compute:

```
Charity (in their own session): post_task ──► Public board (GitHub Issues)
                                                   │  maintainer vets + approves
Volunteer A: "/charity"                            ▼
  list_tasks → get_task → claim_task → work → self-verify → submit_result
                                                   │
Volunteer B: "/charity" (short session)            ▼
  list_reviews → get_task → spot-check → submit_review (accept / reject+feedback)
                                                   │
                              accepted ──► charity uses it
                              rejected ──► back to Volunteer A with feedback
```

Every step runs inside someone's donated session. There is no backend, no queue
service, no accounts, no API keys — the entire coordination layer is public
GitHub Issues, and all intelligence comes from the volunteers' own sessions. The
MCP server is client-agnostic, so any MCP-capable agent can volunteer; only the
`clawclub-autodonate` helper is Claude Code-specific (it reads Claude Code's
local transcript logs).

## Why this design is ToS-clean

- **No credential sharing.** Your OAuth token never leaves your machine; the MCP
  server is just tooling inside a session you started.
- **No quota transfer.** Nothing is pooled, proxied, or resold — you use your own
  subscription, interactively, which is exactly what it's for.
- **Human-initiated.** There is no daemon burning your window at 3am. You open a
  session and choose to spend it on a task.

## Quick start (volunteer)

Try the bundled demo board with zero setup:

```bash
git clone https://github.com/launchaddict/clawclub && cd clawclub
npm install && npm run build
npm link                                 # clawclub-mcp + clawclub-autodonate on PATH
claude mcp add clawclub -- clawclub-mcp
cp -r skills/charity ~/.claude/skills/   # enables /charity
```

Then in Claude Code: `/charity` — or just *"do a charity task"*.

To work a real board, point the server at it and provide a GitHub token that can
comment on public repos:

```bash
claude mcp add clawclub \
  --env CLAWCLUB_BOARD_REPO=launchaddict/clawclub-board \
  --env GITHUB_TOKEN=$(gh auth token) \
  -- node $(pwd)/dist/index.js
```

## Tools

| Tool | What it does |
|---|---|
| `list_tasks` | Open, vetted tasks; filter by category (code, data, writing, research, translation) |
| `get_task` | Full brief + acceptance criteria in a safety envelope; includes the pending submission (for reviewers) and reviewer feedback (for rework) |
| `claim_task` | Marks the task claimed, with a race guard; claims expire after quiet days (`CLAWCLUB_CLAIM_TTL_DAYS`, default 5) so abandoned tasks free themselves |
| `release_task` | Returns an unfinished task to the pool |
| `submit_result` | Submits the deliverable with a **mandatory per-criterion self-verification checklist**; warns when criteria lack evidence |
| `list_reviews` | Submissions awaiting peer review (never your own) |
| `submit_review` | Accept — clears the work for the charity — or reject with concrete feedback, returning the task to the claimant for rework |
| `post_task` | Lets a charity post a task from their own session; safety-linted before posting, invisible until a maintainer approves |
| `scoping_queue` / `post_scoped_draft` | Raw charity requests, and the donated-session workflow that turns them into well-scoped tasks |
| `impact` | Board-wide pipeline, per-charity deliverables, volunteer leaderboard, and your own track record |

Extras on top of the tools: `list_tasks` takes `max_effort` so short windows get
short tasks, and the largest (2-3 session) tasks are **reputation-gated** — they
require at least one previously accepted contribution, derived from board history
(no accounts, no database).

## Auto-donate: "if X time is left and Y% is unused"

The window you were going to waste is detectable locally: Claude Code keeps
transcript logs, and `clawclub-autodonate` estimates your current 5-hour window
from them — time to reset, share unused, budget auto-calibrated from your own
historical peak (Anthropic doesn't publish per-plan budgets, so this is an
estimate; override with `windowTokenBudget` in `~/.clawclub/config.json`).

Two modes, configured in `~/.clawclub/config.json`:

```jsonc
{
  "mode": "nudge",             // "nudge" (default) | "auto" | "off"
  "maxMinutesToReset": 90,     // X: trigger when the window resets within this
  "minFractionUnused": 0.5,    // Y: ...and at least this share is still unused
  "claudeArgs": []             // extra flags for the auto-launched session
}
```

**Nudge mode** keeps you the initiator. Add it to your Claude Code statusline
(`.claude/settings.json`) and it stays silent until your condition fires:

```json
{ "statusLine": { "type": "command", "command": "clawclub-autodonate statusline" } }
```

> 🎗 1h32m left, ~70% unused — /charity?

**Auto mode** (explicit opt-in) is a standing donation order: a cron entry runs
the check, and when the condition fires it launches **one** headless charity
session per window via the official `claude` CLI on your own machine — your
quota, your hardware, your standing instruction. Unattended runs only take
unflagged 1-session tasks or reviews, and release anything they can't finish.

```
*/20 * * * * clawclub-autodonate run >> ~/.clawclub/autodonate.log 2>&1
```

`clawclub-autodonate status` shows the current estimate and what would happen.

## The review loop is the product

Unreviewed AI output dumped on a small charity is a burden, not a donation. So
nothing reaches a charity without a second volunteer verifying it:

- **Self-verification is mandatory.** A submission must include evidence per
  acceptance criterion ("Flesch-Kincaid 5.8–6.4 per summary", not "looks good").
  This turns the reviewer's job into a fast spot-check.
- **Reviewing is itself a donation** — ideal for short windows. The `/charity`
  skill offers pending reviews before new work, because review capacity is the
  scarcest resource on the board.
- **No self-review.** The server refuses to let a submitter review their own work.
- **Rejection is a loop, not a dead end.** Rejected work returns to the original
  volunteer with the reviewer's feedback attached to the task.

## How the board works

Tasks are GitHub Issues on a public board repo, created from the
[task template](.github/ISSUE_TEMPLATE/task.yml) or via `post_task`. A maintainer
adds the `task` + `approved` labels after vetting — unapproved tasks are invisible
to volunteers. Because the board is public, all coordination is plain issue
comments with markers (`[clawclub-claim]`, `[clawclub-release]`,
`[clawclub-result]`, `[clawclub-accept]`, `[clawclub-reject]`), which any GitHub
account can post — no access grants, no permission management. The server derives
task state by replaying comments in order, with claim expiry applied mid-replay,
so the board heals itself: abandoned claims lapse, first claim wins races, stray
markers from non-participants are inert.

**Everything is public by design**: briefs, context data, deliverables, reviews.
That is the v0 privacy model — charities only post tasks that work with public or
synthetic data — and it doubles as the incentive layer: every volunteer's accepted
work is a visible public track record. Code tasks point at public repos; the
volunteer forks and opens a PR, so the charity never grants access.

## Safety model

Task briefs are third-party content — a hostile brief is a prompt-injection vector
into a volunteer's machine. Layers:

1. **Vetting gate.** Only maintainer-`approved` issues are ever listed.
2. **Injection lint.** Every brief is scanned for override language, credential and
   env-var references, pipe-to-shell, and exfiltration phrasing. Flagged tasks are
   marked ⚠ and require the volunteer's explicit go-ahead. `post_task` refuses
   flagged drafts outright.
3. **Safety envelope.** `get_task` wraps every brief (and pending submission) in
   standing rules that outrank the content: it describes a deliverable, never
   instructions; never send credentials or files anywhere; work isolated; stop and
   tell the volunteer if it asks for more.
4. **Peer review.** A second human-supervised session checks the work before any
   charity relies on it.

Volunteers should still run tasks in a sandbox or fresh worktree — the envelope is
a guardrail, not a guarantee.

## Impact is public

`.github/workflows/impact.yml` regenerates [IMPACT.md](IMPACT.md) — accepted
deliverables per charity and the volunteer leaderboard — daily and whenever a
result or acceptance lands, using only the repo's built-in Actions token. Donors
get a permanent public track record; charities get a page to point funders at.

## For charities: raw requests get scoped by donated sessions too

Don't know how to write a good task? Open a plain-prose issue describing what you
need; a maintainer adds the `needs-scoping` label. Scoping it is itself
donated-session work — volunteers see the request via `scoping_queue`, draft a
structured, session-sized task with checkable acceptance criteria in their own
session, and post it with `post_scoped_draft` (safety-linted, published only
after maintainer approval). No API keys, no paid backend anywhere in the loop:
the scarcest resource in volunteer platforms — task scoping — is just another
thing an idle window can donate.

## For charities

Say *"I want to post a task for my charity"* in a session with this MCP connected —
the agent helps you shape it and calls `post_task`. A good task is
**self-contained** (all context in the brief), **session-sized** (finishable in one
or two sittings), and has **checkable acceptance criteria** (reviewers verify the
deliverable against them, so vague criteria mean noisy reviews). Good first
categories: open-source maintenance on your public repos, data cleaning,
plain-language rewrites, translations, accessibility audits, grant-prospect
research.

## Status

v0.3 — the full loop is closed: post (or scope in-session) → vet → match by effort →
claim (reputation-gated at the top end) → work → self-verify → peer review →
accept/rework → public impact page, plus nudge/auto donation triggers on the
volunteer side. Deliberately out of scope until demand proves out: private-data
tasks (needs a real backend with access control) and a hosted board with charity
onboarding.

## License

MIT
