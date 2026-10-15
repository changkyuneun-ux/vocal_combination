// 실연자 앱 서비스 워커: 웹 푸시를 받아 알림으로 띄우고, 알림을 누르면 앱의 알림 탭을 연다.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let data = { title: "dobedubpop", body: "새 알림이 있습니다", kind: "", notificationId: 0 };
  try { data = { ...data, ...event.data.json() }; } catch { /* 본문이 JSON이 아니면 기본 문구 */ }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, tag: `n-${data.notificationId}`, data, icon: "/icon.svg" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window" }).then((list) => {
    const open = list.find((c) => "focus" in c);
    return open ? open.focus().then((c) => c.navigate("/?tab=notifications")) : self.clients.openWindow("/?tab=notifications");
  }));
});
