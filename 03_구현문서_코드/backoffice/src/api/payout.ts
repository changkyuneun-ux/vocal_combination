import { api } from "./client.ts";
import type { ProfileInput, ProfileView } from "./types.ts";

const e = encodeURIComponent;

/** SPACE_SETTLE(usr_settle/usr_settle2). 본문은 rights-core setPayoutProfile의 입력과 같다(firstPayableAt은 서버가 정한다). */
export const setPayoutProfile = ({ partyId, ...body }: ProfileInput) => api<ProfileView>("PUT", `/parties/${e(partyId)}/payout-profile`, body);
export const createPayoutRun = (b: { payoutRunId: string; asOf: string }) => api<{ payoutRunId: string }>("POST", "/payout-runs", b);
export const resubmitPayout = (instructionId: string) => api<{ instructionId: string; providerStatus: string; status: string }>("POST", `/payouts/${e(instructionId)}/resubmit`);
