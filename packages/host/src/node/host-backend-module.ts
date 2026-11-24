import {
  ConnectionHandler,
  JsonRpcConnectionHandler,
} from "@theia/core/lib/common/messaging";
import { BackendApplicationContribution } from "@theia/core/lib/node";
import { ContainerModule } from "@theia/core/shared/inversify";
import {
  HOST_SERVICE_PATH,
  HostService,
  type HostServiceClient,
} from "../common/host-protocol";
import { HostServiceImpl } from "./host-service";

export default new ContainerModule((bind) => {
  bind(HostServiceImpl)
    .toSelf()
    .inSingletonScope()
    // The running app warms its long-op worker when a tournament opens; tests leave this off.
    .onActivation((_ctx, service) => {
      service.enableWorkerPrewarm();
      // A laptop paired as a staff device reconnects to its host at start-up (section 4.1).
      if (process.env.SIMPLETAB_SMOKE !== "1" && process.env.SIMPLETAB_DEMO !== "1") {
        service.resumeDeviceMode();
      }
      return service;
    });
  bind(HostService).toService(HostServiceImpl);
  bind(BackendApplicationContribution).toService(HostServiceImpl);
  bind(ConnectionHandler)
    .toDynamicValue(
      (ctx) =>
        new JsonRpcConnectionHandler<HostServiceClient>(
          HOST_SERVICE_PATH,
          (client) => {
            const service = ctx.container.get<HostService>(HostService);
            service.setClient(client);
            return service;
          },
        ),
    )
    .inSingletonScope();
});
