import path from "path"
import { Hash } from "@opencode-ai/shared/util/hash"
import { Effect, Layer, Record, Result, Schema, Context, Semaphore } from "effect"
import { zod } from "@/util/effect-zod"
import { Global } from "../global"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")
const OPENAI_PROVIDER_ID = "openai"

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

function normalizeEmail(value?: string) {
  if (!value) return
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return
  return trimmed
}

interface OpenAITokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
    email?: string
  }
}

function parseOpenAITokenClaims(token?: string) {
  if (!token) return
  const parts = token.split(".")
  if (parts.length !== 3) return
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as OpenAITokenClaims
  } catch {
    return
  }
}

function tokenAccountID(claims?: OpenAITokenClaims) {
  if (!claims) return
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

function tokenEmail(claims?: OpenAITokenClaims) {
  if (!claims) return
  return claims.email || claims["https://api.openai.com/auth"]?.email
}

function deriveOpenAIAccountMeta(token?: string) {
  const claims = parseOpenAITokenClaims(token)
  return {
    accountId: tokenAccountID(claims),
    email: tokenEmail(claims),
  }
}

function accountID(input: { id?: string; accountId?: string; email?: string; refresh: string }) {
  if (input.id) return input.id
  if (input.accountId) return `acct_${Hash.fast(input.accountId)}`
  if (input.email) return `mail_${Hash.fast(input.email)}`
  return `refresh_${Hash.fast(input.refresh)}`
}

function clampCursor(value: number | undefined, size: number) {
  if (size <= 0) return 0
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  const next = Math.floor(value)
  if (next <= 0) return 0
  return next % size
}

function accountWait(account: OpenAIAccount, now: number) {
  const waits = [account.rateLimitedUntil, account.cooldownUntil]
    .filter((value): value is number => typeof value === "number" && value > now)
    .map((value) => value - now)
  if (waits.length === 0) return 0
  return Math.min(...waits)
}

function accountReady(account: OpenAIAccount, now: number) {
  return accountWait(account, now) === 0
}

function nextRotationCursor(accounts: ReadonlyArray<OpenAIAccount>, accountID: string) {
  if (accounts.length <= 1) return 0
  const index = accounts.findIndex((item) => item.id === accountID)
  if (index === -1) return 0
  return (index + 1) % accounts.length
}

function withAccount(input: OpenAIAccountInput, existing?: OpenAIAccount) {
  const now = Date.now()
  const derived = deriveOpenAIAccountMeta(input.access || existing?.access)
  const accountId = input.accountId ?? existing?.accountId ?? derived.accountId
  const email = normalizeEmail(input.email ?? existing?.email ?? derived.email)
  return new OpenAIAccount({
    id: accountID({
      id: input.id ?? existing?.id,
      accountId,
      email,
      refresh: input.refresh,
    }),
    refresh: input.refresh,
    access: input.access,
    expires: input.expires,
    accountId,
    enterpriseUrl: input.enterpriseUrl ?? existing?.enterpriseUrl,
    email,
    label: input.label ?? existing?.label,
    addedAt: input.addedAt ?? existing?.addedAt ?? now,
    lastUsed: input.lastUsed ?? existing?.lastUsed ?? now,
    rateLimitedUntil:
      typeof input.rateLimitedUntil === "number"
        ? input.rateLimitedUntil
        : input.rateLimitedUntil === null
          ? undefined
          : existing?.rateLimitedUntil,
    cooldownUntil:
      typeof input.cooldownUntil === "number"
        ? input.cooldownUntil
        : input.cooldownUntil === null
          ? undefined
          : existing?.cooldownUntil,
    cooldownReason:
      input.cooldownReason !== undefined
        ? input.cooldownReason ?? undefined
        : existing?.cooldownReason,
  })
}

function syncOpenAI(input: Oauth, accounts: ReadonlyArray<OpenAIAccount>, activeAccountId?: string, rotationCursor?: number) {
  if (accounts.length === 0) return
  const active = accounts.find((item) => item.id === activeAccountId) ?? accounts[0]
  return new Oauth({
    ...input,
    refresh: active.refresh,
    access: active.access,
    expires: active.expires,
    accountId: active.accountId,
    enterpriseUrl: active.enterpriseUrl,
    email: active.email,
    accounts,
    activeAccountId: active.id,
    rotationCursor: clampCursor(rotationCursor, accounts.length),
    multiAccount: accounts.length > 1 ? true : input.multiAccount,
  })
}

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  multiAccount: Schema.optional(Schema.Boolean),
  activeAccountId: Schema.optional(Schema.String),
  rotationCursor: Schema.optional(Schema.Number),
  accounts: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        refresh: Schema.String,
        access: Schema.String,
        expires: Schema.Number,
        accountId: Schema.optional(Schema.String),
        enterpriseUrl: Schema.optional(Schema.String),
        email: Schema.optional(Schema.String),
        label: Schema.optional(Schema.String),
        addedAt: Schema.Number,
        lastUsed: Schema.Number,
        rateLimitedUntil: Schema.optional(Schema.Number),
        cooldownUntil: Schema.optional(Schema.Number),
        cooldownReason: Schema.optional(Schema.String),
      }),
    ),
  ),
}) {}

