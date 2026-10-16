-- 인증·세션(MVP 진행계획 M3, 결정 MD3). 코어가 세션을 발급하고 서브도메인(채널)마다 따로 쿠키를 둔다.
-- 운영: 비밀번호 + TOTP(필수), 권리자: 비밀번호(+ TOTP 선택), 실연자: 본인 인증 공급자의 일회용 코드. 외부 신원 공급자(OIDC)는 공급자 자리만 둔다.
-- 비밀번호는 scrypt 해시, TOTP 비밀은 암호화해 둔다. 세션 토큰·초대 토큰은 해시만 남긴다. 이 표들은 인증 서비스가 시스템 범위에서만 읽고 쓴다.

CREATE TABLE user_credential (
  user_id          mdrl_id PRIMARY KEY REFERENCES user_account,
  password_hash    TEXT NULL,
  password_set_at  TIMESTAMPTZ NULL CHECK (password_set_at = date_trunc('milliseconds', password_set_at)),
  -- TOTP: 비밀을 만들면(등록 대기) totp_secret만 차고, 첫 코드를 맞히면 totp_enabled_at이 찬다.
  totp_secret      TEXT NULL,
  totp_enabled_at  TIMESTAMPTZ NULL CHECK (totp_enabled_at = date_trunc('milliseconds', totp_enabled_at)),
  failed_count     INT NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until     TIMESTAMPTZ NULL,
  CHECK (totp_enabled_at IS NULL OR totp_secret IS NOT NULL)
);

CREATE TABLE user_session (
  token_sha256  TEXT PRIMARY KEY CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  user_id       mdrl_id NOT NULL REFERENCES user_account,
  channel       TEXT NOT NULL CHECK (channel IN ('ops','portal','performer','fan','partner')),
  -- PASSWORD | PASSWORD_TOTP | OTP(본인 인증 코드) | DEV(데모 환경의 페르소나 빠른 로그인)
  method        TEXT NOT NULL CHECK (method IN ('PASSWORD','PASSWORD_TOTP','OTP','DEV')),
  created_at    TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ NULL,
  ip            TEXT NULL,
  user_agent    TEXT NULL
);
CREATE INDEX user_session_user ON user_session (user_id) WHERE revoked_at IS NULL;

-- 초대: 운영이 계정을 만들면 일회용 초대 토큰으로 비밀번호를 정하게 한다(운영은 이메일로 보낸다. 데모는 화면에 보여 준다).
CREATE TABLE user_invitation (
  token_sha256  TEXT PRIMARY KEY CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  user_id       mdrl_id NOT NULL REFERENCES user_account,
  created_by    mdrl_id NOT NULL REFERENCES user_account,
  created_at    TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ NULL
);

ALTER TABLE user_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invitation ENABLE ROW LEVEL SECURITY;
CREATE POLICY credential_system ON user_credential USING (current_setting('rc.scope', true) = 'system') WITH CHECK (current_setting('rc.scope', true) = 'system');
CREATE POLICY session_system ON user_session USING (current_setting('rc.scope', true) = 'system') WITH CHECK (current_setting('rc.scope', true) = 'system');
CREATE POLICY invitation_system ON user_invitation USING (current_setting('rc.scope', true) = 'system') WITH CHECK (current_setting('rc.scope', true) = 'system');
GRANT SELECT, INSERT, UPDATE ON user_credential, user_session, user_invitation TO rc_app;

-- 계정 상태: 운영이 잠글 수 있다(퇴사·유출). 잠긴 계정은 로그인과 기존 세션이 모두 막힌다.
ALTER TABLE user_account ADD COLUMN disabled_at TIMESTAMPTZ NULL;
GRANT UPDATE (disabled_at) ON user_account TO rc_app;
