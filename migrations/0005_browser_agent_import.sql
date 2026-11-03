-- Browser Agent import: only business persistence and transactional guards run here.
ALTER TABLE person ADD COLUMN class_name TEXT;
ALTER TABLE person ADD COLUMN major TEXT;
CREATE TABLE timetable_profile (id TEXT PRIMARY KEY, term_id TEXT NOT NULL REFERENCES term(id), name TEXT NOT NULL, periods TEXT NOT NULL);
CREATE TABLE timetable_entry (id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES person(id), term_id TEXT NOT NULL REFERENCES term(id), profile_id TEXT NOT NULL REFERENCES timetable_profile(id), name TEXT NOT NULL, teacher TEXT, location TEXT, weekday INTEGER NOT NULL, period_from INTEGER NOT NULL, period_to INTEGER NOT NULL, weeks TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE timetable_event (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES timetable_entry(id), person_id TEXT NOT NULL REFERENCES person(id), term_id TEXT NOT NULL REFERENCES term(id), week_index INTEGER NOT NULL, weekday INTEGER NOT NULL, period_index INTEGER NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL);
CREATE INDEX timetable_event_person_time ON timetable_event(person_id,starts_at,ends_at);
CREATE TABLE agent_batch (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, status TEXT NOT NULL, digest TEXT, summary TEXT, created_at TEXT NOT NULL, applied_at TEXT);
CREATE TABLE agent_batch_item (batch_id TEXT NOT NULL REFERENCES agent_batch(id), entity TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL, PRIMARY KEY(batch_id,entity,entity_id));
CREATE TABLE agent_lock (resource TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES agent_batch(id), expires_at INTEGER NOT NULL);
CREATE TABLE agent_commit_context (id INTEGER PRIMARY KEY CHECK(id=1), batch_id TEXT NOT NULL);
CREATE TABLE agent_assertion (id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE agent_revision (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
INSERT INTO agent_revision VALUES(1,0);
CREATE TRIGGER agent_lock_organization_insert BEFORE INSERT ON "organization" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('organization:' || NEW.id,'organization:' || NEW.parent_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_organization_insert AFTER INSERT ON "organization" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_organization_update BEFORE UPDATE ON "organization" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('organization:' || NEW.id,'organization:' || NEW.parent_id,'organization:' || OLD.id,'organization:' || OLD.parent_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_organization_update AFTER UPDATE ON "organization" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_organization_delete BEFORE DELETE ON "organization" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('organization:' || OLD.id,'organization:' || OLD.parent_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_organization_delete AFTER DELETE ON "organization" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_person_insert BEFORE INSERT ON "person" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('person:' || NEW.id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_person_insert AFTER INSERT ON "person" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_person_update BEFORE UPDATE ON "person" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('person:' || NEW.id,'person:' || OLD.id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_person_update AFTER UPDATE ON "person" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_person_delete BEFORE DELETE ON "person" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('person:' || OLD.id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_person_delete AFTER DELETE ON "person" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_term_insert BEFORE INSERT ON "term" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('term:' || NEW.id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_term_insert AFTER INSERT ON "term" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_term_update BEFORE UPDATE ON "term" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('term:' || NEW.id,'term:' || OLD.id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_term_update AFTER UPDATE ON "term" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_term_delete BEFORE DELETE ON "term" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('term:' || OLD.id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_term_delete AFTER DELETE ON "term" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_class_period_insert BEFORE INSERT ON "class_period" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('class_period:' || NEW.id,'term:' || NEW.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_class_period_insert AFTER INSERT ON "class_period" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_class_period_update BEFORE UPDATE ON "class_period" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('class_period:' || NEW.id,'term:' || NEW.term_id,'class_period:' || OLD.id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_class_period_update AFTER UPDATE ON "class_period" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_class_period_delete BEFORE DELETE ON "class_period" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('class_period:' || OLD.id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_class_period_delete AFTER DELETE ON "class_period" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_role_insert BEFORE INSERT ON "role" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('role:' || NEW.id,'organization:' || NEW.org_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_role_insert AFTER INSERT ON "role" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_role_update BEFORE UPDATE ON "role" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('role:' || NEW.id,'organization:' || NEW.org_id,'role:' || OLD.id,'organization:' || OLD.org_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_role_update AFTER UPDATE ON "role" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_role_delete BEFORE DELETE ON "role" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('role:' || OLD.id,'organization:' || OLD.org_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_role_delete AFTER DELETE ON "role" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_membership_insert BEFORE INSERT ON "membership" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('membership:' || NEW.id,'person:' || NEW.person_id,'organization:' || NEW.org_id,'role:' || NEW.role_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_membership_insert AFTER INSERT ON "membership" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_membership_update BEFORE UPDATE ON "membership" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('membership:' || NEW.id,'person:' || NEW.person_id,'organization:' || NEW.org_id,'role:' || NEW.role_id,'membership:' || OLD.id,'person:' || OLD.person_id,'organization:' || OLD.org_id,'role:' || OLD.role_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_membership_update AFTER UPDATE ON "membership" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_membership_delete BEFORE DELETE ON "membership" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('membership:' || OLD.id,'person:' || OLD.person_id,'organization:' || OLD.org_id,'role:' || OLD.role_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_membership_delete AFTER DELETE ON "membership" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_timetable_profile_insert BEFORE INSERT ON "timetable_profile" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('timetable_profile:' || NEW.id,'term:' || NEW.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_timetable_profile_insert AFTER INSERT ON "timetable_profile" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_timetable_profile_update BEFORE UPDATE ON "timetable_profile" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('timetable_profile:' || NEW.id,'term:' || NEW.term_id,'timetable_profile:' || OLD.id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_timetable_profile_update AFTER UPDATE ON "timetable_profile" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_timetable_profile_delete BEFORE DELETE ON "timetable_profile" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('timetable_profile:' || OLD.id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_timetable_profile_delete AFTER DELETE ON "timetable_profile" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_timetable_entry_insert BEFORE INSERT ON "timetable_entry" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('timetable_entry:' || NEW.id,'person:' || NEW.person_id,'term:' || NEW.term_id,'timetable_profile:' || NEW.profile_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_timetable_entry_insert AFTER INSERT ON "timetable_entry" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_timetable_entry_update BEFORE UPDATE ON "timetable_entry" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('timetable_entry:' || NEW.id,'person:' || NEW.person_id,'term:' || NEW.term_id,'timetable_profile:' || NEW.profile_id,'timetable_entry:' || OLD.id,'person:' || OLD.person_id,'term:' || OLD.term_id,'timetable_profile:' || OLD.profile_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_timetable_entry_update AFTER UPDATE ON "timetable_entry" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_timetable_entry_delete BEFORE DELETE ON "timetable_entry" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('timetable_entry:' || OLD.id,'person:' || OLD.person_id,'term:' || OLD.term_id,'timetable_profile:' || OLD.profile_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_timetable_entry_delete AFTER DELETE ON "timetable_entry" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_timetable_event_insert BEFORE INSERT ON "timetable_event" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('timetable_event:' || NEW.id,'timetable_entry:' || NEW.entry_id,'person:' || NEW.person_id,'term:' || NEW.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_timetable_event_insert AFTER INSERT ON "timetable_event" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_timetable_event_update BEFORE UPDATE ON "timetable_event" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('timetable_event:' || NEW.id,'timetable_entry:' || NEW.entry_id,'person:' || NEW.person_id,'term:' || NEW.term_id,'timetable_event:' || OLD.id,'timetable_entry:' || OLD.entry_id,'person:' || OLD.person_id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_timetable_event_update AFTER UPDATE ON "timetable_event" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_timetable_event_delete BEFORE DELETE ON "timetable_event" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('timetable_event:' || OLD.id,'timetable_entry:' || OLD.entry_id,'person:' || OLD.person_id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_timetable_event_delete AFTER DELETE ON "timetable_event" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_course_insert BEFORE INSERT ON "course" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('course:' || NEW.id,'term:' || NEW.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_course_insert AFTER INSERT ON "course" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_course_update BEFORE UPDATE ON "course" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('course:' || NEW.id,'term:' || NEW.term_id,'course:' || OLD.id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_course_update AFTER UPDATE ON "course" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_course_delete BEFORE DELETE ON "course" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('course:' || OLD.id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_course_delete AFTER DELETE ON "course" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_course_meeting_insert BEFORE INSERT ON "course_meeting" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('course_meeting:' || NEW.id,'course:' || NEW.course_id,'term:' || NEW.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_course_meeting_insert AFTER INSERT ON "course_meeting" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_course_meeting_update BEFORE UPDATE ON "course_meeting" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('course_meeting:' || NEW.id,'course:' || NEW.course_id,'term:' || NEW.term_id,'course_meeting:' || OLD.id,'course:' || OLD.course_id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_course_meeting_update AFTER UPDATE ON "course_meeting" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_course_meeting_delete BEFORE DELETE ON "course_meeting" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('course_meeting:' || OLD.id,'course:' || OLD.course_id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_course_meeting_delete AFTER DELETE ON "course_meeting" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_enrollment_insert BEFORE INSERT ON "enrollment" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('enrollment:' || NEW.id,'person:' || NEW.person_id,'course:' || NEW.course_id,'term:' || NEW.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_enrollment_insert AFTER INSERT ON "enrollment" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_enrollment_update BEFORE UPDATE ON "enrollment" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('enrollment:' || NEW.id,'person:' || NEW.person_id,'course:' || NEW.course_id,'term:' || NEW.term_id,'enrollment:' || OLD.id,'person:' || OLD.person_id,'course:' || OLD.course_id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_enrollment_update AFTER UPDATE ON "enrollment" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_enrollment_delete BEFORE DELETE ON "enrollment" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('enrollment:' || OLD.id,'person:' || OLD.person_id,'course:' || OLD.course_id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_enrollment_delete AFTER DELETE ON "enrollment" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_unavailability_insert BEFORE INSERT ON "unavailability" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('unavailability:' || NEW.id,'person:' || NEW.person_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_unavailability_insert AFTER INSERT ON "unavailability" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_unavailability_update BEFORE UPDATE ON "unavailability" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('unavailability:' || NEW.id,'person:' || NEW.person_id,'unavailability:' || OLD.id,'person:' || OLD.person_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_unavailability_update AFTER UPDATE ON "unavailability" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_unavailability_delete BEFORE DELETE ON "unavailability" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('unavailability:' || OLD.id,'person:' || OLD.person_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_unavailability_delete AFTER DELETE ON "unavailability" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_task_insert BEFORE INSERT ON "task" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('task:' || NEW.id,'organization:' || NEW.org_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_task_insert AFTER INSERT ON "task" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_task_update BEFORE UPDATE ON "task" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('task:' || NEW.id,'organization:' || NEW.org_id,'task:' || OLD.id,'organization:' || OLD.org_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_task_update AFTER UPDATE ON "task" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_task_delete BEFORE DELETE ON "task" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('task:' || OLD.id,'organization:' || OLD.org_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_task_delete AFTER DELETE ON "task" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_shift_insert BEFORE INSERT ON "shift" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('shift:' || NEW.id,'task:' || NEW.task_id,'role:' || NEW.required_role_id,'skill:' || NEW.required_skill_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_shift_insert AFTER INSERT ON "shift" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_shift_update BEFORE UPDATE ON "shift" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('shift:' || NEW.id,'task:' || NEW.task_id,'role:' || NEW.required_role_id,'skill:' || NEW.required_skill_id,'shift:' || OLD.id,'task:' || OLD.task_id,'role:' || OLD.required_role_id,'skill:' || OLD.required_skill_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_shift_update AFTER UPDATE ON "shift" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_shift_delete BEFORE DELETE ON "shift" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('shift:' || OLD.id,'task:' || OLD.task_id,'role:' || OLD.required_role_id,'skill:' || OLD.required_skill_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_shift_delete AFTER DELETE ON "shift" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_assignment_insert BEFORE INSERT ON "assignment" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('assignment:' || NEW.id,'person:' || NEW.person_id,'shift:' || NEW.shift_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_assignment_insert AFTER INSERT ON "assignment" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_assignment_update BEFORE UPDATE ON "assignment" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('assignment:' || NEW.id,'person:' || NEW.person_id,'shift:' || NEW.shift_id,'assignment:' || OLD.id,'person:' || OLD.person_id,'shift:' || OLD.shift_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_assignment_update AFTER UPDATE ON "assignment" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_assignment_delete BEFORE DELETE ON "assignment" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('assignment:' || OLD.id,'person:' || OLD.person_id,'shift:' || OLD.shift_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_assignment_delete AFTER DELETE ON "assignment" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_slot_insert BEFORE INSERT ON "slot" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('slot:' || NEW.id,'term:' || NEW.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_slot_insert AFTER INSERT ON "slot" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_slot_update BEFORE UPDATE ON "slot" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('slot:' || NEW.id,'term:' || NEW.term_id,'slot:' || OLD.id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_slot_update AFTER UPDATE ON "slot" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_slot_delete BEFORE DELETE ON "slot" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('slot:' || OLD.id,'term:' || OLD.term_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_slot_delete AFTER DELETE ON "slot" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_course_occurrence_insert BEFORE INSERT ON "course_occurrence" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('course_occurrence:' || NEW.id,'course_meeting:' || NEW.meeting_id,'slot:' || NEW.slot_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_course_occurrence_insert AFTER INSERT ON "course_occurrence" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_course_occurrence_update BEFORE UPDATE ON "course_occurrence" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('course_occurrence:' || NEW.id,'course_meeting:' || NEW.meeting_id,'slot:' || NEW.slot_id,'course_occurrence:' || OLD.id,'course_meeting:' || OLD.meeting_id,'slot:' || OLD.slot_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_course_occurrence_update AFTER UPDATE ON "course_occurrence" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_course_occurrence_delete BEFORE DELETE ON "course_occurrence" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('course_occurrence:' || OLD.id,'course_meeting:' || OLD.meeting_id,'slot:' || OLD.slot_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_course_occurrence_delete AFTER DELETE ON "course_occurrence" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_person_skill_insert BEFORE INSERT ON "person_skill" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('person_skill:' || NEW.id,'person:' || NEW.person_id,'skill:' || NEW.skill_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_person_skill_insert AFTER INSERT ON "person_skill" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_person_skill_update BEFORE UPDATE ON "person_skill" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('person_skill:' || NEW.id,'person:' || NEW.person_id,'skill:' || NEW.skill_id,'person_skill:' || OLD.id,'person:' || OLD.person_id,'skill:' || OLD.skill_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_person_skill_update AFTER UPDATE ON "person_skill" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_person_skill_delete BEFORE DELETE ON "person_skill" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('person_skill:' || OLD.id,'person:' || OLD.person_id,'skill:' || OLD.skill_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_person_skill_delete AFTER DELETE ON "person_skill" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_preference_insert BEFORE INSERT ON "preference" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('preference:' || NEW.id,'person:' || NEW.person_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_preference_insert AFTER INSERT ON "preference" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_preference_update BEFORE UPDATE ON "preference" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('preference:' || NEW.id,'person:' || NEW.person_id,'preference:' || OLD.id,'person:' || OLD.person_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_preference_update AFTER UPDATE ON "preference" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_preference_delete BEFORE DELETE ON "preference" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('preference:' || OLD.id,'person:' || OLD.person_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_preference_delete AFTER DELETE ON "preference" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_shift_pattern_insert BEFORE INSERT ON "shift_pattern" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('shift_pattern:' || NEW.id,'task:' || NEW.task_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_shift_pattern_insert AFTER INSERT ON "shift_pattern" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_shift_pattern_update BEFORE UPDATE ON "shift_pattern" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('shift_pattern:' || NEW.id,'task:' || NEW.task_id,'shift_pattern:' || OLD.id,'task:' || OLD.task_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_shift_pattern_update AFTER UPDATE ON "shift_pattern" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_shift_pattern_delete BEFORE DELETE ON "shift_pattern" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('shift_pattern:' || OLD.id,'task:' || OLD.task_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_shift_pattern_delete AFTER DELETE ON "shift_pattern" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_fairness_stat_insert BEFORE INSERT ON "fairness_stat" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('fairness_stat:' || NEW.id,'person:' || NEW.person_id,'organization:' || NEW.org_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_fairness_stat_insert AFTER INSERT ON "fairness_stat" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_fairness_stat_update BEFORE UPDATE ON "fairness_stat" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('fairness_stat:' || NEW.id,'person:' || NEW.person_id,'organization:' || NEW.org_id,'fairness_stat:' || OLD.id,'person:' || OLD.person_id,'organization:' || OLD.org_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_fairness_stat_update AFTER UPDATE ON "fairness_stat" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_fairness_stat_delete BEFORE DELETE ON "fairness_stat" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('fairness_stat:' || OLD.id,'person:' || OLD.person_id,'organization:' || OLD.org_id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_fairness_stat_delete AFTER DELETE ON "fairness_stat" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_skill_insert BEFORE INSERT ON "skill" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('skill:' || NEW.id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_skill_insert AFTER INSERT ON "skill" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_skill_update BEFORE UPDATE ON "skill" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('skill:' || NEW.id,'skill:' || OLD.id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_skill_update AFTER UPDATE ON "skill" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER agent_lock_skill_delete BEFORE DELETE ON "skill" BEGIN
 SELECT RAISE(ABORT,'agent_locked') WHERE EXISTS (SELECT 1 FROM agent_lock l WHERE l.resource IN ('skill:' || OLD.id) AND l.expires_at > unixepoch() AND NOT EXISTS (SELECT 1 FROM agent_commit_context c WHERE c.id=1 AND c.batch_id=l.batch_id));
END;
CREATE TRIGGER agent_revision_skill_delete AFTER DELETE ON "skill" BEGIN UPDATE agent_revision SET version=version+1 WHERE id=1; END;
