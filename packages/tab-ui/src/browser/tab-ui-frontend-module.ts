import {
  CREDENTIALS_SERVICE_PATH,
  CredentialsService,
} from "@simpletab/host/lib/common/credentials-protocol";
import {
  HOST_SERVICE_PATH,
  HostService,
  HostServiceClient,
} from "@simpletab/host/lib/common/host-protocol";
import {
  bindViewContribution,
  codicon,
  FrontendApplicationContribution,
  ServiceConnectionProvider,
  ViewContainer,
  WidgetFactory,
  WidgetManager,
} from "@theia/core/lib/browser";
import {
  ElectronIpcConnectionProvider,
  ElectronMainConnectionProvider,
} from "@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source";
import { ContainerModule } from "@theia/core/shared/inversify";
import { t } from "./i18n";
import {
  ParticipantsViewContribution,
  SetupViewContribution,
  SIMPLETAB_VIEW_CONTAINER_ID,
  SimpleTabContainerContribution,
  SimpleTabContribution,
} from "./simpletab-contribution";
import { SimpleTabStatusWidget } from "./simpletab-status-widget";
import { HostServiceClientDispatcher } from "./store/host-service-client";
import { TournamentStore } from "./store/tournament-store";
import "./style/simpletab-status.css";
import "./style/simpletab.css";
import { ParticipantsWidget } from "./views/participants-widget";
import { SetupWidget } from "./views/setup-widget";
import { SimpleTabNavWidget } from "./views/simpletab-nav-widget";

export default new ContainerModule((bind) => {
  bind(HostServiceClientDispatcher).toSelf().inSingletonScope();
  bind(HostServiceClient).toService(HostServiceClientDispatcher);

  bind(HostService)
    .toDynamicValue((ctx) => {
      const client = ctx.container.get<HostServiceClient>(HostServiceClient);
      return ServiceConnectionProvider.createProxy<HostService>(
        ctx.container,
        HOST_SERVICE_PATH,
        client,
      );
    })
    .inSingletonScope();

  bind(TournamentStore).toSelf().inSingletonScope();

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

  bind(SimpleTabNavWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: SimpleTabNavWidget.ID,
      createWidget: () => ctx.container.get(SimpleTabNavWidget),
    }))
    .inSingletonScope();

  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: SIMPLETAB_VIEW_CONTAINER_ID,
      createWidget: async () => {
        const factory = ctx.container.get<ViewContainer.Factory>(
          ViewContainer.Factory,
        );
        const container = factory({ id: SIMPLETAB_VIEW_CONTAINER_ID });
        container.setTitleOptions({
          label: t("nav.containerTitle"),
          iconClass: codicon("organization"),
          closeable: true,
        });
        const navWidget = await ctx.container
          .get(WidgetManager)
          .getOrCreateWidget(SimpleTabNavWidget.ID);
        container.addWidget(navWidget, { canHide: false });
        return container;
      },
    }))
    .inSingletonScope();

  bind(SetupWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: SetupWidget.ID,
      createWidget: () => ctx.container.get(SetupWidget),
    }))
    .inSingletonScope();

  bind(ParticipantsWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: ParticipantsWidget.ID,
      createWidget: () => ctx.container.get(ParticipantsWidget),
    }))
    .inSingletonScope();

  bind(SimpleTabStatusWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: SimpleTabStatusWidget.ID,
      createWidget: () => ctx.container.get(SimpleTabStatusWidget),
    }))
    .inSingletonScope();

  bindViewContribution(bind, SimpleTabContainerContribution);
  bindViewContribution(bind, SetupViewContribution);
  bindViewContribution(bind, ParticipantsViewContribution);
  bindViewContribution(bind, SimpleTabContribution);
  bind(FrontendApplicationContribution).toService(SimpleTabContribution);
});
