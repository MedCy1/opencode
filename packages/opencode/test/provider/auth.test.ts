import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Plugin } from "../../src/plugin"
import { ProviderAuth } from "../../src/provider"
import { ProviderID } from "../../src/provider/schema"
import { provideTmpdirInstance } from "../fixture/fixture"

function pluginLayer(results: Array<{ refresh: string; access: string; expires: number; accountId: string; email: string }>) {
  return Layer.mock(Plugin.Service)({
    trigger: <Name extends string, Input, Output>(_name: Name, _input: Input, output: Output) => Effect.succeed(output),
    list: () =>
      Effect.succeed([
        {
          auth: {
            provider: "openai",
            methods: [
              {
                label: "ChatGPT",
                type: "oauth" as const,
                authorize: async () => {
                  const next = results.shift()
                  if (!next) throw new Error("no auth result left")
                  return {
                    url: "https://example.com/oauth",
                    instructions: "Authorize",
                    method: "auto" as const,
                    callback: async () => ({
                      type: "success" as const,
                      ...next,
                    }),
                  }
                },
              },
            ],
          },
        },
      ]),
    init: () => Effect.void,
  })
}

describe("provider auth openai", () => {
  test("callback appends OpenAI OAuth accounts instead of overwriting the existing one", async () => {
    const layer = Layer.mergeAll(
      CrossSpawnSpawner.defaultLayer,
      Auth.defaultLayer,
      ProviderAuth.layer.pipe(
        Layer.provide(Auth.defaultLayer),
        Layer.provide(
          pluginLayer([
            {
              refresh: "rt-1",
              access: "at-1",
              expires: 1,
              accountId: "acc-1",
              email: "one@example.com",
            },
            {
              refresh: "rt-2",
              access: "at-2",
              expires: 2,
              accountId: "acc-2",
              email: "two@example.com",
            },
          ]),
        ),
      ),
    )

    await Effect.runPromise(
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          const providerAuth = yield* ProviderAuth.Service

          yield* auth.remove("openai")

          yield* providerAuth.authorize({
            providerID: ProviderID.openai,
            method: 0,
          })
          yield* providerAuth.callback({
            providerID: ProviderID.openai,
            method: 0,
          })

          yield* providerAuth.authorize({
            providerID: ProviderID.openai,
            method: 0,
          })
          yield* providerAuth.callback({
            providerID: ProviderID.openai,
            method: 0,
          })

          const current = yield* auth.get("openai")
          expect(current?.type).toBe("oauth")
          if (current?.type !== "oauth") return

          const summary = Auth.summarizeOpenAIAccounts(current)
          expect(summary.accounts).toHaveLength(2)
          expect(summary.accounts.map((account) => account.email)).toEqual(["one@example.com", "two@example.com"])
          expect(summary.accounts.find((account) => account.accountId === "acc-2")?.active).toBe(true)
          expect(current.refresh).toBe("rt-2")
        }),
      ).pipe(Effect.provide(layer), Effect.scoped),
    )
  })
})
