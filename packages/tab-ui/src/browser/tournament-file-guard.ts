import type {
  BinaryBuffer,
  BinaryBufferReadable,
  BinaryBufferReadableStream,
} from "@theia/core/lib/common/buffer";
import { FileUri } from "@theia/core/lib/common/file-uri";
import { WorkspaceDeleteHandler } from "@theia/workspace/lib/browser/workspace-delete-handler";
import {
  MarkdownStringImpl,
  type MarkdownString,
} from "@theia/core/lib/common/markdown-rendering/markdown-string";
import { isWindows } from "@theia/core/lib/common/os";
import type URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import {
  FileService,
  type UpdateTextFileOptions,
} from "@theia/filesystem/lib/browser/file-service";
import type { TextDocumentContentChangeEvent } from "@theia/core/shared/vscode-languageserver-protocol";
import {
  FileOperationError,
  type FileOperationResult,
  type CopyFileOptions,
  type CreateFileOptions,
  type FileDeleteOptions,
  type FileOperationOptions,
  type FileStatWithMetadata,
  type MoveFileOptions,
  type WriteFileOptions,
} from "@theia/filesystem/lib/common/files";
import { t } from "./i18n";
import type { HostStatus } from "@simpletab/host/lib/common/host-protocol";

/**
 * What the guard needs from the rest of the app: the host status, and a way to tell the person
 * why a change was refused (Theia only logs a failed rename, move or save). Both are looked up
 * lazily: TournamentStore needs the workspace service, which needs FileService, so injecting
 * the store here directly would be a cycle.
 */
export const FileGuardContext = Symbol("FileGuardContext");
export interface FileGuardContext {
  getStatus(): HostStatus;
  notifyRefused(message: string): void;
}

export type ProtectedReason = "tournament-folder" | "database" | "certificate";

// Theia declares FileOperationResult as a const enum, so it has no runtime
// value; 6 is FileOperationResult.FILE_PERMISSION_DENIED in @theia/filesystem.
const FILE_PERMISSION_DENIED = 6 as FileOperationResult;

/**
 * Decides whether a plain filesystem path belongs to the open tournament's
 * protected files. The host's workspace path is passed in by the caller so
 * this check never needs the filesystem, a URI or a running app.
 */
export function protectedFileReason(
  target: string,
  workspaceDir: string | undefined,
  platform: NodeJS.Platform | string = isWindows ? "win32" : "linux",
): ProtectedReason | null {
  if (workspaceDir === undefined || workspaceDir.trim() === "") {
    return null;
  }
  const windows = platform === "win32";
  const normalize = (value: string): string => {
    const unified = windows ? value.replace(/\\/g, "/").toLowerCase() : value;
    const trimmed = unified.replace(/\/+$/, "");
    return trimmed === "" ? "/" : trimmed;
  };
  const root = normalize(workspaceDir);
  const candidate = normalize(target);

  const isSameOrBelow = (path: string, parent: string): boolean =>
    path === parent ||
    path.startsWith(parent === "/" ? "/" : `${parent}/`);

  // Deleting or moving any ancestor would take the live database and key with it.
  if (isSameOrBelow(root, candidate)) {
    return "tournament-folder";
  }

  const separator = candidate.lastIndexOf("/");
  const parent = separator <= 0 ? "/" : candidate.slice(0, separator);
  const base = candidate.slice(separator + 1);
  const comparedBase = windows ? base.toLowerCase() : base;

  if (parent === root && /^.+\.simpletab\.db(?:-.*)?$/.test(comparedBase)) {
    return "database";
  }
  const collabPath = root === "/" ? "/collab" : `${root}/collab`;
  if (parent === root && comparedBase === "collab") {
    return "certificate";
  }
  if (isSameOrBelow(candidate, collabPath)) {
    return "certificate";
  }
  return null;
}

/**
 * FileService is the single choke point for explorer and editor writes:
 * FileOperationParticipants cannot veto an operation, so the guard lives in
 * the service itself. Only the host laptop has a tournament folder to protect;
 * staff devices may use the explorer as usual.
 */
