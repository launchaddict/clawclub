import type { Submission, Task, TaskBoard, TaskStatus } from "../types.js";
import { lintBrief } from "../safety.js";

// GitHub-Issues-backed board. Tasks are open issues on the board repo carrying
// the labels `task` and `approved` (the approval label is the charity-side
// vetting gate — unapproved tasks are never listed). Volunteers usually have
// no write access to the board repo, so all coordination happens through
// comments with machine-readable markers, which any GitHub account can post:
//
//   [clawclub-claim]    the comment author claims the task
//   [clawclub-release]  the current claimant releases it
//   [clawclub-result]   the current claimant submits a result for review
//
// Claim state is derived by replaying comments in order.

const CLAIM = "[clawclub-claim]";
const RELEASE = "[clawclub-release]";
const RESULT = "[clawclub-result]";

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
}

interface GhComment {
  body: string;
  user: { login: string };
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

  private async claimState(
    issueNumber: number,
  ): Promise<{ status: TaskStatus; claimedBy?: string }> {
    const comments = await this.api<GhComment[]>(
      `/repos/${this.repo}/issues/${issueNumber}/comments?per_page=100`,
    );
    let claimedBy: string | undefined;
    let submitted = false;
    for (const c of comments) {
      const body = c.body ?? "";
      if (body.includes(RESULT) && c.user.login === claimedBy) {
        submitted = true;
      } else if (body.includes(CLAIM) && !claimedBy && !submitted) {
        claimedBy = c.user.login;
      } else if (body.includes(RELEASE) && c.user.login === claimedBy && !submitted) {
        claimedBy = undefined;
      }
    }
    if (submitted) return { status: "submitted", claimedBy };
    if (claimedBy) return { status: "claimed", claimedBy };
    return { status: "open" };
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
    const state = await this.claimState(issue.number);
    return {
      id: String(issue.number),
      title: issue.title,
      ...parsed,
      ...state,
      url: issue.html_url,
      flags: lintBrief(`${issue.title}\n${body}`),
    };
  }

  async listTasks(category?: string): Promise<Task[]> {
    const issues = await this.api<GhIssue[]>(
      `/repos/${this.repo}/issues?labels=task,approved&state=open&per_page=100`,
    );
    const tasks = await Promise.all(issues.map((i) => this.toTask(i)));
    return tasks.filter(
      (t) => !category || t.category.toLowerCase() === category.toLowerCase(),
    );
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
    if (task.status === "submitted") {
      throw new Error(`Task ${id} already has a submitted result.`);
    }
    if (task.status === "claimed") {
      if (task.claimedBy === me) return task;
      throw new Error(`Task ${id} is already claimed by ${task.claimedBy}.`);
    }
    await this.comment(id, `${CLAIM}\nClaimed via clawclub-mcp.`);
    return this.getTask(id);
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
    const parts = [
      RESULT,
      `**Summary:** ${submission.summary}`,
      submission.resultUrl ? `**Result:** ${submission.resultUrl}` : "",
      submission.resultBody ? `\n---\n\n${submission.resultBody}` : "",
      "\n_Submitted for review via clawclub-mcp. A reviewer from the charity should verify this against the acceptance criteria before use._",
    ].filter(Boolean);
    await this.comment(submission.taskId, parts.join("\n"));
    return this.getTask(submission.taskId);
  }
}
