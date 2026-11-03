-- Transactional guards close the gap between preview and concurrent writes.
CREATE TRIGGER assignment_guard BEFORE INSERT ON assignment
WHEN NEW.status IN ('proposed','confirmed','completed')
BEGIN
  SELECT RAISE(ABORT, 'shift_closed') WHERE EXISTS (
    SELECT 1 FROM shift s JOIN task t ON t.id=s.task_id WHERE s.id=NEW.shift_id
    AND (s.status='cancelled' OR t.status IN ('cancelled','done'))
  );
  SELECT RAISE(ABORT, 'shift_full') WHERE (
    SELECT count(*) FROM assignment WHERE shift_id=NEW.shift_id AND status != 'declined'
  ) >= (SELECT required_headcount FROM shift WHERE id=NEW.shift_id);
  SELECT RAISE(ABORT, 'person_overlap') WHERE EXISTS (
    SELECT 1 FROM assignment a JOIN shift old ON old.id=a.shift_id
    JOIN shift target ON target.id=NEW.shift_id
    WHERE a.person_id=NEW.person_id AND a.status IN ('proposed','confirmed','completed')
      AND old.status != 'cancelled'
      AND julianday(old.starts_at)<julianday(target.ends_at)
      AND julianday(old.ends_at)>julianday(target.starts_at)
  );
END;
