import type { Driver, Reply } from "../../../services/rights-core/src/scenario/dynamite-personas.ts";

/**
 * 데모 스택의 코어 API를 부르는 Driver(MVP 진행계획 M4). 데모 진행판 서버가 내부망에서 코어(core-api)에 직접 붙는다:
 * 신원은 개발용 x-actor 헤더(데모 환경의 코어만 받는다. 게이트웨이는 밖에서 온 헤더를 지운다), 시계·작업·공급자 통지는 코어 개발 도구(/dev).
 */
export function httpDriver(core: string, opts: { drainTimeoutMs?: number; log?: (s: string) => void } = {}): Driver {
  const send = async (url: string, init: RequestInit): Promise<Reply> => {
    const r = await fetch(url, init);
    const text = await r.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : undefined; } catch { /* JSON 아님 */ }
    return { status: r.status, body };
  };
  const json = (method: string, url: string, actor: string | null, body?: unknown) => send(url, {
    method, headers: { "x-dbp-csrf": "1", ...(actor ? { "x-actor": actor } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const must = async (what: string, r: Promise<Reply>) => { const x = await r; if (x.status >= 300) throw new Error(`${what}: ${x.status} ${JSON.stringify(x.body)}`); return x.body as any; };
  return {
    call: (channel, actor, method, path, body) => json(method, `${core}/${channel}${path}`, actor, body),
    upload: (channel, actor, path, bytes, contentType) => send(`${core}/${channel}${path}`, {
      method: "POST", headers: { "x-actor": actor, "x-dbp-csrf": "1", "content-type": contentType }, body: new Uint8Array(bytes).buffer as ArrayBuffer,
    }),
    async setClock(at) {
      const now = (await must("clock", json("GET", `${core}/dev/clock`, null))).now as string;
      if (at > now) await must(`clock set ${at}`, json("POST", `${core}/dev/clock/set`, null, { at }));
    },
    async drain() {
      const deadline = Date.now() + (opts.drainTimeoutMs ?? 10 * 60_000);
      for (;;) {
        const n = (await must("pending jobs", json("GET", `${core}/dev/jobs/pending`, null))).pending as number;
        if (n === 0) return;
        if (Date.now() > deadline) throw new Error(`jobs did not finish (${n} pending)`);
        await new Promise((r) => setTimeout(r, 500));
      }
    },
    async provisionUser(u) {
      const r = await json("POST", `${core}/ops/users`, "usr_ops", u);
      if (r.status === 409) return; // 이미 있다(다시 돌릴 때)
      if (r.status >= 300) throw new Error(`provision ${u.userId}: ${r.status} ${JSON.stringify(r.body)}`);
    },
    async providerSigned(contractId, partyId) {
      await must(`provider sign ${contractId}`, json("POST", `${core}/dev/esign/${contractId}/sign`, null, { partyId }));
    },
  };
}
