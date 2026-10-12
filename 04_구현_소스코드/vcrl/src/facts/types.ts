import type { EnumValue } from "../core/enums.ts";
import type { IrDocument } from "../core/envelope.ts";
import type { Instant, Interval } from "../core/time.ts";

type Visibility = EnumValue<"visibility">;
export type ClaimantRole = EnumValue<"claimant_role">;
export type EntityType = "party" | "work" | "recording" | "voice" | "stem" | "claim" | "mandate";

/** share를 가지는 권리 주장 엣지와 허용 source→target 종류. 구조 관계(stem.of, recording.of)는 필드로 표현한다. */
export const CLAIM_EDGE_KINDS = {
  PERFORMED_BY: ["stem", "voice"],
  OWNED_BY: ["voice", "party"],
  CONTROLLED_BY: ["recording", "party"],
  WRITTEN_BY: ["work", "party"],
  CONTRIBUTED_BY: ["recording", "party"],
} as const satisfies Record<string, readonly [EntityType, EntityType]>;
export type ClaimEdge = keyof typeof CLAIM_EDGE_KINDS;

export const MAX_MANDATE_HOPS = 2;

export type Party = { id: string; kind: EnumValue<"party_kind">; ids?: Record<string, string>; visibility?: Visibility };
export type Work = { id: string; ids?: Record<string, string> };
export type Recording = { id: string; of: string; ids?: Record<string, string> };
export type Voice = { id: string; kind: EnumValue<"voice_kind"> };
export type Stem = { id: string; of: string; slot: string; rights_bearing: boolean };

type Recorded = { recorded_at: Instant; superseded_at?: Instant; status: EnumValue<"claim_status">; valid: Interval };

export type Claim = Recorded & {
  id: string;
  source: string;
  edge: ClaimEdge;
  target: string;
  share: string;
  performer_role?: EnumValue<"performer_role">;
  role_detail?: string;
  evidence?: string;
  visibility?: Visibility;
};

export type Mandate = Recorded & {
  id: string;
  from: string;
  to: string;
  right: EnumValue<"mandate_right">;
  share: string;
  visibility?: Visibility;
};

export type FactsBody = {
  parties: Party[];
  works: Work[];
  recordings: Recording[];
  voices: Voice[];
  stems: Stem[];
  claims: Claim[];
  mandates: Mandate[];
};

export type FactsDocument = IrDocument<FactsBody>;
