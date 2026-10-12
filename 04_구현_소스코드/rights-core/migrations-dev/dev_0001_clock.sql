-- 개발 DB 전용(운영 npm run migrate는 적용하지 않는다 — 통합 설계 12.2-6).
CREATE TABLE dev_clock (
  id          BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  base_at     TIMESTAMPTZ NOT NULL CHECK (date_trunc('milliseconds', base_at) = base_at),
  set_real_at TIMESTAMPTZ NOT NULL
);
INSERT INTO dev_clock (base_at, set_real_at) VALUES ('2026-01-01T00:00:00.000Z', now());
GRANT SELECT, UPDATE ON dev_clock TO rc_app;
