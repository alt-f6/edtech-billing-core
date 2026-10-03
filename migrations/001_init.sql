-- Schema for the billing core.
--
-- Money is stored as integer kopecks in BIGINT columns: no floating point and
-- no rounding anywhere in the ledger.
--
-- The ledger is append-only, enforced by a trigger: a correction is a new
-- reversing row, never an UPDATE or DELETE, so every balance can be explained
-- row by row after the fact.

CREATE TYPE attendance_status AS ENUM ('PRESENT', 'ABSENT', 'EXCUSED');
CREATE TYPE transaction_type AS ENUM ('PAYMENT', 'LESSON_CHARGE', 'CHARGE_REVERSAL');
CREATE TYPE payment_intent_status AS ENUM ('PENDING', 'SUCCEEDED', 'CANCELED');

CREATE TABLE app_user (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  password_hash TEXT,
  is_archived   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE student (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE class_session (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_at TIMESTAMPTZ NOT NULL,
  -- Price per student for this lesson. NULL means "no price on record",
  -- which is NOT the same as free: see is_free.
  price        BIGINT CHECK (price IS NULL OR price >= 0),
  is_free      BOOLEAN NOT NULL DEFAULT FALSE,
  is_cancelled BOOLEAN NOT NULL DEFAULT FALSE
);

-- A freeze suspends billing for a student over an inclusive range of
-- calendar dates in the school's time zone.
CREATE TABLE student_freeze (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES student(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  CHECK (end_date >= start_date)
);

CREATE TABLE attendance (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_session_id UUID NOT NULL REFERENCES class_session(id) ON DELETE RESTRICT,
  student_id       UUID NOT NULL REFERENCES student(id) ON DELETE RESTRICT,
  status           attendance_status,  -- NULL = unmarked
  -- Price captured the first time the lesson was marked. Re-marking later
  -- reuses it, so a price change never silently re-prices a past lesson.
  price_at_time    BIGINT NOT NULL CHECK (price_at_time >= 0),
  UNIQUE (class_session_id, student_id)
);

CREATE TABLE ledger_transaction (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID NOT NULL REFERENCES student(id) ON DELETE RESTRICT,
  class_session_id UUID REFERENCES class_session(id) ON DELETE RESTRICT,
  amount           BIGINT NOT NULL,  -- signed kopecks: credits > 0, debits < 0
  type             transaction_type NOT NULL,
  description      TEXT NOT NULL,
  -- Derived from what caused the row (a provider payment id, or a lesson plus
  -- a per-lesson sequence number taken under the student's lock), so a
  -- retried operation collides here instead of writing a second row.
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (type = 'PAYMENT'         AND amount > 0 AND class_session_id IS NULL) OR
    (type = 'LESSON_CHARGE'   AND amount < 0 AND class_session_id IS NOT NULL) OR
    (type = 'CHARGE_REVERSAL' AND amount > 0 AND class_session_id IS NOT NULL)
  )
);
CREATE INDEX ledger_transaction_student_idx ON ledger_transaction (student_id);
CREATE INDEX ledger_transaction_lesson_idx ON ledger_transaction (student_id, class_session_id);

CREATE FUNCTION ledger_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_transaction is append-only: write a reversing row instead of %', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_append_only
  BEFORE UPDATE OR DELETE ON ledger_transaction
  FOR EACH ROW EXECUTE FUNCTION ledger_is_append_only();

CREATE TABLE payment_intent (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID NOT NULL REFERENCES student(id) ON DELETE RESTRICT,
  provider_id TEXT NOT NULL UNIQUE,
  amount      BIGINT NOT NULL CHECK (amount > 0),
  status      payment_intent_status NOT NULL DEFAULT 'PENDING',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fixed-window rate limiter, updated with a single atomic upsert.
-- Keys hold keyed hashes (HMAC) of client IPs, never raw addresses.
CREATE TABLE rate_limit_bucket (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX rate_limit_bucket_reset_idx ON rate_limit_bucket (reset_at);

-- Failed-login counters. ip_hash is an HMAC of the IP, not the raw address.
CREATE TABLE login_attempt (
  ip_hash       TEXT NOT NULL,
  email         TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_attempt  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (ip_hash, email)
);
CREATE INDEX login_attempt_email_idx ON login_attempt (email, last_attempt);
