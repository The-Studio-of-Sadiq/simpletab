import { IntlMessageFormat } from "intl-messageformat";
import { Emitter, type Event } from "@theia/core/lib/common";
import bnAllocation from "../locales/bn/allocation.json";
import bnBreak from "../locales/bn/break.json";
import bnChangelog from "../locales/bn/changelog.json";
import bnCheckin from "../locales/bn/checkin.json";
import bnCommon from "../locales/bn/common.json";
import bnCredentials from "../locales/bn/credentials.json";
import bnDraw from "../locales/bn/draw.json";
import bnFeedback from "../locales/bn/feedback.json";
import bnMotions from "../locales/bn/motions.json";
import bnParticipants from "../locales/bn/participants.json";
import bnProjector from "../locales/bn/projector.json";
import bnReleases from "../locales/bn/releases.json";
import bnResults from "../locales/bn/results.json";
import bnSetup from "../locales/bn/setup.json";
import bnStandings from "../locales/bn/standings.json";
import bnStatus from "../locales/bn/status.json";
import enAllocation from "../locales/en/allocation.json";
import enBreak from "../locales/en/break.json";
import enChangelog from "../locales/en/changelog.json";
import enCheckin from "../locales/en/checkin.json";
import enCommon from "../locales/en/common.json";
import enCredentials from "../locales/en/credentials.json";
import enDraw from "../locales/en/draw.json";
import enFeedback from "../locales/en/feedback.json";
import enMotions from "../locales/en/motions.json";
import enParticipants from "../locales/en/participants.json";
import enProjector from "../locales/en/projector.json";
import enReleases from "../locales/en/releases.json";
import enResults from "../locales/en/results.json";
import enSetup from "../locales/en/setup.json";
import enStandings from "../locales/en/standings.json";
import enStatus from "../locales/en/status.json";

export type SupportedLocale = "en" | "bn";

export type MessageValues = Record<
  string,
  string | number | boolean | Date | null | undefined
>;

export type MessageCatalog = Record<string, string>;

export interface Translator {
  t(key: string, values?: MessageValues): string;
  getLocale(): SupportedLocale;
  setLocale(locale: SupportedLocale): void;
  readonly onLocaleChange: Event<SupportedLocale>;
}

const DEFAULT_CATALOGS: Record<SupportedLocale, MessageCatalog> = {
  en: {
    ...enCommon,
    ...enStatus,
    ...enSetup,
    ...enParticipants,
    ...enCheckin,
    ...enDraw,
    ...enAllocation,
    ...enMotions,
    ...enResults,
    ...enFeedback,
    ...enStandings,
    ...enBreak,
    ...enReleases,
    ...enChangelog,
    ...enCredentials,
    ...enProjector,
  },
  bn: {
    ...bnCommon,
    ...bnStatus,
    ...bnSetup,
    ...bnParticipants,
    ...bnCheckin,
    ...bnDraw,
    ...bnAllocation,
    ...bnMotions,
    ...bnResults,
    ...bnFeedback,
    ...bnStandings,
    ...bnBreak,
    ...bnReleases,
    ...bnChangelog,
    ...bnCredentials,
    ...bnProjector,
  },
};

export function createTranslator(
  catalogs: Record<string, MessageCatalog>,
  initialLocale: SupportedLocale = "en",
): Translator {
  let currentLocale: SupportedLocale = initialLocale;
  const cache = new Map<string, IntlMessageFormat>();
  const emitter = new Emitter<SupportedLocale>();

  function resolveMessage(
    key: string,
    locale: SupportedLocale,
  ): { template: string; effectiveLocale: string } | null {
    const primary = catalogs[locale]?.[key];
    if (typeof primary === "string" && primary.length > 0) {
      return { template: primary, effectiveLocale: locale };
    }
    const fallback = catalogs.en?.[key];
    if (typeof fallback === "string" && fallback.length > 0) {
      return { template: fallback, effectiveLocale: "en" };
    }
    return null;
  }

  return {
    t(key: string, values?: MessageValues): string {
      const resolved = resolveMessage(key, currentLocale);
      if (resolved === null) {
        return key;
      }
      const cacheKey = `${resolved.effectiveLocale}\u0000${key}\u0000${resolved.template}`;
      try {
        let formatter = cache.get(cacheKey);
        if (formatter === undefined) {
          formatter = new IntlMessageFormat(
            resolved.template,
            resolved.effectiveLocale,
          );
          cache.set(cacheKey, formatter);
        }
        const formatted = formatter.format(values);
        return typeof formatted === "string"
          ? formatted
          : Array.isArray(formatted)
            ? formatted.join("")
            : String(formatted);
      } catch {
        return resolved.template;
      }
    },
    getLocale(): SupportedLocale {
      return currentLocale;
    },
    setLocale(locale: SupportedLocale): void {
      if (locale === currentLocale) {
        return;
      }
      currentLocale = locale;
      emitter.fire(locale);
    },
    onLocaleChange: emitter.event,
  };
}

const defaultTranslator = createTranslator(DEFAULT_CATALOGS, "en");

export const t = (key: string, values?: MessageValues): string =>
  defaultTranslator.t(key, values);

export const getLocale = (): SupportedLocale => defaultTranslator.getLocale();

export const setLocale = (locale: SupportedLocale): void =>
  defaultTranslator.setLocale(locale);

export const onLocaleChange: Event<SupportedLocale> =
  defaultTranslator.onLocaleChange;
