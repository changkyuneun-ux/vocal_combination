import { ProfileRegistry } from "./registry.ts";
import { VocalCombinationProfile } from "./vocal.ts";
import { AiMixProfile } from "./ai-mix.ts";

export * from "./registry.ts";
export * from "./vocal.ts";
export * from "./ai-mix.ts";

// 기본 프로파일 등록
ProfileRegistry.register(VocalCombinationProfile);
ProfileRegistry.register(AiMixProfile);
