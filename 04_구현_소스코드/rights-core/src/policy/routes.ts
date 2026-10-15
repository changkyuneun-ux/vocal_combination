import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { DomainError } from "../platform/errors.ts";
import * as policy from "./service.ts";
import { optFilter, parsePage } from "../platform/paging.ts";
import * as q from "./queries.ts";
import { previewPolicy, textFromForm, textToForm, type PolicyForm } from "./form.ts";

export function policyRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Params: { policyId: string }; Body: { packId: string; sourceText: string } }>("/policies/:policyId/compile", async (req, reply) => {
    const out = await withActor(deps, req, (tx, actor) => {
      const { packId, sourceText } = req.body ?? ({} as Partial<typeof req.body>);
      if (typeof packId !== "string" || typeof sourceText !== "string") throw new DomainError("BAD_REQUEST", 400, "packId and sourceText are required strings");
      return policy.compilePolicy(deps.ctx, tx, deps.clock, actor, { policyId: req.params.policyId, packId, sourceText });
    });
    return reply.status(201).send(out);
  });
  const ref = (p: { policyId: string; version: string }) => {
    const version = Number(p.version);
    if (!/^[0-9]+$/.test(p.version) || !Number.isSafeInteger(version) || version < 1) throw new DomainError("BAD_REQUEST", 400, `invalid policy version: ${p.version}`);
    return { policyId: p.policyId, version };
  };
  app.post<{ Params: { policyId: string; version: string } }>("/policies/:policyId/versions/:version/approve", async (req) =>
    withActor(deps, req, async (tx, actor) => { await policy.approvePolicy(deps.ctx, tx, deps.clock, actor, ref(req.params)); return {}; }));
  app.post<{ Params: { policyId: string; version: string } }>("/policies/:policyId/versions/:version/activate", async (req) =>
    withActor(deps, req, async (tx, actor) => { await policy.activatePolicy(deps.ctx, tx, deps.clock, actor, ref(req.params)); return {}; }));
  app.post<{ Params: { policyId: string } }>("/policies/:policyId/rebind", async (req) =>
    withActor(deps, req, (tx, actor) => policy.rebindPolicy(deps.ctx, tx, deps.clock, actor, req.params.policyId)));
  // 분배 규칙 폼(원천 문서 설계 S2): 폼 ↔ MDRL 텍스트, 예시 계산(봉인 없음).
  app.post<{ Body: { form?: PolicyForm; policyId?: string } }>("/policies/form/text", async (req) => withActor(deps, req, async () => {
    if (req.body?.form === undefined) throw new DomainError("BAD_REQUEST", 400, "form is required");
    return { sourceText: textFromForm(req.body.form, req.body.policyId) };
  }));
  app.post<{ Body: { sourceText?: string } }>("/policies/form/parse", async (req) => withActor(deps, req, async () => {
    if (typeof req.body?.sourceText !== "string") throw new DomainError("BAD_REQUEST", 400, "sourceText is required");
    return textToForm(req.body.sourceText);
  }));
  app.post("/policies/preview", async (req) => withActor(deps, req, (tx) => previewPolicy(tx, deps.clock, (req.body ?? {}) as Record<string, any>)));
  // 조회(로그인한 누구나)
  const q0 = (req: { query: unknown }) => req.query as Record<string, unknown>;
  app.get("/policies", async (req) => withActor(deps, req, (tx) => q.listPolicies(tx, { pack: optFilter(q0(req), "pack") }, parsePage(q0(req)))));
  app.get<{ Params: { policyId: string } }>("/policies/:policyId/versions", async (req) =>
    withActor(deps, req, (tx) => q.listVersions(tx, req.params.policyId, parsePage(q0(req)))));
  app.get<{ Params: { policyId: string; version: string } }>("/policies/:policyId/versions/:version", async (req) =>
    withActor(deps, req, (tx) => { const r = ref(req.params); return q.getVersion(tx, r.policyId, r.version); }));
}
