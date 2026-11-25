import type { SubmitResult } from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import {
  buildPrivateUrlsRegeneratePayload,
  collectParticipantTargets,
  isValidCdnHost,
  resolveBallotsOrigin,
} from "../lib/links-generator";
import type { SimpleTabAction } from "./action";
import { defineAction } from "./action";

/** Widget id of the Links page (`LinksWidget.ID`). */
export const LINKS_PAGE = "simpletab-links-widget";

export interface RegenerateLinksInput {
  cdnHost: string;
  ballotsOrigin: string;
  force: boolean;
}

export function buildRegenerateLinksRequest(
  state: Parameters<typeof buildPrivateUrlsRegeneratePayload>[0],
  input: RegenerateLinksInput,
) {
  return {
    type: "private_urls.regenerate" as const,
    payload: buildPrivateUrlsRegeneratePayload(
      state,
      input.cdnHost,
      input.ballotsOrigin,
      input.force,
    ),
  };
}

function makeLinksAction(
  id: string,
  labelKey: string,
  force: boolean,
  confirm: boolean,
): SimpleTabAction<RegenerateLinksInput, SubmitResult> {
  return defineAction<RegenerateLinksInput, SubmitResult>({
    id,
    labelKey,
    page: LINKS_PAGE,
    isEnabled: (snapshot) => {
      const state = snapshot.state;
      return (
        state !== null &&
        stateHasPermission(state, "links.manage") &&
        collectParticipantTargets(state).length > 0 &&
        isValidCdnHost(snapshot.status.onlineSettings?.cdnHost?.trim() ?? "") &&
        (!force || (state.links?.length ?? 0) > 0)
      );
    },
    prompt: async (ctx) => {
      const state = ctx.store.getState();
      const status = ctx.store.getStatus();
      if (state === null || !stateHasPermission(state, "links.manage")) return undefined;
      const cdnHost = status.onlineSettings?.cdnHost?.trim() ?? "";
      if (!isValidCdnHost(cdnHost)) return undefined;
      // The page regenerates without asking; replacing every live link is confirmed here.
      if (confirm) {
        const confirmed = await ctx.prompts.confirm(
          t("action.links.confirmRegenerateTitle"),
          t("action.links.confirmRegenerateMessage"),
        );
        if (!confirmed) return undefined;
      }
      return { cdnHost, ballotsOrigin: resolveBallotsOrigin(status.onlineSettings?.ballotsOrigin), force };
    },
    run: async (ctx, args) => {
      const state = ctx.store.getState();
      if (state === null || !stateHasPermission(state, "links.manage")) {
        return { ok: false, code: "INVALID", errors: [t("links.restrictedBody")] };
      }
      if (!isValidCdnHost(args.cdnHost)) {
        return { ok: false, code: "INVALID", errors: [t("links.missingCdnHost")] };
      }
      if (collectParticipantTargets(state).length === 0) {
        return { ok: false, code: "INVALID", errors: [t("links.noParticipants")] };
      }
      const request = buildRegenerateLinksRequest(state, args);
      if (request.payload.links.length === 0) {
        return { ok: false, code: "INVALID", errors: [t("links.noneMissing")] };
      }
      return ctx.store.submit(request);
    },
  });
}

export const generateLinksAction = makeLinksAction(
  "simpletab.links.generate",
  "action.links.generate",
  false,
  false,
);

export const regenerateLinksAction = makeLinksAction(
  "simpletab.links.regenerate",
  "action.links.regenerate",
  true,
  true,
);

export const LINKS_ACTIONS = [generateLinksAction, regenerateLinksAction] as const;
