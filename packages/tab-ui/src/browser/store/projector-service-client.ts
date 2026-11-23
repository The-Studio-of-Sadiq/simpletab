import type {
  ProjectorServiceClient,
  ProjectorSyncPayload,
} from "@simpletab/host/lib/common/projector-protocol";
import { Emitter, type Event } from "@theia/core/lib/common";
import { injectable } from "@theia/core/shared/inversify";

@injectable()
export class ProjectorServiceClientDispatcher implements ProjectorServiceClient {
  private readonly onDidUpdateEmitter = new Emitter<ProjectorSyncPayload>();
  readonly onDidUpdate: Event<ProjectorSyncPayload> =
    this.onDidUpdateEmitter.event;

  onProjectorUpdate(payload: ProjectorSyncPayload): void {
    this.onDidUpdateEmitter.fire(payload);
  }

  dispose(): void {
    this.onDidUpdateEmitter.dispose();
  }
}
