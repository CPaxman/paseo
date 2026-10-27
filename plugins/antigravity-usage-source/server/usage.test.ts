import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discover, fetchUsage, parseUsage } from "./usage.js";

// Captured from agy 2026-10-27; reset instants are UTC.
const SAMPLE = [
  "Gemini Models\tWeekly Limit Remaining\t97%\t2026-10-31T04:00:12Z",
  "Gemini Models\tFive Hour Limit Remaining\t98%\t2026-10-27T12:00:29Z",
  "Claude and GPT models\tWeekly Limit Remaining\t87%\t2026-10-28T20:03:37Z",
  "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-02T20:19:14Z",
  "",
].join("\n");

describe("antigravity usage source", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agy-home-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("maps each row to a scoped window with a reported duration", () => {
    const windows = parseUsage(SAMPLE);
    expect(windows.map((w) => w.id)).toEqual([
      "gemini_models:weekly",
      "gemini_models:five_hour",
      "claude_and_gpt_models:weekly",
      "gemini_4_argon:weekly",
    ]);
    expect(windows[1]).toMatchObject({
      usedPct: 2,
      remainingPct: 98,
      resetsAt: "2026-10-27T12:00:29Z",
      summary: true,
    });
    expect(windows[2]?.summary).toBeUndefined();
    expect(windows[2]?.usedPct).toBe(13);
  });

  it("names an unrecognised period neutrally instead of guessing a duration", () => {
    const [window] = parseUsage("Gemini Models\tBurst Limit\t40%\tsoon\n");
    expect(window).toMatchObject({ id: "gemini_models:burst_limit", usedPct: 60, resetsAt: null });
  });

  it("reports available usage from agy output", async () => {
    const report = await fetchUsage(async () => SAMPLE);
    expect(report.status).toBe("available");
  });

  it("reports no quota when agy prints no rows", async () => {
    const report = await fetchUsage(async () => "Usage unavailable\n");
    expect(report).toMatchObject({ status: "unavailable", problem: { kind: "no_quota" } });
  });

  it("reports a signed-out agy as rejected and other failures as errors", async () => {
    const signedOut = await fetchUsage(async () => {
      throw new Error("Not logged in");
    });
    expect(signedOut).toMatchObject({ status: "unavailable", problem: { kind: "rejected" } });
    await expect(
      fetchUsage(async () => {
        throw new Error("spawn agy ENOENT");
      }),
    ).rejects.toThrow("agy /usage failed");
  });

  it("discovers the active account by hashed key, only for antigravity sessions", async () => {
    expect(await discover({ kind: "global" }, home)).toEqual([]);
    mkdirSync(join(home, ".gemini"));
    writeFileSync(
      join(home, ".gemini", "google_accounts.json"),
      JSON.stringify({ active: "ada@example.com", old: [] }),
    );
    const [account] = await discover({ kind: "global" }, home);
    expect(account?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(account?.key).not.toContain("ada");
    expect(account?.input).toEqual({ store: "agy-cli" });
    const session = { kind: "session" as const, provider: "antigravity", env: { HOME: home } };
    expect(await discover(session, "/nonexistent")).toHaveLength(1);
    expect(await discover({ ...session, provider: "codex" }, home)).toEqual([]);
  });
});
