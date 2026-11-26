import type { TournamentStore } from "../store/tournament-store";
import { describe, expect, it, vi } from "vitest";
import {
  createDemoTournamentAction,
  pullNowAction,
  runFullCheckAction,
} from "./status-actions";
import { t } from "../i18n";
import { fakeStore, scriptedPrompts, testContext } from "./test-context";

function context(
  answers: unknown[] = [],
  open = true,
): {
  ctx: ReturnType<typeof testContext>;
  calls: ReturnType<typeof fakeStore>["calls"];
} {
  const { store, calls } = fakeStore(null, undefined, {
    status: { open, locks: [] },
    fullCheckResult: { ok: true },
  });
  return {
    ctx: testContext(store, scriptedPrompts(answers)),
    calls,
  };
}

describe("status actions", () => {
  it("prompts for no arguments for the host checks", async () => {
    expect(await runFullCheckAction.prompt(context().ctx)).toEqual({});
    expect(await pullNowAction.prompt(context().ctx)).toEqual({});
  });

  it("prompts for an optional demo directory and cancels cleanly", async () => {
    const { ctx } = context([" /tmp/demo "]);
    expect(await createDemoTournamentAction.prompt(ctx)).toEqual({
      directory: "/tmp/demo",
    });
    const cancelled = context([undefined]).ctx;
    expect(await createDemoTournamentAction.prompt(cancelled)).toBeUndefined();
  });

  it("runs the full check and pull-now through the store", async () => {
    const { ctx, calls } = context();
    expect((await runFullCheckAction.run(ctx, {})).ok).toBe(true);
    expect((await pullNowAction.run(ctx, {})).ok).toBe(true);
    expect(calls.fullChecks).toBe(1);
    expect(calls.pulls).toBe(1);
  });

  it("reports a host failure", async () => {
    const { store } = fakeStore(null, undefined, {
      status: { open: true, locks: [] },
    });
    const failingStore = {
      ...store,
      runFullCheck: vi.fn(async () => {
        throw new Error("check failed");
      }),
    } as unknown as TournamentStore;
    const failing = testContext(failingStore, scriptedPrompts([]));
    const result = await runFullCheckAction.run(failing, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("check failed");
  });

  it("refuses to pull when no tournament is open", async () => {
    const { ctx, calls } = context([], false);
    const result = await pullNowAction.run(ctx, {});
    expect(result.ok).toBe(false);
    expect(calls.pulls).toBe(0);
  });

  it("creates a demo tournament with the prompted directory", async () => {
    const { ctx, calls } = context();
    const result = await createDemoTournamentAction.run(ctx, {
      directory: "/tmp/demo",
    });
    expect(result.ok).toBe(true);
    expect(calls.demoDirectories).toEqual(["/tmp/demo"]);
  });

  it("shows the translated refusal when extensions keep this laptop from hosting", async () => {
    const { store } = fakeStore(null, undefined, {
      createDemoResult: () => {
        throw new Error("Extensions are loaded (pub.one@1.0.0). Restart SimpleTab to unload them.");
      },
    });
    const result = await createDemoTournamentAction.run(testContext(store, scriptedPrompts([])), {
      directory: "",
    });
    expect(result).toEqual({ ok: false, errors: [t("extensions.refusedToHost")] });
  });

  it("enables the checks only for an open tournament", () => {
    const open = fakeStore(null, undefined, {
      status: { open: true, locks: [] },
    }).store.getSnapshot();
    const closed = fakeStore(null, undefined, {
      status: { open: false, locks: [] },
    }).store.getSnapshot();
    expect(runFullCheckAction.isEnabled?.(open)).toBe(true);
    expect(pullNowAction.isEnabled?.(open)).toBe(true);
    expect(runFullCheckAction.isEnabled?.(closed)).toBe(false);
    expect(pullNowAction.isEnabled?.(closed)).toBe(false);
    expect(createDemoTournamentAction.isEnabled?.(closed)).toBe(true);
  });
});
