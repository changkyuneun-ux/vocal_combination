import webpush from "web-push";
import { withSystemScope } from "../platform/actor.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { notFound } from "../platform/errors.ts";
import { enqueue, type OutboxHandlers } from "../platform/outbox.ts";

export type NotificationKind = "USAGE" | "CONSENT" | "PAYOUT" | "OBJECTION" | "IDENTITY" | "CONFIRMATION";
export type PushPayload = { title: string; body: string; kind: NotificationKind; notificationId: number; ref: unknown };
export type PushSubscriptionRow = { endpoint: string; p256dh: string; auth: string };

/** 푸시 전송(웹 푸시). 실패해도 알림함에는 남는다. gone이면 구독을 끈다. */
export type PushSender = { publicKey: string; send(sub: PushSubscriptionRow, payload: PushPayload): Promise<"sent" | "gone" | "failed"> };

/** 웹 푸시(VAPID) 전송자. 키가 없으면 실행마다 새로 만든다(개발용 — 운영은 VAPID_PUBLIC_KEY·VAPID_PRIVATE_KEY를 고정한다). */
export function webPushSender(keys?: { publicKey: string; privateKey: string }, subject = "mailto:ops@dobedubpop.example"): PushSender {
  const k = keys ?? webpush.generateVAPIDKeys();
  return {
    publicKey: k.publicKey,
    async send(sub, payload) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload),
          { vapidDetails: { subject, publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 3600 });
        return "sent";
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        return status === 404 || status === 410 ? "gone" : "failed";
      }
    },
  };
}

/** 시험용: 보내지 않고 기록만 한다. */
export function recordingPushSender(): PushSender & { sent: { endpoint: string; payload: PushPayload }[] } {
  const sent: { endpoint: string; payload: PushPayload }[] = [];
  return { publicKey: "test-public-key", sent, async send(sub, payload) { sent.push({ endpoint: sub.endpoint, payload }); return "sent"; } };
}

/** 파티에 연결된 사용자들에게 알림을 남기고, 푸시는 Outbox로 넘긴다(같은 트랜잭션 — 롤백되면 알림도 없다). */
export async function notifyParty(tx: Tx, clock: Clock, partyId: string, n: { kind: NotificationKind; title: string; body: string; ref?: unknown }): Promise<void> {
  const users = (await tx.query("SELECT user_id FROM user_account WHERE party_id = $1 ORDER BY user_id", [partyId])).rows.map((r) => r.user_id as string);
  for (const u of users) await notifyUser(tx, clock, u, n);
}

/** 알림은 시스템이 만든다(요청자 범위와 상관없이 system 범위로 쓴다 — 실연자·팬 요청이 계기여도 마찬가지). */
export async function notifyUser(tx: Tx, clock: Clock, userId: string, n: { kind: NotificationKind; title: string; body: string; ref?: unknown }): Promise<void> {
  await withSystemScope(tx, async () => {
    const id = (await tx.query(
      "INSERT INTO notification (user_id, kind, title, body, ref, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING notification_id",
      [userId, n.kind, n.title, n.body, JSON.stringify(n.ref ?? {}), clock.now()])).rows[0].notification_id;
    await enqueue(tx, clock, "notification_push", { notificationId: Number(id) });
  });
}

/** Outbox 처리기: 알림을 그 사용자의 살아 있는 구독마다 푸시한다. 전송자가 없으면(푸시 미설정) 알림함에만 남긴다. */
export function pushOutboxHandlers(sender: PushSender | undefined): OutboxHandlers {
  return {
    async notification_push(tx, payload: { notificationId: number }, clock) {
      if (sender === undefined) return;
      const n = (await tx.query("SELECT * FROM notification WHERE notification_id = $1", [payload.notificationId])).rows[0];
      if (n === undefined) return;
      const subs = (await tx.query("SELECT subscription_id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = $1 AND revoked_at IS NULL ORDER BY subscription_id", [n.user_id])).rows;
      let any = false;
      for (const s of subs) {
        const r = await sender.send(s as PushSubscriptionRow, { title: n.title, body: n.body, kind: n.kind, notificationId: Number(n.notification_id), ref: n.ref });
        if (r === "sent") any = true;
        if (r === "gone") await tx.query("UPDATE push_subscription SET revoked_at = $2 WHERE subscription_id = $1", [s.subscription_id, clock.now()]);
      }
      if (any) await tx.query("UPDATE notification SET pushed_at = $2 WHERE notification_id = $1", [n.notification_id, clock.now()]);
    },
  };
}

export async function listNotifications(tx: Tx, userId: string) {
  return (await tx.query("SELECT * FROM notification WHERE user_id = $1 ORDER BY notification_id DESC LIMIT 100", [userId])).rows.map((r) => ({
    notificationId: Number(r.notification_id), kind: r.kind as NotificationKind, title: r.title as string, body: r.body as string, ref: r.ref as unknown,
    createdAt: iso(r.created_at)!, read: r.read_at !== null, pushed: r.pushed_at !== null,
  }));
}

export async function markRead(tx: Tx, clock: Clock, userId: string, id: number): Promise<void> {
  const r = await tx.query("UPDATE notification SET read_at = COALESCE(read_at, $3) WHERE notification_id = $1 AND user_id = $2", [id, userId, clock.now()]);
  if (r.rowCount === 0) throw notFound("notification", String(id));
}

export async function subscribePush(tx: Tx, clock: Clock, userId: string, sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }) {
  if (typeof sub.endpoint !== "string" || typeof sub.keys?.p256dh !== "string" || typeof sub.keys.auth !== "string") throw notFound("push subscription", "invalid body");
  await tx.query(
    `INSERT INTO push_subscription (user_id, endpoint, p256dh, auth, created_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, created_at = EXCLUDED.created_at, revoked_at = NULL`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, clock.now()]);
  return { subscribed: true };
}
