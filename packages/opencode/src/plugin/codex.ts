import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Log } from "../util"
import { Installation } from "../installation"
import { InstallationVersion } from "../installation/version"
import { nextOpenAIAccount, normalizeOpenAIOauth, OAUTH_DUMMY_KEY, updateOpenAIAccount, type Oauth } from "../auth"
import os from "os"
import { setTimeout as sleep } from "node:timers/promises"
import { createServer } from "http"

const log = Log.create({ service: "plugin.codex" })

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000
const RATE_LIMIT_FALLBACK_MS = 60_000
const AUTH_COOLDOWN_MS = 60_000
const SERVER_COOLDOWN_MS = 20_000
const NETWORK_COOLDOWN_MS = 10_000

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
    email?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

export function extractEmailFromClaims(claims: IdTokenClaims): string | undefined {
  return claims.email || claims["https://api.openai.com/auth"]?.email
}

export function extractEmail(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const email = claims && extractEmailFromClaims(claims)
    if (email) return email
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractEmailFromClaims(claims) : undefined
  }
  return undefined
}

function stripAuthorization(headers?: RequestInit["headers"]) {
  if (!headers) return
  if (headers instanceof Headers) {
    headers.delete("authorization")
    headers.delete("Authorization")
    return
  }
  if (Array.isArray(headers)) {
    return headers.filter(([key]) => key.toLowerCase() !== "authorization")
  }
  delete headers["authorization"]
  delete headers["Authorization"]
  return headers
}

async function normalizeRequest(requestInput: RequestInfo | URL, init?: RequestInit) {
  if (!(requestInput instanceof Request)) {
    return { requestInput, init }
  }
  if (init) return { requestInput, init }
  const method = requestInput.method || "GET"
  const nextInit: RequestInit = {
    method,
    headers: new Headers(requestInput.headers),
    signal: requestInput.signal,
  }
  if (method === "GET" || method === "HEAD") return { requestInput: requestInput.url, init: nextInit }
  const body = await requestInput.clone().text()
  if (body) nextInit.body = body
  return { requestInput: requestInput.url, init: nextInit }
}

function requestHeaders(init?: RequestInit) {
  const headers = new Headers()
  if (!init?.headers) return headers
  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => headers.set(key, value))
    return headers
  }
  if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (value !== undefined) headers.set(key, String(value))
    }
    return headers
  }
  for (const [key, value] of Object.entries(init.headers)) {
    if (value !== undefined) headers.set(key, String(value))
  }
  return headers
}

function rewriteCodexUrl(requestInput: RequestInfo | URL) {
  const parsed =
    requestInput instanceof URL
      ? requestInput
      : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
  if (!parsed.pathname.includes("/v1/responses") && !parsed.pathname.includes("/chat/completions")) return parsed
  return new URL(CODEX_API_ENDPOINT)
}

async function responseText(response: Response) {
  try {
    return await response.clone().text()
  } catch {
    return ""
  }
}

function errorCode(body: string) {
  if (!body) return
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } }
    const code = parsed.error?.code
    if (typeof code === "string") return code
    const type = parsed.error?.type
    if (typeof type === "string") return type
  } catch {}
}

function parseRetryAfter(response: Response, body: string) {
  const retryAfterMs = response.headers.get("retry-after-ms")
  if (retryAfterMs) {
    const parsed = Number.parseInt(retryAfterMs, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }

  const retryAfter = response.headers.get("retry-after")
  if (retryAfter) {
    const parsedSeconds = Number.parseFloat(retryAfter)
    if (!Number.isNaN(parsedSeconds) && parsedSeconds > 0) return Math.ceil(parsedSeconds * 1000)
    const parsedDate = Date.parse(retryAfter) - Date.now()
    if (!Number.isNaN(parsedDate) && parsedDate > 0) return Math.ceil(parsedDate)
  }

  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: { retry_after_ms?: unknown; retry_after?: unknown; resets_at?: unknown } }
      const retryAfterMsBody = parsed.error?.retry_after_ms
      if (typeof retryAfterMsBody === "number" && retryAfterMsBody > 0) return retryAfterMsBody
      if (typeof retryAfterMsBody === "string") {
        const numeric = Number.parseInt(retryAfterMsBody, 10)
        if (!Number.isNaN(numeric) && numeric > 0) return numeric
      }
      const retryAfterBody = parsed.error?.retry_after
      if (typeof retryAfterBody === "number" && retryAfterBody > 0) return Math.ceil(retryAfterBody * 1000)
      if (typeof retryAfterBody === "string") {
        const numeric = Number.parseFloat(retryAfterBody)
        if (!Number.isNaN(numeric) && numeric > 0) return Math.ceil(numeric * 1000)
      }
      const resetAt = parsed.error?.resets_at
      if (typeof resetAt === "number" && resetAt > 0) {
        const delta = (resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt) - Date.now()
        if (delta > 0) return Math.ceil(delta)
      }
    } catch {}
  }

  return RATE_LIMIT_FALLBACK_MS
}

