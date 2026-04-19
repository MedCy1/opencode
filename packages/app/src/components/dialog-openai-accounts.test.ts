import { describe, expect, test } from "bun:test"
import { openAIAccountHealth, openAIAccountLabel, openAIAccountLastUsed, openAIStatusOverview, openAIWait } from "./openai-account-display"

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

  test("formats waits and account availability states", () => {
    const now = Date.now()
    expect(openAIWait(65_000)).toBe("1m 5s")

    expect(
      openAIAccountHealth({
        id: "1",
        addedAt: 1,
        lastUsed: 1,
        active: true,
        available: true,
      }, now),
    ).toBe("Ready")

    expect(
      openAIAccountHealth({
        id: "2",
        addedAt: 1,
        lastUsed: 1,
        active: false,
        available: false,
        cooldownUntil: now + 1_000,
        cooldownReason: "network",
      }, now),
    ).toContain("Cooling down (network)")

    expect(openAIAccountLastUsed(now - 5_000, now)).toContain("Last used")
  })

  test("builds a status overview for active and waiting states", () => {
    const now = Date.now()
    expect(
      openAIStatusOverview(
        {
          activeAccountId: "a1",
          nextAccountId: "a2",
          accounts: [
            { id: "a1", addedAt: 1, lastUsed: now - 5_000, active: true, available: true, email: "one@example.com" },
            { id: "a2", addedAt: 1, lastUsed: now - 3_000, active: false, available: true, email: "two@example.com" },
          ],
        },
        now,
      ),
    ).toEqual(
      expect.objectContaining({
        active: "one@example.com",
        next: "two@example.com",
      }),
    )

    expect(
      openAIStatusOverview(
        {
          accounts: [],
          nextWait: 65_000,
          nextWaitReason: "rate_limit",
        },
        now,
      ).next,
    ).toContain("Waiting 1m 5s")
    expect(
      openAIStatusOverview(
        {
          accounts: [],
          nextWait: 65_000,
          nextWaitReason: "rate_limit",
        },
        now,
      ).next,
    ).toContain("rate limited")
  })
})
