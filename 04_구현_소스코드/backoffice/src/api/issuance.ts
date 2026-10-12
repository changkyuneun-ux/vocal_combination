import { api } from "./client.ts";
import type { IssueBody, IssueSeal } from "./types.ts";

const enc = encodeURIComponent;

/** mdrl enums.ts의 claimant_role. rights-core `Declared`의 role 값이다. */
export const CLAIMANT_ROLES = [
  "MASTER_OWNER", "WORK_AUTHOR", "CMO", "PERFORMER_FEATURED", "PERFORMER_NON_FEATURED", "AGENCY", "AI_PROVIDER", "RECORDING_CONTRIBUTOR",
] as const;

export type Declared = { role: string; party: string };

export const createPack = (b: { packId: string; packCode: string; title: string; factsScopeId: string }) => api<unknown>("POST", "/packs", b);
export const setClaimants = (packId: string, entries: Declared[]) => api<unknown>("PUT", `/packs/${enc(packId)}/claimants`, entries);
export const activatePack = (packId: string) => api<unknown>("POST", `/packs/${enc(packId)}/activate`, {});
export const issue = (b: IssueBody) => api<IssueSeal>("POST", "/issues", b);
