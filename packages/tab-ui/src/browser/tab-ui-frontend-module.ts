import {
  CREDENTIALS_SERVICE_PATH,
  CredentialsService,
} from "@simpletab/host/lib/common/credentials-protocol";
import {
  HOST_SERVICE_PATH,
  HostService,
} from "@simpletab/host/lib/common/host-protocol";
import {
  bindViewContribution,
  FrontendApplicationContribution,
  ServiceConnectionProvider,
  WidgetFactory,
} from "@theia/core/lib/browser";
import {
  ElectronIpcConnectionProvider,
  ElectronMainConnectionProvider,
} from "@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source";
import { ContainerModule } from "@theia/core/shared/inversify";
import { SimpleTabContribution } from "./simpletab-contribution";
import { SimpleTabStatusWidget } from "./simpletab-status-widget";

export default new ContainerModule((bind) => {
  bind(HostService)
    .toDynamicValue((ctx) =>
      ServiceConnectionProvider.createProxy<HostService>(
        ctx.container,
        HOST_SERVICE_PATH,
      ),
    )
    .inSingletonScope();

  bind(CredentialsService)
    .toDynamicValue((ctx) => {
      if (ctx.container.isBound(ElectronMainConnectionProvider)) {
        return ElectronIpcConnectionProvider.createProxy<CredentialsService>(
          ctx.container,
          CREDENTIALS_SERVICE_PATH,
        );
      }
      throw new Error(
        "CredentialsService is available only when running in Electron.",
      );
    })
    .inSingletonScope();

  bind(SimpleTabStatusWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: SimpleTabStatusWidget.ID,
      createWidget: () => ctx.container.get(SimpleTabStatusWidget),
    }))
    .inSingletonScope();

  bindViewContribution(bind, SimpleTabContribution);
  bind(FrontendApplicationContribution).toService(SimpleTabContribution);
});
