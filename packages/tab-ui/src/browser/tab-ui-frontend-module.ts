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
  PROJECTOR_SERVICE_PATH,
  ProjectorService,
  ProjectorServiceClient,
} from "@simpletab/host/lib/common/projector-protocol";
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
import { FilterContribution } from "@theia/core/lib/common";
import { ContainerModule } from "@theia/core/shared/inversify";
import { t } from "./i18n";
import { SimpleTabShellFilterContribution } from "./shell-view-filter";
import {
  AllocationViewContribution,
  BreakViewContribution,
  ChangelogViewContribution,
  CheckinViewContribution,
  CredentialsViewContribution,
  DrawViewContribution,
  FeedbackViewContribution,
  LinksViewContribution,
  MotionsViewContribution,
  ParticipantsViewContribution,
  ProjectorControlViewContribution,
  ReleasesViewContribution,
  ResultsViewContribution,
  SetupViewContribution,
  SIMPLETAB_VIEW_CONTAINER_ID,
  SimpleTabContainerContribution,
  SimpleTabContribution,
  StandingsViewContribution,
} from "./simpletab-contribution";
import { SimpleTabStatusWidget } from "./simpletab-status-widget";
import { HostServiceClientDispatcher } from "./store/host-service-client";
import { ProjectorServiceClientDispatcher } from "./store/projector-service-client";
import {
  TournamentStore,
  TournamentWorkspaceOpener,
} from "./store/tournament-store";
import { TheiaTournamentWorkspaceOpener } from "./workspace-sync";
import "./style/simpletab-status.css";
import "./style/simpletab.css";
import { AllocationWidget } from "./views/allocation-widget";
import { BreakWidget } from "./views/break-widget";
import { ChangelogWidget } from "./views/changelog-widget";
import { CheckinWidget } from "./views/checkin-widget";
import { CredentialsWidget } from "./views/credentials-widget";
import { DrawWidget } from "./views/draw-widget";
import { FeedbackWidget } from "./views/feedback-widget";
import { LinksWidget } from "./views/links-widget";
import { MotionsWidget } from "./views/motions-widget";
import { ParticipantsWidget } from "./views/participants-widget";
import { ProjectorControlWidget } from "./views/projector-widget";
import { ReleasesWidget } from "./views/releases-widget";
import { ResultsWidget } from "./views/results-widget";
import { SetupWidget } from "./views/setup-widget";
import { SimpleTabNavWidget } from "./views/simpletab-nav-widget";
import { StandingsWidget } from "./views/standings-widget";

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

  bind(TheiaTournamentWorkspaceOpener).toSelf().inSingletonScope();
  bind(TournamentWorkspaceOpener).toService(TheiaTournamentWorkspaceOpener);
  bind(TournamentStore).toSelf().inSingletonScope();

  bind(SimpleTabShellFilterContribution).toSelf().inSingletonScope();
  bind(FilterContribution).toService(SimpleTabShellFilterContribution);
  bind(FrontendApplicationContribution).toService(
    SimpleTabShellFilterContribution,
  );

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

  bind(ProjectorServiceClientDispatcher).toSelf().inSingletonScope();
  bind(ProjectorServiceClient).toService(ProjectorServiceClientDispatcher);

  bind(ProjectorService)
    .toDynamicValue((ctx) => {
      if (ctx.container.isBound(ElectronMainConnectionProvider)) {
        const client = ctx.container.get<ProjectorServiceClient>(
          ProjectorServiceClient,
        );
        return ElectronIpcConnectionProvider.createProxy<ProjectorService>(
          ctx.container,
          PROJECTOR_SERVICE_PATH,
          client,
        );
      }
      throw new Error(
        "ProjectorService is available only when running in Electron.",
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

  bind(CheckinWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: CheckinWidget.ID,
      createWidget: () => ctx.container.get(CheckinWidget),
    }))
    .inSingletonScope();

  bind(DrawWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: DrawWidget.ID,
      createWidget: () => ctx.container.get(DrawWidget),
    }))
    .inSingletonScope();

  bind(AllocationWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: AllocationWidget.ID,
      createWidget: () => ctx.container.get(AllocationWidget),
    }))
    .inSingletonScope();

  bind(MotionsWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: MotionsWidget.ID,
      createWidget: () => ctx.container.get(MotionsWidget),
    }))
    .inSingletonScope();

  bind(ResultsWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: ResultsWidget.ID,
      createWidget: () => ctx.container.get(ResultsWidget),
    }))
    .inSingletonScope();

  bind(FeedbackWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: FeedbackWidget.ID,
      createWidget: () => ctx.container.get(FeedbackWidget),
    }))
    .inSingletonScope();

  bind(StandingsWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: StandingsWidget.ID,
      createWidget: () => ctx.container.get(StandingsWidget),
    }))
    .inSingletonScope();

  bind(BreakWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: BreakWidget.ID,
      createWidget: () => ctx.container.get(BreakWidget),
    }))
    .inSingletonScope();

  bind(ReleasesWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: ReleasesWidget.ID,
      createWidget: () => ctx.container.get(ReleasesWidget),
    }))
    .inSingletonScope();

  bind(ChangelogWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: ChangelogWidget.ID,
      createWidget: () => ctx.container.get(ChangelogWidget),
    }))
    .inSingletonScope();

  bind(CredentialsWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: CredentialsWidget.ID,
      createWidget: () => ctx.container.get(CredentialsWidget),
    }))
    .inSingletonScope();

  bind(LinksWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: LinksWidget.ID,
      createWidget: () => ctx.container.get(LinksWidget),
    }))
    .inSingletonScope();

  bind(ProjectorControlWidget).toSelf().inSingletonScope();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: ProjectorControlWidget.ID,
      createWidget: () => ctx.container.get(ProjectorControlWidget),
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
  bindViewContribution(bind, CheckinViewContribution);
  bindViewContribution(bind, DrawViewContribution);
  bindViewContribution(bind, AllocationViewContribution);
  bindViewContribution(bind, MotionsViewContribution);
  bindViewContribution(bind, ResultsViewContribution);
  bindViewContribution(bind, FeedbackViewContribution);
  bindViewContribution(bind, StandingsViewContribution);
  bindViewContribution(bind, BreakViewContribution);
  bindViewContribution(bind, ReleasesViewContribution);
  bindViewContribution(bind, ChangelogViewContribution);
  bindViewContribution(bind, CredentialsViewContribution);
  bindViewContribution(bind, LinksViewContribution);
  bindViewContribution(bind, ProjectorControlViewContribution);
  bindViewContribution(bind, SimpleTabContribution);
  bind(FrontendApplicationContribution).toService(SimpleTabContribution);
});
