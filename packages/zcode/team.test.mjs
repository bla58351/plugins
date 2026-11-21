// An account with a GLM Coding Plan of its own and a seat on a team's
// (#285): the plan sign-ins take its own plan, as ZCode does by default,
// and "ZCode: a team's GLM Coding Plan" takes the team's seat, as ZCode's
// plan picker does with a "team-coding-plan" selection. The two are kept
// as two accounts, named apart.
import { afterEach, beforeAll, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin } = await import("./index.mjs"))
})
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const ok = (data) => Response.json({ code: 200, success: true, data })
const CN_LABEL = "ZCode: ZChat (zchat.z.ai) GLM Coding Plan"
const TEAM_LABEL = "ZCode: a team's GLM Coding Plan"
const CN_URL = "https://ZChat.Z.AI/oauth?redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fcallback&state=keep%20this"

// an account with its own BigModel Pro plan in 默认项目 and a seat on team t1
function vendor({ seat = "VALID", teams = true, user = { email: "ada@example.com" }, authorizeURL = "https://open.bigmodel.cn/login", tokens = { bigmodel: { access_token: "bm-token" } } } = {}) {
  const seen = []
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === "string" ? input : input.url)
    const h = new Headers(init.headers)
    const org = h.get("Bigmodel-Organization")
    const proj = h.get("Bigmodel-Project")
    seen.push({ method: init.method ?? "GET", origin: u.origin, path: u.pathname, org, proj, auth: h.get("authorization"), key: h.get("x-api-key"), body: init.body })
    const p = u.pathname
    if (p === "/api/v1/oauth/cli/init") return ok({ flow_id: "f1", authorize_url: authorizeURL, poll_interval_sec: 0, expires_at: 0 })
    if (p === "/api/v1/oauth/cli/poll/f1") return ok({ status: "ready", ...tokens, token: "", user })
    if (p === "/api/anthropic/v1/messages") return ok({ type: "message", content: [] })
    if (p === "/api/biz/customer/getCustomerInfo")
      return ok({
        organizations: [
          { organizationId: "own-org", organizationName: "默认机构", projects: [{ projectId: "own-p", projectName: "默认项目", projectType: 1 }] },
          ...(teams ? [{ organizationId: "t1", organizationName: "Team", projects: [{ projectId: "tp1", projectName: "Team project", projectType: 2 }] }] : []),
        ],
      })
    if (p === "/api/biz/v1/organization/own-org/projects/own-p/api_keys") return ok([{ name: "zcode-api-key", apiKey: "own" }])
    if (p === "/api/biz/v1/organization/own-org/projects/own-p/api_keys/copy/own") return ok({ secretKey: "own-secret" })
    if (p === "/api/biz/subscription/list") return ok([{ status: "VALID", productName: "GLM Coding Pro" }])
    if (p === "/api/biz/team/subscribe/product/querySubscribeDetail" && org === "t1" && proj === "tp1")
      return ok({ hasSubscription: true, status: "EFFECTIVE", memberGrantStatus: seat, productName: "GLM Coding Team Max" })
    if (p === "/api/biz/v1/organization/t1/projects/tp1/api_keys" && org === "t1") return ok([{ name: "zcode-team-api-key", apiKey: "tk", keyType: 2 }])
    if (p === "/api/biz/v1/organization/t1/projects/tp1/api_keys/copy/tk" && org === "t1") return ok({ secretKey: "team-secret" })
    return new Response("unexpected " + p, { status: 404 })
  }
  return seen
}

async function signIn(label, inputs) {
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const m = hooks.auth.methods.find((x) => x.label === label)
  expect(m).toBeDefined()
  const a = await m.authorize(inputs)
  return a.callback()
}

test("the plan sign-in takes the account's own plan when it has a team seat too", async () => {
  vendor()
  const r = await signIn("ZCode: BigModel (智谱) GLM Coding Plan")
  expect(r.type).toBe("success")
  expect(r.access).toBe("own.own-secret")
  expect(r.accountId).toBe("ada@example.com")
  const s = JSON.parse(r.refresh)
  expect(s).toMatchObject({ site: "bigmodel", key: "own.own-secret", plan: "GLM Coding Pro" })
  expect(s.org).toBeUndefined()
})

test("the team sign-in takes the team's seat, its key and plan, under a name of its own", async () => {
  const seen = vendor()
  const r = await signIn("ZCode: a team's GLM Coding Plan", { site: "bigmodel" })
  expect(r.type).toBe("success")
  expect(r.access).toBe("tk.team-secret")
  expect(r.expires).toBe(0)
  expect(r.accountId).toBe("ada@example.com (team)")
  expect(JSON.parse(r.refresh)).toMatchObject({
    site: "bigmodel",
    base: "https://open.bigmodel.cn/api/anthropic",
    key: "tk.team-secret",
    token: "bm-token",
    org: "t1",
    project: "tp1",
    plan: "GLM Coding Team Max",
  })
  // the account's own key is neither read nor made
  expect(seen.some((x) => x.path.includes("own-org"))).toBe(false)
})

