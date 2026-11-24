import { FileUri } from "@theia/core/lib/common/file-uri";
import { isWindows } from "@theia/core/lib/common/os";
import type URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { WorkspaceService } from "@theia/workspace/lib/browser";
import type { TournamentWorkspaceOpener } from "./store/tournament-store";

export function isSameWorkspaceFolder(current: URI, target: URI): boolean {
  return current.normalizePath().isEqual(target.normalizePath(), !isWindows);
}

@injectable()
export class TheiaTournamentWorkspaceOpener
  implements TournamentWorkspaceOpener
{
  constructor(
    @inject(WorkspaceService)
    private readonly workspaceService: WorkspaceService,
  ) {}

  async openTournamentFolder(folderPath: string): Promise<void> {
    const trimmed = folderPath.trim();
    if (trimmed.length === 0) {
      return;
    }
    const targetUri = FileUri.create(trimmed);
    await this.workspaceService.ready;
    const roots = this.workspaceService.tryGetRoots();
    if (
      !this.workspaceService.isMultiRootWorkspaceOpened &&
      roots.length === 1 &&
      isSameWorkspaceFolder(roots[0].resource, targetUri)
    ) {
      return;
    }
    this.workspaceService.open(targetUri, { preserveWindow: true });
  }
}
