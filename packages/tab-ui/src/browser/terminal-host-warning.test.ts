import type { DeviceModeStatus, HostStatus } from "@simpletab/host/lib/common/host-protocol";
import { Emitter } from "@theia/core/lib/common";
import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import { isHostLaptop, TerminalHostWarningContribution } from "./terminal-host-warning";

const device: DeviceModeStatus = {
  connection: "connected",
  deviceId: "dev-1",
  hostAddress: "192.168.1.10:47820",
  deviceName: "Rafi's laptop",
  roleId: "tab_director",
  roleName: "Tab director",
  queued: [],
  rejected: [],
  presence: [],
};

function makeContribution(status: HostStatus) {
  const created = new Emitter<unknown>();
  const warnings: string[] = [];
  const contribution = new TerminalHostWarningContribution();
  Object.assign(contribution, {
    terminalService: { onDidCreateTerminal: created.event },
    messageService: {
      warn: (message: string) => {
        warnings.push(message);
        return Promise.resolve(undefined);
      },
    },
    store: { getStatus: () => status },
  });
  contribution.onStart();
  return { openTerminal: () => created.fire({}), warnings };
}

describe("terminal host warning", () => {
  it("treats every laptop that is not a staff device as the host", () => {
    expect(isHostLaptop({ open: true, locks: [] })).toBe(true);
    expect(isHostLaptop({ open: false, locks: [] })).toBe(true);
    expect(isHostLaptop({ open: true, locks: [], device })).toBe(false);
  });

  it("warns each time a terminal is opened on the host", () => {
    const { openTerminal, warnings } = makeContribution({ open: true, locks: [] });
    openTerminal();
    openTerminal();
    expect(warnings).toEqual([t("terminal.hostWarning"), t("terminal.hostWarning")]);
    expect(warnings[0]).toContain("host laptop");
  });

  it("does not warn on a staff device", () => {
    const { openTerminal, warnings } = makeContribution({ open: true, locks: [], device });
    openTerminal();
    expect(warnings).toEqual([]);
  });
});
