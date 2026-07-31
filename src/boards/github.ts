import {
  CLAIM_TTL_MS,
  computeStats,
  type BoardStats,
  type Review,
  type ScopingRequest,
  type Submission,
  type Task,
  type TaskBoard,
  type TaskDraft,
  type TaskStatus,
} from "../types.js";
import { lintBrief } from "../safety.js";

// GitHub-Issues-backed board. Tasks are open issues on the board repo carrying
// the labels `task` and `approved` (the approval label is the maintainer-side
// vetting gate — unapproved tasks are never listed). Volunteers usually have
// no write access to the board repo, so all coordination happens through
// comments with machine-readable markers, which any GitHub account can post:
//
//   [clawclub-claim]    the comment author claims the task
//   [clawclub-release]  the current claimant releases it
//   [clawclub-result]   the current claimant submits a result for review
//   [clawclub-accept]   a reviewer (not the claimant) accepts the submission
//   [clawclub-reject]   a reviewer rejects it; the task returns to the
//                       claimant for rework with the reviewer's feedback
//
// State is derived by replaying comments in chronological order. Claims that
// go quiet longer than the TTL expire mid-replay, so an abandoned task can be
// re-claimed by anyone without maintainer intervention.

const CLAIM = "[clawclub-claim]";
const RELEASE = "[clawclub-release]";
const RESULT = "[clawclub-result]";
const ACCEPT = "[clawclub-accept]";
const REJECT = "[clawclub-reject]";

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
}

interface GhComment {
  body: string;
  created_at: string;
  user: { login: string };
}

interface ReplayState {
  status: TaskStatus;
  claimedBy?: string;
  latestSubmission?: string;
  reviewFeedback?: string;
}

export function replayComments(
  comments: Array<{ body: string; author: string; at: number }>,
  now: number,
): ReplayState {
  let claimedBy: string | undefined;
  let claimSince = 0;
  let expiredClaimant: string | undefined;
  let submitted = false;
  let accepted = false;
  let latestSubmission: string | undefined;
  let reviewFeedback: string | undefined;

  const expireIfStale = (at: number) => {
    if (claimedBy && !submitted && at - claimSince > CLAIM_TTL_MS) {
      expiredClaimant = claimedBy;
      claimedBy = undefined;
    }
  };

  for (const c of comments) {
    if (accepted) break;
    expireIfStale(c.at);
    const body = c.body ?? "";
    if (body.includes(CLAIM)) {
      if (!claimedBy && !submitted) {
        claimedBy = c.author;
        claimSince = c.at;
        expiredClaimant = undefined;
      }
    } else if (body.includes(RELEASE)) {
      if (claimedBy === c.author && !submitted) {
        claimedBy = undefined;
        expiredClaimant = undefined;
      }
    } else if (body.includes(RESULT)) {
      // The claimant submits; an expired claimant may still submit late as
      // long as nobody else claimed in the meantime.
      if (claimedBy === c.author || (!claimedBy && expiredClaimant === c.author)) {
        claimedBy = c.author;
        submitted = true;
        latestSubmission = body.replace(RESULT, "").trim();
        reviewFeedback = undefined;
      }
    } else if (body.includes(ACCEPT)) {
      if (submitted && c.author !== claimedBy) accepted = true;
    } else if (body.includes(REJECT)) {
      if (submitted && c.author !== claimedBy) {
        submitted = false;
        reviewFeedback = body.replace(REJECT, "").trim();
        claimSince = c.at; // rework clock restarts at the rejection
      }
    }
  }
  if (!accepted) expireIfStale(now);

  const status: TaskStatus = accepted
    ? "accepted"
    : submitted
      ? "submitted"
      : claimedBy
        ? "claimed"
        : "open";
  return { status, claimedBy, latestSubmission, reviewFeedback };
}

export class GitHubBoard implements TaskBoard {
  private repo: string;
  private token: string;
  private login: string | null = null;

  constructor(repo: string, token: string) {
    this.repo = repo;
    this.token = token;
  }

  name(): string {
    return `GitHub board ${this.repo}`;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} on ${path}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  async whoami(): Promise<string> {
    if (!this.login) {
      const user = await this.api<{ login: string }>("/user");
      this.login = user.login;
    }
    return this.login;
  }

