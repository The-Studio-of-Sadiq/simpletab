import { ConnectionHandler, RpcConnectionHandler } from "@theia/core/lib/common/messaging";
import { BackendApplicationContribution } from "@theia/core/lib/node";
import { ContainerModule } from "@theia/core/shared/inversify";
import { HOST_SERVICE_PATH, HostService } from "../common/host-protocol";
import { HostServiceImpl } from "./host-service";

export default new ContainerModule((bind) => {
  bind(HostServiceImpl).toSelf().inSingletonScope();
  bind(HostService).toService(HostServiceImpl);
  bind(BackendApplicationContribution).toService(HostServiceImpl);
  bind(ConnectionHandler)
    .toDynamicValue(
      (ctx) =>
        new RpcConnectionHandler(HOST_SERVICE_PATH, () =>
          ctx.container.get<HostService>(HostService),
        ),
    )
    .inSingletonScope();
});
