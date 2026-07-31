export type TaskStatus = "open" | "claimed" | "submitted";

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
  url?: string;
  flags: string[];
}

export interface Submission {
  taskId: string;
  summary: string;
  resultUrl?: string;
  resultBody?: string;
}

export interface TaskBoard {
  name(): string;
  listTasks(category?: string): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  claimTask(id: string): Promise<Task>;
  releaseTask(id: string): Promise<Task>;
  submitResult(submission: Submission): Promise<Task>;
  whoami(): Promise<string>;
}
