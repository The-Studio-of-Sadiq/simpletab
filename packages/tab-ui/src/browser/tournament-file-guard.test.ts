import type { DeviceModeStatus, HostStatus } from "@simpletab/host/lib/common/host-protocol";
import { BinaryBuffer } from "@theia/core/lib/common/buffer";
import { FileUri } from "@theia/core/lib/common/file-uri";
import URI from "@theia/core/lib/common/uri";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import {
  FileOperationError,
  type FileStatWithMetadata,
} from "@theia/filesystem/lib/common/files";
import path from "node:path";
import { WorkspaceDeleteHandler } from "@theia/workspace/lib/browser/workspace-delete-handler";
import { afterEach, describe, expect, it, vi } from "vitest";

// The real handler's module graph loads CSS, which Node cannot import in tests.
vi.mock("@theia/workspace/lib/browser/workspace-delete-handler", () => ({
  WorkspaceDeleteHandler: class {
    isEnabled(uris: unknown[]): boolean {
      return uris.length > 0;
    }
  },
}));
import { t } from "./i18n";
import {
  GuardedFileService,
  GuardedWorkspaceDeleteHandler,
  protectedFileReason,
} from "./tournament-file-guard";

// Importing Theia's browser FileService loads Lumino's dragdrop module, which
// defines a class extending DragEvent; jsdom does not provide that global.
vi.hoisted(() => {
  if (typeof globalThis.DragEvent === "undefined") {
    Object.defineProperty(globalThis, "DragEvent", {
      configurable: true,
      value: class DragEvent extends Event {},
    });
  }
});

// Theia's FileOperationResult is a const enum (no runtime export); 6 is FILE_PERMISSION_DENIED.
const FILE_PERMISSION_DENIED = 6;

const device: DeviceModeStatus = {
  connection: "connected",
  deviceId: "dev-1",
  hostAddress: "192.168.1.10:47820",
  deviceName: "Rafi's laptop",
  roleId: "tab_director",
  roleName: "Tab director",
  queued: [],
  rejected: [],
  presence: [],
};

describe("protectedFileReason", () => {
  const win = "C:\\t\\bp";

  it("protects the Windows workspace folder, its ancestors and trailing separators", () => {
    expect(protectedFileReason(win, win, "win32")).toBe("tournament-folder");
    expect(protectedFileReason(`${win}\\`, `${win}\\`, "win32")).toBe(
      "tournament-folder",
    );
    expect(protectedFileReason("C:\\t", win, "win32")).toBe(
      "tournament-folder",
    );
    expect(protectedFileReason("C:/t", win, "win32")).toBe(
      "tournament-folder",
    );
  });

  it("protects database files directly inside the Windows workspace", () => {
    expect(
      protectedFileReason(`${win}\\bp.simpletab.db`, win, "win32"),
    ).toBe("database");
    expect(
      protectedFileReason(`${win}/bp.simpletab.db-wal`, win, "win32"),
    ).toBe("database");
    expect(
      protectedFileReason(`${win}\\bp.simpletab.db-shm`, win, "win32"),
    ).toBe("database");
    expect(
      protectedFileReason(`${win}\\bp.simpletab.db-journal`, win, "win32"),
    ).toBe("database");
    expect(
      protectedFileReason(`${win}\\BP.SimpleTab.DB`, win, "win32"),
    ).toBe("database");
  });

  it("protects collab and everything below it on Windows", () => {
    expect(protectedFileReason(`${win}\\collab`, win, "win32")).toBe(
      "certificate",
    );
    expect(
      protectedFileReason(`${win}\\COLLAB\\key.pem`, win, "win32"),
    ).toBe("certificate");
  });

  it("leaves ordinary files, other folders and subfolders alone on Windows", () => {
    expect(protectedFileReason(`${win}\\teams.csv`, win, "win32")).toBeNull();
    expect(protectedFileReason(`${win}\\.gitignore`, win, "win32")).toBeNull();
    expect(protectedFileReason(`${win}\\archive`, win, "win32")).toBeNull();
    expect(
      protectedFileReason(`${win}\\archive\\bp.simpletab.db`, win, "win32"),
    ).toBeNull();
    expect(
      protectedFileReason(`${win}\\notes\\collab\\key.pem`, win, "win32"),
    ).toBeNull();
    expect(
      protectedFileReason("C:\\t\\bp-old\\bp.simpletab.db", win, "win32"),
    ).toBeNull();
    expect(
      protectedFileReason("C:\\t\\bp-old\\collab", win, "win32"),
    ).toBeNull();
  });

  it("uses the same rules for POSIX paths, with case-sensitive names", () => {
    const posix = "/t/bp";
    expect(protectedFileReason(posix, posix, "linux")).toBe("tournament-folder");
    expect(protectedFileReason("/t/", posix, "linux")).toBe("tournament-folder");
    expect(protectedFileReason(`${posix}/bp.simpletab.db`, posix, "linux")).toBe(
      "database",
    );
    expect(
      protectedFileReason(`${posix}/bp.simpletab.db-journal`, posix, "linux"),
    ).toBe("database");
    expect(protectedFileReason(`${posix}/collab`, posix, "linux")).toBe(
      "certificate",
    );
    expect(
      protectedFileReason(`${posix}/collab/key.pem`, posix, "linux"),
    ).toBe("certificate");
    expect(protectedFileReason(`${posix}/teams.csv`, posix, "linux")).toBeNull();
    expect(
      protectedFileReason(`${posix}/BP.SimpleTab.DB`, posix, "linux"),
    ).toBeNull();
    expect(
      protectedFileReason(`${posix}/sub/bp.simpletab.db`, posix, "linux"),
    ).toBeNull();
    expect(
      protectedFileReason("/t/bp-old/bp.simpletab.db", posix, "linux"),
    ).toBeNull();
  });

  it("protects nothing when no tournament is open", () => {
    expect(protectedFileReason(`${win}\\bp.simpletab.db`, undefined, "win32"))
      .toBeNull();
    expect(protectedFileReason(`${win}\\collab`, undefined, "win32")).toBeNull();
    expect(protectedFileReason(win, undefined, "win32")).toBeNull();
  });
});

