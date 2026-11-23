import {
  buildBreakCategories,
  getRulesPreset,
  RULES_PRESETS,
  slugify,
  validateSlug,
  type RulesPreset,
} from "@simpletab/core/lib/setup/presets";
import { SIDE_NAME_OPTIONS, SIDE_NAME_SETS } from "@simpletab/core/lib/sideNames";
import type { OpRequest } from "@simpletab/core/ops";
import type {
  BreakCategory,
  SideNames,
  TournamentPreferences,
} from "@simpletab/core/types";
import type {
  CreateTournamentParams,
  CreateTournamentResult,
  HostStatus,
  ProjectedState,
  SimpleTabFormatChoice,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";

export interface SetupViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  onCreateTournament: (
    params: CreateTournamentParams,
  ) => Promise<CreateTournamentResult>;
  onOpenTournament: (dbPath: string) => Promise<HostStatus>;
  onSubmitOp: (request: OpRequest) => Promise<SubmitResult>;
  onPickDirectory?: () => Promise<string | undefined>;
  onPickDbFile?: () => Promise<string | undefined>;
}

type SettingsFieldKey =
  | "name"
  | "minSpeakerScore"
  | "maxSpeakerScore"
  | "stepSpeakerScore"
  | "minReplyScore"
  | "maxReplyScore"
  | "sideNames"
  | "prelimRounds"
  | "breakSize";

function presetsForFormat(format: SimpleTabFormatChoice): RulesPreset[] {
  return RULES_PRESETS.filter((preset) => {
    if (preset.format === "poly") {
      return false;
    }
    return format === "bp" ? preset.format === "bp" : preset.format !== "bp";
  });
}

function mapSettingsErrorToField(
  message: string,
  target: Partial<Record<SettingsFieldKey, string[]>>,
): void {
  const lower = message.toLowerCase();
  const add = (field: SettingsFieldKey, text: string): void => {
    target[field] = [...(target[field] ?? []), text];
  };

  if (lower.includes("tournament name")) {
    add("name", message);
  }
  if (lower.includes("minspeakerscore")) {
    add("minSpeakerScore", message);
  }
  if (lower.includes("maxspeakerscore")) {
    add("maxSpeakerScore", message);
  }
  if (lower.includes("stepspeakerscore")) {
    add("stepSpeakerScore", message);
  }
  if (lower.includes("minreplyscore")) {
    add("minReplyScore", message);
  }
  if (lower.includes("maxreplyscore")) {
    add("maxReplyScore", message);
  }
  if (lower.includes("sidenames")) {
    add("sideNames", message);
  }
  if (lower.includes("preliminary round")) {
    add("prelimRounds", message);
  }
  if (lower.includes("break size") || lower.includes("break sizes")) {
    add("breakSize", message);
  }
}

