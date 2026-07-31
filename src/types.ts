// Task lifecycle: open → claimed → submitted → accepted (terminal).
// A rejected submission returns the task to "claimed" with reviewer feedback so
// the claimant can rework it. A claim that goes quiet past the TTL expires and
// the task is open again (the expired claimant may still submit if nobody else
// has claimed in the meantime).
export type TaskStatus = "open" | "claimed" | "submitted" | "accepted";

export interface VerificationItem {
  criterion: string;
  evidence: string;
}

export interface Task {
  id: string;
  title: string;
  charity: string;
  category: string;
  estimatedEffort: string;
  brief: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  claimedBy?: string;
  // Populated when status is "submitted": the submission body awaiting review.
  latestSubmission?: string;
  // Populated after a rejection: the reviewer's feedback for rework.
  reviewFeedback?: string;
  url?: string;
  flags: string[];
}

export interface Submission {
  taskId: string;
  summary: string;
  verification: VerificationItem[];
  resultUrl?: string;
  resultBody?: string;
}

export interface Review {
  taskId: string;
  verdict: "accept" | "reject";
  feedback: string;
}

export interface TaskDraft {
  title: string;
  charity: string;
  category: string;
  estimatedEffort: string;
  brief: string;
  acceptanceCriteria: string[];
}

export interface BoardStats {
  open: number;
  inProgress: number;
  awaitingReview: number;
  accepted: number;
  // login → number of accepted contributions (the volunteer's track record)
  acceptedByVolunteer: Record<string, number>;
  // charity → number of accepted deliverables
  acceptedByCharity: Record<string, number>;
}

export interface TaskBoard {
  name(): string;
  listTasks(category?: string): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  claimTask(id: string): Promise<Task>;
  releaseTask(id: string): Promise<Task>;
  submitResult(submission: Submission): Promise<Task>;
  submitReview(review: Review): Promise<Task>;
  postTask(draft: TaskDraft): Promise<string>;
  impactStats(): Promise<BoardStats>;
  whoami(): Promise<string>;
}

// Ranks for effort matching: a volunteer with "1 session" of time shouldn't be
// offered a "2-3 sessions" task first.
export const EFFORT_RANK: Record<string, number> = {
  "1 session": 1,
  "1-2 sessions": 2,
  "2-3 sessions": 3,
};

export function effortRank(effort: string): number {
  return EFFORT_RANK[effort] ?? 2;
}

export function computeStats(tasks: Task[]): BoardStats {
  const stats: BoardStats = {
    open: 0,
    inProgress: 0,
    awaitingReview: 0,
    accepted: 0,
    acceptedByVolunteer: {},
    acceptedByCharity: {},
  };
  for (const t of tasks) {
    if (t.status === "open") stats.open++;
    else if (t.status === "claimed") stats.inProgress++;
    else if (t.status === "submitted") stats.awaitingReview++;
    else if (t.status === "accepted") {
      stats.accepted++;
      if (t.claimedBy) {
        stats.acceptedByVolunteer[t.claimedBy] =
          (stats.acceptedByVolunteer[t.claimedBy] ?? 0) + 1;
      }
      stats.acceptedByCharity[t.charity] =
        (stats.acceptedByCharity[t.charity] ?? 0) + 1;
    }
  }
  return stats;
}

export const CLAIM_TTL_MS =
  Number(process.env.CLAWCLUB_CLAIM_TTL_DAYS ?? 5) * 24 * 60 * 60 * 1000;
