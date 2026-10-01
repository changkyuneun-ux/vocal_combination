import { api, devApi } from "./client.ts";
import type { CompileResult, SeedResult } from "./types.ts";

const enc = encodeURIComponent;
export const compilePolicy = (policyId: string, packId: string, sourceText: string) =>
  api<CompileResult>("POST", `/policies/${enc(policyId)}/compile`, { packId, sourceText });
export const approveVersion = (policyId: string, version: number) => api<unknown>("POST", `/policies/${enc(policyId)}/versions/${version}/approve`, {});
export const activateVersion = (policyId: string, version: number) => api<unknown>("POST", `/policies/${enc(policyId)}/versions/${version}/activate`, {});
export const rebindPolicy = (policyId: string) => api<unknown>("POST", `/policies/${enc(policyId)}/rebind`, {});
export const seedSyntheticSong = () => devApi<SeedResult>("POST", "/seed/synthetic-song", {});
