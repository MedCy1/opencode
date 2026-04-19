import { createMemo, createResource, createSignal, onMount, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { OpenAioAuthAccountSummary, OpenAioAuthStatusResult, ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useKeyboard } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "@tui/util/provider-origin"
import { Locale } from "@/util"

const PROVIDER_PRIORITY: Record<string, number> = {
  opencode: 0,
  "opencode-go": 1,
  openai: 2,
  "github-copilot": 3,
  anthropic: 4,
  google: 5,
}

type MethodOption = {
  method: ProviderAuthMethod
  index: number
}

export function openAIAccountLabel(account: Pick<OpenAioAuthAccountSummary, "label" | "email" | "accountId">, index: number) {
  return account.label ?? account.email ?? account.accountId ?? `Account ${index + 1}`
}

export function openAIAccountStatus(account: OpenAioAuthAccountSummary) {
  if (account.available) return "Ready"
  if (typeof account.rateLimitedUntil === "number" && account.rateLimitedUntil > Date.now()) {
    return `Rate limited for ${Locale.duration(account.rateLimitedUntil - Date.now())}`
  }
  if (typeof account.cooldownUntil === "number" && account.cooldownUntil > Date.now()) {
    const wait = Locale.duration(account.cooldownUntil - Date.now())
    return account.cooldownReason ? `Cooling down (${account.cooldownReason}) for ${wait}` : `Cooling down for ${wait}`
  }
  return "Unavailable"
}

export function openAIAccountLastUsed(lastUsed: number, now = Date.now()) {
  if (!lastUsed) return "last used never"
  const delta = Math.max(now - lastUsed, 0)
  if (delta < 86_400_000) return `last used ${Locale.duration(delta)} ago`
  return `last used ${Locale.datetime(lastUsed)}`
}

export function openAIStatusSummary(status: OpenAioAuthStatusResult, now = Date.now()) {
  const activeIndex = status.accounts.findIndex((account) => account.id === status.activeAccountId)
  const nextIndex = status.accounts.findIndex((account) => account.id === status.nextAccountId)
  const active = activeIndex === -1 ? undefined : status.accounts[activeIndex]
  const next = nextIndex === -1 ? undefined : status.accounts[nextIndex]
  return {
    active: active ? openAIAccountLabel(active, activeIndex) : undefined,
    next: next
      ? openAIAccountLabel(next, nextIndex)
      : status.nextWait
        ? `Waiting ${Locale.duration(status.nextWait)} (${status.nextWaitReason === "rate_limit" ? "rate limited" : "cooldown"})`
        : undefined,
    nextAccountId: next?.id,
    now,
  }
}

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()

  async function refreshProviders() {
    await sdk.client.instance.dispose()
    await sync.bootstrap({ fatal: false }).catch(toast.error)
  }

  async function runMethod(providerID: string, entry: MethodOption) {
    const method = entry.method
    if (method.type === "oauth") {
      let inputs: Record<string, string> | undefined
      if (method.prompts?.length) {
        const value = await PromptsMethod({
          dialog,
          prompts: method.prompts,
        })
        if (!value) return
        inputs = value
      }

      const result = await sdk.client.provider.oauth.authorize({
        providerID,
        method: entry.index,
        inputs,
      })
      if (result.error) {
        toast.show({
          variant: "error",
          message: JSON.stringify(result.error),
        })
        dialog.clear()
        return
      }
      if (result.data?.method === "code") {
        dialog.replace(() => (
          <CodeMethod providerID={providerID} title={method.label} index={entry.index} authorization={result.data!} />
        ))
      }
      if (result.data?.method === "auto") {
        dialog.replace(() => (
          <AutoMethod providerID={providerID} title={method.label} index={entry.index} authorization={result.data!} />
        ))
      }
      return
    }

    let metadata: Record<string, string> | undefined
    if (method.prompts?.length) {
      const value = await PromptsMethod({ dialog, prompts: method.prompts })
      if (!value) return
      metadata = value
    }
    dialog.replace(() => <ApiMethod providerID={providerID} title={method.label} metadata={metadata} />)
  }

  async function chooseMethod(providerID: string, methods: MethodOption[], title = "Select auth method") {
    const selected = methods.length > 1
      ? await new Promise<MethodOption | null>((resolve) => {
          dialog.replace(
            () => (
              <DialogSelect
                title={title}
                options={methods.map((entry) => ({
                  title: entry.method.label,
                  value: entry,
                }))}
                onSelect={(option) => resolve(option.value)}
              />
            ),
            () => resolve(null),
          )
        })
      : methods[0]
    if (!selected) return
    await runMethod(providerID, selected)
  }

  async function openOpenAIManager(methods: MethodOption[]) {
    const oauthMethods = methods.filter((entry) => entry.method.type === "oauth")
    dialog.replace(() => (
      <DialogOpenAIAccounts
        oauthMethods={oauthMethods}
        onAddAccount={() => chooseMethod("openai", oauthMethods, "Choose ChatGPT auth method")}
      />
    ))
  }

  async function openOpenAIOptions(methods: MethodOption[]) {
    const status = await sdk.client.provider.openai.oauth.account
      .status({}, { throwOnError: true })
      .then((x) => x.data)
      .catch(() => ({ accounts: [] }))
    const oauthMethods = methods.filter((entry) => entry.method.type === "oauth")
    const apiMethods = methods.filter((entry) => entry.method.type === "api")
    const summary = openAIStatusSummary(status)
    dialog.replace(() => (
      <DialogSelect
        title="OpenAI"
        options={[
          ...(oauthMethods.length
            ? [
                {
                  title: status.accounts.length ? "Add ChatGPT account" : "Connect ChatGPT account",
                  value: "oauth",
                  description: status.accounts.length ? `${status.accounts.length} saved account(s)` : "ChatGPT Plus/Pro",
                  onSelect: () => {
                    void chooseMethod("openai", oauthMethods, "Choose ChatGPT auth method")
                  },
                },
              ]
            : []),
          ...(apiMethods.length
            ? [
                {
                  title: "Use API key",
                  value: "api",
                  description: "OpenAI Platform key",
                  onSelect: () => {
                    void chooseMethod("openai", apiMethods, "Choose API key method")
                  },
                },
              ]
            : []),
          ...(status.accounts.length
            ? [
                {
                  title: "Manage ChatGPT accounts",
                  value: "manage",
                  description: summary.next ?? summary.active,
                  onSelect: () => {
                    void openOpenAIManager(methods)
                  },
                },
              ]
            : []),
          {
            title: "Disconnect OpenAI",
            value: "disconnect",
            description: "Remove all OpenAI credentials",
            onSelect: () => {
              void sdk.client.auth
                .remove({ providerID: "openai" }, { throwOnError: true })
                .then(refreshProviders)
                .then(() => {
                  toast.show({ message: "OpenAI disconnected", variant: "success" })
                  dialog.clear()
                })
                .catch(toast.error)
            },
          },
        ]}
      />
    ))
  }

  const options = createMemo(() => {
    return pipe(
      sync.data.provider_next.all,
      sortBy((x) => PROVIDER_PRIORITY[x.id] ?? 99),
      map((provider) => {
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, provider.id)
        const connected = sync.data.provider_next.connected.includes(provider.id)

        return {
          title: provider.name,
          value: provider.id,
          description: {
            opencode: "(Recommended)",
            anthropic: "(API key)",
            openai: "(ChatGPT Plus/Pro or API key)",
            "opencode-go": "Low cost subscription for everyone",
          }[provider.id],
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Other",
          gutter: connected ? <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            if (consoleManaged) return

            const methods = (sync.data.provider_auth[provider.id] ?? [
              {
                type: "api",
                label: "API key",
              },
            ]).map((method, index) => ({ method, index }))
            if (provider.id === "openai") {
              await openOpenAIOptions(methods)
              return
            }
            await chooseMethod(provider.id, methods)
          },
        }
      }),
    )
  })
  return options
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  return <DialogSelect title="Connect a provider" options={options()} />
}

