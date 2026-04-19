import { describe, expect, test } from "bun:test"
import { openAIAccountLabel, openAIAccountStatus } from "./openai-account-display"

describe("dialog-openai-accounts helpers", () => {
  test("prefers email over opaque identifiers", () => {
    expect(
      openAIAccountLabel(
        {
          id: "1",
          addedAt: 1,
          lastUsed: 1,
          active: false,
          available: true,
          email: "user@example.com",
          accountId: "refresh_deadbeef",
        },
        0,
      ),
    ).toBe("user@example.com")
  })

  test("falls back to a numbered label when display metadata is missing", () => {
    expect(
      openAIAccountLabel(
        {
          id: "1",
          addedAt: 1,
          lastUsed: 1,
          active: false,
          available: true,
        },
        1,
      ),
    ).toBe("Account 2")
  })

  test("reports account availability states", () => {
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
        cooldownUntil: Date.now() + 1_000,
        cooldownReason: "network",
      }),
    ).toBe("Cooling down (network)")
  })
})
