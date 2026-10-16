import { describe, expect, it } from "vitest";
import { ApiError, api, devApi } from "./client.ts";

type Call = { url: string; init: RequestInit };
function fake(status: number, body: unknown, calls: Call[] = []) {
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return f;
}

describe("client", () => {
  it("409 error body becomes ApiError", async () => {
    const f = fake(409, { code: "RETRY", message: "again", diagnostics: [{ a: 1 }] });
    const err = (await api("POST", "/x", {}, { fetchImpl: f }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("RETRY");
    expect(err.message).toBe("again");
    expect(err.diagnostics).toEqual([{ a: 1 }]);
  });
  it("non-JSON error body still yields ApiError", async () => {
    const err = (await api("GET", "/x", undefined, { fetchImpl: fake(502, "bad gateway") }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.diagnostics).toEqual([]);
  });
  it("sends /api/<channel> prefix (ops by default), x-actor and json body; actorOverride wins", async () => {
    const calls: Call[] = [];
    const out = await api<{ ok: boolean }>("POST", "/things", { n: 1 }, { fetchImpl: fake(200, { ok: true }, calls), actorOverride: "usr_settle" });
    expect(out).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("/api/ops/things");
    await api("GET", "/works", undefined, { fetchImpl: fake(200, {}, calls), channel: "portal" });
    expect(calls[1]!.url).toBe("/api/portal/works");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["x-actor"]).toBe("usr_settle");
    expect(h["content-type"]).toBe("application/json");
    expect(calls[0]!.init.body).toBe('{"n":1}');
  });
  it("devApi uses /api/dev and no x-actor", async () => {
    const calls: Call[] = [];
    await devApi("GET", "/clock", undefined, { fetchImpl: fake(200, {}, calls) });
    expect(calls[0]!.url).toBe("/api/dev/clock");
    expect((calls[0]!.init.headers as Record<string, string>)["x-actor"]).toBeUndefined();
  });
});