function DialogOpenAIAccounts(props: { oauthMethods: MethodOption[]; onAddAccount: () => Promise<void> }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()

  async function refreshProviders() {
    await sdk.client.instance.dispose()
    await sync.bootstrap({ fatal: false }).catch(toast.error)
  }

  const [accounts, { refetch }] = createResource(async () => {
    const result = await sdk.client.provider.openai.oauth.account.status({}, { throwOnError: true })
    return result.data ?? { accounts: [] }
  })

  function reopen() {
    dialog.replace(() => <DialogOpenAIAccounts oauthMethods={props.oauthMethods} onAddAccount={props.onAddAccount} />)
  }

  const options = createMemo(() => {
    if (!accounts.latest) {
      return [
        {
          title: "Loading accounts...",
          value: "loading",
          onSelect: () => {},
        },
      ]
    }

    const summary = openAIStatusSummary(accounts.latest)

    return [
      ...(props.oauthMethods.length
        ? [
            {
              title: "Add ChatGPT account",
              value: "add",
              category: "Manage",
              onSelect: () => {
                void props.onAddAccount()
              },
            },
          ]
        : []),
      ...(summary.active || summary.next
        ? [
            ...(summary.active
              ? [
                  {
                    title: `Active: ${summary.active}`,
                    value: "status-active",
                    category: "Status",
                    onSelect: () => {},
                  },
                ]
              : []),
            ...(summary.next
              ? [
                  {
                    title: `Next request: ${summary.next}`,
                    value: "status-next",
                    category: "Status",
                    onSelect: () => {},
                  },
                ]
              : []),
          ]
        : []),
      {
        title: "Disconnect OpenAI",
        value: "disconnect",
        category: "Manage",
        onSelect: () => {
          void sdk.client.auth
            .remove({ providerID: "openai" }, { throwOnError: true })
            .then(refreshProviders)
            .then(() => {
              toast.show({ message: "OpenAI disconnected", variant: "success" })
              dialog.clear()
            })
            .catch(toast.error)
        },
      },
      ...accounts.latest.accounts.map((account, index) => ({
        title: `${openAIAccountLabel(account, index)}${account.active ? " (active)" : summary.nextAccountId === account.id ? " (next)" : ""}`,
        value: account,
        category: "Accounts",
        description: openAIAccountStatus(account),
        footer: [account.accountId, openAIAccountLastUsed(account.lastUsed)].filter(Boolean).join(" · "),
        gutter: account.active ? <text fg={theme.success}>✓</text> : summary.nextAccountId === account.id ? <text>→</text> : undefined,
        onSelect: () => {
          dialog.replace(() => (
            <DialogOpenAIAccount
              account={account}
              onBack={reopen}
              onChange={async () => {
                await refreshProviders()
                await refetch()
                reopen()
              }}
            />
          ))
        },
      })),
    ]
  })

  return <DialogSelect<string | OpenAioAuthAccountSummary> title="Manage OpenAI accounts" options={options()} />
}

