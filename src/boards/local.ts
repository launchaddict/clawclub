import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAIM_TTL_MS,
  computeStats,
  type BoardStats,
  type Review,
  type Submission,
  type Task,
  type TaskBoard,
  type TaskDraft,
  type TaskStatus,
} from "../types.js";
import { lintBrief } from "../safety.js";

// File-backed demo board so the server can be tried with zero setup and no
// GitHub token. Seed tasks ship read-only in board/demo-tasks.json; claim,
// submission, and review state is kept in a separate gitignored state file.
// Identity comes from CLAWCLUB_VOLUNTEER, so the review flow can be exercised
// by running a second session under a different name.

interface SeedTask {
  id: string;
  title: string;
  charity: string;
  category: string;
  estimatedEffort: string;
  brief: string;
  acceptanceCriteria: string[];
}

interface TaskState {
  status: TaskStatus;
  claimedBy?: string;
  claimedAt?: number;
  latestSubmission?: string;
  reviewFeedback?: string;
}

interface DemoState {
  [taskId: string]: TaskState;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD_DIR = path.resolve(here, "..", "..", "board");
const SEED_FILE = path.join(BOARD_DIR, "demo-tasks.json");
const STATE_FILE = path.join(BOARD_DIR, "demo-state.json");

export class LocalBoard implements TaskBoard {
  private volunteer: string;

  constructor(volunteer = process.env.CLAWCLUB_VOLUNTEER ?? "demo-volunteer") {
    this.volunteer = volunteer;
  }

  name(): string {
    return "local demo board";
  }

  async whoami(): Promise<string> {
    return this.volunteer;
  }

  private readSeeds(): SeedTask[] {
    return JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  }

  private readState(): DemoState {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  }

  private writeState(state: DemoState): void {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }

  private effective(s: TaskState | undefined): TaskState {
    if (!s) return { status: "open" };
    // Claims (including rework after a rejection) expire after the TTL.
    if (
      s.status === "claimed" &&
      s.claimedAt !== undefined &&
      Date.now() - s.claimedAt > CLAIM_TTL_MS
    ) {
      return { status: "open" };
    }
    return s;
  }

  private toTask(seed: SeedTask, state: DemoState): Task {
    const s = this.effective(state[seed.id]);
    return {
      ...seed,
      status: s.status,
      claimedBy: s.claimedBy,
      latestSubmission: s.latestSubmission,
      reviewFeedback: s.reviewFeedback,
      flags: lintBrief(`${seed.title}\n${seed.brief}`),
    };
  }

  async listTasks(category?: string): Promise<Task[]> {
    const state = this.readState();
    return this.readSeeds()
      .map((seed) => this.toTask(seed, state))
      .filter((t) => !category || t.category.toLowerCase() === category.toLowerCase());
  }

  async getTask(id: string): Promise<Task> {
    const seed = this.readSeeds().find((t) => t.id === id);
    if (!seed) throw new Error(`No task with id "${id}" on the demo board.`);
    return this.toTask(seed, this.readState());
  }

  async claimTask(id: string): Promise<Task> {
    const task = await this.getTask(id);
    if (task.status === "accepted" || task.status === "submitted") {
      throw new Error(`Task ${id} is ${task.status} — not claimable.`);
    }
    if (task.status === "claimed") {
      if (task.claimedBy === this.volunteer) return task;
      throw new Error(`Task ${id} is already claimed by ${task.claimedBy}.`);
    }
    const state = this.readState();
    state[id] = { status: "claimed", claimedBy: this.volunteer, claimedAt: Date.now() };
    this.writeState(state);
    return this.getTask(id);
  }

  async releaseTask(id: string): Promise<Task> {
    const task = await this.getTask(id);
    if (task.status !== "claimed" || task.claimedBy !== this.volunteer) {
      throw new Error(`Task ${id} is not claimed by you.`);
    }
    const state = this.readState();
    delete state[id];
    this.writeState(state);
    return this.getTask(id);
  }

  async submitResult(submission: Submission): Promise<Task> {
    const task = await this.getTask(submission.taskId);
    if (task.status !== "claimed" || task.claimedBy !== this.volunteer) {
      throw new Error(`Claim task ${submission.taskId} before submitting a result.`);
    }
    const checklist = submission.verification
      .map((v) => `- [x] ${v.criterion} — ${v.evidence}`)
      .join("\n");
    const body = [
      `Summary: ${submission.summary}`,
      submission.resultUrl ? `Result: ${submission.resultUrl}` : "",
      `Self-verification:\n${checklist}`,
      submission.resultBody ? `---\n${submission.resultBody}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const state = this.readState();
    state[submission.taskId] = {
      status: "submitted",
      claimedBy: this.volunteer,
      latestSubmission: body,
    };
    this.writeState(state);
    return this.getTask(submission.taskId);
  }

  async submitReview(review: Review): Promise<Task> {
    const task = await this.getTask(review.taskId);
    if (task.status !== "submitted") {
      throw new Error(`Task ${review.taskId} has no submission awaiting review.`);
    }
    if (task.claimedBy === this.volunteer) {
      throw new Error(`You made this submission — you cannot review your own work.`);
    }
    const state = this.readState();
    const current = state[review.taskId];
    if (review.verdict === "accept") {
      state[review.taskId] = { ...current, status: "accepted" };
    } else {
      state[review.taskId] = {
        ...current,
        status: "claimed",
        claimedAt: Date.now(), // rework clock restarts at the rejection
        reviewFeedback: review.feedback,
      };
    }
    this.writeState(state);
    return this.getTask(review.taskId);
  }

  async impactStats(): Promise<BoardStats> {
    return computeStats(await this.listTasks());
  }

  async postTask(_draft: TaskDraft): Promise<string> {
    throw new Error(
      "The demo board is read-only. Set CLAWCLUB_BOARD_REPO (and GITHUB_TOKEN) to post tasks to a real board.",
    );
  }
}
