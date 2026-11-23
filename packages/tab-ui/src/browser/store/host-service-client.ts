import type {
  HostServiceClient,
  StateChangedEvent,
} from "@simpletab/host/lib/common/host-protocol";
import { Emitter, type Event } from "@theia/core/lib/common";
import { injectable } from "@theia/core/shared/inversify";

@injectable()
export class HostServiceClientDispatcher implements HostServiceClient {
  private readonly onDidStateChangeEmitter = new Emitter<StateChangedEvent>();
  readonly onDidStateChange: Event<StateChangedEvent> =
    this.onDidStateChangeEmitter.event;

  onStateChanged(event: StateChangedEvent): void {
    this.onDidStateChangeEmitter.fire(event);
  }

  dispose(): void {
    this.onDidStateChangeEmitter.dispose();
  }
}
