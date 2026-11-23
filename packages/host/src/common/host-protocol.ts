export const HOST_SERVICE_PATH = "/services/simpletab-host";

export const HostService = Symbol("HostService");

export interface HostLockInfo {
  opType: string;
  actorRef: string;
}

export interface HostStatus {
  open: boolean;
  slug?: string;
  headSeq?: number;
  integrityOk?: boolean;
  canSync?: boolean;
  locks: HostLockInfo[];
}

export interface CreateDemoResult {
  dbPath: string;
  status: HostStatus;
}

export interface HostService {
  status(): Promise<HostStatus>;
  openTournament(dbPath: string): Promise<HostStatus>;
  createDemoTournament(dir: string): Promise<CreateDemoResult>;
}