function rateLimited(response: Response, body: string) {
  if (response.status === 429) return true
  const code = errorCode(body)?.toLowerCase()
  if (!code) return false
  return code.includes("rate_limit") || code.includes("usage_limit") || code.includes("too_many_requests")
}

function shouldRotateAuth(response: Response) {
  return response.status === 401 || response.status === 403
}

async function persistOpenAIAuth(input: PluginInput, auth: Oauth) {
  await input.client.auth.set({
    path: { id: "openai" },
    body: auth,
  })
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json()
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json()
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>OpenCode - Codex Authorization Successful</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to OpenCode.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>OpenCode - Codex Authorization Failed</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${error}</div>
    </div>
  </body>
</html>`

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  oauthServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)

    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const errorDescription = url.searchParams.get("error_description")

      if (error) {
        const errorMsg = errorDescription || error
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      if (!code) {
        const errorMsg = "Missing authorization code"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      if (!pendingOAuth || state !== pendingOAuth.state) {
        const errorMsg = "Invalid state - potential CSRF attack"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      const current = pendingOAuth
      pendingOAuth = undefined

      exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
        .then((tokens) => current.resolve(tokens))
        .catch((err) => current.reject(err))

      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(HTML_SUCCESS)
      return
    }

    if (url.pathname === "/cancel") {
      pendingOAuth?.reject(new Error("Login cancelled"))
      pendingOAuth = undefined
      res.writeHead(200)
      res.end("Login cancelled")
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  await new Promise<void>((resolve, reject) => {
    oauthServer!.listen(OAUTH_PORT, () => {
      log.info("codex oauth server started", { port: OAUTH_PORT })
      resolve()
    })
    oauthServer!.on("error", reject)
  })

  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.close(() => {
      log.info("codex oauth server stopped")
    })
    oauthServer = undefined
  }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (pendingOAuth) {
          pendingOAuth = undefined
          reject(new Error("OAuth callback timeout - authorization took too long"))
        }
      },
      5 * 60 * 1000,
    ) // 5 minute timeout

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

export async function CodexAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "openai",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Filter models to only allowed Codex models for OAuth
        const allowedModels = new Set([
          "gpt-5.1-codex",
          "gpt-5.1-codex-max",
          "gpt-5.1-codex-mini",
          "gpt-5.2",
          "gpt-5.2-codex",
          "gpt-5.3-codex",
          "gpt-5.4",
          "gpt-5.4-mini",
        ])
        for (const [modelId, model] of Object.entries(provider.models)) {
          if (modelId.includes("codex")) continue
          if (allowedModels.has(model.api.id)) continue
          const match = model.api.id.match(/^gpt-(\d+\.\d+)/)
          if (match && parseFloat(match[1]) > 5.4) continue
          delete provider.models[modelId]
        }

        // Zero out costs for Codex (included with ChatGPT subscription)
        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }

          // gpt-5.5 models temporarily have restricted context window size for codex plans
          if (model.id.includes("gpt-5.5")) {
            model.limit = {
              context: 400_000,
              //@ts-expect-error incorrect type for v1 sdk but works
              input: 272_000,
              output: 128_000,
            }
          }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const normalized = await normalizeRequest(requestInput, init)
            const nextInit = normalized.init ? { ...normalized.init } : undefined
            const stripped = stripAuthorization(nextInit?.headers)
            if (nextInit && stripped) nextInit.headers = stripped

            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(normalized.requestInput, nextInit)

            let authState = normalizeOpenAIOauth(currentAuth as Oauth)
            let persisted = authState
            let lastFailure: Response | undefined

            while (true) {
              const selection = nextOpenAIAccount(authState)
              authState = selection.auth

              if (!selection.account) {
                if (selection.rateLimitWait > 0) {
                  log.info("all codex accounts rate-limited", {
                    wait: selection.rateLimitWait,
                    count: authState.accounts?.length ?? 0,
                  })
                  await sleep(selection.rateLimitWait, undefined, nextInit?.signal ? { signal: nextInit.signal } : undefined)
                  continue
                }
                if (lastFailure) return lastFailure
                return new Response(
                  JSON.stringify({
                    error: {
                      message: "All ChatGPT OAuth accounts are temporarily unavailable. Run `opencode auth login` or `opencode auth switch`.",
                    },
                  }),
                  {
                    status: 503,
                    headers: { "Content-Type": "application/json" },
                  },
                )
              }

              let account = selection.account

              if (!account.access || account.expires <= Date.now()) {
                try {
                  log.info("refreshing codex access token", { accountID: account.id })
                  const tokens = await refreshAccessToken(account.refresh)
                  authState = updateOpenAIAccount(authState, account.id, {
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    accountId: extractAccountId(tokens) || account.accountId,
                    email: extractEmail(tokens) || account.email,
                    lastUsed: Date.now(),
                    rateLimitedUntil: null,
                    cooldownUntil: null,
                    cooldownReason: null,
                  })!
                  await persistOpenAIAuth(input, authState)
                  persisted = authState
                  account = authState.accounts!.find((item) => item.id === account.id)!
                } catch (error) {
                  log.warn("codex account refresh failed", {
                    accountID: account.id,
                    error: error instanceof Error ? error.message : String(error),
                  })
                  authState = updateOpenAIAccount(authState, account.id, {
                    cooldownUntil: Date.now() + AUTH_COOLDOWN_MS,
                    cooldownReason: "auth",
                    lastUsed: Date.now(),
                  })!
                  await persistOpenAIAuth(input, authState)
                  persisted = authState
                  continue
                }
              }

              const headers = requestHeaders(nextInit)
              headers.set("authorization", `Bearer ${account.access}`)
              if (account.accountId) headers.set("ChatGPT-Account-Id", account.accountId)

              const url = rewriteCodexUrl(normalized.requestInput)

              let response: Response
              try {
                response = await fetch(url, {
                  ...nextInit,
                  headers,
                })
              } catch (error) {
                if (nextInit?.signal?.aborted) throw error
                log.warn("codex account network failure", {
                  accountID: account.id,
                  error: error instanceof Error ? error.message : String(error),
                })
                authState = updateOpenAIAccount(authState, account.id, {
                  cooldownUntil: Date.now() + NETWORK_COOLDOWN_MS,
                  cooldownReason: "network",
                  lastUsed: Date.now(),
                })!
                await persistOpenAIAuth(input, authState)
                persisted = authState
                continue
              }

              if (response.ok) {
                if (authState.activeAccountId !== persisted.activeAccountId) {
                  await persistOpenAIAuth(input, authState)
                }
                return response
              }

              const body = await responseText(response)
              lastFailure = response

              if (rateLimited(response, body)) {
                authState = updateOpenAIAccount(authState, account.id, {
                  rateLimitedUntil: Date.now() + parseRetryAfter(response, body),
                  cooldownUntil: null,
                  cooldownReason: null,
                  lastUsed: Date.now(),
                })!
                await persistOpenAIAuth(input, authState)
                persisted = authState
                continue
              }

              if (shouldRotateAuth(response)) {
                authState = updateOpenAIAccount(authState, account.id, {
                  cooldownUntil: Date.now() + AUTH_COOLDOWN_MS,
                  cooldownReason: errorCode(body)?.toLowerCase().includes("usage") ? "entitlement" : "auth",
                  lastUsed: Date.now(),
                })!
                await persistOpenAIAuth(input, authState)
                persisted = authState
                continue
              }

              if (response.status >= 500) {
                authState = updateOpenAIAccount(authState, account.id, {
                  cooldownUntil: Date.now() + SERVER_COOLDOWN_MS,
                  cooldownReason: "server",
                  lastUsed: Date.now(),
                })!
                await persistOpenAIAuth(input, authState)
                persisted = authState
                continue
              }

              return response
            }
          },
        }
      },
      methods: [
        {
          label: "ChatGPT Pro/Plus (browser)",
          type: "oauth",
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = generateState()
            const authUrl = buildAuthorizeUrl(redirectUri, pkce, state)

            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
                const accountId = extractAccountId(tokens)
                const email = extractEmail(tokens)
                return {
                  type: "success" as const,
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  accountId,
                  email,
                }
              },
            }
          },
        },
        {
          label: "ChatGPT Pro/Plus (headless)",
          type: "oauth",
          authorize: async () => {
            const deviceResponse = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": `opencode/${InstallationVersion}`,
              },
              body: JSON.stringify({ client_id: CLIENT_ID }),
            })

            if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

            const deviceData = (await deviceResponse.json()) as {
              device_auth_id: string
              user_code: string
              interval: string
            }
            const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

            return {
              url: `${ISSUER}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      "User-Agent": `opencode/${InstallationVersion}`,
                    },
                    body: JSON.stringify({
                      device_auth_id: deviceData.device_auth_id,
                      user_code: deviceData.user_code,
                    }),
                  })

                  if (response.ok) {
                    const data = (await response.json()) as {
                      authorization_code: string
                      code_verifier: string
                    }

                    const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
                      method: "POST",
                      headers: { "Content-Type": "application/x-www-form-urlencoded" },
                      body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code: data.authorization_code,
                        redirect_uri: `${ISSUER}/deviceauth/callback`,
                        client_id: CLIENT_ID,
                        code_verifier: data.code_verifier,
                      }).toString(),
                    })

                    if (!tokenResponse.ok) {
                      throw new Error(`Token exchange failed: ${tokenResponse.status}`)
                    }

                    const tokens: TokenResponse = await tokenResponse.json()

                    return {
                      type: "success" as const,
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                      email: extractEmail(tokens),
                    }
                  }

                  if (response.status !== 403 && response.status !== 404) {
                    return { type: "failed" as const }
                  }

                  await sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "openai") return
      output.headers.originator = "opencode"
      output.headers["User-Agent"] = `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers.session_id = input.sessionID
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "openai") return
      // Match codex cli
      output.maxOutputTokens = undefined
    },
  }
}
