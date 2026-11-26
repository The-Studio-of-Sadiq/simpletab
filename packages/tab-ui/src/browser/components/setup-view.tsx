import {
  getRulesPreset,
  RULES_PRESETS,
  slugify,
  type RulesPreset,
} from "@simpletab/core/lib/setup/presets";
import { SIDE_NAME_OPTIONS, SIDE_NAME_SETS } from "@simpletab/core/lib/sideNames";
import type { SideNames } from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
  SimpleTabFormatChoice,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import {
  isExtensionsLoadedError,
  restartSimpleTabAction,
} from "../actions/extensions-actions";
import {
  createTournamentAction,
  openTournamentAction,
  saveSettingsAction,
  validateCreateInput,
  type CreateTournamentActionResult,
  type CreateTournamentInput,
  type OpenTournamentActionResult,
  type SaveSettingsInput,
  type SaveSettingsResult,
  type SettingsFieldKey,
} from "../actions/setup-actions";
import { t } from "../i18n";

export interface SetupViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  run: ActionRunner;
  onPickDirectory?: () => Promise<string | undefined>;
  onPickDbFile?: () => Promise<string | undefined>;
}

function presetsForFormat(format: SimpleTabFormatChoice): RulesPreset[] {
  return RULES_PRESETS.filter((preset) => {
    if (preset.format === "poly") {
      return false;
    }
    return format === "bp" ? preset.format === "bp" : preset.format !== "bp";
  });
}

function isRefusalMessage(message: string): boolean {
  return message === t("extensions.refusedToHost");
}

export const SetupView: React.FC<SetupViewProps> = ({
  state,
  status,
  run,
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
  const [extensionsRefused, setExtensionsRefused] = React.useState(false);
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
    setExtensionsRefused(false);
    setCreateSuccess(null);
    try {
      const opened = await run<{ dbPath: string }, OpenTournamentActionResult>(
        openTournamentAction,
        { dbPath: picked },
      );
      if (!opened.ok) {
        setExtensionsRefused(opened.errors.some(isRefusalMessage));
        setCreateError(opened.errors.join("; "));
        return;
      }
      setCreateSuccess(
        t("setup.openedSuccess", { slug: opened.status.slug ?? picked }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isExtensionsLoadedError(message)) {
        setExtensionsRefused(true);
        setCreateError(t("extensions.refusedToHost"));
      } else {
        setCreateError(message);
      }
    }
  };

  const handleCreateSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setCreateError(null);
    setExtensionsRefused(false);
    setCreateSuccess(null);

    const prelimNum = Number(createPrelimRounds);
    const params = {
      name: createName.trim(),
      slug: createSlug.trim(),
      format: createFormat,
      presetId: selectedPreset.id,
      prelimRounds: prelimNum,
      directory: createDirectory.trim(),
    };
    const nextFieldErrors = validateCreateInput(params);
    setCreateFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) {
      return;
    }

    setCreating(true);
    try {
      const result = await run<CreateTournamentInput, CreateTournamentActionResult>(
        createTournamentAction,
        params,
      );
      if (!result.ok) {
        setExtensionsRefused(result.errors.some(isRefusalMessage));
        setCreateError(result.errors.join("; "));
        return;
      }
      setCreateSuccess(
        t("setup.createdSuccess", {
          name: result.result.state.tournament.name,
          slug: result.result.state.tournament.slug,
          dbPath: result.result.dbPath,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isExtensionsLoadedError(message)) {
        setExtensionsRefused(true);
        setCreateError(t("extensions.refusedToHost"));
      } else {
        setCreateError(message);
      }
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
    const parseFinite = (raw: string, field: SettingsFieldKey): number | undefined => {
      const trimmed = raw.trim();
      const value = Number(trimmed);
      if (trimmed.length === 0 || !Number.isFinite(value)) {
        fieldErrors[field] = [t("setup.invalidNumber")];
        return undefined;
      }
      return value;
    };
    const asNumber = (value: number | undefined): number => value ?? 0;

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

    setSavingSettings(true);
    try {
      const result = await run<SaveSettingsInput, SaveSettingsResult>(saveSettingsAction, {
        name: settingsName,
        minSpeakerScore: asNumber(nextMinSpeaker),
        maxSpeakerScore: asNumber(nextMaxSpeaker),
        stepSpeakerScore: asNumber(nextStepSpeaker),
        minReplyScore: asNumber(nextMinReply),
        maxReplyScore: asNumber(nextMaxReply),
        replyScoresEnabled,
        sideNames,
        prelimRounds: asNumber(nextPrelim),
        breakSize: asNumber(nextBreakSize),
      });
      if (!result.ok) {
        setSettingsFieldErrors(result.fieldErrors);
        setSettingsBannerError(result.errors.join(" | "));
        return;
      }
      setSettingsBannerSuccess(
        result.unchanged
          ? t("setup.settingsUnchanged")
          : t("setup.settingsSaved", { seq: result.seq }),
      );
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
            data-action={openTournamentAction.id}
            onClick={() => {
              void handleOpenExisting();
            }}
          >
            {t("setup.openExisting")}
          </button>
        </div>
      </div>

      {status.open &&
      status.device === undefined &&
      (status.extensionsLoaded?.length ?? 0) > 0 ? (
        <div className="simpletab-alert simpletab-alert-warning" role="alert">
          <span>{t("extensions.hostWarning")}</span>{" "}
          <button
            type="button"
            className="theia-button secondary"
            data-action={restartSimpleTabAction.id}
            onClick={() => {
              void run(restartSimpleTabAction, {});
            }}
          >
            {t("extensions.restart")}
          </button>
        </div>
      ) : null}

      {createSuccess !== null ? (
        <div className="simpletab-alert simpletab-alert-success" role="status">
          {createSuccess}
        </div>
      ) : null}

      {createError !== null ? (
        <div className="simpletab-alert simpletab-alert-error" role="alert">
          <span>{createError}</span>{" "}
          {extensionsRefused ? (
            <button
              type="button"
              className="theia-button secondary"
              data-action={restartSimpleTabAction.id}
              onClick={() => {
                void run(restartSimpleTabAction, {});
              }}
            >
              {t("extensions.restart")}
            </button>
          ) : null}
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
                data-view-only
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
              data-action={createTournamentAction.id}
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
                data-action={saveSettingsAction.id}
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
