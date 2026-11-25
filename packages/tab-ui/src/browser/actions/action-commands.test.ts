import type { ProjectedState, SubmitResult } from "@simpletab/host/lib/common/host-protocol";
import { describe, expect, it, vi } from "vitest";
import { t } from "../i18n";
import en from "../locales/en/actions.json";

// The real shell, dialogs and widget manager load CSS, which Node cannot import in tests.
vi.mock("@theia/core/lib/browser/shell/application-shell", () => ({ ApplicationShell: class {} }));
vi.mock("@theia/core/lib/browser/dialogs", () => ({ ConfirmDialog: class {} }));
vi.mock("@theia/core/lib/browser/widget-manager", () => ({ WidgetManager: class {} }));

const { executeAction } = await import("./action-commands");
const { ALL_ACTIONS } = await import("./all-actions");
const { acceptProposalAction } = await import("./proposals-actions");
const { fakeStore, scriptedPrompts, testContext } = await import("./test-context");

const english: Record<string, string> = en;
const director = { roleId: "tab_director", permissions: ["x"], proposals: [] } as unknown as ProjectedState;

function notifier() {
  const errors: string[] = [];
  const infos: string[] = [];
  return {
    errors,
    infos,
    notify: {
      error: (message: string) => {
        errors.push(message);
      },
      info: (message: string) => {
        infos.push(message);
      },
    },
  };
}

describe("action commands", () => {
  it("give every action a unique simpletab.* id and an English label", () => {
    const ids = ALL_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const action of ALL_ACTIONS) {
      expect(action.id).toMatch(/^simpletab\.[a-z-]+\.[a-z-]+$/);
      expect(english[action.labelKey], action.labelKey).toBeTruthy();
    }
  });

  it("run a page's button with its arguments and return the result without notifying", async () => {
    const { store, submitted } = fakeStore(director);
    const { errors, infos, notify } = notifier();
    const prompts = scriptedPrompts([]);
    const result = await executeAction(
      acceptProposalAction,
      testContext(store, prompts),
      { proposalId: "p1" },
      notify,
    );
    expect(result).toMatchObject({ ok: true });
    expect(prompts.asked).toEqual([]);
    expect(submitted).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(infos).toEqual([]);
  });

  it("prompt from the palette and report the outcome there", async () => {
    const refusal = { ok: false, code: "FORBIDDEN", errors: ["Not allowed."] } as SubmitResult;
    const refused = fakeStore(director, refusal);
    const { errors, infos, notify } = notifier();
    await executeAction(acceptProposalAction, testContext(refused.store, scriptedPrompts(["p1"])), undefined, notify);
    expect(errors).toEqual(["Not allowed."]);

    const ok = fakeStore(director);
    await executeAction(acceptProposalAction, testContext(ok.store, scriptedPrompts(["p1"])), undefined, notify);
    expect(infos).toEqual([t("action.done", { action: t("action.proposals.accept") })]);
  });

  it("do nothing when the palette prompt is cancelled", async () => {
    const { store, submitted } = fakeStore(director);
    const { errors, infos, notify } = notifier();
    const result = await executeAction(
      acceptProposalAction,
      testContext(store, scriptedPrompts([undefined])),
      undefined,
      notify,
    );
    expect(result).toBeUndefined();
    expect(submitted).toEqual([]);
    expect(errors).toEqual([]);
    expect(infos).toEqual([]);
  });
});
