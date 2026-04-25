import type { OpenAioAuthStatusResult } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { createResource, createSignal, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { openAIAccountHealth, openAIAccountLabel, openAIAccountLastUsed, openAIStatusOverview } from "./openai-account-display"
import { DialogConnectProvider } from "./dialog-connect-provider"

export function DialogOpenAIAccounts() {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const [busy, setBusy] = createSignal(false)
  const [status, { refetch }] = createResource<OpenAioAuthStatusResult>(async () => {
    const result = await globalSDK.client.provider.openai.oauth.account.status(undefined, { throwOnError: true })
    return result.data ?? { accounts: [] }
  })

  async function refresh() {
    await globalSDK.client.global.dispose().catch(() => undefined)
    await refetch()
  }

  async function activate(accountID: string) {
    if (busy()) return
    setBusy(true)
    try {
      await globalSDK.client.provider.openai.oauth.account.select({ accountID }, { throwOnError: true })
      await refresh()
      showToast({ variant: "success", icon: "circle-check", title: "Active account updated" })
    } finally {
      setBusy(false)
    }
  }

  async function remove(accountID: string) {
    if (busy()) return
    setBusy(true)
    try {
      await globalSDK.client.provider.openai.oauth.account.remove({ accountID }, { throwOnError: true })
      await refresh()
      if ((status.latest?.accounts.length ?? 0) === 0) {
        dialog.close()
        showToast({ variant: "success", icon: "circle-check", title: "OpenAI account removed" })
        return
      }
      showToast({ variant: "success", icon: "circle-check", title: "OpenAI account removed" })
    } finally {
      setBusy(false)
    }
  }

  async function disconnectAll() {
    if (busy()) return
    setBusy(true)
    try {
      await globalSDK.client.auth.remove({ providerID: "openai" }, { throwOnError: true })
      await globalSDK.client.global.dispose().catch(() => undefined)
      dialog.close()
      showToast({ variant: "success", icon: "circle-check", title: "OpenAI disconnected" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Manage OpenAI Accounts">
      <div class="flex flex-col gap-6 px-5 pb-6 pt-2 max-w-[560px] w-full">
        <div class="flex flex-wrap gap-3">
          <Button
            size="large"
            variant="secondary"
            disabled={busy()}
            onClick={() => {
              dialog.close()
              dialog.show(() => <DialogConnectProvider provider="openai" />)
            }}
          >
            Add account
          </Button>
          <Button size="large" variant="ghost" disabled={busy()} onClick={() => void disconnectAll()}>
            Disconnect OpenAI
          </Button>
        </div>

        <Show
          when={!status.loading}
          fallback={
            <div class="text-14-regular text-text-base flex items-center gap-2">
              <Spinner />
              <span>Loading OpenAI accounts...</span>
            </div>
          }
        >
          <Show
            when={(status.latest?.accounts.length ?? 0) > 0}
            fallback={
              <div class="text-14-regular text-text-base">
                No ChatGPT OAuth accounts are stored for OpenAI yet. Add one to enable automatic rotation.
              </div>
            }
          >
            <div class="flex flex-col gap-3">
              <div class="rounded-2xl border border-border-weak-base bg-surface-raised-base px-4 py-4">
                <div class="text-12-medium uppercase tracking-[0.08em] text-text-weak">Rotation</div>
                <div class="mt-3 flex flex-col gap-2 text-14-regular text-text-base">
                  <Show when={status.latest}>{(data) => {
                    const overview = () => openAIStatusOverview(data())
                    return (
                      <>
                        <Show when={overview().active}>
                          <div class="flex flex-wrap gap-x-2 gap-y-1">
                            <span class="text-text-weak">Active</span>
                            <span class="text-text-strong">{overview().active}</span>
                            <Show when={overview().activeHealth}>
                              <span class="text-text-weak">{overview().activeHealth}</span>
                            </Show>
                          </div>
                        </Show>
                        <Show when={overview().next}>
                          <div class="flex flex-wrap gap-x-2 gap-y-1">
                            <span class="text-text-weak">Next request</span>
                            <span class="text-text-strong">{overview().next}</span>
                          </div>
                        </Show>
                      </>
                    )
                  }}</Show>
                </div>
              </div>

              <div class="flex flex-col border border-border-weak-base rounded-2xl overflow-hidden">
              <For each={status.latest?.accounts ?? []}>
                {(account, index) => (
                  <div class="flex flex-wrap items-center justify-between gap-4 px-4 py-4 border-b border-border-weak-base last:border-b-0">
                    <div class="flex flex-col min-w-0 gap-1">
                      <div class="text-14-medium text-text-strong truncate flex flex-wrap items-center gap-2">
                        <span>{openAIAccountLabel(account, index())}</span>
                        <Show when={account.active}>
                          <span class="text-11-medium uppercase tracking-[0.08em] text-text-weak">Active</span>
                        </Show>
                        <Show when={status.latest?.nextAccountId === account.id && !account.active}>
                          <span class="text-11-medium uppercase tracking-[0.08em] text-text-weak">Next</span>
                        </Show>
                      </div>
                      <div class="text-12-regular text-text-weak flex flex-wrap gap-x-3 gap-y-1">
                        <span>{openAIAccountHealth(account)}</span>
                        <span>{openAIAccountLastUsed(account.lastUsed)}</span>
                        <Show when={account.accountId}>
                          <span class="font-mono">{account.accountId}</span>
                        </Show>
                      </div>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <Show when={!account.active}>
                        <Button size="large" variant="secondary" disabled={busy()} onClick={() => void activate(account.id)}>
                          Make active
                        </Button>
                      </Show>
                      <Button size="large" variant="ghost" disabled={busy()} onClick={() => void remove(account.id)}>
                        Remove
                      </Button>
                    </div>
                  </div>
                )}
              </For>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