  private async replayState(issueNumber: string | number): Promise<ReplayState> {
    const comments = await this.api<GhComment[]>(
      `/repos/${this.repo}/issues/${issueNumber}/comments?per_page=100`,
    );
    return replayComments(
      comments.map((c) => ({
        body: c.body ?? "",
        author: c.user.login,
        at: Date.parse(c.created_at),
      })),
      Date.now(),
    );
  }

  private parseBody(body: string): {
    charity: string;
    category: string;
    estimatedEffort: string;
    brief: string;
    acceptanceCriteria: string[];
  } {
    // Matches the issue-template headings; anything unmatched falls back to
    // treating the whole body as the brief.
    const section = (name: string): string | undefined => {
      const match = body.match(
        new RegExp(`###\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n###\\s|$)`, "i"),
      );
      return match?.[1].trim();
    };
    const criteria = (section("Acceptance criteria") ?? "")
      .split("\n")
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);
    return {
      charity: section("Charity") ?? "unknown",
      category: section("Category") ?? "general",
      estimatedEffort: section("Estimated effort") ?? "unknown",
      brief: section("Brief") ?? body.trim(),
      acceptanceCriteria: criteria,
    };
  }

  private async toTask(issue: GhIssue): Promise<Task> {
    const body = issue.body ?? "";
    const parsed = this.parseBody(body);
    const state = await this.replayState(issue.number);
    return {
      id: String(issue.number),
      title: issue.title,
      ...parsed,
      ...state,
      url: issue.html_url,
      flags: lintBrief(`${issue.title}\n${body}`),
    };
  }

  private async fetchIssues(state: "open" | "all"): Promise<GhIssue[]> {
    const issues: GhIssue[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.api<GhIssue[]>(
        `/repos/${this.repo}/issues?labels=task,approved&state=${state}&per_page=100&page=${page}`,
      );
      issues.push(...batch);
      if (batch.length < 100) break;
    }
    // The issues endpoint also returns PRs; a board repo shouldn't have
    // task-labeled PRs, but filter defensively.
    return issues.filter((i) => !("pull_request" in i));
  }

  async listTasks(category?: string): Promise<Task[]> {
    const issues = await this.fetchIssues("open");
    const tasks = await Promise.all(issues.map((i) => this.toTask(i)));
    return tasks.filter(
      (t) => !category || t.category.toLowerCase() === category.toLowerCase(),
    );
  }

  async impactStats(): Promise<BoardStats> {
    // Includes closed issues so accepted-and-closed work still counts toward
    // volunteers' track records and charities' totals.
    const issues = await this.fetchIssues("all");
    const tasks = await Promise.all(issues.map((i) => this.toTask(i)));
    return computeStats(tasks);
  }

  async getTask(id: string): Promise<Task> {
    const issue = await this.api<GhIssue>(`/repos/${this.repo}/issues/${id}`);
    const labels = issue.labels.map((l) => l.name);
    if (!labels.includes("task") || !labels.includes("approved")) {
      throw new Error(
        `Issue #${id} is not an approved task (labels: ${labels.join(", ") || "none"}).`,
      );
    }
    return this.toTask(issue);
  }

  private async comment(issueNumber: string, body: string): Promise<void> {
    await this.api(`/repos/${this.repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async claimTask(id: string): Promise<Task> {
    const task = await this.getTask(id);
    const me = await this.whoami();
    if (task.status === "accepted" || task.status === "submitted") {
      throw new Error(`Task ${id} is ${task.status} — not claimable.`);
    }
    if (task.status === "claimed") {
      if (task.claimedBy === me) return task;
      throw new Error(`Task ${id} is already claimed by ${task.claimedBy}.`);
    }
    await this.comment(id, `${CLAIM}\nClaimed via clawclub-mcp.`);
    // Race guard: someone may have claimed between our read and our comment.
    // Replay decides the winner (first claim comment); a losing claim comment
    // is inert, so just report the loss.
    const after = await this.getTask(id);
    if (after.claimedBy !== me) {
      throw new Error(
        `Task ${id} was claimed by ${after.claimedBy} just before you — your claim comment has no effect. Pick another task.`,
      );
    }
    return after;
  }

  async releaseTask(id: string): Promise<Task> {
    const task = await this.getTask(id);
    const me = await this.whoami();
    if (task.status !== "claimed" || task.claimedBy !== me) {
      throw new Error(`Task ${id} is not claimed by you.`);
    }
    await this.comment(id, `${RELEASE}\nReleased — this task is open again.`);
    return this.getTask(id);
  }

  async submitResult(submission: Submission): Promise<Task> {
    const task = await this.getTask(submission.taskId);
    const me = await this.whoami();
    if (task.status !== "claimed" || task.claimedBy !== me) {
      throw new Error(`Claim task ${submission.taskId} before submitting a result.`);
    }
    const checklist = submission.verification
      .map((v) => `- [x] **${v.criterion}** — ${v.evidence}`)
      .join("\n");
    const parts = [
      RESULT,
      `**Summary:** ${submission.summary}`,
      submission.resultUrl ? `**Result:** ${submission.resultUrl}` : "",
      `\n**Self-verification against acceptance criteria:**\n${checklist}`,
      submission.resultBody ? `\n---\n\n${submission.resultBody}` : "",
      "\n_Submitted via clawclub-mcp. Awaiting peer review before the charity uses it._",
    ].filter(Boolean);
    await this.comment(submission.taskId, parts.join("\n"));
    return this.getTask(submission.taskId);
  }

  async submitReview(review: Review): Promise<Task> {
    const task = await this.getTask(review.taskId);
    const me = await this.whoami();
    if (task.status !== "submitted") {
      throw new Error(`Task ${review.taskId} has no submission awaiting review.`);
    }
    if (task.claimedBy === me) {
      throw new Error(`You made this submission — you cannot review your own work.`);
    }
    const marker = review.verdict === "accept" ? ACCEPT : REJECT;
    const heading =
      review.verdict === "accept"
        ? "Reviewed and **accepted** — verified against the acceptance criteria."
        : "Reviewed and **rejected** — returned to the claimant for rework.";
    await this.comment(
      review.taskId,
      `${marker}\n${heading}\n\n${review.feedback}\n\n_Reviewed via clawclub-mcp._`,
    );
    return this.getTask(review.taskId);
  }

  // Raw charity requests waiting to be turned into structured tasks. Scoping
  // them is itself donated-session work — no API keys, no backend: a
  // volunteer's own session reads the prose and drafts the structured task.
  async scopingQueue(): Promise<ScopingRequest[]> {
    const issues = await this.api<GhIssue[]>(
      `/repos/${this.repo}/issues?labels=needs-scoping&state=open&per_page=100`,
    );
    return issues
      .filter((i) => !("pull_request" in i))
      .map((i) => ({
        id: String(i.number),
        title: i.title,
        body: i.body ?? "",
        url: i.html_url,
      }));
  }

  async postScopedDraft(requestId: string, draft: TaskDraft, notes: string): Promise<string> {
    const flags = lintBrief(`${draft.title}\n${draft.brief}`);
    const body = [
      "## Structured draft (scoped in a donated session)",
      "",
      `### Charity\n${draft.charity}`,
      `### Category\n${draft.category}`,
      `### Estimated effort\n${draft.estimatedEffort}`,
      `### Brief\n${draft.brief}`,
      `### Acceptance criteria\n${draft.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
      "",
      `**Suggested title:** ${draft.title}`,
      `**Notes for maintainer:** ${notes}`,
      `**Safety lint:** ${flags.length ? `⚠ flagged: ${flags.join(", ")} — do not approve as-is` : "clean"}`,
      "",
      "To publish: replace the issue body with the draft above (from `### Charity` through the criteria), set the title, then swap the `needs-scoping` label for `task` + `approved`.",
      "",
      "_Scoped via clawclub-mcp._",
    ].join("\n");
    await this.comment(requestId, body);
    const issue = await this.api<GhIssue>(`/repos/${this.repo}/issues/${requestId}`);
    return issue.html_url;
  }

  async postTask(draft: TaskDraft): Promise<string> {
    const flags = lintBrief(`${draft.title}\n${draft.brief}`);
    if (flags.length) {
      throw new Error(
        `Draft failed the safety lint (${flags.join(", ")}). Rework the brief — it must describe a deliverable, not reference credentials, shell pipelines, or agent instructions.`,
      );
    }
    const body = [
      `### Charity\n${draft.charity}`,
      `### Category\n${draft.category}`,
      `### Estimated effort\n${draft.estimatedEffort}`,
      `### Brief\n${draft.brief}`,
      `### Acceptance criteria\n${draft.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
    ].join("\n\n");
    const issue = await this.api<GhIssue>(`/repos/${this.repo}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: `[Task] ${draft.title}`, body }),
    });
    return issue.html_url;
  }
}
