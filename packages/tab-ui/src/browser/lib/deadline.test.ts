import {
  formatDeadlineTime,
  isDeadlinePassed,
  localDateTimeToUtcIso,
  utcIsoToLocalParts,
} from "./deadline";

describe("deadline timezone helpers", () => {
  it("converts Asia/Dhaka (UTC+6) local date/time to UTC ISO and formats back", () => {
    const utc = localDateTimeToUtcIso("2026-10-01", "14:00", "Asia/Dhaka");
    expect(utc).toBe("2026-10-01T08:00:00.000Z");
    expect(formatDeadlineTime(utc!, "Asia/Dhaka")).toBe("14:00");
    expect(utcIsoToLocalParts(utc!, "Asia/Dhaka")).toEqual({
      date: "2026-10-01",
      time: "14:00",
    });
  });

  it("handles Europe/London across GMT (winter) and BST (summer DST)", () => {
    const winterUtc = localDateTimeToUtcIso("2026-01-15", "14:00", "Europe/London");
    expect(winterUtc).toBe("2026-01-15T14:00:00.000Z");

    const summerUtc = localDateTimeToUtcIso("2026-07-15", "14:00", "Europe/London");
    expect(summerUtc).toBe("2026-07-15T13:00:00.000Z");
    expect(formatDeadlineTime(summerUtc!, "Europe/London")).toBe("14:00");

    // DST fall-back day (2026-10-25): 00:30 is BST (UTC+1), 02:30 is GMT (UTC+0)
    expect(localDateTimeToUtcIso("2026-10-25", "00:30", "Europe/London")).toBe(
      "2026-10-24T23:30:00.000Z",
    );
    expect(localDateTimeToUtcIso("2026-10-25", "02:30", "Europe/London")).toBe(
      "2026-10-25T02:30:00.000Z",
    );
  });

  it("rejects invalid dates and invalid time zones and checks deadline expiry", () => {
    expect(localDateTimeToUtcIso("2026-02-30", "14:00", "Asia/Dhaka")).toBeNull();
    expect(localDateTimeToUtcIso("2026-10-01", "14:00", "Mars/Olympus")).toBeNull();
    expect(
      isDeadlinePassed(
        "2026-10-01T08:00:00.000Z",
        Date.parse("2026-10-01T08:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isDeadlinePassed(
        "2026-10-01T08:00:00.000Z",
        Date.parse("2026-10-01T07:59:59.000Z"),
      ),
    ).toBe(false);
  });
});
