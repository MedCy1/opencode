import type { OpenAioAuthAccountSummary } from "@opencode-ai/sdk/v2/client"

export function openAIAccountLabel(account: OpenAioAuthAccountSummary, index: number) {
  return account.label ?? account.email ?? account.accountId ?? `Account ${index + 1}`
}

export function openAIAccountStatus(account: OpenAioAuthAccountSummary) {
  if (account.available) return account.active ? "Active" : "Ready"
  if (account.rateLimitedUntil) return "Rate limited"
  if (account.cooldownUntil) return account.cooldownReason ? `Cooling down (${account.cooldownReason})` : "Cooling down"
  return "Unavailable"
}
