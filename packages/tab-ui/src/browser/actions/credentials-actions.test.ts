import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it, vi } from "vitest";
import type { ActionPrompts } from "./action";
import {
  clearCredentialSecretAction,
  setCredentialSecretAction,
  testCredentialSecretAction,
  updateOnlineSettingsAction,
} from "./credentials-actions";
import {
  fakeCredentialsService,
  fakeStore,
  scriptedPrompts,
  testContext,
} from "./test-context";

function context(
  answers: unknown[] = [],
  services: Parameters<typeof testContext>[3] = {},
  open = true,
): {
  ctx: ReturnType<typeof testContext>;
  inputOptions: Array<{ prompt: string; password: boolean }>;
} {
  const base = scriptedPrompts(answers);
  const inputOptions: Array<{ prompt: string; password: boolean }> = [];
  const prompts: ActionPrompts = {
    ...base,
    input: async (prompt, options) => {
      inputOptions.push({ prompt, password: options?.password === true });
      return base.input(prompt, options);
    },
  };
  const store = fakeStore(null, undefined, { status: { open, locks: [] } }).store;
  return { ctx: testContext(store, prompts, async () => undefined, services), inputOptions };
}

function snapshot(open: boolean, state: ProjectedState | null = null) {
  return fakeStore(state, undefined, { status: { open, locks: [] } }).store.getSnapshot();
}

