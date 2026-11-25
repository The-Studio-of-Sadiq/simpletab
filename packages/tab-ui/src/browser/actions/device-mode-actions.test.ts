import type { DeviceModeStatus } from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { describe, expect, it } from "vitest";
import {
  dismissRejectedEditsAction,
  joinHostAction,
  leaveHostAction,
} from "./device-mode-actions";
import {
  fakeStore,
  scriptedPrompts,
  testContext,
  type ScriptedPrompts,
} from "./test-context";

function device(rejected: DeviceModeStatus["rejected"] = []): DeviceModeStatus {
  return {
    connection: "connected",
    deviceId: "dev-1",
    hostAddress: "127.0.0.1:47820",
    deviceName: "Test laptop",
    roleId: "tab_director",
    roleName: "Tab director",
    queued: [],
    rejected,
    presence: [],
  };
}

function context(
  answers: unknown[] = [],
  status: {
    open?: boolean;
    device?: DeviceModeStatus;
  } = {},
): {
  ctx: ReturnType<typeof testContext>;
  calls: ReturnType<typeof fakeStore>["calls"];
} {
  const { store, calls } = fakeStore(null, undefined, {
    status: { open: status.open ?? false, locks: [], device: status.device },
  });
  return { ctx: testContext(store, scriptedPrompts(answers)), calls };
}

describe("device-mode actions", () => {
  it("asks for a non-empty address, code and name, re-asking when required", async () => {
    const { ctx } = context([
      "",
      "127.0.0.1:47820",
      "1234 5678",
      "Test laptop",
    ]);
    const args = await joinHostAction.prompt(ctx);
    expect(args).toEqual({
      address: "127.0.0.1:47820",
      code: "1234 5678",
      deviceName: "Test laptop",
    });
    expect((ctx.prompts as ScriptedPrompts).asked).toHaveLength(4);
  });

  it("cancels a join prompt at any question", async () => {
    expect(await joinHostAction.prompt(context([undefined]).ctx)).toBeUndefined();
    expect(
      await joinHostAction.prompt(context(["127.0.0.1:47820", undefined]).ctx),
    ).toBeUndefined();
  });

  it("runs a join through the store", async () => {
    const { ctx, calls } = context();
    const params = {
      address: "127.0.0.1:47820",
      code: "1234 5678",
      deviceName: "Test laptop",
    };
    expect((await joinHostAction.run(ctx, params)).ok).toBe(true);
    expect(calls.joinParams).toEqual([params]);
  });

  it("confirms leaving with the banner's text, and runs leave and dismiss", async () => {
    const { ctx, calls } = context([true], { device: device() });
    expect(await leaveHostAction.prompt(ctx)).toEqual({});
    expect((ctx.prompts as ScriptedPrompts).asked).toEqual([t("action.device-mode.leaveHost")]);
    expect(await leaveHostAction.prompt(context([false], { device: device() }).ctx)).toBeUndefined();
    expect(await dismissRejectedEditsAction.prompt(ctx)).toEqual({});
    expect((await leaveHostAction.run(ctx, {})).ok).toBe(true);
    expect((await dismissRejectedEditsAction.run(ctx, {})).ok).toBe(true);
    expect(calls.leftHost).toBe(1);
    expect(calls.dismissedRejected).toBe(1);
  });

  it("enables each action only in its device state", () => {
    const joined = fakeStore(null, undefined, {
      status: { open: false, locks: [], device: device() },
    }).store.getSnapshot();
    const openHost = fakeStore(null, undefined, {
      status: { open: true, locks: [], device: device() },
    }).store.getSnapshot();
    const rejected = fakeStore(null, undefined, {
      status: {
        open: false,
        locks: [],
        device: device([
          {
            seq: 1,
            opType: "team.add",
            actorRef: "device:dev-1",
            reason: "not allowed",
          },
        ] as unknown as DeviceModeStatus["rejected"]),
      },
    }).store.getSnapshot();

    expect(joinHostAction.isEnabled?.(joined)).toBe(false);
    expect(leaveHostAction.isEnabled?.(joined)).toBe(true);
    expect(dismissRejectedEditsAction.isEnabled?.(joined)).toBe(false);
    expect(dismissRejectedEditsAction.isEnabled?.(rejected)).toBe(true);
    expect(joinHostAction.isEnabled?.(openHost)).toBe(false);
    expect(
      joinHostAction.isEnabled?.(
        fakeStore(null, undefined, { status: { open: false, locks: [] } }).store.getSnapshot(),
      ),
    ).toBe(true);
  });
});
