-- Project.Rota · 初始 schema
-- 由 schema/rota.yaml 生成，请勿手改；改动一律回到 LinkML 源文件。
-- 生成命令：pnpm gen
CREATE TABLE "term" (
	id TEXT NOT NULL,
	name TEXT NOT NULL,
	start_date DATE,
	week_count INTEGER,
	timezone TEXT,
	status VARCHAR(8) NOT NULL,
	created_at DATETIME NOT NULL,
	updated_at DATETIME,
	PRIMARY KEY (id),
	UNIQUE (name)
);
CREATE INDEX "ix_term_id" ON "term" (id);
CREATE INDEX "term_name_idx" ON "term" (name);

CREATE TABLE "person" (
	id TEXT NOT NULL,
	student_no TEXT,
	full_name TEXT NOT NULL,
	email TEXT,
	phone TEXT,
	status VARCHAR(9) NOT NULL,
	created_at DATETIME NOT NULL,
	updated_at DATETIME,
	PRIMARY KEY (id),
	UNIQUE (student_no)
);
CREATE INDEX "ix_person_id" ON "person" (id);
CREATE INDEX "person_student_no_idx" ON "person" (student_no);

CREATE TABLE "organization" (
	id TEXT NOT NULL,
	code TEXT,
	name TEXT NOT NULL,
	parent_id TEXT,
	kind VARCHAR(10) NOT NULL,
	status VARCHAR(8) NOT NULL,
	created_at DATETIME NOT NULL,
	updated_at DATETIME,
	PRIMARY KEY (id),
	UNIQUE (code),
	FOREIGN KEY(parent_id) REFERENCES "organization" (id)
);
CREATE INDEX "ix_organization_id" ON "organization" (id);
CREATE INDEX "organization_code_idx" ON "organization" (code);

CREATE TABLE "skill" (
	id TEXT NOT NULL,
	code TEXT,
	name TEXT,
	PRIMARY KEY (id)
);
CREATE INDEX "ix_skill_id" ON "skill" (id);

CREATE TABLE "admin_user" (
	id TEXT NOT NULL,
	oidc_subject TEXT,
	email TEXT,
	full_name TEXT,
	role VARCHAR(5) NOT NULL,
	enabled BOOLEAN,
	last_login_at DATETIME,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (oidc_subject)
);
CREATE INDEX "admin_user_oidc_subject_idx" ON "admin_user" (oidc_subject);
CREATE INDEX "ix_admin_user_id" ON "admin_user" (id);

CREATE TABLE "llm_provider" (
	id TEXT NOT NULL,
	name TEXT,
	kind VARCHAR(17) NOT NULL,
	base_url TEXT,
	model TEXT,
	api_key_secret TEXT,
	enabled BOOLEAN,
	params TEXT,
	updated_at DATETIME,
	PRIMARY KEY (id)
);
CREATE INDEX "ix_llm_provider_id" ON "llm_provider" (id);

CREATE TABLE "import_job" (
	id TEXT NOT NULL,
	source_kind VARCHAR(10) NOT NULL,
	file_key TEXT,
	status VARCHAR(12) NOT NULL,
	raw_text TEXT,
	parsed_json TEXT,
	error TEXT,
	created_at DATETIME NOT NULL,
	updated_at DATETIME,
	PRIMARY KEY (id)
);
CREATE INDEX "ix_import_job_id" ON "import_job" (id);

CREATE TABLE "audit_event" (
	id TEXT NOT NULL,
	actor_id TEXT,
	action TEXT,
	target_type TEXT,
	target_id TEXT,
	payload TEXT,
	actor_ip TEXT,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id)
);
CREATE INDEX "ix_audit_event_id" ON "audit_event" (id);

CREATE TABLE "class_period" (
	id TEXT NOT NULL,
	term_id TEXT NOT NULL,
	period_index INTEGER,
	label TEXT,
	start_time TEXT,
	end_time TEXT,
	PRIMARY KEY (id),
	UNIQUE (term_id, period_index),
	FOREIGN KEY(term_id) REFERENCES "term" (id)
);
CREATE INDEX "ix_class_period_id" ON "class_period" (id);
CREATE INDEX "class_period_term_id_period_index_idx" ON "class_period" (term_id, period_index);

