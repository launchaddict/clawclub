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

export interface TaskBoard {
  name(): string;
  listTasks(category?: string): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  claimTask(id: string): Promise<Task>;
  releaseTask(id: string): Promise<Task>;
  submitResult(submission: Submission): Promise<Task>;
  submitReview(review: Review): Promise<Task>;
  postTask(draft: TaskDraft): Promise<string>;
  whoami(): Promise<string>;
}

export const CLAIM_TTL_MS =
  Number(process.env.CLAWCLUB_CLAIM_TTL_DAYS ?? 5) * 24 * 60 * 60 * 1000;
