-- Soft delete: deleting a project sets deleted_at. Rows stay (and their tasks stay)
-- until a purge hard-deletes them, which fires the ON DELETE CASCADE below.
CREATE TABLE projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(200) NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

-- Priority is intentionally not a column: it is derived from due_date at read time
-- (see priority.ts), so storing it would create a value that goes stale.
CREATE TABLE tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'todo'
              CHECK (status IN ('todo', 'in_progress', 'done')),
  due_date    DATE,
  code        TEXT CHECK (char_length(code) <= 5000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Postgres does not index foreign key columns automatically.
CREATE INDEX idx_tasks_project_id ON tasks (project_id);
CREATE INDEX idx_tasks_due_date ON tasks (due_date);
-- Makes the purge query cheap: only soft-deleted rows are indexed.
CREATE INDEX idx_projects_deleted_at ON projects (deleted_at) WHERE deleted_at IS NOT NULL;
