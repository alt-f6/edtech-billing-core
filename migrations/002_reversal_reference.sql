-- Every CHARGE_REVERSAL names the LESSON_CHARGE it reverses, and a charge can
-- be reversed at most once. This moves "never refund the same charge twice"
-- from the application into the schema: a code path that forgets a check, or
-- acts on a stale read, gets an error at INSERT instead of a wrong balance.
--
-- Charges and payments leave reverses_id NULL. NULLs are distinct in a UNIQUE
-- constraint, so they never collide with each other. A re-mark appends a new
-- charge with a new id, which can in turn be reversed once.
--
-- Written for a fresh schema: on a ledger that already holds reversals, add
-- the CHECK as NOT VALID, backfill reverses_id, then VALIDATE it.

ALTER TABLE ledger_transaction
  ADD COLUMN reverses_id UUID REFERENCES ledger_transaction(id) ON DELETE RESTRICT;

ALTER TABLE ledger_transaction
  ADD CONSTRAINT ledger_charge_reversed_once UNIQUE (reverses_id);

ALTER TABLE ledger_transaction
  ADD CONSTRAINT ledger_reversal_names_charge
  CHECK ((type = 'CHARGE_REVERSAL') = (reverses_id IS NOT NULL));

-- A reversal must undo exactly its charge: same student, same lesson, the
-- same amount with the opposite sign. Ledger rows are never updated, so
-- checking once at insert is enough.
CREATE FUNCTION ledger_reversal_matches_charge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  charge ledger_transaction%ROWTYPE;
BEGIN
  IF NEW.reverses_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO charge FROM ledger_transaction WHERE id = NEW.reverses_id;
  IF NOT FOUND
     OR charge.type <> 'LESSON_CHARGE'
     OR charge.student_id <> NEW.student_id
     OR charge.class_session_id IS DISTINCT FROM NEW.class_session_id
     OR charge.amount <> -NEW.amount THEN
    RAISE EXCEPTION 'reversal % does not match charge %', NEW.idempotency_key, NEW.reverses_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_reversal_matches_charge
  BEFORE INSERT ON ledger_transaction
  FOR EACH ROW EXECUTE FUNCTION ledger_reversal_matches_charge();
