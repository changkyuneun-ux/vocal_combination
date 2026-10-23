import { listMemberships, loadActor, type Actor } from "../platform/actor.ts";
import type { Tx } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";

/**
 * API 채널(아키텍처 문서 "사용자 업무 시스템 분리", 다음 작업 5). 앱마다 쓰는 표면과 들어올 수 있는 신원이 다르다.
 * - ops: 운영 백오피스. 플랫폼 운영 테넌트 사용자만.
 * - portal: 권리자 포털. 권리 테넌트(레이블·기획사·출판사·독립 아티스트) 소속만. 플랫폼은 권리를 다루지 않으므로(결정 WD1~WD3)
 *   플랫폼 소속으로는 들어오지 못한다 — 위임 대행(x-on-behalf-of)도 포털에서는 막힌다. 여러 소속을 가진 계정(총괄)은 권리 테넌트 소속으로 들어온다.
 *   신탁단체는 권리를 만들지 않으므로 들어오지 못한다(결정 TD12).
 * - performer: 실연자 앱. PERFORMER 역할의 본인 계정(파티 연결)만.
 * - fan: 팬 앱. 팬 파티에 연결된 개인 계정만.
 * - partner: 참여 기관 화면. 참여 기관(신탁단체·유통 파트너) 사용자만(결정 TD12 — 파트너 채널을 넓혔다).
 */
export type Channel = "ops" | "portal" | "performer" | "fan" | "partner";

declare module "fastify" {
  interface FastifyRequest {
    channel?: Channel;
  }
}

export function allowed(channel: Channel, a: Actor): boolean {
  switch (channel) {
    case "ops": return a.scope === "platform";
    case "portal": return a.scope === "tenant" && a.orgClass === "RIGHTS";
    case "performer": return a.permissions.has("performer.self") && a.partyId !== undefined;
    case "fan": return a.scope === "party" && a.partyType === "FAN";
    case "partner": return a.scope === "tenant" && a.orgClass === "PARTICIPANT";
  }
}

/** 채널 인증 정책: 신원이 이 채널에 들어올 수 없으면 403 CHANNEL_FORBIDDEN. 권한 검사(requirePermission)는 그 뒤에 따로 한다. */
export function assertChannel(channel: Channel, actor: Actor): void {
  if (!allowed(channel, actor)) throw new DomainError("CHANNEL_FORBIDDEN", 403, `${actor.userId} (${actor.scope}/${actor.tenantType}) cannot use the ${channel} channel`);
}

/**
 * 이 채널에서 일할 소속으로 행위자를 읽는다(결정 TD9). tenantId(세션의 현재 소속·x-tenant 헤더)를 주면 그 소속이어야 하고,
 * 없으면 기본 소속, 기본 소속이 이 채널에 못 들어오면 들어올 수 있는 첫 소속을 고른다(예: 실연자 계정이 독립 아티스트 테넌트로 포털에).
 */
export async function actorForChannel(tx: Tx, userId: string, channel: Channel, tenantId?: string | null): Promise<Actor> {
  if (tenantId) {
    const a = await loadActor(tx, userId, tenantId);
    assertChannel(channel, a);
    return a;
  }
  const home = await loadActor(tx, userId).catch((e: unknown) => e as Error);
  if (!(home instanceof Error) && allowed(channel, home)) return home;
  for (const m of await listMemberships(tx, userId)) {
    if (m.home) continue;
    const a = await loadActor(tx, userId, m.tenantId).catch(() => undefined);
    if (a !== undefined && allowed(channel, a)) return a;
  }
  if (home instanceof Error) throw home;
  assertChannel(channel, home);
  return home;
}
