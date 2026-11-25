import {
  CREDENTIAL_NAMES,
  type CredentialName,
  type CredentialStatusEntry,
  type CredentialTestResult,
  type SmtpCredentialPayload,
} from "@simpletab/host/lib/common/credentials-protocol";
import type { OnlineSettings } from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { isValidCdnHost } from "../lib/links-generator";
import { stateHasPermission } from "../lib/permissions";
import { defineAction, type ActionContext } from "./action";
import { inputNumber, inputRequired, pickYesNo } from "./prompt-helpers";

/** Widget id of the Credentials page. */
export const CREDENTIALS_PAGE = "simpletab-credentials-widget";

export interface SmtpFormValues {
  host: string;
  port: string;
  user: string;
  password: string;
  from: string;
}

export const EMPTY_SMTP_FORM: SmtpFormValues = {
  host: "",
  port: "587",
  user: "",
  password: "",
  from: "",
};

export interface SecretFormValues {
  token: string;
  smtp: SmtpFormValues;
}

const EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const DISPLAY_EMAIL_RE = /^[^<>]+<\s*([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)\s*>$/;
const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const PAGES_PROJECT_RE = /^[a-z0-9-]{1,58}$/;

export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  if (EMAIL_RE.test(trimmed)) {
    return true;
  }
  const match = DISPLAY_EMAIL_RE.exec(trimmed);
  return match !== null && EMAIL_RE.test(match[1] ?? "");
}

/** Serializes a secret exactly as electron-main expects; shared by the page and the action. */
export function serializeSecret(
  name: CredentialName,
  values: SecretFormValues,
): { value?: string; errorKey?: string } {
  if (name !== "smtp") {
    const trimmed = values.token.trim();
    return trimmed.length > 0
      ? { value: trimmed }
      : { errorKey: "credentials.validationEmpty" };
  }
  const host = values.smtp.host.trim();
  const port = Number(values.smtp.port.trim());
  const user = values.smtp.user.trim();
  const password = values.smtp.password;
  const from = values.smtp.from.trim();
  if (
    host.length === 0 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    user.length === 0 ||
    password.length === 0 ||
    !isValidEmail(from)
  ) {
    return { errorKey: "credentials.validationSmtp" };
  }
  const payload: SmtpCredentialPayload = { host, port, user, password, from };
  return { value: JSON.stringify(payload) };
}

/** "owner/name" from "owner/name" or a github.com address; "" clears it; undefined when invalid. */
export function normalizeGithubRepo(value: string): string | undefined {
  const trimmed = value
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (trimmed.length === 0) return "";
  const parts = trimmed.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts as [string, string];
  if (!GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(repo) || repo === "." || repo === "..") {
    return undefined;
  }
  return `${owner}/${repo}`;
}

/** Validates one online-settings form field before it reaches the host. */
export function normalizeOnlinePatch(
  patch: Partial<OnlineSettings>,
): { patch?: Partial<OnlineSettings>; errorKey?: string } {
  const next: Partial<OnlineSettings> = { ...patch };
  if (next.cdnHost !== undefined) {
    const host = next.cdnHost.trim().toLowerCase();
    if (host.length > 0 && !isValidCdnHost(host)) {
      return { errorKey: "credentials.cdnHostInvalid" };
    }
    next.cdnHost = host;
  }
  if (next.cloudflareAccountId !== undefined) {
    const account = next.cloudflareAccountId.trim().toLowerCase();
    if (account.length > 0 && !ACCOUNT_ID_RE.test(account)) {
      return { errorKey: "credentials.pagesAccountInvalid" };
    }
    next.cloudflareAccountId = account;
  }
  if (next.pagesProject !== undefined) {
    const project = next.pagesProject.trim().toLowerCase();
    if (project.length > 0 && !PAGES_PROJECT_RE.test(project)) {
      return { errorKey: "credentials.pagesProjectInvalid" };
    }
    next.pagesProject = project;
  }
  if (next.githubRepo !== undefined) {
    const repo = normalizeGithubRepo(next.githubRepo);
    if (repo === undefined) {
      return { errorKey: "credentials.githubRepoInvalid" };
    }
    next.githubRepo = repo;
  }
  return { patch: next };
}

export function credentialLabel(name: CredentialName): string {
  switch (name) {
    case "tournamentKey":
      return t("credentials.fieldTournamentKey");
    case "cdnToken":
      return t("credentials.fieldCdnToken");
    case "smtp":
      return t("credentials.fieldSmtp");
    case "githubToken":
      return t("credentials.fieldGithubToken");
    case "ownWorkerToken":
      return t("credentials.fieldOwnWorkerToken");
  }
}

export function credentialDescription(name: CredentialName): string {
  switch (name) {
    case "tournamentKey":
      return t("credentials.fieldTournamentKeyDesc");
    case "cdnToken":
      return t("credentials.fieldCdnTokenDesc");
    case "smtp":
      return t("credentials.fieldSmtpDesc");
    case "githubToken":
      return t("credentials.fieldGithubTokenDesc");
    case "ownWorkerToken":
      return t("credentials.fieldOwnWorkerTokenDesc");
  }
}

