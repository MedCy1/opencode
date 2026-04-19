import type { OpenAioAuthAccountSummary, OpenAioAuthStatusResult } from "@opencode-ai/sdk/v2/client"

export function openAIAccountLabel(account: OpenAioAuthAccountSummary, index: number) {
  return account.label ?? account.email ?? account.accountId ?? `Account ${index + 1}`
}

export function openAIWait(ms: number) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.floor((ms % 60_000) / 1000)
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  }
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

export function openAIAccountHealth(account: OpenAioAuthAccountSummary, now = Date.now()) {
  if (account.available) return "Ready"
  if (typeof account.rateLimitedUntil === "number" && account.rateLimitedUntil > now) {
    return `Rate limited for ${openAIWait(account.rateLimitedUntil - now)}`
  }
  if (typeof account.cooldownUntil === "number" && account.cooldownUntil > now) {
    const wait = openAIWait(account.cooldownUntil - now)
    return account.cooldownReason ? `Cooling down (${account.cooldownReason}) for ${wait}` : `Cooling down for ${wait}`
  }
  return "Unavailable"
}

export function openAIAccountLastUsed(lastUsed: number, now = Date.now()) {
  if (!lastUsed) return "Never used"
  return `Last used ${openAIWait(Math.max(now - lastUsed, 0))} ago`
}

export function openAIStatusOverview(status: OpenAioAuthStatusResult, now = Date.now()) {
  const activeIndex = status.accounts.findIndex((account) => account.id === status.activeAccountId)
  const nextIndex = status.accounts.findIndex((account) => account.id === status.nextAccountId)
  const active = activeIndex === -1 ? undefined : status.accounts[activeIndex]
  const next = nextIndex === -1 ? undefined : status.accounts[nextIndex]
  return {
    active: active ? openAIAccountLabel(active, activeIndex) : undefined,
    next: next
      ? openAIAccountLabel(next, nextIndex)
      : status.nextWait
        ? `Waiting ${openAIWait(status.nextWait)}${status.nextWaitReason ? ` (${status.nextWaitReason === "rate_limit" ? "rate limited" : "cooldown"})` : ""}`
        : undefined,
    nextAccountId: next?.id,
    activeAccountId: active?.id,
    activeHealth: active ? openAIAccountHealth(active, now) : undefined,
  }
}
