# AI draft audit notes

Scope: the unedited AI draft in `ai-draft/` (commit "Add AI draft (before audit)").
Checked against the Data Architecture Audit Checklist, plus differences from my own
design for the Projects and Tasks domain.

## Checklist results

### 1. SQL referential integrity: passed
- `schema.sql`, line 11: `project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE`.
  The foreign key is real and enforced, with an explicit cascade rule.
- `schema.sql`, line 22: `idx_tasks_project_id`. Postgres does not index foreign key
  columns automatically, so this index matters, and the draft included it.
- Also present: CHECK constraints on `status` (line 14) and `priority` (line 16), and a
  secondary index on `due_date` (line 23).
- Verified live: inserting a task with a random `project_id` fails with error 23503, and
  deleting a project cascades to its tasks (smoke test, SQL constraint section).

### 2. NoSQL anti-patterns: passed, with gaps
- Good: a single `projects` collection with tasks embedded as an array
  (`mongoRepo.ts`, `buildTask` and `createProject`). No second collection, no manual
  joins. One `findOne` returns a project with all its tasks.
- Good: each embedded task has its own `_id`, so `tasks.$.status` and `$pull` work
  (`updateTaskStatus`, `removeTask`).
- Gap: no database-level validation. SQL rejects `status = 'banana'` with a CHECK
  constraint, but Mongo enforces status only in `server.ts` (`taskError`). A direct write
  to Mongo can store invalid data.
- Gap: the `tasks.dueDate` index is created in application code at first connection
  (`db.ts`, `getMongoDb`), not in a setup or seed step.
- Trade-off: "all tasks due soon across every project" is natural in SQL but needs array
  unwinding in Mongo, even with the multikey index.

### 3. SQL injection and parameterization: passed
- Every query in `sqlRepo.ts` passes user values as `$1`, `$2`, ... parameters. The only
  template-string SQL is static text (`PROJECT_WITH_TASKS`) with no interpolated input.
- `createProject` wraps the project and task inserts in `BEGIN` / `COMMIT` / `ROLLBACK`,
  so a failed task insert does not leave a half-created project.

### 4. ID and primary key generation: passed, with a catch
- SQL uses `gen_random_uuid()` (`schema.sql`, lines 2 and 10), which is safe to generate
  across distributed boundaries. Mongo uses ObjectId.
- Catch: the two engines use different ID types and field names (`id` vs `_id`), so the
  "unified" API returns different shapes. The smoke test needs an `idOf` helper to cope.

## Flaws and omissions in the draft

1. **Stored priority.** `tasks.priority` is a column, but priority is derivable from
   `due_date`. A stored derived value goes stale as time passes and is a normalization
   smell. (My design computes priority at read time.)
2. **Inconsistent behavior across engines.**
   - Mongo updates the parent project's `updatedAt` when a task is added, changed, or
     removed (`addTask`, `updateTaskStatus`, `removeTask`). SQL never touches
     `projects.updated_at` when a task changes.
   - Invalid IDs: SQL returns 400 (error handler in `server.ts` maps code 22P02), but
     Mongo returns 404, because `toId` returns null.
   - `listProjects` returns a `task_count` in SQL but full task arrays in Mongo.
3. **`updated_at` is maintained by application code.** There is no trigger, so any edit
   made directly in SQL leaves `updated_at` unchanged.
4. **Hard deletes only.** `deleteProject` removes data immediately in both engines. My
   design needs a soft delete with a retention period, then a purge that triggers the
   cascade.
5. **Missing `code` field** on tasks, which my design requires.
6. **The generated code did not type-check.** The first `mongoRepo.ts` failed `tsc`
   (TS2322 on `$push` and `$pull`). I patched it with two `as any` casts, which removes
   type safety on those calls.
7. **Setup problem.** The draft hard-codes the Postgres port (5432) and credentials.
   On my machine a locally installed Postgres already held port 5432, so the app got
   "password authentication failed". I moved the container to 5433 and set `DATABASE_URL`.

## Flaw I will fix on camera
(Pick one: stored priority, missing Mongo validation, or hard deletes. Write which one
and what the fix is.)