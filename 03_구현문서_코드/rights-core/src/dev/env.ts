export const DEV_DB_NAME = "rights_core_dev";

/**
 * RC_DEV=1이면 DATABASE_URL의 DB 이름이 rights_core_dev이고 RC_PSP가 비었거나 "fake"이며 RC_ADMIN_URL이 있고 DATABASE_URL과 같은 호스트·포트·DB여야 한다.
 * 어긋나면 throw Error("DEV_ONLY: ..."). RC_DEV가 "1"이 아니면 false(통합 설계 12.2-7).
 */
export function devModeFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.RC_DEV !== "1") return false;
  const problems: string[] = [];
  const dbUrl = env.DATABASE_URL;
  if (dbUrl === undefined || dbUrl === "") problems.push("DATABASE_URL is required");
  else {
    let name: string | undefined;
    try { name = new URL(dbUrl).pathname; } catch { /* 아래에서 보고한다 */ }
    if (name !== `/${DEV_DB_NAME}`) problems.push(`DATABASE_URL must point at database ${DEV_DB_NAME}`);
  }
  const psp = env.RC_PSP;
  if (psp !== undefined && psp !== "" && psp !== "fake") problems.push(`RC_PSP must be "fake" or unset, got ${psp}`);
  const admin = env.RC_ADMIN_URL;
  if (admin === undefined || admin === "") problems.push("RC_ADMIN_URL is required");
  else if (dbUrl !== undefined && dbUrl !== "") {
    try {
      const a = new URL(admin), d = new URL(dbUrl);
      if (a.hostname !== d.hostname || a.port !== d.port || a.pathname !== d.pathname) problems.push("RC_ADMIN_URL must point at the same host, port and database as DATABASE_URL");
    } catch { problems.push("RC_ADMIN_URL is not a valid URL"); }
  }
  if (problems.length > 0) throw new Error(`DEV_ONLY: ${problems.join("; ")}`);
  return true;
}
