import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

function runAuth<A, E>(fx: Effect.Effect<A, E, Auth.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(Auth.defaultLayer)))
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("provider openai oauth account routes", () => {
  test("lists stored OpenAI OAuth accounts", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await runAuth(
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
          }),
        )

        const app = Server.Default().app
        const response = await app.request("/provider/openai/oauth/accounts")

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          activeAccountId: expect.any(String),
          accounts: [
            expect.objectContaining({
              accountId: "acc-1",
              email: "one@example.com",
              active: false,
            }),
            expect.objectContaining({
              accountId: "acc-2",
              email: "two@example.com",
              active: true,
            }),
          ],
        })
      },
    })
  })

  test("select route updates the active OpenAI OAuth account", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const selected = await runAuth(
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
            return Auth.summarizeOpenAIAccounts(current).accounts.find((account) => account.accountId === "acc-1")!.id
          }),
        )

        const app = Server.Default().app
        const response = await app.request("/provider/openai/oauth/accounts/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountID: selected }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toBe(true)

        const current = await runAuth(
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            return yield* auth.get("openai")
          }),
        )

        expect(current?.type).toBe("oauth")
        if (current?.type !== "oauth") return
        expect(current.accountId).toBe("acc-1")
        expect(current.email).toBe("one@example.com")
      },
    })
  })

  test("remove route deletes accounts and removes provider after the last one", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const accounts = await runAuth(
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
            return Auth.summarizeOpenAIAccounts(current).accounts
          }),
        )

        const first = accounts.find((account) => account.accountId === "acc-1")!
        const second = accounts.find((account) => account.accountId === "acc-2")!
        const app = Server.Default().app

        const removeFirst = await app.request(`/provider/openai/oauth/accounts/${first.id}`, {
          method: "DELETE",
        })
        expect(removeFirst.status).toBe(200)
        expect(await removeFirst.json()).toBe(true)

        const afterFirst = await runAuth(
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            return yield* auth.get("openai")
          }),
        )

        expect(afterFirst?.type).toBe("oauth")
        if (afterFirst?.type !== "oauth") return
        expect(afterFirst.accountId).toBe("acc-2")

        const removeSecond = await app.request(`/provider/openai/oauth/accounts/${second.id}`, {
          method: "DELETE",
        })
        expect(removeSecond.status).toBe(200)
        expect(await removeSecond.json()).toBe(true)

        const afterSecond = await runAuth(
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            return yield* auth.get("openai")
          }),
        )

        expect(afterSecond).toBeUndefined()
      },
    })
  })
})