describe("GuardedFileService", () => {
  const workspace = path.resolve(path.sep, "t", "bp");
  const dbUri = FileUri.create(path.join(workspace, "bp.simpletab.db"));
  const csvUri = FileUri.create(path.join(workspace, "teams.csv"));
  const hostStatus: HostStatus = {
    open: true,
    locks: [],
    workspaceDir: workspace,
  };
  const stat = {} as FileStatWithMetadata;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  let refused: string[] = [];

  function makeService(status: HostStatus): GuardedFileService {
    refused = [];
    const service = Object.create(
      GuardedFileService.prototype,
    ) as GuardedFileService;
    Object.assign(service, {
      context: {
        getStatus: () => status,
        notifyRefused: (message: string) => {
          refused.push(message);
        },
      },
    });
    return service;
  }

  async function expectDenied(
    operation: Promise<unknown>,
    message: string,
  ): Promise<void> {
    const error = await operation.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(FileOperationError);
    if (!(error instanceof FileOperationError)) {
      throw new Error("Expected a FileOperationError");
    }
    expect(error.fileOperationResult).toBe(FILE_PERMISSION_DENIED);
    expect(error.message).toBe(message);
  }

  it("blocks guarded deletes and lets ordinary files reach the base service", async () => {
    const base = vi
      .spyOn(FileService.prototype, "delete")
      .mockResolvedValue(undefined);
    const service = makeService(hostStatus);

    await expectDenied(
      service.delete(dbUri),
      t("files.protectedDatabase", { name: "bp.simpletab.db" }),
    );
    expect(base).not.toHaveBeenCalled();

    await expectDenied(
      service.delete(FileUri.create(path.dirname(workspace))),
      t("files.protectedFolder"),
    );
    expect(base).not.toHaveBeenCalled();

    await service.delete(csvUri);
    expect(base).toHaveBeenCalledWith(csvUri, undefined);
  });

  it("checks both move endpoints", async () => {
    const base = vi.spyOn(FileService.prototype, "move").mockResolvedValue(stat);
    const service = makeService(hostStatus);

    await expectDenied(
      service.move(dbUri, csvUri),
      t("files.protectedDatabase", { name: "bp.simpletab.db" }),
    );
    await expectDenied(
      service.move(csvUri, FileUri.create(path.join(workspace, "collab", "key.pem"))),
      t("files.protectedCertificate"),
    );
    expect(base).not.toHaveBeenCalled();

    await service.move(csvUri, FileUri.create(path.join(workspace, "renamed.csv")));
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("checks only the copy target", async () => {
    const base = vi.spyOn(FileService.prototype, "copy").mockResolvedValue(stat);
    const service = makeService(hostStatus);

    await service.copy(dbUri, csvUri);
    expect(base).toHaveBeenCalledWith(dbUri, csvUri, undefined);

    await expectDenied(
      service.copy(csvUri, dbUri),
      t("files.protectedDatabase", { name: "bp.simpletab.db" }),
    );
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("guards file creation and writes", async () => {
    const create = vi
      .spyOn(FileService.prototype, "createFile")
      .mockResolvedValue(stat);
    const write = vi
      .spyOn(FileService.prototype, "writeFile")
      .mockResolvedValue(stat);
    const service = makeService(hostStatus);
    const buffer = BinaryBuffer.fromString("x");
    const keyUri = FileUri.create(path.join(workspace, "collab", "key.pem"));

    await expectDenied(
      service.createFile(dbUri),
      t("files.protectedDatabase", { name: "bp.simpletab.db" }),
    );
    await expectDenied(
      service.writeFile(keyUri, buffer),
      t("files.protectedCertificate"),
    );
    expect(create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();

    await service.createFile(csvUri);
    await service.writeFile(csvUri, buffer);
    expect(create).toHaveBeenCalledWith(csvUri, undefined, undefined);
    expect(write).toHaveBeenCalledWith(csvUri, buffer, undefined);
  });

  it("guards incremental editor saves (update)", async () => {
    const result = Object.assign({}, stat, { encoding: "utf8" });
    const update = vi
      .spyOn(FileService.prototype, "update")
      .mockResolvedValue(result);
    const service = makeService(hostStatus);
    const changes = [{ text: "x" }];
    const options = { readEncoding: "utf8" };

    await expectDenied(
      service.update(dbUri, changes, options),
      t("files.protectedDatabase", { name: "bp.simpletab.db" }),
    );
    expect(update).not.toHaveBeenCalled();

    await service.update(csvUri, changes, options);
    expect(update).toHaveBeenCalledWith(csvUri, changes, options);
  });

  it("opens protected files read-only with the reason", () => {
    const base = vi
      .spyOn(FileService.prototype, "getReadOnlyMessage")
      .mockReturnValue(undefined);
    const service = makeService(hostStatus);

    expect(service.getReadOnlyMessage(dbUri)?.value).toBe(
      t("files.protectedDatabase", { name: "bp.simpletab.db" }),
    );
    expect(base).not.toHaveBeenCalled();
    expect(service.getReadOnlyMessage(csvUri)).toBeUndefined();
    expect(base).toHaveBeenCalledWith(csvUri);
  });

  it("tells the person why each refused change was refused", async () => {
    vi.spyOn(FileService.prototype, "delete").mockResolvedValue(undefined);
    const service = makeService(hostStatus);
    const message = t("files.protectedDatabase", { name: "bp.simpletab.db" });

    await expectDenied(service.delete(dbUri), message);
    await service.delete(csvUri);
    expect(refused).toEqual([message]);
  });

  it("disables Delete for protected files only", () => {
    const service = makeService(hostStatus);
    vi.spyOn(WorkspaceDeleteHandler.prototype, "isEnabled").mockReturnValue(true);
    const handler = Object.create(
      GuardedWorkspaceDeleteHandler.prototype,
    ) as GuardedWorkspaceDeleteHandler;
    Object.assign(handler, { guard: service });

    expect(handler.isEnabled([csvUri])).toBe(true);
    expect(handler.isEnabled([dbUri])).toBe(false);
    expect(handler.isEnabled([csvUri, dbUri])).toBe(false);
    expect(refused).toEqual([]);
  });

  it("guards folder creation", async () => {
    const base = vi
      .spyOn(FileService.prototype, "createFolder")
      .mockResolvedValue(stat);
    const service = makeService(hostStatus);
    const collabUri = FileUri.create(path.join(workspace, "collab"));

    await expectDenied(
      service.createFolder(collabUri),
      t("files.protectedCertificate"),
    );
    expect(base).not.toHaveBeenCalled();

    const archiveUri = FileUri.create(path.join(workspace, "archive"));
    await service.createFolder(archiveUri);
    expect(base).toHaveBeenCalledWith(archiveUri, undefined);
  });

  it("ignores non-file URIs and staff devices", async () => {
    const base = vi
      .spyOn(FileService.prototype, "delete")
      .mockResolvedValue(undefined);
    const service = makeService(hostStatus);
    const deviceService = makeService({
      open: true,
      locks: [],
      workspaceDir: workspace,
      device,
    });

    await service.delete(new URI("untitled:Untitled-1"));
    await deviceService.delete(dbUri);
    expect(base).toHaveBeenCalledTimes(2);
  });
});