export class OpenAIAccount extends Schema.Class<OpenAIAccount>("OpenAIOAuthAccount")({
  id: Schema.String,
  refresh: Schema.String,
  access: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  addedAt: Schema.Number,
  lastUsed: Schema.Number,
  rateLimitedUntil: Schema.optional(Schema.Number),
  cooldownUntil: Schema.optional(Schema.Number),
  cooldownReason: Schema.optional(Schema.String),
}) {}

export class OpenAIAccountSummary extends Schema.Class<OpenAIAccountSummary>("OpenAIOAuthAccountSummary")({
  id: Schema.String,
  accountId: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  addedAt: Schema.Number,
  lastUsed: Schema.Number,
  active: Schema.Boolean,
  available: Schema.Boolean,
  rateLimitedUntil: Schema.optional(Schema.Number),
  cooldownUntil: Schema.optional(Schema.Number),
  cooldownReason: Schema.optional(Schema.String),
}) {
  static readonly zod = zod(this)
}

export class OpenAIAccountsResult extends Schema.Class<OpenAIAccountsResult>("OpenAIOAuthAccountsResult")({
  activeAccountId: Schema.optional(Schema.String),
  accounts: Schema.Array(OpenAIAccountSummary),
}) {
  static readonly zod = zod(this)
}

export interface OpenAIAccountInput {
  id?: string
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
  email?: string
  label?: string
  addedAt?: number
  lastUsed?: number
  rateLimitedUntil?: number | null
  cooldownUntil?: number | null
  cooldownReason?: string | null
}

function findOpenAIAccountIndex(
  accounts: ReadonlyArray<OpenAIAccount>,
  input: { id?: string; accountId?: string; email?: string; refresh?: string },
) {
  if (input.id) {
    const byID = accounts.findIndex((item) => item.id === input.id)
    if (byID !== -1) return byID
  }

  if (input.accountId) {
    const byAccountID = accounts.findIndex((item) => item.accountId === input.accountId)
    if (byAccountID !== -1) return byAccountID
  }

  if (input.refresh) {
    const byRefresh = accounts.findIndex((item) => item.refresh === input.refresh)
    if (byRefresh !== -1) return byRefresh
  }

  const email = normalizeEmail(input.email)
  if (!email) return -1
  return accounts.findIndex((item) => item.email === email && !item.accountId)
}

export function normalizeOpenAIOauth(input: Oauth) {
  const seed = input.accounts?.length
    ? input.accounts.map((item) =>
        (() => {
          const derived = deriveOpenAIAccountMeta(item.access)
          const accountId = item.accountId ?? derived.accountId
          const email = normalizeEmail(item.email ?? derived.email)
          return new OpenAIAccount({
            ...item,
            id: accountID({ id: item.id, accountId, email, refresh: item.refresh }),
            accountId,
            email,
          })
        })(),
      )
    : [
        (() => {
          const derived = deriveOpenAIAccountMeta(input.access)
          const accountId = input.accountId ?? derived.accountId
          const email = normalizeEmail(input.email ?? derived.email)
          return new OpenAIAccount({
            id: accountID({ accountId, email, refresh: input.refresh }),
            refresh: input.refresh,
            access: input.access,
            expires: input.expires,
            accountId,
            enterpriseUrl: input.enterpriseUrl,
            email,
            addedAt: Date.now(),
            lastUsed: 0,
          })
        })(),
      ]
  return syncOpenAI(input, seed, input.activeAccountId, input.rotationCursor)!
}

export function getOpenAIAccounts(input?: Info) {
  if (!input || input.type !== "oauth") return []
  return normalizeOpenAIOauth(input).accounts ?? []
}

export function getActiveOpenAIAccount(input?: Info) {
  if (!input || input.type !== "oauth") return
  const auth = normalizeOpenAIOauth(input)
  return auth.accounts?.find((item) => item.id === auth.activeAccountId)
}

