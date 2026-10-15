-- 실연자 앱(다음 작업 11): 본인 인증, 이의제기, 알림·푸시. 이 표들은 사용자 본인 것만 보인다(rc.user_id).

CREATE FUNCTION rc_user() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('rc.user_id', true), '') $$;

-- 본인 인증: 실연 동의 서명은 본인 인증을 마친 계정만 한다(휴대폰·PASS 등 인증 수단은 공급자에 맡긴다).
ALTER TABLE user_account ADD COLUMN identity_verified_at TIMESTAMPTZ NULL CHECK (identity_verified_at = date_trunc('milliseconds', identity_verified_at));
ALTER TABLE user_account ADD COLUMN identity_method TEXT NULL;
GRANT UPDATE (identity_verified_at, identity_method) ON user_account TO rc_app;

CREATE TABLE identity_challenge (
  challenge_id BIGSERIAL PRIMARY KEY,
  user_id      mdrl_id NOT NULL REFERENCES user_account,
  method       TEXT NOT NULL,
  code_sha256  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  expires_at   TIMESTAMPTZ NOT NULL CHECK (expires_at = date_trunc('milliseconds', expires_at)),
  attempts     INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  verified_at  TIMESTAMPTZ NULL CHECK (verified_at = date_trunc('milliseconds', verified_at))
);
ALTER TABLE identity_challenge ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_challenge ON identity_challenge USING (rc_sees_all() OR user_id = rc_user()) WITH CHECK (rc_sees_all() OR user_id = rc_user());
GRANT SELECT, INSERT ON identity_challenge TO rc_app;
GRANT UPDATE (attempts, verified_at) ON identity_challenge TO rc_app;
GRANT USAGE ON SEQUENCE identity_challenge_challenge_id_seq TO rc_app;

-- 이의제기: 실연자가 자기와 관련된 권리 주장에 분쟁을 연다. 누가 열었는지 남긴다.
ALTER TABLE dispute ADD COLUMN opened_by mdrl_id NULL REFERENCES user_account;

-- 앱 알림함과 웹 푸시 구독.
CREATE TABLE notification (
  notification_id BIGSERIAL PRIMARY KEY,
  user_id         mdrl_id NOT NULL REFERENCES user_account,
  kind            TEXT NOT NULL CHECK (kind IN ('USAGE','CONSENT','PAYOUT','OBJECTION','IDENTITY')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  ref             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  read_at         TIMESTAMPTZ NULL CHECK (read_at = date_trunc('milliseconds', read_at)),
  pushed_at       TIMESTAMPTZ NULL CHECK (pushed_at = date_trunc('milliseconds', pushed_at))
);
CREATE INDEX notification_user ON notification (user_id, notification_id DESC);
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_read ON notification FOR SELECT USING (rc_sees_all() OR user_id = rc_user());
CREATE POLICY system_write ON notification FOR INSERT WITH CHECK (rc_sees_all());
CREATE POLICY own_update ON notification FOR UPDATE USING (rc_sees_all() OR user_id = rc_user()) WITH CHECK (rc_sees_all() OR user_id = rc_user());
GRANT SELECT, INSERT ON notification TO rc_app;
GRANT UPDATE (read_at, pushed_at) ON notification TO rc_app;
GRANT USAGE ON SEQUENCE notification_notification_id_seq TO rc_app;

CREATE TABLE push_subscription (
  subscription_id BIGSERIAL PRIMARY KEY,
  user_id         mdrl_id NOT NULL REFERENCES user_account,
  endpoint        TEXT NOT NULL UNIQUE CHECK (endpoint ~ '^https://'),
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  revoked_at      TIMESTAMPTZ NULL CHECK (revoked_at = date_trunc('milliseconds', revoked_at))
);
ALTER TABLE push_subscription ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_subscription ON push_subscription USING (rc_sees_all() OR user_id = rc_user()) WITH CHECK (rc_sees_all() OR user_id = rc_user());
GRANT SELECT, INSERT ON push_subscription TO rc_app;
GRANT UPDATE (revoked_at, p256dh, auth, user_id, created_at) ON push_subscription TO rc_app;
GRANT USAGE ON SEQUENCE push_subscription_subscription_id_seq TO rc_app;

-- 커밋 시점에 도는 무결성 검사(지연 제약 트리거)는 그때의 요청 범위가 아니라 전체 행을 봐야 한다. 실연자 앱의 이의제기처럼
-- 요청 중에 잠시 system 범위로 쓴 행도, 커밋 때 요청자 범위의 RLS에 가려 "후속 버전 없음"으로 잘못 거부되지 않게
-- 검사 함수를 소유자 권한(SECURITY DEFINER, 테이블 소유자는 RLS를 우회)으로 돌린다. 검사 함수는 행을 바꾸지 않는다.
ALTER FUNCTION rc_require_successor() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION rc_entry_balanced() SECURITY DEFINER SET search_path = public;