export interface CredentialActionSuccess {
  ok: true;
  status: CredentialStatusEntry[];
  test?: CredentialTestResult;
  onlineSettings?: OnlineSettings;
}

export interface CredentialActionFailure {
  ok: false;
  errors: string[];
  status?: CredentialStatusEntry[];
  test?: CredentialTestResult;
}

export type CredentialActionResult = CredentialActionSuccess | CredentialActionFailure;

function unavailable(): CredentialActionFailure {
  return { ok: false, errors: [t("credentials.unavailable")] };
}

function canManage(state: ActionContext["store"]["getState"] extends () => infer S ? S : never): boolean {
  return state === null || stateHasPermission(state, "credentials.manage");
}

async function pickCredential(ctx: ActionContext): Promise<CredentialName | undefined> {
  return ctx.prompts.pick(
    CREDENTIAL_NAMES.map((name) => ({
      label: credentialLabel(name),
      value: name,
    })),
    t("action.credentials.pickCredential"),
  );
}

async function promptSecret(ctx: ActionContext): Promise<SetSecretArgs | undefined> {
  const name = await pickCredential(ctx);
  if (name === undefined) {
    return undefined;
  }
  if (name !== "smtp") {
    const token = await inputRequired(
      ctx,
      t("action.credentials.secretPrompt", { label: credentialLabel(name) }),
      undefined,
      { password: true },
    );
    return token === undefined ? undefined : { name, values: { token, smtp: EMPTY_SMTP_FORM } };
  }
  // The SMTP form's fields in order; run() applies the page's own check to the whole set.
  const host = await inputRequired(ctx, t("action.credentials.smtpHostPrompt"), undefined);
  if (host === undefined) return undefined;
  const port = await inputNumber(ctx, t("action.credentials.smtpPortPrompt"), 587, {
    integer: true,
    min: 1,
    max: 65535,
  });
  if (port === undefined) return undefined;
  const user = await inputRequired(ctx, t("action.credentials.smtpUserPrompt"), undefined);
  if (user === undefined) return undefined;
  const password = await inputRequired(ctx, t("action.credentials.smtpPasswordPrompt"), undefined, {
    password: true,
  });
  if (password === undefined) return undefined;
  const from = await inputRequired(ctx, t("action.credentials.smtpFromPrompt"), undefined);
  if (from === undefined) return undefined;
  return {
    name,
    values: { token: "", smtp: { host, port: String(port), user, password, from } },
  };
}

export interface SetSecretArgs {
  name: CredentialName;
  values: SecretFormValues;
}