export const SetupView: React.FC<SetupViewProps> = ({
  state,
  onCreateTournament,
  onOpenTournament,
  onSubmitOp,
  onPickDirectory,
  onPickDbFile,
}) => {
  const baseId = React.useId();

  // Create Tournament state
  const [createName, setCreateName] = React.useState("");
  const [createSlug, setCreateSlug] = React.useState("");
  const [slugEdited, setSlugEdited] = React.useState(false);
  const [createFormat, setCreateFormat] =
    React.useState<SimpleTabFormatChoice>("bp");
  const [createPresetId, setCreatePresetId] = React.useState("bp");
  const [createPrelimRounds, setCreatePrelimRounds] = React.useState("4");
  const [createDirectory, setCreateDirectory] = React.useState("");
  const [createFieldErrors, setCreateFieldErrors] = React.useState<{
    name?: string;
    slug?: string;
    prelimRounds?: string;
  }>({});
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  // Core Settings state
  const currentBreakCategory = React.useMemo(() => {
    if (state === null) {
      return undefined;
    }
    return (
      state.breakCategories.find((cat) => cat.isGeneral) ??
      state.breakCategories[0]
    );
  }, [state]);

  const currentPrelimCount = React.useMemo(() => {
    if (state === null) {
      return 0;
    }
    return state.rounds.filter(
      (round) => round.stage === "preliminary" && !round.cancelled,
    ).length;
  }, [state]);

  const [settingsName, setSettingsName] = React.useState("");
  const [minSpeakerScore, setMinSpeakerScore] = React.useState("");
  const [maxSpeakerScore, setMaxSpeakerScore] = React.useState("");
  const [stepSpeakerScore, setStepSpeakerScore] = React.useState("");
  const [replyScoresEnabled, setReplyScoresEnabled] = React.useState(false);
  const [minReplyScore, setMinReplyScore] = React.useState("");
  const [maxReplyScore, setMaxReplyScore] = React.useState("");
  const [sideNames, setSideNames] = React.useState<SideNames>("aff-neg");
  const [settingsPrelimRounds, setSettingsPrelimRounds] = React.useState("4");
  const [breakSize, setBreakSize] = React.useState("8");
  const [settingsFieldErrors, setSettingsFieldErrors] = React.useState<
    Partial<Record<SettingsFieldKey, string[]>>
  >({});
  const [settingsBannerError, setSettingsBannerError] = React.useState<
    string | null
  >(null);
  const [settingsBannerSuccess, setSettingsBannerSuccess] = React.useState<
    string | null
  >(null);
  const [savingSettings, setSavingSettings] = React.useState(false);

  React.useEffect(() => {
    if (state === null) {
      return;
    }
    const prefs = state.tournament.preferences;
    setSettingsName(state.tournament.name);
    setMinSpeakerScore(String(prefs.minSpeakerScore));
    setMaxSpeakerScore(String(prefs.maxSpeakerScore));
    setStepSpeakerScore(String(prefs.stepSpeakerScore));
    setReplyScoresEnabled(prefs.replyScoresEnabled);
    setMinReplyScore(String(prefs.minReplyScore));
    setMaxReplyScore(String(prefs.maxReplyScore));
    setSideNames(prefs.sideNames ?? "aff-neg");
    setSettingsPrelimRounds(String(currentPrelimCount));
    setBreakSize(
      String(
        currentBreakCategory?.breakSize ??
          (state.tournament.format === "bp" ? 8 : 4),
      ),
    );
    setSettingsFieldErrors({});
  }, [
    state?.tournament.id,
    state?.seq,
    currentBreakCategory?.breakSize,
    currentPrelimCount,
  ]);

  const availablePresets = React.useMemo(
    () => presetsForFormat(createFormat),
    [createFormat],
  );

  const selectedPreset =
    getRulesPreset(createPresetId) ?? availablePresets[0];

  const handleFormatChange = (nextFormat: SimpleTabFormatChoice): void => {
    setCreateFormat(nextFormat);
    const matching = presetsForFormat(nextFormat);
    if (matching.length > 0 && !matching.some((p) => p.id === createPresetId)) {
      setCreatePresetId(matching[0].id);
    }
  };

  const handleBrowseDirectory = async (): Promise<void> => {
    if (onPickDirectory === undefined) {
      setCreateError(t("setup.fileDialogUnavailable"));
      return;
    }
    const picked = await onPickDirectory();
    if (picked !== undefined) {
      setCreateDirectory(picked);
    }
  };

  const handleOpenExisting = async (): Promise<void> => {
    if (onPickDbFile === undefined) {
      setCreateError(t("setup.fileDialogUnavailable"));
      return;
    }
    const picked = await onPickDbFile();
    if (picked === undefined) {
      return;
    }
    setCreateError(null);
    setCreateSuccess(null);
    try {
      const opened = await onOpenTournament(picked);
      setCreateSuccess(
        t("setup.openedSuccess", { slug: opened.slug ?? picked }),
      );
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCreateSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setCreateError(null);
    setCreateSuccess(null);

    const nextFieldErrors: {
      name?: string;
      slug?: string;
      prelimRounds?: string;
    } = {};

    if (createName.trim().length === 0) {
      nextFieldErrors.name = t("setup.nameRequired");
    }
    const slugErr = validateSlug(createSlug.trim());
    if (slugErr.length > 0) {
      nextFieldErrors.slug = slugErr;
    }
    const prelimNum = Number(createPrelimRounds);
    if (
      !Number.isInteger(prelimNum) ||
      prelimNum < 0 ||
      prelimNum > 20
    ) {
      nextFieldErrors.prelimRounds = t("setup.prelimRoundsError");
    }

    setCreateFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) {
      return;
    }

    setCreating(true);
    try {
      const result = await onCreateTournament({
        name: createName.trim(),
        slug: createSlug.trim(),
        format: createFormat,
        presetId: selectedPreset.id,
        prelimRounds: prelimNum,
        directory: createDirectory.trim(),
      });
      setCreateSuccess(
        t("setup.createdSuccess", {
          name: result.state.tournament.name,
          slug: result.state.tournament.slug,
          dbPath: result.dbPath,
        }),
      );
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  const handleSaveSettings = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (state === null) {
      return;
    }

    setSettingsFieldErrors({});
    setSettingsBannerError(null);
    setSettingsBannerSuccess(null);

    const fieldErrors: Partial<Record<SettingsFieldKey, string[]>> = {};
    const parseFinite = (
      raw: string,
      field: SettingsFieldKey,
    ): number | null => {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        fieldErrors[field] = [t("setup.invalidNumber")];
        return null;
      }
      const value = Number(trimmed);
      if (!Number.isFinite(value)) {
        fieldErrors[field] = [t("setup.invalidNumber")];
        return null;
      }
      return value;
    };

    const nextMinSpeaker = parseFinite(minSpeakerScore, "minSpeakerScore");
    const nextMaxSpeaker = parseFinite(maxSpeakerScore, "maxSpeakerScore");
    const nextStepSpeaker = parseFinite(stepSpeakerScore, "stepSpeakerScore");
    const nextMinReply = parseFinite(minReplyScore, "minReplyScore");
    const nextMaxReply = parseFinite(maxReplyScore, "maxReplyScore");
    const nextPrelim = parseFinite(settingsPrelimRounds, "prelimRounds");
    const nextBreakSize = parseFinite(breakSize, "breakSize");

    if (Object.keys(fieldErrors).length > 0) {
      setSettingsFieldErrors(fieldErrors);
      return;
    }

    const prefs = state.tournament.preferences;
    const partialPrefs: Partial<TournamentPreferences> = {};
    if (nextMinSpeaker !== null && nextMinSpeaker !== prefs.minSpeakerScore) {
      partialPrefs.minSpeakerScore = nextMinSpeaker;
    }
    if (nextMaxSpeaker !== null && nextMaxSpeaker !== prefs.maxSpeakerScore) {
      partialPrefs.maxSpeakerScore = nextMaxSpeaker;
    }
    if (nextStepSpeaker !== null && nextStepSpeaker !== prefs.stepSpeakerScore) {
      partialPrefs.stepSpeakerScore = nextStepSpeaker;
    }
    if (state.tournament.format !== "bp") {
      if (replyScoresEnabled !== prefs.replyScoresEnabled) {
        partialPrefs.replyScoresEnabled = replyScoresEnabled;
      }
      if (nextMinReply !== null && nextMinReply !== prefs.minReplyScore) {
        partialPrefs.minReplyScore = nextMinReply;
      }
      if (nextMaxReply !== null && nextMaxReply !== prefs.maxReplyScore) {
        partialPrefs.maxReplyScore = nextMaxReply;
      }
      if (sideNames !== (prefs.sideNames ?? "aff-neg")) {
        partialPrefs.sideNames = sideNames;
      }
    }

    const nameChanged = settingsName !== state.tournament.name;
    const prefsChanged = Object.keys(partialPrefs).length > 0;
    const prelimChanged = nextPrelim !== null && nextPrelim !== currentPrelimCount;
    const breakChanged =
      nextBreakSize !== null &&
      nextBreakSize !== currentBreakCategory?.breakSize;

    if (!nameChanged && !prefsChanged && !prelimChanged && !breakChanged) {
      setSettingsBannerSuccess(t("setup.settingsUnchanged"));
      return;
    }

    setSavingSettings(true);
    try {
      let lastSeq = state.seq;
      const errors: string[] = [];

      if (nameChanged || prefsChanged) {
        const result = await onSubmitOp({
          type: "settings.update",
          payload: {
            ...(nameChanged ? { name: settingsName } : {}),
            preferences: partialPrefs,
          },
        });
        if (!result.ok) {
          for (const err of result.errors) {
            mapSettingsErrorToField(err, fieldErrors);
            errors.push(`${result.code}: ${err}`);
          }
        } else {
          lastSeq = result.seq;
        }
      }

      if (prelimChanged && nextPrelim !== null) {
        const result = await onSubmitOp({
          type: "round.set_prelim_count",
          payload: { count: nextPrelim },
        });
        if (!result.ok) {
          for (const err of result.errors) {
            mapSettingsErrorToField(err, fieldErrors);
            errors.push(`${result.code}: ${err}`);
          }
        } else {
          lastSeq = result.seq;
        }
      }

      if (breakChanged && nextBreakSize !== null) {
        let nextCategories: BreakCategory[];
        if (currentBreakCategory !== undefined) {
          nextCategories = state.breakCategories.map((cat) =>
            cat.id === currentBreakCategory.id
              ? { ...cat, breakSize: nextBreakSize }
              : cat,
          );
        } else {
          nextCategories = buildBreakCategories(state.tournament.id, [
            {
              key: "open",
              name: "Open",
              breakSize: nextBreakSize,
              reserveSize: 0,
              isGeneral: true,
            },
          ]);
        }
        const result = await onSubmitOp({
          type: "break.categories_save",
          payload: { categories: nextCategories },
        });
        if (!result.ok) {
          for (const err of result.errors) {
            mapSettingsErrorToField(err, fieldErrors);
            errors.push(`${result.code}: ${err}`);
          }
        } else {
          lastSeq = result.seq;
        }
      }

      if (errors.length > 0) {
        setSettingsFieldErrors(fieldErrors);
        setSettingsBannerError(errors.join(" | "));
      } else {
        setSettingsBannerSuccess(t("setup.settingsSaved", { seq: lastSeq }));
      }
    } finally {
      setSavingSettings(false);
    }
  };

  const renderFieldError = (field: SettingsFieldKey): React.ReactNode => {
    const msgs = settingsFieldErrors[field];
    if (!msgs || msgs.length === 0) {
      return null;
    }
    return (
      <span id={`${baseId}-err-${field}`} className="simpletab-field-error">
        {msgs.join("; ")}
      </span>
    );
  };

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h1 className="simpletab-title">{t("setup.title")}</h1>
        <div className="simpletab-actions">
          <button
            type="button"
            className="theia-button secondary"
            onClick={() => {
              void handleOpenExisting();
            }}
          >
            {t("setup.openExisting")}
          </button>
        </div>
      </div>

      {createSuccess !== null ? (
        <div className="simpletab-alert simpletab-alert-success" role="status">
          {createSuccess}
        </div>
      ) : null}

      {createError !== null ? (
        <div className="simpletab-alert simpletab-alert-error" role="alert">
          {createError}
        </div>
      ) : null}

      <section className="simpletab-section" aria-labelledby={`${baseId}-create-h`}>
        <h2 id={`${baseId}-create-h`} className="simpletab-subtitle">
          {t("setup.createSectionTitle")}
        </h2>
        <form
          className="simpletab-form"
          aria-labelledby={`${baseId}-create-h`}
          noValidate
          onSubmit={(e) => {
            void handleCreateSubmit(e);
          }}
        >
          <div className="simpletab-form-grid">
            <div className="simpletab-field">
              <label htmlFor={`${baseId}-create-name`}>
                {t("setup.nameLabel")}
              </label>
              <input
                id={`${baseId}-create-name`}
                type="text"
                required
                aria-invalid={createFieldErrors.name !== undefined}
                aria-describedby={
                  createFieldErrors.name
                    ? `${baseId}-create-name-err`
                    : `${baseId}-create-name-hint`
                }
                value={createName}
                onChange={(e) => {
                  const next = e.target.value;
                  setCreateName(next);
                  if (!slugEdited) {
                    setCreateSlug(slugify(next));
                  }
                }}
              />
              <span id={`${baseId}-create-name-hint`} className="simpletab-hint">
                {t("setup.nameHint")}
              </span>
              {createFieldErrors.name ? (
                <span id={`${baseId}-create-name-err`} className="simpletab-field-error">
                  {createFieldErrors.name}
                </span>
              ) : null}
            </div>

            <div className="simpletab-field">
              <label htmlFor={`${baseId}-create-slug`}>
                {t("setup.slugLabel")}
              </label>
              <input
                id={`${baseId}-create-slug`}
                type="text"
                required
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={createFieldErrors.slug !== undefined}
                aria-describedby={
                  createFieldErrors.slug
                    ? `${baseId}-create-slug-err`
                    : `${baseId}-create-slug-hint`
                }
                value={createSlug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setCreateSlug(e.target.value);
                }}
              />
              <span id={`${baseId}-create-slug-hint`} className="simpletab-hint">
                {t("setup.slugHint")}
              </span>
              {createFieldErrors.slug ? (
                <span id={`${baseId}-create-slug-err`} className="simpletab-field-error">
                  {createFieldErrors.slug}
                </span>
              ) : null}
            </div>
          </div>

          <fieldset className="simpletab-fieldset">
            <legend>{t("setup.formatLegend")}</legend>
            <div className="simpletab-checkbox-row">
              <div className="simpletab-checkbox-item">
                <input
                  id={`${baseId}-format-bp`}
                  name="create-format"
                  type="radio"
                  value="bp"
                  checked={createFormat === "bp"}
                  onChange={() => handleFormatChange("bp")}
                />
                <label htmlFor={`${baseId}-format-bp`}>
                  {t("setup.formatBp")}
                </label>
              </div>
              <div className="simpletab-checkbox-item">
                <input
                  id={`${baseId}-format-2t`}
                  name="create-format"
                  type="radio"
                  value="two-team"
                  checked={createFormat === "two-team"}
                  onChange={() => handleFormatChange("two-team")}
                />
                <label htmlFor={`${baseId}-format-2t`}>
                  {t("setup.formatTwoTeam")}
                </label>
              </div>
            </div>
          </fieldset>

          <div className="simpletab-form-grid">
            <div className="simpletab-field">
              <label htmlFor={`${baseId}-create-preset`}>
                {t("setup.presetLabel")}
              </label>
              <select
                id={`${baseId}-create-preset`}
                value={selectedPreset.id}
                onChange={(e) => setCreatePresetId(e.target.value)}
              >
                {availablePresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
              <span className="simpletab-hint">{selectedPreset.blurb}</span>
            </div>

            <div className="simpletab-field">
              <label htmlFor={`${baseId}-create-prelims`}>
                {t("setup.prelimRoundsLabel")}
              </label>
              <input
                id={`${baseId}-create-prelims`}
                type="number"
                min={0}
                max={20}
                required
                aria-invalid={createFieldErrors.prelimRounds !== undefined}
                aria-describedby={
                  createFieldErrors.prelimRounds
                    ? `${baseId}-create-prelims-err`
                    : `${baseId}-create-prelims-hint`
                }
                value={createPrelimRounds}
                onChange={(e) => setCreatePrelimRounds(e.target.value)}
              />
              <span id={`${baseId}-create-prelims-hint`} className="simpletab-hint">
                {t("setup.prelimRoundsHint")}
              </span>
              {createFieldErrors.prelimRounds ? (
                <span
                  id={`${baseId}-create-prelims-err`}
                  className="simpletab-field-error"
                >
                  {createFieldErrors.prelimRounds}
                </span>
              ) : null}
            </div>
          </div>

          <div className="simpletab-field">
            <label htmlFor={`${baseId}-create-dir`}>
              {t("setup.directoryLabel")}
            </label>
            <div className="simpletab-input-row">
              <input
                id={`${baseId}-create-dir`}
                type="text"
                aria-describedby={`${baseId}-create-dir-hint`}
                value={createDirectory}
                onChange={(e) => setCreateDirectory(e.target.value)}
              />
              <button
                type="button"
                className="theia-button secondary"
                onClick={() => {
                  void handleBrowseDirectory();
                }}
              >
                {t("setup.browseFolder")}
              </button>
            </div>
            <span id={`${baseId}-create-dir-hint`} className="simpletab-hint">
              {t("setup.directoryHint")}
            </span>
          </div>

          <div className="simpletab-actions">
            <button
              type="submit"
              className="theia-button"
              disabled={creating}
            >
              {creating ? t("setup.creating") : t("setup.createButton")}
            </button>
          </div>
        </form>
      </section>

      {state !== null ? (
        <section className="simpletab-section" aria-labelledby={`${baseId}-settings-h`}>
          <h2 id={`${baseId}-settings-h`} className="simpletab-subtitle">
            {t("setup.settingsSectionTitle")}
          </h2>
          <p className="simpletab-hint">
            {t("setup.currentTournament", {
              name: state.tournament.name,
              slug: state.tournament.slug,
            })}
          </p>

          {settingsBannerSuccess !== null ? (
            <div className="simpletab-alert simpletab-alert-success" role="status">
              {settingsBannerSuccess}
            </div>
          ) : null}

          {settingsBannerError !== null ? (
            <div className="simpletab-alert simpletab-alert-error" role="alert">
              {settingsBannerError}
            </div>
          ) : null}

          <form
            className="simpletab-form"
            aria-labelledby={`${baseId}-settings-h`}
            noValidate
            onSubmit={(e) => {
              void handleSaveSettings(e);
            }}
          >
            <div className="simpletab-field">
              <label htmlFor={`${baseId}-set-name`}>
                {t("setup.nameLabel")}
              </label>
              <input
                id={`${baseId}-set-name`}
                type="text"
                aria-invalid={settingsFieldErrors.name !== undefined}
                aria-describedby={
                  settingsFieldErrors.name ? `${baseId}-err-name` : undefined
                }
                value={settingsName}
                onChange={(e) => setSettingsName(e.target.value)}
              />
              {renderFieldError("name")}
            </div>

            <div className="simpletab-form-grid">
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-min-spk`}>
                  {t("setup.minSpeakerScore")}
                </label>
                <input
                  id={`${baseId}-min-spk`}
                  type="number"
                  step="any"
                  aria-invalid={settingsFieldErrors.minSpeakerScore !== undefined}
                  aria-describedby={
                    settingsFieldErrors.minSpeakerScore
                      ? `${baseId}-err-minSpeakerScore`
                      : undefined
                  }
                  value={minSpeakerScore}
                  onChange={(e) => setMinSpeakerScore(e.target.value)}
                />
                {renderFieldError("minSpeakerScore")}
              </div>

              <div className="simpletab-field">
                <label htmlFor={`${baseId}-max-spk`}>
                  {t("setup.maxSpeakerScore")}
                </label>
                <input
                  id={`${baseId}-max-spk`}
                  type="number"
                  step="any"
                  aria-invalid={settingsFieldErrors.maxSpeakerScore !== undefined}
                  aria-describedby={
                    settingsFieldErrors.maxSpeakerScore
                      ? `${baseId}-err-maxSpeakerScore`
                      : undefined
                  }
                  value={maxSpeakerScore}
                  onChange={(e) => setMaxSpeakerScore(e.target.value)}
                />
                {renderFieldError("maxSpeakerScore")}
              </div>

              <div className="simpletab-field">
                <label htmlFor={`${baseId}-step-spk`}>
                  {t("setup.stepSpeakerScore")}
                </label>
                <input
                  id={`${baseId}-step-spk`}
                  type="number"
                  step="any"
                  aria-invalid={settingsFieldErrors.stepSpeakerScore !== undefined}
                  aria-describedby={
                    settingsFieldErrors.stepSpeakerScore
                      ? `${baseId}-err-stepSpeakerScore`
                      : undefined
                  }
                  value={stepSpeakerScore}
                  onChange={(e) => setStepSpeakerScore(e.target.value)}
                />
                {renderFieldError("stepSpeakerScore")}
              </div>
            </div>

            {state.tournament.format !== "bp" ? (
              <>
                <div className="simpletab-checkbox-item">
                  <input
                    id={`${baseId}-reply-enabled`}
                    type="checkbox"
                    checked={replyScoresEnabled}
                    onChange={(e) => setReplyScoresEnabled(e.target.checked)}
                  />
                  <label htmlFor={`${baseId}-reply-enabled`}>
                    {t("setup.replyScoresEnabled")}
                  </label>
                </div>

                <div className="simpletab-form-grid">
                  <div className="simpletab-field">
                    <label htmlFor={`${baseId}-min-rep`}>
                      {t("setup.minReplyScore")}
                    </label>
                    <input
                      id={`${baseId}-min-rep`}
                      type="number"
                      step="any"
                      aria-invalid={settingsFieldErrors.minReplyScore !== undefined}
                      aria-describedby={
                        settingsFieldErrors.minReplyScore
                          ? `${baseId}-err-minReplyScore`
                          : undefined
                      }
                      value={minReplyScore}
                      onChange={(e) => setMinReplyScore(e.target.value)}
                    />
                    {renderFieldError("minReplyScore")}
                  </div>

                  <div className="simpletab-field">
                    <label htmlFor={`${baseId}-max-rep`}>
                      {t("setup.maxReplyScore")}
                    </label>
                    <input
                      id={`${baseId}-max-rep`}
                      type="number"
                      step="any"
                      aria-invalid={settingsFieldErrors.maxReplyScore !== undefined}
                      aria-describedby={
                        settingsFieldErrors.maxReplyScore
                          ? `${baseId}-err-maxReplyScore`
                          : undefined
                      }
                      value={maxReplyScore}
                      onChange={(e) => setMaxReplyScore(e.target.value)}
                    />
                    {renderFieldError("maxReplyScore")}
                  </div>

                  <div className="simpletab-field">
                    <label htmlFor={`${baseId}-side-names`}>
                      {t("setup.sideNamesLabel")}
                    </label>
                    <select
                      id={`${baseId}-side-names`}
                      aria-invalid={settingsFieldErrors.sideNames !== undefined}
                      aria-describedby={
                        settingsFieldErrors.sideNames
                          ? `${baseId}-err-sideNames`
                          : undefined
                      }
                      value={sideNames}
                      onChange={(e) => setSideNames(e.target.value as SideNames)}
                    >
                      {SIDE_NAME_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {SIDE_NAME_SETS[option].label}
                        </option>
                      ))}
                    </select>
                    {renderFieldError("sideNames")}
                  </div>
                </div>
              </>
            ) : (
              <p className="simpletab-hint">{t("setup.sideNamesBpNote")}</p>
            )}

            <div className="simpletab-form-grid">
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-set-prelims`}>
                  {t("setup.prelimRoundsLabel")}
                </label>
                <input
                  id={`${baseId}-set-prelims`}
                  type="number"
                  aria-invalid={settingsFieldErrors.prelimRounds !== undefined}
                  aria-describedby={
                    settingsFieldErrors.prelimRounds
                      ? `${baseId}-err-prelimRounds`
                      : undefined
                  }
                  value={settingsPrelimRounds}
                  onChange={(e) => setSettingsPrelimRounds(e.target.value)}
                />
                {renderFieldError("prelimRounds")}
              </div>

              <div className="simpletab-field">
                <label htmlFor={`${baseId}-set-break`}>
                  {t("setup.breakSizeLabel")}
                </label>
                <input
                  id={`${baseId}-set-break`}
                  type="number"
                  aria-invalid={settingsFieldErrors.breakSize !== undefined}
                  aria-describedby={
                    settingsFieldErrors.breakSize
                      ? `${baseId}-err-breakSize`
                      : `${baseId}-set-break-hint`
                  }
                  value={breakSize}
                  onChange={(e) => setBreakSize(e.target.value)}
                />
                <span id={`${baseId}-set-break-hint`} className="simpletab-hint">
                  {t("setup.breakSizeHint")}
                </span>
                {renderFieldError("breakSize")}
              </div>
            </div>

            <div className="simpletab-actions">
              <button
                type="submit"
                className="theia-button"
                disabled={savingSettings}
              >
                {savingSettings ? t("setup.savingSettings") : t("setup.saveSettings")}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
};
