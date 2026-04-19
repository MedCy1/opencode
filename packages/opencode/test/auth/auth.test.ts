import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

function createTestJwt(payload: object) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("Auth", () => {
  it.live("set normalizes trailing slashes in keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeDefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set cleans up pre-existing trailing-slash entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "old",
        })
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "new",
        })
        const data = yield* auth.all()
        const keys = Object.keys(data).filter((key) => key.includes("example.com"))
        expect(keys).toEqual(["https://example.com"])
        const entry = data["https://example.com"]!
        expect(entry.type).toBe("wellknown")
        if (entry.type === "wellknown") expect(entry.token).toBe("new")
      }),
    ),
  )

  it.live("remove deletes both trailing-slash and normalized keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        yield* auth.remove("https://example.com/")
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeUndefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set and remove are no-ops on keys without trailing slashes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("anthropic", {
          type: "api",
          key: "sk-test",
        })
        const data = yield* auth.all()
        expect(data["anthropic"]).toBeDefined()
        yield* auth.remove("anthropic")
        const after = yield* auth.all()
        expect(after["anthropic"]).toBeUndefined()
      }),
    ),
  )

  it.live("stores multiple OpenAI OAuth accounts without overwriting existing ones", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("openai")
        yield* auth.upsertOpenAIAccount({
          refresh: "rt-1",
          access: "at-1",
          expires: 1,
          accountId: "acc-1",
          email: "one@example.com",
        })
        yield* auth.upsertOpenAIAccount({
          refresh: "rt-2",
          access: "at-2",
          expires: 2,
          accountId: "acc-2",
          email: "two@example.com",
        })
        const current = yield* auth.get("openai")
        expect(current?.type).toBe("oauth")
        if (current?.type !== "oauth") return
        const summary = Auth.summarizeOpenAIAccounts(current)
        expect(summary.accounts).toHaveLength(2)
        expect(summary.accounts.map((account) => account.accountId)).toEqual(["acc-1", "acc-2"])
        expect(summary.accounts.find((account) => account.accountId === "acc-2")?.active).toBe(true)
        expect(current.refresh).toBe("rt-2")
      }),
    ),
  )

  it.live("selecting an OpenAI account syncs the active top-level credential", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("openai")
        yield* auth.upsertOpenAIAccount({
          refresh: "rt-1",
          access: "at-1",
          expires: 1,
          accountId: "acc-1",
          email: "one@example.com",
        })
        yield* auth.upsertOpenAIAccount({
          refresh: "rt-2",
          access: "at-2",
          expires: 2,
          accountId: "acc-2",
          email: "two@example.com",
        })
        const current = yield* auth.get("openai")
        expect(current?.type).toBe("oauth")
        if (current?.type !== "oauth") return
        const first = Auth.summarizeOpenAIAccounts(current).accounts.find((account) => account.accountId === "acc-1")
        expect(first).toBeDefined()
        yield* auth.selectOpenAIAccount(first!.id)
        const next = yield* auth.get("openai")
        expect(next?.type).toBe("oauth")
        if (next?.type !== "oauth") return
        expect(next.refresh).toBe("rt-1")
        expect(next.accountId).toBe("acc-1")
      }),
    ),
  )

  it.live("removing the last OpenAI account removes the provider entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("openai")
        yield* auth.upsertOpenAIAccount({
          refresh: "rt-1",
          access: "at-1",
          expires: 1,
          accountId: "acc-1",
        })
        const current = yield* auth.get("openai")
        expect(current?.type).toBe("oauth")
        if (current?.type !== "oauth") return
        const account = Auth.summarizeOpenAIAccounts(current).accounts[0]
        yield* auth.removeOpenAIAccount(account.id)
        const next = yield* auth.get("openai")
        expect(next).toBeUndefined()
      }),
    ),
  )

  it.live("nextOpenAIAccount only reports wait time for rate-limited accounts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("openai")
        const now = Date.now()
        const current = yield* auth.upsertOpenAIAccount({
          refresh: "rt-1",
          access: "at-1",
          expires: 1,
          accountId: "acc-1",
        })
        const first = Auth.summarizeOpenAIAccounts(current).accounts[0]
        const blocked = Auth.updateOpenAIAccount(current, first.id, {
          rateLimitedUntil: now + 10_000,
          cooldownUntil: now + 20_000,
        })
        expect(blocked).toBeDefined()
        const selection = Auth.nextOpenAIAccount(blocked!, now)
        expect(selection.account).toBeUndefined()
        expect(selection.rateLimitWait).toBeGreaterThan(0)
        expect(selection.cooldownWait).toBeGreaterThan(0)

        const cooldownOnly = Auth.updateOpenAIAccount(current, first.id, {
          rateLimitedUntil: null,
          cooldownUntil: now + 20_000,
        })
        expect(cooldownOnly).toBeDefined()
        const cooldownSelection = Auth.nextOpenAIAccount(cooldownOnly!, now)
        expect(cooldownSelection.account).toBeUndefined()
        expect(cooldownSelection.rateLimitWait).toBe(0)
        expect(cooldownSelection.cooldownWait).toBeGreaterThan(0)
      }),
    ),
  )

  it.live("summarizeOpenAIStatus reports the next ready account when rotation will switch", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("openai")
        yield* auth.upsertOpenAIAccount({
          refresh: "rt-1",
          access: "at-1",
          expires: 1,
          accountId: "acc-1",
          email: "one@example.com",
        })
        const current = yield* auth.upsertOpenAIAccount({
          refresh: "rt-2",
          access: "at-2",
          expires: 2,
          accountId: "acc-2",
          email: "two@example.com",
        })
        const first = Auth.summarizeOpenAIAccounts(current).accounts.find((account) => account.accountId === "acc-1")
        expect(first).toBeDefined()
        const blocked = Auth.updateOpenAIAccount(current, first!.id, {
          rateLimitedUntil: Date.now() + 10_000,
        })
        expect(blocked).toBeDefined()
        const status = Auth.summarizeOpenAIStatus(blocked!)
        expect(status.activeAccountId).toBe(blocked!.activeAccountId)
        expect(status.nextAccountId).toBe(blocked!.activeAccountId)
        expect(status.nextWait).toBeUndefined()
      }),
    ),
  )

  it.live("summarizeOpenAIStatus reports wait reason when all accounts are unavailable", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("openai")
        const current = yield* auth.upsertOpenAIAccount({
          refresh: "rt-1",
          access: "at-1",
          expires: 1,
          accountId: "acc-1",
          email: "one@example.com",
        })
        const blocked = Auth.updateOpenAIAccount(current, Auth.summarizeOpenAIAccounts(current).accounts[0]!.id, {
          cooldownUntil: Date.now() + 20_000,
        })
        expect(blocked).toBeDefined()
        const status = Auth.summarizeOpenAIStatus(blocked!)
        expect(status.nextAccountId).toBeUndefined()
        expect(status.nextWaitReason).toBe("cooldown")
        expect(status.nextWait).toBeGreaterThan(0)
      }),
    ),
  )

  it.live("derives OpenAI account email and accountId from stored access token", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove("openai")
        const current = yield* auth.upsertOpenAIAccount({
          refresh: "rt-derived",
          access: createTestJwt({
            email: "derived@example.com",
            "https://api.openai.com/auth": { chatgpt_account_id: "acc-derived" },
          }),
          expires: 1,
        })
        const summary = Auth.summarizeOpenAIAccounts(current)
        expect(summary.accounts[0]?.email).toBe("derived@example.com")
        expect(summary.accounts[0]?.accountId).toBe("acc-derived")
        expect(summary.accounts[0]?.id.startsWith("refresh_")).toBe(false)
      }),
    ),
  )
})
