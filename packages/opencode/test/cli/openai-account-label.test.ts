import { describe, expect, test } from "bun:test"
import { openAIAccountLabel, openAIAccountLastUsed, openAIAccountStatus, openAIStatusSummary } from "../../src/cli/cmd/tui/component/dialog-provider"

describe("tui openai account helpers", () => {
  test("prefers email over opaque account identifiers", () => {
    expect(
      openAIAccountLabel(
        {
          email: "user@example.com",
          accountId: "refresh_deadbeef",
        },
        0,
      ),
    ).toBe("user@example.com")
  })

  test("falls back to a neutral numbered label when no display metadata exists", () => {
    expect(openAIAccountLabel({}, 1)).toBe("Account 2")
  })

  test("reports rate-limited and active account states", () => {
    const now = Date.now()
    expect(
      openAIAccountStatus({
        id: "1",
        addedAt: 1,
        lastUsed: 1,
        active: true,
        available: true,
      }),
    ).toBe("Ready")

    expect(
      openAIAccountStatus({
        id: "2",
        addedAt: 1,
        lastUsed: 1,
        active: false,
        available: false,
        rateLimitedUntil: now + 1_000,
      }),
    ).toContain("Rate limited")

    expect(openAIAccountLastUsed(now - 5_000, now)).toContain("last used")
  })

  test("builds a TUI summary for the active and next accounts", () => {
    const summary = openAIStatusSummary({
      activeAccountId: "a1",
      nextAccountId: "a2",
      accounts: [
        { id: "a1", addedAt: 1, lastUsed: 1, active: true, available: true, email: "one@example.com" },
        { id: "a2", addedAt: 1, lastUsed: 1, active: false, available: true, email: "two@example.com" },
      ],
    })

    expect(summary.active).toBe("one@example.com")
    expect(summary.next).toBe("two@example.com")
  })
})
