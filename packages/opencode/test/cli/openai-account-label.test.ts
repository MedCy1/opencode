import { describe, expect, test } from "bun:test"
import { openAIAccountLabel, openAIAccountStatus } from "../../src/cli/cmd/tui/component/dialog-provider"

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
    expect(
      openAIAccountStatus({
        id: "1",
        addedAt: 1,
        lastUsed: 1,
        active: true,
        available: true,
      }),
    ).toBe("Active")

    expect(
      openAIAccountStatus({
        id: "2",
        addedAt: 1,
        lastUsed: 1,
        active: false,
        available: false,
        rateLimitedUntil: Date.now() + 1_000,
      }),
    ).toBe("Rate limited")
  })
})
