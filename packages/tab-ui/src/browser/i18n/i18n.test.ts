import { createTranslator, t } from "./index";

describe("tab-ui i18n translator", () => {
  it("formats ICU messages with values from the shipped English catalog", () => {
    expect(t("status.title")).toBe("SimpleTab Status");
    expect(t("nav.tournamentSummary", { slug: "wudc", seq: 12 })).toBe(
      "wudc · seq 12",
    );
  });

  it("falls back to English when a key is missing or empty in the active locale", () => {
    const translator = createTranslator(
      {
        en: {
          greeting: "Hello, {name}!",
          onlyEn: "English fallback text",
        },
        bn: {
          greeting: "স্বাগতম, {name}!",
          onlyEn: "",
        },
      },
      "bn",
    );

    expect(translator.t("greeting", { name: "Rashed" })).toBe("স্বাগতম, Rashed!");
    expect(translator.t("onlyEn")).toBe("English fallback text");
  });

  it("returns the key itself when a key is missing in all catalogs", () => {
    const translator = createTranslator(
      {
        en: { known: "Known" },
        bn: { known: "জানা" },
      },
      "bn",
    );

    expect(translator.t("does.not.exist")).toBe("does.not.exist");
  });

  it("notifies listeners when the active locale changes", () => {
    const translator = createTranslator(
      {
        en: { hello: "Hello" },
        bn: { hello: "হ্যালো" },
      },
      "en",
    );
    const seen: string[] = [];
    const sub = translator.onLocaleChange((next) => seen.push(next));

    translator.setLocale("bn");
    expect(translator.getLocale()).toBe("bn");
    expect(translator.t("hello")).toBe("হ্যালো");
    expect(seen).toEqual(["bn"]);

    sub.dispose();
  });
});
