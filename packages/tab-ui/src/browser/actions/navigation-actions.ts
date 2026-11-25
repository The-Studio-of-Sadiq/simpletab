import { defineAction, type SimpleTabAction } from "./action";

/**
 * "Open a page" commands: the navigation bar's buttons, pages' "Open X" buttons and the palette
 * all run these. The ids are the shell's long-standing `simpletab.<page>.open` commands.
 */
type OpenAction = SimpleTabAction<Record<string, never>, { ok: true }>;

function openAction(id: string, labelKey: string, widgetId: string): OpenAction {
  return defineAction<Record<string, never>, { ok: true }>({
    id,
    labelKey,
    page: widgetId,
    isEnabled: () => true,
    prompt: async () => ({}),
    async run(ctx) {
      await ctx.openPage(widgetId);
      return { ok: true };
    },
  });
}

export const openSetupPageAction = openAction("simpletab.setup.open", "action.nav.openSetup", "simpletab-setup-widget");
export const openParticipantsPageAction = openAction("simpletab.participants.open", "action.nav.openParticipants", "simpletab-participants-widget");
export const openCheckinPageAction = openAction("simpletab.checkin.open", "action.nav.openCheckin", "simpletab-checkin-widget");
export const openDrawPageAction = openAction("simpletab.draw.open", "action.nav.openDraw", "simpletab-draw-widget");
export const openAllocationPageAction = openAction("simpletab.allocation.open", "action.nav.openAllocation", "simpletab-allocation-widget");
export const openMotionsPageAction = openAction("simpletab.motions.open", "action.nav.openMotions", "simpletab-motions-widget");
export const openResultsPageAction = openAction("simpletab.results.open", "action.nav.openResults", "simpletab-results-widget");
export const openFeedbackPageAction = openAction("simpletab.feedback.open", "action.nav.openFeedback", "simpletab-feedback-widget");
export const openStandingsPageAction = openAction("simpletab.standings.open", "action.nav.openStandings", "simpletab-standings-widget");
export const openBreakPageAction = openAction("simpletab.break.open", "action.nav.openBreak", "simpletab-break-widget");
export const openReleasesPageAction = openAction("simpletab.releases.open", "action.nav.openReleases", "simpletab-releases-widget");
export const openChangelogPageAction = openAction("simpletab.changelog.open", "action.nav.openChangelog", "simpletab-changelog-widget");
export const openLinksPageAction = openAction("simpletab.links.open", "action.nav.openLinks", "simpletab-links-widget");
export const openCredentialsPageAction = openAction("simpletab.credentials.open", "action.nav.openCredentials", "simpletab-credentials-widget");
export const openProjectorControlPageAction = openAction("simpletab.projectorControl.open", "action.nav.openProjector", "simpletab-projector-control-widget");
export const openStatusPageAction = openAction("simpletab.status.open", "action.nav.openStatus", "simpletab-status-widget");
export const openDevicesPageAction = openAction("simpletab.devices.open", "action.nav.openDevices", "simpletab-devices-widget");
export const openAssistantPageAction = openAction("simpletab.assistant.open", "action.nav.openAssistant", "simpletab-assistant-widget");
export const openProposalsPageAction = openAction("simpletab.proposals.open", "action.nav.openProposals", "simpletab.proposals");

export const NAVIGATION_ACTIONS = [
  openSetupPageAction,
  openParticipantsPageAction,
  openCheckinPageAction,
  openDrawPageAction,
  openAllocationPageAction,
  openMotionsPageAction,
  openResultsPageAction,
  openFeedbackPageAction,
  openStandingsPageAction,
  openBreakPageAction,
  openReleasesPageAction,
  openChangelogPageAction,
  openLinksPageAction,
  openCredentialsPageAction,
  openProjectorControlPageAction,
  openStatusPageAction,
  openDevicesPageAction,
  openAssistantPageAction,
  openProposalsPageAction,
] as const;