export function upsertOpenAIAccount(input: Oauth | undefined, next: OpenAIAccountInput) {
  const base = input ? normalizeOpenAIOauth(input) : new Oauth({ type: "oauth", refresh: next.refresh, access: next.access, expires: next.expires })
  const accounts = [...(base.accounts ?? [])]
  const index = findOpenAIAccountIndex(accounts, next)
  const existing = index === -1 ? undefined : accounts[index]
  const account = withAccount(next, existing)
  if (index === -1) {
    accounts.push(account)
  } else {
    accounts[index] = account
  }
  return syncOpenAI(base, accounts, account.id, nextRotationCursor(accounts, account.id))!
}

export function selectOpenAIAccount(input: Oauth, accountID: string) {
  const base = normalizeOpenAIOauth(input)
  const accounts = [...(base.accounts ?? [])]
  const match = accounts.find((item) => item.id === accountID)
  if (!match) return
  return syncOpenAI(base, accounts, match.id, nextRotationCursor(accounts, match.id))!
}

export function removeOpenAIAccount(input: Oauth, accountID: string) {
  const base = normalizeOpenAIOauth(input)
  const accounts = (base.accounts ?? []).filter((item) => item.id !== accountID)
  if (accounts.length === 0) return
  const activeAccountId = base.activeAccountId === accountID ? accounts[0]?.id : base.activeAccountId
  return syncOpenAI(base, accounts, activeAccountId, base.rotationCursor)
}

export function updateOpenAIAccount(input: Oauth, accountID: string, patch: Partial<OpenAIAccountInput>) {
  const base = normalizeOpenAIOauth(input)
  const accounts = [...(base.accounts ?? [])]
  const index = findOpenAIAccountIndex(accounts, { id: accountID })
  if (index === -1) return
  const current = accounts[index]
  accounts[index] = withAccount(
    {
      id: current.id,
      refresh: patch.refresh ?? current.refresh,
      access: patch.access ?? current.access,
      expires: patch.expires ?? current.expires,
      accountId: patch.accountId ?? current.accountId,
      enterpriseUrl: patch.enterpriseUrl ?? current.enterpriseUrl,
      email: patch.email ?? current.email,
      label: patch.label ?? current.label,
      addedAt: patch.addedAt ?? current.addedAt,
      lastUsed: patch.lastUsed ?? current.lastUsed,
      rateLimitedUntil: patch.rateLimitedUntil ?? current.rateLimitedUntil ?? null,
      cooldownUntil: patch.cooldownUntil ?? current.cooldownUntil ?? null,
      cooldownReason: patch.cooldownReason ?? current.cooldownReason ?? null,
    },
    current,
  )
  return syncOpenAI(base, accounts, base.activeAccountId, base.rotationCursor)!
}

export function nextOpenAIAccount(input: Oauth, now = Date.now()) {
  const auth = normalizeOpenAIOauth(input)
  const accounts = [...(auth.accounts ?? [])]
  const active = getActiveOpenAIAccount(auth)
  if (active && accountReady(active, now)) return { auth, account: active, wait: 0, rateLimitWait: 0, cooldownWait: 0 }
  const start = clampCursor(auth.rotationCursor, accounts.length)
  let index = 0
  while (index < accounts.length) {
    const candidate = accounts[(start + index) % accounts.length]
    if (accountReady(candidate, now)) {
      const next = syncOpenAI(auth, accounts, candidate.id, nextRotationCursor(accounts, candidate.id))!
      return { auth: next, account: candidate, wait: 0, rateLimitWait: 0, cooldownWait: 0 }
    }
    index += 1
  }
  const rateLimitWaits = accounts
    .map((account) => (typeof account.rateLimitedUntil === "number" && account.rateLimitedUntil > now ? account.rateLimitedUntil - now : 0))
    .filter((value) => value > 0)
  const cooldownWaits = accounts
    .map((account) => (typeof account.cooldownUntil === "number" && account.cooldownUntil > now ? account.cooldownUntil - now : 0))
    .filter((value) => value > 0)
  const rateLimitWait = rateLimitWaits.length ? Math.min(...rateLimitWaits) : 0
  const cooldownWait = cooldownWaits.length ? Math.min(...cooldownWaits) : 0
  return { auth, account: undefined, wait: rateLimitWait || cooldownWait, rateLimitWait, cooldownWait }
}