@injectable()
export class GuardedFileService extends FileService {
  constructor(
    @inject(FileGuardContext) private readonly context: FileGuardContext,
  ) {
    super();
  }

  /** The translated reason this URI is protected, or null when it may be changed. */
  protectedMessage(uri: URI): string | null {
    if (uri.scheme !== "file") {
      return null;
    }
    const status = this.context.getStatus();
    if (status.device !== undefined) {
      return null;
    }
    const reason = protectedFileReason(FileUri.fsPath(uri), status.workspaceDir);
    if (reason === null) {
      return null;
    }
    return reason === "database"
      ? t("files.protectedDatabase", { name: uri.path.base })
      : reason === "certificate"
        ? t("files.protectedCertificate")
        : t("files.protectedFolder");
  }

  private checkTarget(uri: URI): void {
    const message = this.protectedMessage(uri);
    if (message !== null) {
      this.context.notifyRefused(message);
      throw new FileOperationError(message, FILE_PERMISSION_DENIED);
    }
  }

  /**
   * Editors open protected files read-only and show this reason, so a change is never typed only
   * to be refused on save (Theia logs a refused save but does not tell the person).
   */
  override getReadOnlyMessage(resource: URI): MarkdownString | undefined {
    const message = this.protectedMessage(resource);
    return message !== null ? new MarkdownStringImpl(message) : super.getReadOnlyMessage(resource);
  }

  override async delete(
    resource: URI,
    options?: FileOperationOptions & Partial<FileDeleteOptions>,
  ): Promise<void> {
    this.checkTarget(resource);
    return super.delete(resource, options);
  }

  override async move(
    source: URI,
    target: URI,
    options?: MoveFileOptions,
  ): Promise<FileStatWithMetadata> {
    this.checkTarget(source);
    this.checkTarget(target);
    return super.move(source, target, options);
  }

  override async copy(
    source: URI,
    target: URI,
    options?: CopyFileOptions,
  ): Promise<FileStatWithMetadata> {
    this.checkTarget(target);
    return super.copy(source, target, options);
  }

  override async createFile(
    resource: URI,
    bufferOrReadableOrStream?:
      | BinaryBuffer
      | BinaryBufferReadable
      | BinaryBufferReadableStream,
    options?: CreateFileOptions,
  ): Promise<FileStatWithMetadata> {
    this.checkTarget(resource);
    return super.createFile(resource, bufferOrReadableOrStream, options);
  }

  override async writeFile(
    resource: URI,
    bufferOrReadableOrStream:
      | BinaryBuffer
      | BinaryBufferReadable
      | BinaryBufferReadableStream,
    options?: WriteFileOptions,
  ): Promise<FileStatWithMetadata> {
    this.checkTarget(resource);
    return super.writeFile(resource, bufferOrReadableOrStream, options);
  }

  /** Incremental editor saves write through the provider directly, not through writeFile. */
  override async update(
    resource: URI,
    changes: TextDocumentContentChangeEvent[],
    options: UpdateTextFileOptions,
  ): Promise<FileStatWithMetadata & { encoding: string }> {
    this.checkTarget(resource);
    return super.update(resource, changes, options);
  }

  override async createFolder(
    resource: URI,
    options?: FileOperationOptions,
  ): Promise<FileStatWithMetadata> {
    this.checkTarget(resource);
    return super.createFolder(resource, options);
  }
}

/**
 * Delete is disabled for protected files, so the explorer never offers it. Without this, Theia's
 * handler logs the refusal and then offers a permanent delete instead, without saying why.
 */
@injectable()
export class GuardedWorkspaceDeleteHandler extends WorkspaceDeleteHandler {
  @inject(GuardedFileService)
  protected readonly guard!: GuardedFileService;

  override isEnabled(uris: URI[]): boolean {
    return super.isEnabled(uris) && uris.every((uri) => this.guard.protectedMessage(uri) === null);
  }
}
