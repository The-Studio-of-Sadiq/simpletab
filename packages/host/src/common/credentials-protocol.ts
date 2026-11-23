export const CREDENTIALS_SERVICE_PATH = "/services/simpletab-credentials";

export const CredentialsService = Symbol("CredentialsService");

export type CredentialName =
  | "tournamentKey"
  | "cdnToken"
  | "smtp"
  | "ownWorkerToken"
  | "githubToken";

export const CREDENTIAL_NAMES: readonly CredentialName[] = [
  "tournamentKey",
  "cdnToken",
  "smtp",
  "ownWorkerToken",
  "githubToken",
];

export interface CredentialStatusEntry {
  name: CredentialName;
  set: boolean;
  testedAt?: string;
  ok?: boolean;
  error?: string;
}

export interface SmtpCredentialPayload {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

export interface CredentialTestResult {
  ok: boolean;
  error?: string;
}

export interface CredentialsService {
  status(): Promise<CredentialStatusEntry[]>;
  set(name: CredentialName, value: string): Promise<void>;
  clear(name: CredentialName): Promise<void>;
  test(name: CredentialName): Promise<CredentialTestResult>;
}
