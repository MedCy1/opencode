import { describe, expect, test } from "bun:test"
import { formatOpenAIAccountLastUsed, formatOpenAIAccountRuntimeStatus } from "../../src/cli/cmd/providers"

describe("providers status helpers", () => {
  test("formats ready and waiting account states", () => {
    const now = Date.now()
    expect(
      formatOpenAIAccountRuntimeStatus(
        {
          id: "1",
          addedAt: 1,
          lastUsed: 1,
          active: true,
          available: true,
        },
        now,
      ),
    ).toBe("ready")

    expect(
      formatOpenAIAccountRuntimeStatus(
        {
          id: "2",
          addedAt: 1,
          lastUsed: 1,
          active: false,
          available: false,
          rateLimitedUntil: now + 15_000,
        },
        now,
      ),
    ).toContain("rate limited")

    expect(
      formatOpenAIAccountRuntimeStatus(
        {
          id: "3",
          addedAt: 1,
          lastUsed: 1,
          active: false,
          available: false,
          cooldownUntil: now + 15_000,
          cooldownReason: "network",
        },
        now,
      ),
    ).toContain("cooling down (network)")
  })

  test("formats last used as never or relative time", () => {
    const now = Date.now()
    expect(formatOpenAIAccountLastUsed(0, now)).toBe("never")
    expect(formatOpenAIAccountLastUsed(now - 5_000, now)).toContain("ago")
  })
})
