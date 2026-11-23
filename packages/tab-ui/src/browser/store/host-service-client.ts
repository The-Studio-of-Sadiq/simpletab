import type {
  HostLockInfo,
  HostServiceClient,
  StateChangedEvent,
} from "@simpletab/host/lib/common/host-protocol";
import { Emitter, type Event } from "@theia/core/lib/common";
import { injectable } from "@theia/core/shared/inversify";

@injectable()
export class HostServiceClientDispatcher implements HostServiceClient {
  private readonly onDidStateChangeEmitter = new Emitter<StateChangedEvent>();
  private readonly onDidLocksChangeEmitter = new Emitter<HostLockInfo[]>();
  readonly onDidStateChange: Event<StateChangedEvent> =
    this.onDidStateChangeEmitter.event;
  readonly onDidLocksChange: Event<HostLockInfo[]> =
    this.onDidLocksChangeEmitter.event;

  onStateChanged(event: StateChangedEvent): void {
    this.onDidStateChangeEmitter.fire(event);
  }

  onLocksChanged(locks: HostLockInfo[]): void {
    this.onDidLocksChangeEmitter.fire(locks);
  }

  dispose(): void {
    this.onDidStateChangeEmitter.dispose();
    this.onDidLocksChangeEmitter.dispose();
  }
}
