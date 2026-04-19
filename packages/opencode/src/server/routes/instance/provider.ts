import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Auth } from "@/auth"
import { Config } from "@/config"
import { Provider } from "@/provider"
import { ModelsDev } from "@/provider"
import { ProviderAuth } from "@/provider"
import { ProviderID } from "@/provider/schema"
import { mapValues } from "remeda"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { Effect } from "effect"
import { jsonRequest } from "./trace"

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(Provider.ListResult.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ProviderRoutes.list", c, function* () {
          const svc = yield* Provider.Service
          const cfg = yield* Config.Service
          const config = yield* cfg.get()
          const all = yield* Effect.promise(() => ModelsDev.get())
          const disabled = new Set(config.disabled_providers ?? [])
          const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
          const filtered: Record<string, (typeof all)[string]> = {}
          for (const [key, value] of Object.entries(all)) {
            if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
              filtered[key] = value
            }
          }
          const connected = yield* svc.list()
          const providers = Object.assign(
            mapValues(filtered, (x) => Provider.fromModelsDevProvider(x)),
            connected,
          )
          return {
            all: Object.values(providers),
            default: Provider.defaultModelIDs(providers),
            connected: Object.keys(connected),
          }
        }),
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Methods.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ProviderRoutes.auth", c, function* () {
          const svc = yield* ProviderAuth.Service
          return yield* svc.methods()
        }),
    )
    .post(
      "/:providerID/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.zod.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator("json", ProviderAuth.AuthorizeInput.zod),
      async (c) =>
        jsonRequest("ProviderRoutes.oauth.authorize", c, function* () {
          const providerID = c.req.valid("param").providerID
          const { method, inputs } = c.req.valid("json")
          const svc = yield* ProviderAuth.Service
          return yield* svc.authorize({
            providerID,
            method,
            inputs,
          })
        }),
    )
    .post(
      "/:providerID/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator("json", ProviderAuth.CallbackInput.zod),
      async (c) =>
        jsonRequest("ProviderRoutes.oauth.callback", c, function* () {
          const providerID = c.req.valid("param").providerID
          const { method, code } = c.req.valid("json")
          const svc = yield* ProviderAuth.Service
          yield* svc.callback({
            providerID,
            method,
            code,
          })
          return true
        }),
    )
    .get(
      "/openai/oauth/accounts",
      describeRoute({
        summary: "List OpenAI OAuth accounts",
        description: "List configured OpenAI OAuth accounts and the active account.",
        operationId: "provider.openai.oauth.account.list",
        responses: {
          200: {
            description: "OpenAI OAuth accounts",
            content: {
              "application/json": {
                schema: resolver(Auth.OpenAIAccountsResult.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ProviderRoutes.openai.oauth.accounts", c, function* () {
          const auth = yield* Auth.Service
          return yield* auth.openaiAccounts()
        }),
    )
    .get(
      "/openai/oauth/status",
      describeRoute({
        summary: "Get OpenAI OAuth status",
        description: "Get the active OpenAI OAuth account, next rotation candidate, wait state, and per-account health.",
        operationId: "provider.openai.oauth.account.status",
        responses: {
          200: {
            description: "OpenAI OAuth runtime status",
            content: {
              "application/json": {
                schema: resolver(Auth.OpenAIStatusResult.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ProviderRoutes.openai.oauth.status", c, function* () {
          const auth = yield* Auth.Service
          return yield* auth.openaiStatus()
        }),
    )
    .post(
      "/openai/oauth/accounts/select",
      describeRoute({
        summary: "Select OpenAI OAuth account",
        description: "Set the active OpenAI OAuth account used for Codex requests.",
        operationId: "provider.openai.oauth.account.select",
        responses: {
          200: {
            description: "Account selected",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          accountID: z.string().meta({ description: "OpenAI account ID" }),
        }),
      ),
      async (c) =>
        jsonRequest("ProviderRoutes.openai.oauth.accounts.select", c, function* () {
          const auth = yield* Auth.Service
          yield* auth.selectOpenAIAccount(c.req.valid("json").accountID)
          return true
        }),
    )
    .delete(
      "/openai/oauth/accounts/:accountID",
      describeRoute({
        summary: "Remove OpenAI OAuth account",
        description: "Remove a stored OpenAI OAuth account from the local account pool.",
        operationId: "provider.openai.oauth.account.remove",
        responses: {
          200: {
            description: "Account removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          accountID: z.string().meta({ description: "OpenAI account ID" }),
        }),
      ),
      async (c) =>
        jsonRequest("ProviderRoutes.openai.oauth.accounts.remove", c, function* () {
          const auth = yield* Auth.Service
          yield* auth.removeOpenAIAccount(c.req.valid("param").accountID)
          return true
        }),
    ),
)
