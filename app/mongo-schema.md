# MongoDB model

One collection, `projects`, with tasks embedded as an array. Reading a
project with all of its tasks is a single `findOne`.

## Sample document

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

`priority` (high, medium, low) is not stored. The API computes it from
`dueDate` on every read (see `priority.ts`), so it can never go stale.

## Soft delete

Deleting a project sets `deletedAt`. Every query filters on `deletedAt: null`,
so the project disappears from reads but the document (with its embedded tasks)
stays. A TTL index on `deletedAt` makes MongoDB remove the document by itself
once it is older than the retention period (default 30 days, `RETENTION_DAYS`).
Documents where `deletedAt` is `null` are never expired.

## Indexes

- `{ "tasks.dueDate": 1 }` (multikey) for finding tasks by due date
- `{ "deletedAt": 1 }` with `expireAfterSeconds` (TTL) for automatic purge

## Design notes

- Tasks are embedded because they belong to exactly one project and are
  almost always read together with it.
- Each embedded task gets its own `_id` so it can be targeted by
  positional updates (`tasks.$.status`) and `$pull`.
- Single-document writes are atomic in MongoDB, so pushing a task or
  changing a task status needs no transaction.