describe("credentials actions", () => {
  describe("setCredentialSecretAction", () => {
    it("prompts for a masked token, re-asking when it is empty", async () => {
      const { ctx, inputOptions } = context(["tournamentKey", "", "  secret-token  "]);
      const args = await setCredentialSecretAction.prompt(ctx);
      expect(args).toEqual({
        name: "tournamentKey",
        values: {
          token: "  secret-token  ",
          smtp: {
            host: "",
            port: "587",
            user: "",
            password: "",
            from: "",
          },
        },
      });
      expect(ctx.prompts).toMatchObject({ asked: expect.any(Array) });
      expect(inputOptions).toHaveLength(2);
      expect(inputOptions.every((call) => call.password)).toBe(true);
    });

    it("returns undefined when the person cancels", async () => {
      const { ctx } = context([undefined]);
      expect(await setCredentialSecretAction.prompt(ctx)).toBeUndefined();
    });

    it("serializes and stores the secret, then refreshes the status", async () => {
      const credentials = fakeCredentialsService();
      const { ctx } = context([], { credentials: credentials.service });
      const result = await setCredentialSecretAction.run(ctx, {
        name: "tournamentKey",
        values: {
          token: " secret-token ",
          smtp: {
            host: "",
            port: "587",
            user: "",
            password: "",
            from: "",
          },
        },
      });
      expect(result).toEqual({ ok: true, status: [] });
      expect(credentials.calls.sets).toEqual([
        { name: "tournamentKey", value: "secret-token" },
      ]);
      expect(credentials.calls.statusReads).toBe(1);
    });

    it("reports validation errors without calling the host", async () => {
      const credentials = fakeCredentialsService();
      const { ctx } = context([], { credentials: credentials.service });
      const result = await setCredentialSecretAction.run(ctx, {
        name: "tournamentKey",
        values: {
          token: "   ",
          smtp: {
            host: "",
            port: "587",
            user: "",
            password: "",
            from: "",
          },
        },
      });
      expect(result.ok).toBe(false);
      expect(credentials.calls.sets).toEqual([]);
    });

    it("reports an unavailable credentials service", async () => {
      const { ctx } = context();
      const result = await setCredentialSecretAction.run(ctx, {
        name: "tournamentKey",
        values: {
          token: "secret-token",
          smtp: {
            host: "",
            port: "587",
            user: "",
            password: "",
            from: "",
          },
        },
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("clearCredentialSecretAction", () => {
    it("picks a credential and cancels cleanly", async () => {
      const { ctx } = context(["cdnToken", true]);
      expect(await clearCredentialSecretAction.prompt(ctx)).toEqual({
        name: "cdnToken",
      });
      // Clearing a saved secret is confirmed; declining cancels.
      expect(await clearCredentialSecretAction.prompt(context(["cdnToken", false]).ctx)).toBeUndefined();
      const cancelled = context([undefined]).ctx;
      expect(await clearCredentialSecretAction.prompt(cancelled)).toBeUndefined();
    });

    it("clears the credential through the service", async () => {
      const credentials = fakeCredentialsService();
      const { ctx } = context([], { credentials: credentials.service });
      expect(
        await clearCredentialSecretAction.run(ctx, { name: "cdnToken" }),
      ).toEqual({ ok: true, status: [] });
      expect(credentials.calls.clears).toEqual(["cdnToken"]);
    });
  });

  describe("testCredentialSecretAction", () => {
    it("picks a credential and cancels cleanly", async () => {
      const { ctx } = context(["smtp"]);
      expect(await testCredentialSecretAction.prompt(ctx)).toEqual({ name: "smtp" });
      const cancelled = context([undefined]).ctx;
      expect(await testCredentialSecretAction.prompt(cancelled)).toBeUndefined();
    });

    it("tests the credential and returns the result with the status", async () => {
      const credentials = fakeCredentialsService({
        test: vi.fn(async () => ({ ok: true })),
      });
      const { ctx } = context([], { credentials: credentials.service });
      expect(await testCredentialSecretAction.run(ctx, { name: "smtp" })).toEqual({
        ok: true,
        status: [],
        test: { ok: true },
      });
      expect(credentials.calls.tests).toEqual(["smtp"]);
    });

    it("surfaces a failed test", async () => {
      const credentials = fakeCredentialsService({
        test: vi.fn(async () => ({ ok: false, error: "Bad credentials" })),
      });
      const { ctx } = context([], { credentials: credentials.service });
      const result = await testCredentialSecretAction.run(ctx, {
        name: "smtp",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toContain("Bad credentials");
    });
  });

  describe("updateOnlineSettingsAction", () => {
    it("prompts for a boolean field and for a choice field", async () => {
      const booleanContext = context(["ballotPortal", true]).ctx;
      expect(await updateOnlineSettingsAction.prompt(booleanContext)).toEqual({
        patch: { ballotPortal: true },
      });
      const choiceContext = context(["ballotCollection", "qr_only"]).ctx;
      expect(await updateOnlineSettingsAction.prompt(choiceContext)).toEqual({
        patch: { ballotCollection: "qr_only" },
      });
    });

    it("normalizes text and cancels cleanly", async () => {
      const { ctx } = context(["cdnHost", " Example.Pages.Dev "]);
      expect(await updateOnlineSettingsAction.prompt(ctx)).toEqual({
        patch: { cdnHost: " Example.Pages.Dev " },
      });
      const cancelled = context([undefined]).ctx;
      expect(await updateOnlineSettingsAction.prompt(cancelled)).toBeUndefined();
    });

    it("runs a normalized patch through the store", async () => {
      const { ctx } = context();
      const result = await updateOnlineSettingsAction.run(ctx, {
        patch: { cdnHost: " Example.Pages.Dev " },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.onlineSettings?.cdnHost).toBe("example.pages.dev");
    });

    it("rejects an invalid value without calling the store's patch method", async () => {
      const { ctx } = context();
      const result = await updateOnlineSettingsAction.run(ctx, {
        patch: { cdnHost: "not a valid host" },
      });
      expect(result.ok).toBe(false);
    });

    it("rejects a patch when no tournament is open", async () => {
      const { ctx } = context([], {}, false);
      const result = await updateOnlineSettingsAction.run(ctx, {
        patch: { ballotPortal: true },
      });
      expect(result.ok).toBe(false);
    });
  });

  it("enables the actions only where they apply", () => {
    expect(setCredentialSecretAction.isEnabled?.(snapshot(true))).toBe(true);
    expect(clearCredentialSecretAction.isEnabled?.(snapshot(false))).toBe(true);
    expect(testCredentialSecretAction.isEnabled?.(snapshot(false))).toBe(true);
    expect(
      updateOnlineSettingsAction.isEnabled?.(snapshot(true)),
    ).toBe(true);
    expect(
      updateOnlineSettingsAction.isEnabled?.(snapshot(false)),
    ).toBe(false);
    const noPermission = {
      roleId: "guest",
      permissions: [],
    } as unknown as ProjectedState;
    expect(
      setCredentialSecretAction.isEnabled?.(snapshot(true, noPermission)),
    ).toBe(false);
  });
});
