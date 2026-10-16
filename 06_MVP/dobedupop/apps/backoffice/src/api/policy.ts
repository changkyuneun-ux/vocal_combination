import { api, ApiError, devApi } from "./client.ts";
import type { CompileResult, SeedResult } from "./types.ts";

const enc = encodeURIComponent;
export const compilePolicy = (policyId: string, packId: string, sourceText: string) =>
  api<CompileResult>("POST", `/policies/${enc(policyId)}/compile`, { packId, sourceText });
export const approveVersion = (policyId: string, version: number) => api<unknown>("POST", `/policies/${enc(policyId)}/versions/${version}/approve`, {});
export const activateVersion = (policyId: string, version: number) => api<unknown>("POST", `/policies/${enc(policyId)}/versions/${version}/activate`, {});
export const rebindPolicy = (policyId: string) => api<unknown>("POST", `/policies/${enc(policyId)}/rebind`, {});
/** 읽기 전용(아무것도 쓰지 않는다): 합성 곡의 식별자와 정책 원문. */
export const peekSyntheticSong = () => devApi<SeedResult>("GET", "/seed/synthetic-song");
export const packExists = (packId: string) =>
  api<unknown>("GET", `/packs/${enc(packId)}`).then(() => true, (e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return false;
    throw e;
  });