function DialogOpenAIAccount(props: {
  account: OpenAioAuthAccountSummary
  onBack: () => void
  onChange: () => Promise<void>
}) {
  const sdk = useSDK()
  const toast = useToast()

  const options = createMemo(() => [
    ...(!props.account.active
      ? [
          {
            title: "Make active",
            value: "activate",
            description: "Use this account for new Codex requests",
            onSelect: () => {
              void sdk.client.provider.openai.oauth.account
                .select({ accountID: props.account.id }, { throwOnError: true })
                .then(props.onChange)
                .then(() => {
                  toast.show({ message: "Active OpenAI account updated", variant: "success" })
                })
                .catch(toast.error)
            },
          },
        ]
      : []),
    {
      title: "Remove account",
      value: "remove",
      description: props.account.email ?? props.account.accountId ?? "Stored ChatGPT account",
      onSelect: () => {
        void sdk.client.provider.openai.oauth.account
          .remove({ accountID: props.account.id }, { throwOnError: true })
          .then(props.onChange)
          .then(() => {
            toast.show({ message: "OpenAI account removed", variant: "success" })
          })
          .catch(toast.error)
      },
    },
    {
      title: "Back",
      value: "back",
      onSelect: props.onBack,
    },
  ])

  return <DialogSelect title={openAIAccountLabel(props.account, 0)} options={options()} />
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()

  useKeyboard((evt) => {
    if (evt.name === "c" && !evt.ctrl && !evt.meta) {
      const code = props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
      Clipboard.copy(code)
        .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
        .catch(toast.error)
    }
  })

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (result.error) {
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <DialogModel providerID={props.providerID} />)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
  metadata?: Record<string, string>
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      description={
        {
          opencode: (
            <box gap={1}>
              <text fg={theme.textMuted}>
                OpenCode Zen gives you access to all the best coding models at the cheapest prices with a single API
                key.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://opencode.ai/zen</span> to get a key
              </text>
            </box>
          ),
          "opencode-go": (
            <box gap={1}>
              <text fg={theme.textMuted}>
                OpenCode Go is a $10 per month subscription that provides reliable access to popular open coding models
                with generous usage limits.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://opencode.ai/zen</span> and enable OpenCode Go
              </text>
            </box>
          ),
        }[props.providerID] ?? undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
            ...(props.metadata ? { metadata: props.metadata } : {}),
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ProviderAuthMethod["prompts"]>[number][]
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}