CREATE TABLE "slot" (
	id TEXT NOT NULL,
	term_id TEXT NOT NULL,
	week_index INTEGER,
	weekday INTEGER,
	period_index INTEGER,
	starts_at DATETIME,
	ends_at DATETIME,
	PRIMARY KEY (id),
	UNIQUE (term_id, week_index, weekday, period_index),
	FOREIGN KEY(term_id) REFERENCES "term" (id)
);
CREATE INDEX "slot_term_id_week_index_weekday_period_index_idx" ON "slot" (term_id, week_index, weekday, period_index);
CREATE INDEX "ix_slot_id" ON "slot" (id);

CREATE TABLE "role" (
	id TEXT NOT NULL,
	code TEXT,
	name TEXT,
	org_id TEXT,
	description TEXT,
	PRIMARY KEY (id),
	FOREIGN KEY(org_id) REFERENCES "organization" (id)
);
CREATE INDEX "ix_role_id" ON "role" (id);

CREATE TABLE "person_skill" (
	id TEXT NOT NULL,
	person_id TEXT NOT NULL,
	skill_id TEXT,
	level INTEGER,
	PRIMARY KEY (id),
	UNIQUE (person_id, skill_id),
	FOREIGN KEY(person_id) REFERENCES "person" (id),
	FOREIGN KEY(skill_id) REFERENCES "skill" (id)
);
CREATE INDEX "ix_person_skill_id" ON "person_skill" (id);
CREATE INDEX "person_skill_person_id_skill_id_idx" ON "person_skill" (person_id, skill_id);

CREATE TABLE "course" (
	id TEXT NOT NULL,
	term_id TEXT NOT NULL,
	code TEXT,
	name TEXT,
	teacher TEXT,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(term_id) REFERENCES "term" (id)
);
CREATE INDEX "ix_course_id" ON "course" (id);

CREATE TABLE "unavailability" (
	id TEXT NOT NULL,
	person_id TEXT NOT NULL,
	starts_at DATETIME,
	ends_at DATETIME,
	kind VARCHAR(9) NOT NULL,
	status VARCHAR(8) NOT NULL,
	reason TEXT,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(person_id) REFERENCES "person" (id)
);
CREATE INDEX "ix_unavailability_id" ON "unavailability" (id);

CREATE TABLE "preference" (
	id TEXT NOT NULL,
	person_id TEXT NOT NULL,
	weekday INTEGER,
	period_from INTEGER,
	period_to INTEGER,
	polarity VARCHAR(6) NOT NULL,
	weight FLOAT,
	note TEXT,
	PRIMARY KEY (id),
	FOREIGN KEY(person_id) REFERENCES "person" (id)
);
CREATE INDEX "ix_preference_id" ON "preference" (id);

CREATE TABLE "task" (
	id TEXT NOT NULL,
	org_id TEXT,
	title TEXT NOT NULL,
	description TEXT,
	kind VARCHAR(9) NOT NULL,
	status VARCHAR(9) NOT NULL,
	window_start DATETIME,
	window_end DATETIME,
	created_at DATETIME NOT NULL,
	updated_at DATETIME,
	PRIMARY KEY (id),
	FOREIGN KEY(org_id) REFERENCES "organization" (id)
);
CREATE INDEX "ix_task_id" ON "task" (id);

CREATE TABLE "fairness_stat" (
	id TEXT NOT NULL,
	person_id TEXT NOT NULL,
	org_id TEXT,
	window_key TEXT,
	shift_count INTEGER,
	minutes INTEGER,
	carry_over FLOAT,
	last_assigned_at DATETIME,
	PRIMARY KEY (id),
	UNIQUE (person_id, org_id, window_key),
	FOREIGN KEY(person_id) REFERENCES "person" (id),
	FOREIGN KEY(org_id) REFERENCES "organization" (id)
);
CREATE INDEX "ix_fairness_stat_id" ON "fairness_stat" (id);
CREATE INDEX "fairness_stat_person_id_org_id_window_key_idx" ON "fairness_stat" (person_id, org_id, window_key);

