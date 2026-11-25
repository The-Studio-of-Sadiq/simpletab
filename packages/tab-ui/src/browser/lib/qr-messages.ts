import type { QrReceiveResult } from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";

/** Words for a refused QR ballot scan (checked on the host; see `HostService.receiveQrBallot`). */
export function qrFailureMessage(result: Extract<QrReceiveResult, { ok: false }>): string {
  switch (result.kind) {
    case "empty":
      return t("results.qrEmptyError");
    case "needs_links":
      return t("results.qrNeedsPrivateLinks");
    case "no_matching_key":
      return t("results.qrNoMatchingKey");
    case "wrong_tournament":
      return t("results.qrWrongTournament", { slug: result.detail ?? "" });
    case "invalid_payload":
      return t("results.qrInvalidPayload");
    case "missing_ids":
      return t("results.qrMissingIds");
    case "invalid":
      return result.detail !== undefined ? `${t("results.qrDecodeFailed")} ${result.detail}` : t("results.qrDecodeFailed");
    case "duplicate":
      return t("results.qrDuplicate");
    case "offline":
    case "rejected":
    default:
      return result.errors.length > 0 ? result.errors.join(" ") : t("results.qrDecodeFailed");
  }
}

/** Splits pasted or scanned text into codes (one `ST1.` code or several `ST1F.` fragments). */
export function splitQrCodes(text: string): string[] {
  return text.split(/\s+/).map((part) => part.trim()).filter((part) => part.length > 0);
}
