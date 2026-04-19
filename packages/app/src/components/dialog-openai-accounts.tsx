import type { OpenAioAuthAccountsResult, OpenAioAuthAccountSummary } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { createResource, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { DialogConnectProvider } from "./dialog-connect-provider"

function label(account: OpenAioAuthAccountSummary, index: number) {
  return account.label ?? account.email ?? account.accountId ?? `Account ${index + 1}`
}

function status(account: OpenAioAuthAccountSummary) {
  if (account.available) return account.active ? "Active" : "Ready"
  if (account.rateLimitedUntil) return "Rate limited"
  if (account.cooldownUntil) return account.cooldownReason ? `Cooling down (${account.cooldownReason})` : "Cooling down"
  return "Unavailable"
}

export function DialogOpenAIAccounts() {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const [accounts, { refetch }] = createResource<OpenAioAuthAccountsResult>(async () => {
    const result = await globalSDK.client.provider.openai.oauth.account.list(undefined, { throwOnError: true })
    return result.data ?? { accounts: [] }
  })

  async function refresh() {
    await globalSDK.client.global.dispose().catch(() => undefined)
    await refetch()
  }

  async function activate(accountID: string) {
    await globalSDK.client.provider.openai.oauth.account.select({ accountID }, { throwOnError: true })
    await refresh()
    showToast({ variant: "success", icon: "circle-check", title: "Active account updated" })
  }

  async function remove(accountID: string) {
    await globalSDK.client.provider.openai.oauth.account.remove({ accountID }, { throwOnError: true })
    await refresh()
    if ((accounts.latest?.accounts.length ?? 0) === 0) {
      dialog.close()
      showToast({ variant: "success", icon: "circle-check", title: "OpenAI account removed" })
      return
    }
    showToast({ variant: "success", icon: "circle-check", title: "OpenAI account removed" })
  }

  async function disconnectAll() {
    await globalSDK.client.auth.remove({ providerID: "openai" }, { throwOnError: true })
    await globalSDK.client.global.dispose().catch(() => undefined)
    dialog.close()
    showToast({ variant: "success", icon: "circle-check", title: "OpenAI disconnected" })
  }

  return (
    <Dialog title="Manage OpenAI Accounts">
      <div class="flex flex-col gap-6 px-5 pb-6 pt-2 max-w-[560px] w-full">
        <div class="flex flex-wrap gap-3">
          <Button
            size="large"
            variant="secondary"
            onClick={() => {
              dialog.close()
              dialog.show(() => <DialogConnectProvider provider="openai" />)
            }}
          >
            Add account
          </Button>
          <Button size="large" variant="ghost" onClick={() => void disconnectAll()}>
            Disconnect OpenAI
          </Button>
        </div>

        <Show
          when={!accounts.loading}
          fallback={
            <div class="text-14-regular text-text-base flex items-center gap-2">
              <Spinner />
              <span>Loading OpenAI accounts...</span>
            </div>
          }
        >
          <Show
            when={(accounts.latest?.accounts.length ?? 0) > 0}
            fallback={
              <div class="text-14-regular text-text-base">
                No ChatGPT OAuth accounts are stored for OpenAI yet. Add one to enable automatic rotation.
              </div>
            }
          >
            <div class="flex flex-col border border-border-weak-base rounded-2xl overflow-hidden">
              <For each={accounts.latest?.accounts ?? []}>
                {(account, index) => (
                  <div class="flex flex-wrap items-center justify-between gap-4 px-4 py-4 border-b border-border-weak-base last:border-b-0">
                    <div class="flex flex-col min-w-0 gap-1">
                      <div class="text-14-medium text-text-strong truncate">{label(account, index())}</div>
                      <div class="text-12-regular text-text-weak flex flex-wrap gap-x-3 gap-y-1">
                        <span>{status(account)}</span>
                        <Show when={account.accountId}>
                          <span class="font-mono">{account.accountId}</span>
                        </Show>
                      </div>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <Show when={!account.active}>
                        <Button size="large" variant="secondary" onClick={() => void activate(account.id)}>
                          Make active
                        </Button>
                      </Show>
                      <Button size="large" variant="ghost" onClick={() => void remove(account.id)}>
                        Remove
                      </Button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
