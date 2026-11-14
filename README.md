# Week 07: Polyglot Persistence (Projects and Tasks)

By: Eric Cashman
- AD372
 
The same Projects and Tasks domain modeled twice, once relationally in PostgreSQL and once as documents in MongoDB, behind one Node.js/TypeScript API with CRUD for both engines.

- `ai-draft/` is the unedited first draft the AI produced. It is kept as the "before".
- `app/` is the working version with my corrections (see [Corrections to the AI draft](#corrections-to-the-ai-draft)).
- `audit-notes.md` is my audit of the draft against the course checklist.
- Pull request with the before-and-after diff: TODO: paste PR link

## Domain description

A project has a name and instructions. A project has many tasks. A task has a title, a status (`todo`, `in_progress`, `done`), an optional due date, and an optional `code` text snippet.

Three rules shape the design:

1. **Priority is derived, not stored.** Tasks near their due date matter most. The API computes `high`, `medium`, or `low` from the due date on every read (overdue or within 3 days is high, within 7 days is medium, otherwise low). Storing it would create a value that goes stale as days pass.
2. **Deleting a project is a soft delete.** The project is marked deleted and hidden, and can be restored. After a retention period (default 30 days) it is purged for real.
3. **Reading a project means reading its tasks.** That access pattern drives the MongoDB design (embed tasks) and is why SQL needs a join.

## Schemas

### SQL (PostgreSQL), 3NF

```mermaid
erDiagram
  projects ||--o{ tasks : has
  projects {
    uuid id PK
    varchar name
    text instructions
    timestamptz created_at
    timestamptz updated_at
    timestamptz deleted_at
  }
  tasks {
    uuid id PK
    uuid project_id FK
    varchar title
    varchar status
    date due_date
    text code
    timestamptz created_at
    timestamptz updated_at
  }
```

```sql
CREATE TABLE projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(200) NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

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

CREATE INDEX idx_tasks_project_id ON tasks (project_id);
CREATE INDEX idx_tasks_due_date ON tasks (due_date);
CREATE INDEX idx_projects_deleted_at ON projects (deleted_at) WHERE deleted_at IS NOT NULL;
```

- The foreign key has `ON DELETE CASCADE`, so a purge removes a project's tasks. A soft delete does not fire it, because no row is deleted yet.
- Postgres does not index foreign key columns automatically, so `idx_tasks_project_id` is explicit.
- `due_date` is indexed for "what is due soon across all projects".
- Every query is parameterized (`$1`, `$2`, ...); no user input is concatenated into SQL.

### NoSQL (MongoDB), embedded document

One `projects` collection. Tasks are embedded, so one `findOne` returns a project with all of its tasks and no joins or second query are needed.

```json
{
  "_id": "ObjectId('665f1c2e9b1e8a0012a4c001')",
  "name": "Website redesign",
  "instructions": "Refresh the marketing site",
  "createdAt": "2026-11-12T20:00:00.000Z",
  "updatedAt": "2026-11-12T20:00:00.000Z",
  "deletedAt": null,
  "tasks": [
    {
      "_id": "ObjectId('665f1c2e9b1e8a0012a4c002')",
      "title": "Draft new homepage copy",
      "status": "todo",
      "dueDate": "2026-11-20T00:00:00.000Z",
      "code": "const headline = 'Hello';",
      "createdAt": "2026-11-12T20:00:00.000Z",
      "updatedAt": "2026-11-12T20:00:00.000Z"
    }
  ]
}
```

- Each embedded task has its own `_id` so it can be updated in place (`tasks.$.status`) or removed (`$pull`). Single-document writes are atomic.
- Indexes: a multikey index on `tasks.dueDate`, and a TTL index on `deletedAt` that lets MongoDB remove a soft-deleted project by itself once the retention period passes.
- Trade-off: "all tasks due soon across every project" is a natural SQL query but needs array handling in MongoDB.

See also [`app/mongo-schema.md`](app/mongo-schema.md).

## Prerequisites and setup

You need Node.js 20 or newer, Git, and Docker Desktop (running).

```bash
git clone https://github.com/Eric-Cashman/week05-database-crud.git
cd week05-database-crud/app
npm install
docker compose up -d
```

`docker compose up -d` starts PostgreSQL 16 and MongoDB 7. The SQL schema (`schema.sql`) loads automatically the first time the Postgres container is created. To start over from a clean database (for example after the schema changes), run `docker compose down -v` and then `docker compose up -d`.

The compose file publishes Postgres on host port **5433**, not 5432. A Postgres installed directly on my Windows machine already used 5432, and the app silently talked to it and failed with "password authentication failed for user app". Point the app at the container with `DATABASE_URL`:

```powershell
# Windows PowerShell
$env:DATABASE_URL="postgres://app:app@localhost:5433/tasks"
npm run dev
```

```bash
# macOS / Linux
export DATABASE_URL=postgres://app:app@localhost:5433/tasks
npm run dev
```

The API listens on http://localhost:3000. Optional environment variables: `PORT` (default 3000), `MONGO_URL` (default `mongodb://localhost:27017`), `RETENTION_DAYS` (default 30).

Run the tests in a second terminal, with the same `DATABASE_URL` set:

```powershell
npm run smoke   # about 60 pass/fail checks across both engines
npm run qa      # runs the QA checklist and writes QA-RESULTS.md
```

Note: both scripts purge soft-deleted projects (`olderThanDays=0`), so run them before creating demo data you want to keep.

## API

Every route exists under both `/sql` and `/mongo`.

| Method and path | What it does | Success |
| --- | --- | --- |
| `POST /projects` | Create a project, optionally with tasks | 201 |
| `GET /projects` | List projects (hides soft-deleted) | 200 |
| `GET /projects/:id` | Read a project with its tasks and derived priority | 200 |
| `PATCH /projects/:id` | Update `name` and/or `instructions` | 200 |
| `DELETE /projects/:id` | Soft delete | 204 |
| `POST /projects/:id/restore` | Undo a soft delete | 200 |
| `POST /purge?olderThanDays=N` | Hard-delete projects soft-deleted more than N days ago | 200 |
| `POST /projects/:id/tasks` | Add a task | 201 |
| `PATCH /projects/:id/tasks/:taskId` | Update a task's `status` | 200 |
| `DELETE /projects/:id/tasks/:taskId` | Remove a task | 204 |

Errors: 400 for invalid input or a malformed id, 404 when the project or task does not exist.

## AI disclosure and prompt appendix

**Tool:** Claude (Claude Sonnet 5.5), used through the Claude app.

**Exact prompt submitted for the initial draft** (the assignment's sample prompt with my domain filled in):

```text
Act as a senior database architect. I am designing a backend feature for a Task Management System with Projects and Tasks.

I need to implement polyglot persistence to compare relational (SQL) and non-relational (NoSQL) modeling:

Relational Schema (PostgreSQL/MySQL/SQLite):
   - Create normalized (3NF) tables with primary keys, foreign keys, timestamps, and indexes.

   - Ensure proper referential integrity (e.g., ON DELETE CASCADE).

NoSQL Schema (MongoDB/Document Store):
   - Design an idiomatic document model for the exact same domain.

   - Optimize for reading a complete project with its associated tasks in a single query (denormalized or embedded array).

Working Application / CRUD Service (Node.js, Python, or Go):
   - Implement basic CRUD endpoints/methods for both databases:

     * Create a record/document

     * Read by ID and list all records

     * Update an attribute

     * Delete a record

A minimal frontend or test script to execute and verify these operations against both databases.


Provide the SQL DDL statements, NoSQL schema/JSON structure, database connection logic, and CRUD controller code.
```

The prompt log is in [`ai-draft/prompt.md`](ai-draft/prompt.md) and the unedited output is the rest of `ai-draft/`.

**Context worth disclosing:** I ran that prompt in a conversation that had already covered my domain choice, my access patterns, and a baseline ER sketch, so the AI had more context than the bare prompt. I also used the same assistant for later work, all of which I reviewed and ran myself: debugging my local setup, drafting `audit-notes.md`, writing the corrections in `app/`, drafting the QA script, and drafting this README.

### What the AI got right

- Real foreign key with `ON DELETE CASCADE` and a CHECK constraint on `status`, plus indexes on `project_id` and `due_date` (`schema.sql`).
- Fully parameterized SQL, and a transaction around creating a project with its tasks (`sqlRepo.ts`).
- Idiomatic MongoDB: one collection with embedded tasks, each with its own `_id`, atomic `$push` and positional `$set` (`mongoRepo.ts`).
- UUIDs for SQL keys, which are safe to generate across services.

### What I had to patch or change

1. **Stored `priority` column.** It is derivable from `due_date`, so storing it breaks normalization and goes stale. I removed it and compute it at read time for both engines.
2. **Hard deletes only.** My domain needs a retention period, so I added soft delete, restore, and purge. SQL purges on demand and the purge triggers the cascade; MongoDB uses a TTL index.
3. **No `code` field** on tasks, which my design needs. Added to both engines, with a length check in SQL.
4. **Type errors in the generated MongoDB code.** `mongoRepo.ts` failed `tsc` on `$push` and `$pull`; I patched it with two `as any` casts, which costs some type safety.
5. **Date handling bug I found while fixing priority.** The `pg` driver turns SQL `DATE` values into JavaScript dates at local midnight, which can shift the day. I made it return plain `YYYY-MM-DD` strings.
6. **Setup assumptions.** The draft hard-coded Postgres on port 5432; I moved the container to 5433 and made the URL configurable.
7. **Inconsistencies between engines** are documented in `audit-notes.md` (parent `updated_at` handling, invalid-id status codes, list shapes). Not all are fixed; they are listed as known trade-offs.

Full notes: [`audit-notes.md`](audit-notes.md).

## QA test summary

`npm run qa` runs the assignment's QA checklist against the live API and both databases and writes the evidence to [`QA-RESULTS.md`](app/QA-RESULTS.md).

| Checklist item | How it is verified |
| --- | --- |
| SQL create and read (parent plus child, joined data) | `npm run qa`, step 1a |
| SQL update visible on next read | `npm run qa`, step 1b |
| SQL delete and cascade (soft delete, then purge removes children) | `npm run qa`, step 1c, with direct Postgres queries |
| SQL negative test: orphaned task rejected (error 23503) | `npm run qa`, step 1d, and `npm run smoke` |
| NoSQL create and single-query read | `npm run qa`, step 2a |
| NoSQL atomic update (`$push` into the embedded array, positional `$set`) | `npm run qa`, step 2b |
| NoSQL delete and clean state | `npm run qa`, step 2c, with direct MongoDB queries |
| UI and responsive design | Not applicable: no frontend |
| HTTP status codes 200, 201, 204, 400, 404 | `npm run qa`, step 4a |
| Terminal health (no driver warnings or stack traces) | Manual check of the server terminal during the run |

Completed on: TODO: date of my final run. Result: TODO: paste the last line of the QA output.
