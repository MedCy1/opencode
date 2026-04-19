import { afterEach, describe, expect, test } from "bun:test"
import { Oauth } from "../../src/auth"
import {
  CodexAuthPlugin,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  extractEmailFromClaims,
  extractEmail,
  type IdTokenClaims,
} from "../../src/plugin/codex"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function createOpenAIOauth(input: {
  activeIndex?: number
  accounts: Array<{
    refresh: string
    access: string
    expires: number
    accountId?: string
    email?: string
  }>
}) {
  const accounts = input.accounts.map((account, index) => ({
    id: `account-${index + 1}`,
    refresh: account.refresh,
    access: account.access,
    expires: account.expires,
    accountId: account.accountId,
    email: account.email,
    addedAt: index + 1,
    lastUsed: 0,
  }))
  const active = accounts[input.activeIndex ?? accounts.length - 1] ?? accounts[0]
  return new Oauth({
    type: "oauth",
    refresh: active.refresh,
    access: active.access,
    expires: active.expires,
    accountId: active.accountId,
    email: active.email,
    multiAccount: accounts.length > 1,
    activeAccountId: active.id,
    rotationCursor: 0,
    accounts,
  })
}

async function createLoader(auth: Oauth) {
  let current = auth
  const persisted: Oauth[] = []
  const hooks = await CodexAuthPlugin({
    client: {
      auth: {
        set: async (input: { body: Oauth }) => {
          current = input.body
          persisted.push(input.body)
          return { data: input.body }
        },
      },
    } as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })
  const loaded = await hooks.auth!.loader!(
    async () => current,
    {
      id: "openai",
      models: {
        "gpt-5.4": {
          id: "gpt-5.4",
          api: { id: "gpt-5.4", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
          cost: { input: 1, output: 1, cache: { read: 1, write: 1 } },
        },
      },
    } as never,
  )
  return {
    fetch: loaded.fetch!,
    persisted,
    current: () => current,
  }
}

describe("plugin.codex", () => {
  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })

  describe("extractEmailFromClaims", () => {
    test("extracts email from root claim", () => {
      expect(extractEmailFromClaims({ email: "root@example.com" })).toBe("root@example.com")
    })

    test("extracts nested email claim", () => {
      expect(
        extractEmailFromClaims({
          "https://api.openai.com/auth": { email: "nested@example.com" },
        }),
      ).toBe("nested@example.com")
    })
  })

  describe("extractEmail", () => {
    test("prefers id_token email", () => {
      const idToken = createTestJwt({ email: "id@example.com" })
      const accessToken = createTestJwt({ email: "access@example.com" })
      expect(
        extractEmail({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("id@example.com")
    })

    test("falls back to access_token email", () => {
      expect(
        extractEmail({
          id_token: createTestJwt({ chatgpt_account_id: "acc" }),
          access_token: createTestJwt({ email: "access@example.com" }),
          refresh_token: "rt",
        }),
      ).toBe("access@example.com")
    })
  })

  describe("multi-account runtime", () => {
    test("rotates to the next account after a rate limit response", async () => {
      const calls: Array<{ authorization: string | null; accountId: string | null }> = []
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        calls.push({
          authorization: headers.get("authorization"),
          accountId: headers.get("ChatGPT-Account-Id"),
        })
        if (calls.length === 1) {
          return new Response(JSON.stringify({ error: { code: "rate_limit" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "retry-after": "5" },
          })
        }
        return new Response("ok", { status: 200 })
      }) as typeof fetch

      const { fetch, persisted, current } = await createLoader(
        createOpenAIOauth({
          activeIndex: 0,
          accounts: [
            {
              refresh: "rt-1",
              access: createTestJwt({ email: "one@example.com" }),
              expires: Date.now() + 60_000,
              accountId: "acc-1",
              email: "one@example.com",
            },
            {
              refresh: "rt-2",
              access: createTestJwt({ email: "two@example.com" }),
              expires: Date.now() + 60_000,
              accountId: "acc-2",
              email: "two@example.com",
            },
          ],
        }),
      )

      const response = await fetch("https://api.openai.com/v1/responses", {
        headers: { authorization: "Bearer ignored" },
      })

      expect(response.status).toBe(200)
      expect(calls).toEqual([
        { authorization: expect.stringContaining("Bearer"), accountId: "acc-1" },
        { authorization: expect.stringContaining("Bearer"), accountId: "acc-2" },
      ])
      expect(persisted.length).toBeGreaterThanOrEqual(2)
      expect(current().accountId).toBe("acc-2")
      expect(
        persisted[0]?.accounts?.find((account) => account.accountId === "acc-1")?.rateLimitedUntil,
      ).toBeGreaterThan(Date.now())
    })

    test("waits and retries when all accounts are temporarily rate-limited", async () => {
      let calls = 0
      globalThis.fetch = (async () => {
        calls += 1
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { code: "rate_limit" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "retry-after-ms": "5" },
          })
        }
        return new Response("ok", { status: 200 })
      }) as typeof fetch

      const { fetch } = await createLoader(
        createOpenAIOauth({
          activeIndex: 0,
          accounts: [
            {
              refresh: "rt-1",
              access: createTestJwt({ email: "one@example.com" }),
              expires: Date.now() + 60_000,
              accountId: "acc-1",
              email: "one@example.com",
            },
          ],
        }),
      )

      const response = await fetch("https://api.openai.com/v1/responses")

      expect(response.status).toBe(200)
      expect(calls).toBe(2)
    })

    test("refreshes expired accounts and persists derived metadata", async () => {
      const fetchCalls: string[] = []
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        fetchCalls.push(url)
        if (url.includes("/oauth/token")) {
          expect(String(init?.body)).toContain("grant_type=refresh_token")
          expect(String(init?.body)).toContain("refresh_token=rt-expired")
          return new Response(
            JSON.stringify({
              refresh_token: "rt-fresh",
              access_token: createTestJwt({
                email: "fresh@example.com",
                "https://api.openai.com/auth": { chatgpt_account_id: "acc-fresh" },
              }),
              id_token: createTestJwt({ email: "fresh@example.com", chatgpt_account_id: "acc-fresh" }),
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        const headers = new Headers(init?.headers)
        expect(headers.get("ChatGPT-Account-Id")).toBe("acc-fresh")
        return new Response("ok", { status: 200 })
      }) as typeof fetch

      const { fetch, persisted, current } = await createLoader(
        createOpenAIOauth({
          activeIndex: 0,
          accounts: [
            {
              refresh: "rt-expired",
              access: createTestJwt({ email: "stale@example.com" }),
              expires: Date.now() - 1_000,
            },
          ],
        }),
      )

      const response = await fetch("https://api.openai.com/v1/responses")

      expect(response.status).toBe(200)
      expect(fetchCalls.some((url) => url.includes("/oauth/token"))).toBe(true)
      expect(current().email).toBe("fresh@example.com")
      expect(current().accountId).toBe("acc-fresh")
      expect(persisted[0]?.email).toBe("fresh@example.com")
      expect(persisted[0]?.accountId).toBe("acc-fresh")
    })
  })
})
