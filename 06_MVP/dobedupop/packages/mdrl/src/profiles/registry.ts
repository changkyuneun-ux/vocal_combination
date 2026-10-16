import type { EnumName } from "../core/enums.ts";


/**
 * 마스터 규격 5.10절 및 6.2.6절 / 6.8절에 따른 프로파일 정의 인터페이스.
 * 프로파일은 마스터 코어의 불변식을 완화할 수 없으며, 등록점에 어휘를 확장 바인딩한다.
 */
export interface ProfileDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly asset_kinds: readonly string[];
  readonly edge_kinds: readonly string[];
  readonly claimant_roles: readonly string[];
  readonly party_kinds: readonly string[];
  readonly mandate_rights: readonly string[];
  readonly usage_metrics: readonly string[];
  readonly vector_fns: readonly string[];
  readonly event_types: readonly string[];
  readonly holding_reasons: readonly string[];
  readonly actions: readonly string[];
}

export class ProfileRegistry {
  private static profiles = new Map<string, ProfileDefinition>();

  public static register(profile: ProfileDefinition): void {
    this.profiles.set(profile.id, profile);
  }

  public static get(profileId: string): ProfileDefinition | undefined {
    return this.profiles.get(profileId);
  }

  public static has(profileId: string): boolean {
    return this.profiles.has(profileId);
  }

  public static list(): ProfileDefinition[] {
    return Array.from(this.profiles.values());
  }

  public static isRegisteredValue(profileId: string, extensionPoint: keyof ProfileDefinition, value: string): boolean {
    const profile = this.profiles.get(profileId);
    if (!profile) return false;
    const list = profile[extensionPoint];
    return Array.isArray(list) && list.includes(value);
  }
}