export function summarizeOpenAIAccounts(input?: Info, now = Date.now()) {
  if (!input || input.type !== "oauth") {
    return new OpenAIAccountsResult({
      accounts: [],
    })
  }
  const auth = normalizeOpenAIOauth(input)
  return new OpenAIAccountsResult({
    activeAccountId: auth.activeAccountId,
    accounts: (auth.accounts ?? []).map(
      (account) =>
        new OpenAIAccountSummary({
          id: account.id,
          accountId: account.accountId,
          email: account.email,
          label: account.label,
          addedAt: account.addedAt,
          lastUsed: account.lastUsed,
          active: auth.activeAccountId === account.id,
          available: accountReady(account, now),
          rateLimitedUntil: account.rateLimitedUntil,
          cooldownUntil: account.cooldownUntil,
          cooldownReason: account.cooldownReason,
        }),
    ),
  })
}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

const _Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export const Info = Object.assign(_Info, { zod: zod(_Info) })
export type Info = Schema.Schema.Type<typeof _Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  readonly openaiAccounts: () => Effect.Effect<OpenAIAccountsResult, AuthError>
  readonly upsertOpenAIAccount: (input: OpenAIAccountInput) => Effect.Effect<Oauth, AuthError>
  readonly selectOpenAIAccount: (accountID: string) => Effect.Effect<Oauth, AuthError>
  readonly removeOpenAIAccount: (accountID: string) => Effect.Effect<Oauth | undefined, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const decode = Schema.decodeUnknownOption(Info)
    const lock = Semaphore.makeUnsafe(1)

    const readAll = Effect.fn("Auth.readAll")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
        } catch {}
      }

      return (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
    })

    const all = Effect.fn("Auth.all")(function* () {
      const data = yield* readAll()
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const mutate = <Args extends readonly unknown[], A>(name: string, fn: (data: Record<string, Info>, ...args: Args) => A) =>
      Effect.fn(name)(function* (...args: Args) {
        return yield* (
        lock.withPermits(1)(
          Effect.gen(function* () {
            const data = yield* all()
            const result = fn(data, ...args)
            yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
            return result
          }),
        )
        )
      })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = mutate("Auth.set", (data: Record<string, Info>, key: string, info: Info) => {
      const norm = key.replace(/\/+$/, "")
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      data[norm] = info
    }) as Interface["set"]

    const remove = mutate("Auth.remove", (data: Record<string, Info>, key: string) => {
      const norm = key.replace(/\/+$/, "")
      delete data[key]
      delete data[norm]
    }) as Interface["remove"]

    const openaiAccounts = Effect.fn("Auth.openaiAccounts")(function* () {
      return summarizeOpenAIAccounts(yield* get(OPENAI_PROVIDER_ID))
    })

    const upsertOpenAIAccountFx = mutate(
      "Auth.upsertOpenAIAccount",
      (data: Record<string, Info>, input: OpenAIAccountInput) => {
        const current = data[OPENAI_PROVIDER_ID]
        const next = upsertOpenAIAccount(current?.type === "oauth" ? current : undefined, input)
        data[OPENAI_PROVIDER_ID] = next
        return next
      },
    ) as Interface["upsertOpenAIAccount"]

    const selectOpenAIAccountFx = mutate(
      "Auth.selectOpenAIAccount",
      (data: Record<string, Info>, accountID: string) => {
        const current = data[OPENAI_PROVIDER_ID]
        if (!current || current.type !== "oauth") throw new AuthError({ message: `OpenAI OAuth account not found: ${accountID}` })
        const next = selectOpenAIAccount(current, accountID)
        if (!next) throw new AuthError({ message: `OpenAI OAuth account not found: ${accountID}` })
        data[OPENAI_PROVIDER_ID] = next
        return next
      },
    ) as Interface["selectOpenAIAccount"]

    const removeOpenAIAccountFx = mutate(
      "Auth.removeOpenAIAccount",
      (data: Record<string, Info>, accountID: string) => {
        const current = data[OPENAI_PROVIDER_ID]
        if (!current || current.type !== "oauth") throw new AuthError({ message: `OpenAI OAuth account not found: ${accountID}` })
        const next = removeOpenAIAccount(current, accountID)
        if (!next) {
          delete data[OPENAI_PROVIDER_ID]
          return undefined
        }
        data[OPENAI_PROVIDER_ID] = next
        return next
      },
    ) as Interface["removeOpenAIAccount"]

    return Service.of({
      get,
      all,
      set,
      remove,
      openaiAccounts,
      upsertOpenAIAccount: upsertOpenAIAccountFx,
      selectOpenAIAccount: selectOpenAIAccountFx,
      removeOpenAIAccount: removeOpenAIAccountFx,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Auth from "."