CREATE TABLE "membership" (
	id TEXT NOT NULL,
	person_id TEXT NOT NULL,
	org_id TEXT,
	role_id TEXT,
	status VARCHAR(9) NOT NULL,
	valid_from DATE,
	valid_to DATE,
	is_primary BOOLEAN,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (person_id, org_id, role_id, valid_from),
	FOREIGN KEY(person_id) REFERENCES "person" (id),
	FOREIGN KEY(org_id) REFERENCES "organization" (id),
	FOREIGN KEY(role_id) REFERENCES "role" (id)
);
CREATE INDEX "ix_membership_id" ON "membership" (id);
CREATE INDEX "membership_person_id_org_id_role_id_valid_from_idx" ON "membership" (person_id, org_id, role_id, valid_from);

CREATE TABLE "course_meeting" (
	id TEXT NOT NULL,
	course_id TEXT,
	term_id TEXT NOT NULL,
	weekday INTEGER,
	period_from INTEGER,
	period_to INTEGER,
	pattern_kind VARCHAR(6) NOT NULL,
	week_ranges TEXT,
	location TEXT,
	PRIMARY KEY (id),
	FOREIGN KEY(course_id) REFERENCES "course" (id),
	FOREIGN KEY(term_id) REFERENCES "term" (id)
);
CREATE INDEX "ix_course_meeting_id" ON "course_meeting" (id);

CREATE TABLE "shift_pattern" (
	id TEXT NOT NULL,
	task_id TEXT,
	weekday INTEGER,
	period_from INTEGER,
	period_to INTEGER,
	pattern_kind VARCHAR(6) NOT NULL,
	week_ranges TEXT,
	required_headcount INTEGER,
	required_role_id TEXT,
	PRIMARY KEY (id),
	FOREIGN KEY(task_id) REFERENCES "task" (id),
	FOREIGN KEY(required_role_id) REFERENCES "role" (id)
);
CREATE INDEX "ix_shift_pattern_id" ON "shift_pattern" (id);

CREATE TABLE "shift" (
	id TEXT NOT NULL,
	task_id TEXT,
	starts_at DATETIME,
	ends_at DATETIME,
	required_headcount INTEGER NOT NULL,
	required_role_id TEXT,
	required_skill_id TEXT,
	location TEXT,
	status VARCHAR(9) NOT NULL,
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(task_id) REFERENCES "task" (id),
	FOREIGN KEY(required_role_id) REFERENCES "role" (id),
	FOREIGN KEY(required_skill_id) REFERENCES "skill" (id)
);
CREATE INDEX "ix_shift_id" ON "shift" (id);

CREATE TABLE "course_occurrence" (
	id TEXT NOT NULL,
	meeting_id TEXT,
	slot_id TEXT,
	status VARCHAR(9) NOT NULL,
	note TEXT,
	PRIMARY KEY (id),
	FOREIGN KEY(meeting_id) REFERENCES "course_meeting" (id),
	FOREIGN KEY(slot_id) REFERENCES "slot" (id)
);
CREATE INDEX "ix_course_occurrence_id" ON "course_occurrence" (id);

CREATE TABLE "assignment" (
	id TEXT NOT NULL,
	shift_id TEXT,
	person_id TEXT NOT NULL,
	status VARCHAR(9) NOT NULL,
	score FLOAT,
	reason TEXT,
	assigned_at DATETIME,
	assigned_by TEXT,
	PRIMARY KEY (id),
	UNIQUE (shift_id, person_id),
	FOREIGN KEY(shift_id) REFERENCES "shift" (id),
	FOREIGN KEY(person_id) REFERENCES "person" (id)
);
CREATE INDEX "ix_assignment_id" ON "assignment" (id);
CREATE INDEX "assignment_shift_id_person_id_idx" ON "assignment" (shift_id, person_id);
