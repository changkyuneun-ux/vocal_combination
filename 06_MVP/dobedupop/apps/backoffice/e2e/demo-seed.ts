import type { APIRequestContext } from "@playwright/test";

/** 데모 진행판으로 Dynamite 시연 데이터를 끝까지 채운다(이미 끝났으면 그대로). 데모 스택 시험이 함께 쓴다. */
const DOMAIN = process.env.E2E_DOMAIN ?? "dobedupop.localhost";
const DEMO = `http://demo.${DOMAIN}/api/demo`;

export async function ensureDynamite(request: APIRequestContext): Promise<void> {
  const view = async () => (await (await request.get(`${DEMO}/steps`)).json()) as { running: boolean; steps: { status: string; id: string; error?: string }[] };
  let v = await view();
  if (v.steps.every((s) => s.status === "done")) return;
  if (!v.running) {
    await request.post(`${DEMO}/reset`, { headers: { "x-dbp-csrf": "1" } });
    await request.post(`${DEMO}/run-all`, { headers: { "x-dbp-csrf": "1" } });
  }
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    v = await view();
    const failed = v.steps.find((s) => s.status === "failed");
    if (failed) throw new Error(`demo step ${failed.id} failed: ${failed.error}`);
    if (v.steps.every((s) => s.status === "done")) return;
    if (Date.now() > deadline) throw new Error("demo seed did not finish");
    await new Promise((r) => setTimeout(r, 3000));
  }
}