test("the team sign-in with no seat says so, and never falls back to the account's own plan", async () => {
  vendor({ seat: "UNASSIGNED" })
  let r = await signIn("ZCode: a team's GLM Coding Plan", { site: "bigmodel" })
  expect(r.type).toBe("failed")
  expect(r.error).toContain("has no seat on it yet")

  vendor({ teams: false })
  r = await signIn("ZCode: a team's GLM Coding Plan", { site: "bigmodel" })
  expect(r.type).toBe("failed")
  expect(r.error).toContain("has no seat on a team's GLM Coding Plan")
})

test("the team sign-in asks which site, as the key sign-in does", async () => {
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const m = hooks.auth.methods.find((x) => x.label === TEAM_LABEL)
  expect(m.type).toBe("oauth")
  expect(m.prompts.map((p) => [p.key, p.type, p.options.map((o) => o.value)])).toEqual([["site", "select", ["zai", "bigmodel", "zai_cn"]]])
})

test("Z.ai CN keeps the server's browser URL and uses its own token and BigModel plan", async () => {
  const seen = vendor({ authorizeURL: CN_URL, tokens: { zai_cn: { accessToken: "cn-token" }, zai: { access_token: "international-token" } } })
  const { auth } = await ZCodeAuthPlugin()
  expect(auth.methods.map((m) => m.label)).toEqual([
    "ZCode: Z.ai GLM Coding Plan",
    "ZCode: BigModel (智谱) GLM Coding Plan",
    TEAM_LABEL,
    "ZCode app's sign-in",
    "GLM Coding Plan API key",
    CN_LABEL,
  ])
  const flow = await auth.methods.at(-1).authorize()
  expect(flow.url).toBe(CN_URL)
  expect(JSON.parse(seen[0].body)).toEqual({ provider: "zai_cn" })
  const signedIn = await flow.callback()
  expect(signedIn).toMatchObject({ type: "success", access: "own.own-secret" })
  expect(JSON.parse(signedIn.refresh)).toMatchObject({ site: "zai_cn", base: "https://open.bigmodel.cn/api/anthropic", key: "own.own-secret" })
  expect(seen.find((r) => r.path === "/api/biz/customer/getCustomerInfo")).toMatchObject({ origin: "https://bigmodel.cn", auth: "cn-token" })
  expect(seen.some((r) => r.path === "/api/auth/z/login")).toBe(false)

  const opts = await auth.loader(async () => ({ ...signedIn, type: "oauth" }), { id: "zcode" })
  expect(opts.baseURL).toBe("https://open.bigmodel.cn/api/anthropic/v1")
  const response = await opts.fetch("https://api.z.ai/api/anthropic/v1/messages", { method: "POST", body: "{}" })
  expect(response.status).toBe(200)
  expect(seen.at(-1)).toMatchObject({ origin: "https://open.bigmodel.cn", path: "/api/anthropic/v1/messages", key: "own.own-secret" })
})

test("a Z.ai CN team sign-in accepts the poll's zai token and keeps the BigModel team scope", async () => {
  const seen = vendor({ authorizeURL: CN_URL, tokens: { zai: { access_token: "cn-team-token" } } })
  const signedIn = await signIn(TEAM_LABEL, { site: "zai_cn" })
  expect(signedIn).toMatchObject({ type: "success", accountId: "ada@example.com (team)", access: "tk.team-secret" })
  expect(JSON.parse(signedIn.refresh)).toMatchObject({ site: "zai_cn", token: "cn-team-token", org: "t1", project: "tp1" })
  expect(seen.find((r) => r.path.endsWith("querySubscribeDetail"))).toMatchObject({ origin: "https://bigmodel.cn", auth: "cn-team-token", org: "t1", proj: "tp1" })
  expect(seen.some((r) => r.path.includes("own-org"))).toBe(false)
})

// wakkana on Discord (WorkBuddy's, the same here): the browser sign-in
// keeps the account's user id beside its name, for magpie to tell two
// accounts of one name apart by
test("the plan sign-in keeps the account's user id", async () => {
  vendor({ user: { name: "Ada", user_id: 42 } })
  const r = await signIn("ZCode: BigModel (智谱) GLM Coding Plan")
  expect(r.accountId).toBe("Ada")
  expect(r.uid).toBe("42")
})
