#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getWindowStatus, type WindowStatus } from "./usage.js";

// Auto-donate: turn "my window is about to reset mostly unused" into a
// charity session — either as a nudge the user acts on, or (explicit opt-in)
// by launching one capped, headless Claude Code session via the official CLI
// on the user's own machine.
//
//   clawclub-autodonate status      human-readable report + what would happen
//   clawclub-autodonate statusline  one-line nudge for Claude Code's statusLine
//   clawclub-autodonate run         cron entrypoint; launches `claude -p` when
//                                   the condition is met (auto mode only,
//                                   max one auto-session per window)

interface Config {
  mode: "nudge" | "auto" | "off";
  maxMinutesToReset: number;
  minFractionUnused: number;
  windowTokenBudget: number | null;
  claudeArgs: string[];
}

const DEFAULTS: Config = {
  mode: "nudge",
  maxMinutesToReset: 90,
  minFractionUnused: 0.5,
  windowTokenBudget: null,
  claudeArgs: [],
};

const CONFIG_DIR = path.join(os.homedir(), ".clawclub");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const MARKER_FILE = path.join(CONFIG_DIR, "last-auto-window");

function loadConfig(): Config {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function conditionMet(status: WindowStatus, cfg: Config): boolean {
  if (!status.active || status.minutesToReset === undefined) return false;
  if (status.budget <= 0) return false; // no history to calibrate against
  const fractionUnused = 1 - status.fractionUsed;
  return (
    status.minutesToReset <= cfg.maxMinutesToReset &&
    fractionUnused >= cfg.minFractionUnused
  );
}

function fmtMinutes(m: number): string {
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

function describe(status: WindowStatus): string {
  if (!status.active) return "No active usage window (next session opens a fresh one).";
  const pctUnused = Math.round((1 - status.fractionUsed) * 100);
  return `Window resets in ${fmtMinutes(status.minutesToReset!)}; ~${pctUnused}% unused (est. ${status.tokensUsed.toLocaleString()} of ~${status.budget.toLocaleString()} tokens; budget ${status.budget ? "auto-calibrated from your history" : "unknown — no history yet"}).`;
}

const HEADLESS_PROMPT = `Donate this session to one charity task using the clawclub MCP tools. Follow the /charity skill workflow if available. Rules for this unattended run: check list_reviews first and prefer completing one review; otherwise pick ONE open task with estimated effort "1 session" and no safety flags — never start a flagged task unattended. Work in a fresh temporary directory. Verify against every acceptance criterion before submit_result. If nothing suitable exists or the task cannot be finished, release any claim and stop cleanly with a short report.`;

function alreadyRanThisWindow(status: WindowStatus): boolean {
  try {
    return fs.readFileSync(MARKER_FILE, "utf8").trim() === String(status.windowStart);
  } catch {
    return false;
  }
}

const cmd = process.argv[2] ?? "status";
const cfg = loadConfig();
const status = getWindowStatus(cfg.windowTokenBudget ?? undefined);
const met = conditionMet(status, cfg);

switch (cmd) {
  case "statusline": {
    // For Claude Code's statusLine.command: print a nudge only when relevant.
    if (cfg.mode !== "off" && met) {
      const pctUnused = Math.round((1 - status.fractionUsed) * 100);
      process.stdout.write(
        `🎗 ${fmtMinutes(status.minutesToReset!)} left, ~${pctUnused}% unused — /charity?`,
      );
    }
    break;
  }
  case "run": {
    if (cfg.mode !== "auto") {
      console.log(`mode is "${cfg.mode}" — auto-donate disabled. ${describe(status)}`);
      break;
    }
    if (!met) {
      console.log(`Condition not met. ${describe(status)}`);
      break;
    }
    if (alreadyRanThisWindow(status)) {
      console.log("Already auto-donated this window — capped at one session per window.");
      break;
    }
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(MARKER_FILE, String(status.windowStart));
    console.log(`Condition met. ${describe(status)}\nLaunching one charity session via claude -p ...`);
    const result = spawnSync("claude", ["-p", HEADLESS_PROMPT, ...cfg.claudeArgs], {
      stdio: "inherit",
    });
    process.exitCode = result.status ?? 1;
    break;
  }
  case "status":
  default: {
    console.log(describe(status));
    console.log(
      `Config: mode=${cfg.mode}, trigger = resets within ${cfg.maxMinutesToReset}m AND ≥${Math.round(cfg.minFractionUnused * 100)}% unused (${CONFIG_FILE}).`,
    );
    console.log(
      met
        ? cfg.mode === "auto"
          ? "Condition MET — `clawclub-autodonate run` would launch a charity session."
          : "Condition MET — a good moment for /charity."
        : "Condition not met.",
    );
  }
}
