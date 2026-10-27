import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromReportedDuration,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

// agy owns its login and token refresh; asking it for `/usage` means this source never reads
// or writes a credential store. The command answers from the quota API without a model turn.
export type RunAgy = () => Promise<string>;

const runAgy: RunAgy = () =>
  new Promise((resolve, reject) => {
    execFile(
      "agy",
      ["-p", "/usage", "--print-timeout", "15s"],
      { timeout: 18_000, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      },
    );
  });

const DURATIONS: Array<[RegExp, number]> = [
  [/\bweekly\b/i, 604_800],
  [/\bfive[- ]hour\b|\b5[- ]?h(our)?\b/i, 18_000],
  [/\bdaily\b/i, 86_400],
];

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Parses agy's tab-separated rows: group, limit name, remaining percent, reset instant. */
export function parseUsage(stdout: string): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const line of stdout.split("\n")) {
    const [group, name, remaining, resetsAt] = line.split("\t").map((cell) => cell.trim());
    const match = remaining?.match(/^(\d+(?:\.\d+)?)%$/);
    if (!group || !name || !match) continue;
    const usedPct = Math.max(0, 100 - Number(match[1]));
    const duration = DURATIONS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
    windows.push(
      windowFromReportedDuration({
        durationSeconds: duration,
        scope: { id: slug(group), label: group },
        unknown: { id: slug(name), label: name, shortLabel: "" },
        utilizationPct: usedPct,
        resetsAt: resetsAt && !Number.isNaN(Date.parse(resetsAt)) ? resetsAt : null,
        summary: /^gemini models$/i.test(group),
        tone: toneFromUsedPct(usedPct),
      }),
    );
  }
  return windows;
}

export async function fetchUsage(run: RunAgy = runAgy): Promise<UsageReport> {
  let stdout: string;
  try {
    stdout = await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not (logged|signed) in|login required|unauthenticated/i.test(message)) {
      return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
    }
    throw new Error(`agy /usage failed: ${message}`);
  }
  const windows = parseUsage(stdout);
  if (windows.length === 0) {
    return unavailable({ kind: "no_quota", detail: "agy /usage reported no quota windows" });
  }
  return { status: "available", windows };
}

/** The active Google account from agy's account list; an email, so it is hashed into the key. */
async function activeAccount(home: string): Promise<string | null> {
  try {
    const raw = await readFile(join(home, ".gemini", "google_accounts.json"), "utf8");
    const active = (JSON.parse(raw) as { active?: unknown }).active;
    return typeof active === "string" && active ? active : null;
  } catch {
    return null;
  }
}

export async function discover(
  scope: UsageScope,
  home: string = homedir(),
): Promise<UsageAccount[]> {
  if (scope.kind === "session" && scope.provider !== "antigravity") return [];
  const account = await activeAccount(scope.kind === "session" ? (scope.env.HOME ?? home) : home);
  if (!account) return [];
  return [{ key: hashAccountKey(account), harness: "Antigravity", input: { store: "agy-cli" } }];
}