export const setCredentialSecretAction = defineAction<SetSecretArgs, CredentialActionResult>({
  id: "simpletab.credentials.set-secret",
  labelKey: "action.credentials.setSecret",
  page: CREDENTIALS_PAGE,
  isEnabled(snapshot) {
    return canManage(snapshot.state);
  },
  prompt: promptSecret,
  async run(ctx, { name, values }) {
    const credentials = ctx.services?.credentials;
    if (credentials === undefined) {
      return unavailable();
    }
    const serialized = serializeSecret(name, values);
    if (serialized.errorKey !== undefined || serialized.value === undefined) {
      return {
        ok: false,
        errors: [t(serialized.errorKey ?? "credentials.validationEmpty")],
      };
    }
    try {
      await credentials.set(name, serialized.value);
      return { ok: true, status: await credentials.status() };
    } catch (error) {
      return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
  },
});

export interface ClearSecretArgs {
  name: CredentialName;
}

export const clearCredentialSecretAction = defineAction<ClearSecretArgs, CredentialActionResult>({
  id: "simpletab.credentials.clear-secret",
  labelKey: "action.credentials.clearSecret",
  page: CREDENTIALS_PAGE,
  isEnabled(snapshot) {
    return canManage(snapshot.state);
  },
  async prompt(ctx) {
    const name = await pickCredential(ctx);
    if (name === undefined) return undefined;
    // The page clears at once; a saved secret cannot be recovered, so the palette asks.
    const confirmed = await ctx.prompts.confirm(
      t("action.credentials.confirmClearTitle", { label: credentialLabel(name) }),
      t("action.credentials.confirmClearMessage"),
    );
    return confirmed ? { name } : undefined;
  },
  async run(ctx, { name }) {
    const credentials = ctx.services?.credentials;
    if (credentials === undefined) {
      return unavailable();
    }
    try {
      await credentials.clear(name);
      return { ok: true, status: await credentials.status() };
    } catch (error) {
      return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
  },
});

export interface TestSecretArgs {
  name: CredentialName;
}

export const testCredentialSecretAction = defineAction<TestSecretArgs, CredentialActionResult>({
  id: "simpletab.credentials.test-secret",
  labelKey: "action.credentials.testSecret",
  page: CREDENTIALS_PAGE,
  isEnabled(snapshot) {
    return canManage(snapshot.state);
  },
  async prompt(ctx) {
    const name = await pickCredential(ctx);
    return name === undefined ? undefined : { name };
  },
  async run(ctx, { name }) {
    const credentials = ctx.services?.credentials;
    if (credentials === undefined) {
      return unavailable();
    }
    try {
      const result = await credentials.test(name);
      const status = await credentials.status();
      if (result.ok) {
        return { ok: true, status, test: result };
      }
      return {
        ok: false,
        status,
        test: result,
        errors: [result.error ?? t("credentials.testFailedGeneric")],
      };
    } catch (error) {
      return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
  },
});

type OnlineField =
  | "ballotPortal"
  | "livePublicSite"
  | "githubArchive"
  | "onlineRegistration"
  | "ballotCollection"
  | "trustSignedBallots"
  | "cdnHost"
  | "cloudflareAccountId"
  | "pagesProject"
  | "githubRepo";

const ONLINE_FIELDS: ReadonlyArray<{ value: OnlineField; labelKey: string }> = [
  { value: "ballotPortal", labelKey: "credentials.switchBallotPortal" },
  { value: "livePublicSite", labelKey: "credentials.switchLiveSite" },
  { value: "githubArchive", labelKey: "credentials.switchGithubArchive" },
  { value: "onlineRegistration", labelKey: "credentials.switchOnlineRegistration" },
  { value: "ballotCollection", labelKey: "credentials.ballotCollectionLabel" },
  { value: "trustSignedBallots", labelKey: "credentials.switchTrustSignedBallots" },
  { value: "cdnHost", labelKey: "credentials.cdnHostLabel" },
  { value: "cloudflareAccountId", labelKey: "credentials.pagesAccountLabel" },
  { value: "pagesProject", labelKey: "credentials.pagesProjectLabel" },
  { value: "githubRepo", labelKey: "credentials.githubRepoLabel" },
];

const BOOLEAN_FIELDS: ReadonlySet<OnlineField> = new Set([
  "ballotPortal",
  "livePublicSite",
  "githubArchive",
  "onlineRegistration",
  "trustSignedBallots",
]);

const TEXT_PROMPT_KEYS: Partial<Record<OnlineField, string>> = {
  cdnHost: "action.credentials.cdnHostPrompt",
  cloudflareAccountId: "action.credentials.pagesAccountPrompt",
  pagesProject: "action.credentials.pagesProjectPrompt",
  githubRepo: "action.credentials.githubRepoPrompt",
};

export interface UpdateOnlineSettingsArgs {
  patch: Partial<OnlineSettings>;
}

export const updateOnlineSettingsAction = defineAction<
  UpdateOnlineSettingsArgs,
  CredentialActionResult
>({
  id: "simpletab.credentials.update-online-settings",
  labelKey: "action.credentials.updateOnlineSettings",
  page: CREDENTIALS_PAGE,
  isEnabled(snapshot) {
    return snapshot.status.open && canManage(snapshot.state);
  },
  async prompt(ctx) {
    const field = await ctx.prompts.pick(
      ONLINE_FIELDS.map((item) => ({ label: t(item.labelKey), value: item.value })),
      t("action.credentials.pickOnlineSetting"),
    );
    if (field === undefined) {
      return undefined;
    }
    const current = ctx.store.getStatus().onlineSettings;
    if (BOOLEAN_FIELDS.has(field)) {
      const enabled = await pickYesNo(
        ctx,
        t("action.credentials.pickOnlineValue"),
        current?.[field] === true,
      );
      return enabled === undefined ? undefined : { patch: { [field]: enabled } };
    }
    if (field === "ballotCollection") {
      const mode = await ctx.prompts.pick(
        [
          { label: t("credentials.collectionOnline"), value: "online" },
          { label: t("credentials.collectionOnlineQr"), value: "online_qr" },
          { label: t("credentials.collectionQrOnly"), value: "qr_only" },
        ],
        t("action.credentials.pickOnlineValue"),
      );
      return mode === undefined
        ? undefined
        : { patch: { ballotCollection: mode as NonNullable<OnlineSettings["ballotCollection"]> } };
    }
    const promptKey = TEXT_PROMPT_KEYS[field];
    if (promptKey === undefined) {
      return undefined;
    }
    const value = current?.[field];
    const raw = await ctx.prompts.input(t(promptKey), {
      value: typeof value === "string" ? value : undefined,
      optional: true,
    });
    return raw === undefined ? undefined : { patch: { [field]: raw } };
  },
  async run(ctx, { patch }) {
    const normalized = normalizeOnlinePatch(patch);
    if (normalized.errorKey !== undefined || normalized.patch === undefined) {
      return {
        ok: false,
        errors: [t(normalized.errorKey ?? "credentials.validationEmpty")],
      };
    }
    if (!ctx.store.getStatus().open) {
      return { ok: false, errors: [t("credentials.noTournamentOnline")] };
    }
    try {
      const onlineSettings = await ctx.store.updateOnlineSettings(normalized.patch);
      return { ok: true, status: [], onlineSettings };
    } catch (error) {
      return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
  },
});

/** One command per credentials operation; no host call is duplicated in the page. */
export const CREDENTIALS_ACTIONS = [
  setCredentialSecretAction,
  clearCredentialSecretAction,
  testCredentialSecretAction,
  updateOnlineSettingsAction,
] as const;
