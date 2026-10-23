import type { APIRequestContext } from "@playwright/test";
import { ok } from "./fixtures.ts";

/** 빅히트 권리 테넌트 온보딩(Dynamite onboard 단계와 같은 API): 테넌트 확인됨, 관리자·담당자, 멤버 2·작가 2, 레이블·소속사 당사자. */
export async function onboardBighit(request: APIRequestContext): Promise<void> {
  await ok(request, "usr_ops", "POST", "/users", { userId: "usr_rights", displayName: "온보딩", roles: ["ONBOARDING"], tenantId: "tnt_platform" }).catch(() => undefined);
  await ok(request, "usr_rights", "POST", "/tenants", { tenantId: "tnt_bighit", tenantType: "LABEL", name: "빅히트 뮤직", businessNo: "BRN-E2E", country: "KR", representative: "대표" });
  for (const item of ["BUSINESS_ID", "REPRESENTATIVE", "PLATFORM_AGREEMENT"]) await ok(request, "usr_rights", "PUT", `/tenants/tnt_bighit/checks/${item}`, { checked: true, note: "e2e" });
  await ok(request, "usr_rights", "POST", "/tenants/tnt_bighit/status", { status: "VERIFIED" });
  // 운영은 첫 관리자만 발급하고(결정 TD4), 담당자는 빅히트 관리자가 포털에서 초대한다.
  await ok(request, "usr_ops", "POST", "/users", { userId: "usr_bh_admin", displayName: "빅히트 관리자", roles: ["TENANT_ADMIN"], tenantId: "tnt_bighit" });
  for (const [userId, role] of [["usr_bh_rights", "RIGHTS_EDITOR"], ["usr_bh_policy", "EDITOR"], ["usr_bh_approver", "WORK_APPROVER"], ["usr_bh_activator", "ACTIVATOR"]] as const) {
    await ok(request, "usr_bh_admin", "POST", "/portal/users", { userId, displayName: userId, roles: [role] });
  }
  for (const [partyId, name] of [["pty_jungkook", "정국"], ["pty_jimin", "지민"]] as const) {
    await ok(request, "usr_rights", "POST", "/parties", { partyId, partyType: "MEMBER", displayName: name, tenantId: "tnt_platform_default" });
  }
  for (const [partyId, name] of [["pty_david_stewart", "David Stewart"], ["pty_jessica_agombar", "Jessica Agombar"]] as const) {
    await ok(request, "usr_rights", "POST", "/parties", { partyId, partyType: "AUTHOR", displayName: name });
  }
  for (const [partyId, partyType, displayName] of [["pty_bighit_label", "LABEL", "빅히트 레이블"], ["pty_bighit_agency", "AGENCY", "빅히트 소속사"]] as const) {
    await ok(request, "usr_bh_rights", "POST", "/portal/parties", { partyId, partyType, displayName });
  }
}
