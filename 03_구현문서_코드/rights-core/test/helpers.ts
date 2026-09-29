import { createDb, type Db } from "../src/platform/db.ts";
import { ADMIN_URL, createFreshDatabase } from "../src/platform/dbadmin.ts";

/** 템플릿 DB를 복제한 새 DB에 rc_app 역할로 연결한다. 테스트 파일마다 한 번 호출하고 after()에서 drop한다. */
export async function freshDb(): Promise<{ db: Db; drop(): Promise<void> }> {
  const fresh = await createFreshDatabase(ADMIN_URL);
  const db = createDb(fresh.appUrl);
  return {
    db,
    async drop() {
      await db.close();
      await fresh.drop();
    },
  };
}
