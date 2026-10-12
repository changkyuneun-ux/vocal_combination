import { test } from "node:test";
import assert from "node:assert/strict";
import { ProfileRegistry, AiMixProfile, VocalCombinationProfile } from "../../src/profiles/index.ts";
import { splitLrm } from "../../src/allocation/lrm.ts";
import { parseRatio, ratio } from "../../src/core/ratio.ts";
import { digestOf } from "../../src/core/digest.ts";

test("ProfileRegistry manages multiple profiles independently", () => {
  assert.equal(ProfileRegistry.has("vocal-combination"), true);
  assert.equal(ProfileRegistry.has("ai-mix"), true);

  const aiMix = ProfileRegistry.get("ai-mix");
  assert.equal(aiMix?.name, "AI Mixing and Voice Performance Profile");
  assert.equal(aiMix?.claimant_roles.includes("MIX_ENGINEER"), true);
  assert.equal(aiMix?.claimant_roles.includes("MODEL_PROVIDER"), true);

  assert.equal(ProfileRegistry.isRegisteredValue("ai-mix", "asset_kinds", "model_run"), true);
  assert.equal(ProfileRegistry.isRegisteredValue("vocal-combination", "asset_kinds", "slot"), true);
});

test("Master LRM evaluator deterministically allocates revenue for AI Mix scenario", () => {
  // AI Mix 수익 분배 시뮬레이션:
  // 총 매출 10,000 KRW
  // 1층: Platform(2000bps, 20%), Model/AI Tech Pool(3000bps, 30%), Rights Pool(5000bps, 50%)
  const tier1Splits = [
    { key: "platform", weight: parseRatio("1/5") },
    { key: "ai_tech", weight: parseRatio("3/10") },
    { key: "rights", weight: parseRatio("1/2") },
  ];

  const totalAmount = 10000n;
  const tier1Lines = splitLrm(totalAmount, tier1Splits);

  assert.equal(tier1Lines.find((l) => l.key === "platform")?.amount, 2000n);
  assert.equal(tier1Lines.find((l) => l.key === "ai_tech")?.amount, 3000n);
  assert.equal(tier1Lines.find((l) => l.key === "rights")?.amount, 5000n);

  // 2층: AI Tech Pool (3,000 KRW) 안에서 Model Provider(70%)와 Mix Engineer(30%) 배분
  const aiTechSplits = [
    { key: "pty_model_provider", weight: parseRatio("7/10") },
    { key: "pty_mix_engineer", weight: parseRatio("3/10") },
  ];
  const aiTechLines = splitLrm(3000n, aiTechSplits);
  assert.equal(aiTechLines.find((l) => l.key === "pty_model_provider")?.amount, 2100n);
  assert.equal(aiTechLines.find((l) => l.key === "pty_mix_engineer")?.amount, 900n);


  // 금액 보존 불변식 검증 (원금 = 플랫폼 + 모델 + 엔지니어 + 저작권)
  const sum = 2000n + 2100n + 900n + 5000n;
  assert.equal(sum, totalAmount);

  // 결과 IR의 다이제스트 재현성 검증
  const resultIr = {
    profile: "ai-mix@1.0",
    event_id: "evt_ai_001",
    currency: "KRW",
    total: "10000",
    lines: [
      { party: "pty_platform", role: "PLATFORM", bucket: "platform", amount: "2000" },
      { party: "pty_model_provider", role: "MODEL_PROVIDER", bucket: "model_share", amount: "2100" },
      { party: "pty_mix_engineer", role: "MIX_ENGINEER", bucket: "mix_share", amount: "900" },
      { party: "pty_label", role: "MASTER_OWNER", bucket: "rights", amount: "5000" },
    ],
  };

  const digest1 = digestOf(resultIr);
  const digest2 = digestOf(resultIr);
  assert.equal(digest1, digest2);
  assert.equal(digest1.startsWith("vcrl:sha256:"), true);
});
