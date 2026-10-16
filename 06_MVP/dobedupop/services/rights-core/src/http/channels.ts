import type { Actor } from "../platform/actor.ts";
import { DomainError } from "../platform/errors.ts";

/**
 * API 채널(아키텍처 문서 "사용자 업무 시스템 분리", 다음 작업 5). 앱마다 쓰는 표면과 들어올 수 있는 신원이 다르다.
 * - ops: 운영 백오피스. 플랫폼 운영 테넌트 사용자만.
 * - portal: 권리자 포털. 권리자 테넌트(레이블·기획사·출판사·신탁단체) 사용자, 그리고 온보딩·대행을 하는 플랫폼 운영.
 * - performer: 실연자 앱. PERFORMER 역할의 본인 계정(파티 연결)만.
 * - fan: 팬 앱. 팬 파티에 연결된 개인 계정만.
 * - partner: 파트너 연동. B2B 파트너 테넌트 사용자만.
 */
export type Channel = "ops" | "portal" | "performer" | "fan" | "partner";

declare module "fastify" {
  interface FastifyRequest {
    channel?: Channel;
  }
}

const RIGHTS_HOLDER_TENANTS = new Set(["LABEL", "AGENCY", "PUBLISHER", "CMO"]);

export function allowed(channel: Channel, a: Actor): boolean {
  switch (channel) {
    case "ops": return a.scope === "platform";
    case "portal": return a.scope === "platform" || (a.scope === "tenant" && RIGHTS_HOLDER_TENANTS.has(a.tenantType));
    case "performer": return a.roles.has("PERFORMER") && a.partyId !== undefined;
    case "fan": return a.scope === "party" && a.partyType === "FAN";
    case "partner": return a.scope === "tenant" && a.tenantType === "B2B_PARTNER";
  }
}

/** 채널 인증 정책: 신원이 이 채널에 들어올 수 없으면 403 CHANNEL_FORBIDDEN. 역할 검사(requireRole)는 그 뒤에 따로 한다. */
export function assertChannel(channel: Channel, actor: Actor): void {
  if (!allowed(channel, actor)) throw new DomainError("CHANNEL_FORBIDDEN", 403, `${actor.userId} (${actor.scope}/${actor.tenantType}) cannot use the ${channel} channel`);
}
