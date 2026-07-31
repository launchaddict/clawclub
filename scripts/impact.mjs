#!/usr/bin/env node
// Generates IMPACT.md — the board's public track record — from board history.
// Run by .github/workflows/impact.yml on the board repo; can also be run
// manually: CLAWCLUB_BOARD_REPO=owner/repo GITHUB_TOKEN=... node scripts/impact.mjs
import fs from "node:fs";
import { GitHubBoard } from "../dist/boards/github.js";

const repo = process.env.CLAWCLUB_BOARD_REPO ?? process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repo || !token) {
  console.error("Set CLAWCLUB_BOARD_REPO (or GITHUB_REPOSITORY) and GITHUB_TOKEN.");
  process.exit(1);
}

const board = new GitHubBoard(repo, token);
const stats = await board.impactStats();

const charities = Object.entries(stats.acceptedByCharity).sort((a, b) => b[1] - a[1]);
const volunteers = Object.entries(stats.acceptedByVolunteer).sort((a, b) => b[1] - a[1]);

const md = `# Impact

*What donated Claude sessions have produced on this board. Regenerated automatically — do not edit by hand.*

**Pipeline right now:** ${stats.open} open · ${stats.inProgress} in progress · ${stats.awaitingReview} awaiting review · **${stats.accepted} accepted deliverables**

## Delivered to charities

${charities.length ? charities.map(([c, n]) => `- **${c}** — ${n} accepted deliverable(s)`).join("\n") : "_Nothing accepted yet — [pick a task](README.md#quick-start-volunteer) and be the first._"}

## Volunteers

${volunteers.length ? volunteers.map(([v, n], i) => `${i + 1}. [@${v}](https://github.com/${v}) — ${n} accepted contribution(s)`).join("\n") : "_No contributions yet._"}

---
_Accepted means a second volunteer verified the work against the task's acceptance criteria. See [README](README.md) for how the board works._
`;

fs.writeFileSync(new URL("../IMPACT.md", import.meta.url), md);
console.log(`IMPACT.md regenerated for ${repo}: ${stats.accepted} accepted, ${volunteers.length} volunteer(s).`);
