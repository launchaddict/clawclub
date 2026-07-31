import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Estimates the state of the user's current 5-hour usage window from Claude
// Code's local transcript files (~/.claude/projects/**/*.jsonl). Everything
// here is an estimate: Anthropic doesn't publish per-plan window budgets, so
// the budget defaults to the largest window observed in the user's own
// history (auto-calibration) unless overridden in config.

export interface WindowStatus {
  active: boolean;
  windowStart?: number;
  windowEnd?: number;
  minutesToReset?: number;
  tokensUsed: number;
  budget: number;
  fractionUsed: number;
}

interface UsageEvent {
  ts: number;
  tokens: number;
}

const WINDOW_MS = 5 * 60 * 60 * 1000;

function projectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

function* jsonlFiles(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(full);
    else if (entry.name.endsWith(".jsonl")) yield full;
  }
}

export function readUsageEvents(dir = projectsDir()): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const file of jsonlFiles(dir)) {
    let lines: string[];
    try {
      lines = fs.readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      try {
        const entry = JSON.parse(line);
        const usage = entry?.message?.usage;
        const ts = Date.parse(entry?.timestamp ?? "");
        if (!usage || Number.isNaN(ts)) continue;
        // Cache reads are heavily discounted against limits; weigh the
        // components that actually consume the window.
        const tokens =
          (usage.input_tokens ?? 0) +
          (usage.output_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);
        if (tokens > 0) events.push({ ts, tokens });
      } catch {
        // skip malformed lines
      }
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

interface Block {
  start: number;
  end: number;
  tokens: number;
}

// Windows open at the first prompt after the previous window closed, floored
// to the hour (matching how resets are commonly observed to behave).
export function computeBlocks(events: UsageEvent[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const e of events) {
    if (!current || e.ts >= current.end) {
      const start = new Date(e.ts);
      start.setMinutes(0, 0, 0);
      current = { start: start.getTime(), end: start.getTime() + WINDOW_MS, tokens: 0 };
      blocks.push(current);
    }
    current.tokens += e.tokens;
  }
  return blocks;
}

export function windowStatus(
  events: UsageEvent[],
  now: number,
  budgetOverride?: number,
): WindowStatus {
  const blocks = computeBlocks(events);
  const historicalMax = blocks.reduce((m, b) => Math.max(m, b.tokens), 0);
  const budget = budgetOverride && budgetOverride > 0 ? budgetOverride : historicalMax;
  const current = blocks.length ? blocks[blocks.length - 1] : undefined;
  if (!current || now >= current.end) {
    return { active: false, tokensUsed: 0, budget, fractionUsed: 0 };
  }
  return {
    active: true,
    windowStart: current.start,
    windowEnd: current.end,
    minutesToReset: Math.round((current.end - now) / 60000),
    tokensUsed: current.tokens,
    budget,
    fractionUsed: budget > 0 ? Math.min(1, current.tokens / budget) : 0,
  };
}

export function getWindowStatus(budgetOverride?: number): WindowStatus {
  return windowStatus(readUsageEvents(), Date.now(), budgetOverride);
}
