import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Submission, Task, TaskBoard, TaskStatus } from "../types.js";
import { lintBrief } from "../safety.js";

// File-backed demo board so the server can be tried with zero setup and no
// GitHub token. Seed tasks ship read-only in board/demo-tasks.json; claim and
// submission state is kept in a separate gitignored state file.

interface SeedTask {
  id: string;
  title: string;
  charity: string;
  category: string;
  estimatedEffort: string;
  brief: string;
  acceptanceCriteria: string[];
}

interface DemoState {
  [taskId: string]: {
    status: TaskStatus;
    claimedBy?: string;
    submission?: Submission;
  };
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

  private toTask(seed: SeedTask, state: DemoState): Task {
    const s = state[seed.id];
    return {
      ...seed,
      status: s?.status ?? "open",
      claimedBy: s?.claimedBy,
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
    if (task.status === "claimed" && task.claimedBy !== this.volunteer) {
      throw new Error(`Task ${id} is already claimed by ${task.claimedBy}.`);
    }
    if (task.status === "submitted") {
      throw new Error(`Task ${id} already has a submitted result.`);
    }
    const state = this.readState();
    state[id] = { status: "claimed", claimedBy: this.volunteer };
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
    const state = this.readState();
    state[submission.taskId] = {
      status: "submitted",
      claimedBy: this.volunteer,
      submission,
    };
    this.writeState(state);
    return this.getTask(submission.taskId);
  }
}
