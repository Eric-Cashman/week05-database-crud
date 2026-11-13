# Prompt log: initial AI draft

Tool: Claude (Claude Sonnet 5.5), claude.ai chat
Date: 2026-11-12

Note for README disclosure: this prompt was run in a conversation that had
already discussed the domain (Projects and Tasks) and a baseline ER sketch.
Say so in the AI disclosure section.

## Exact prompt submitted (assignment sample prompt, domain filled in)

```
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

## Raw output

The files in this folder (schema.sql, mongo-schema.md, db.ts, sqlRepo.ts,
mongoRepo.ts, server.ts, smoke-test.ts, docker-compose.yml, package.json,
tsconfig.json) are the first draft. Do not edit them; copy the
folder and make your corrected version separately so you can diff the two.

One change was made after generation, and it is itself an audit finding:
the original mongoRepo.ts did not pass `tsc --noEmit`. The `$push` and
`$pull` calls on `collection<Document>('projects')` failed type-checking
(TS2322). The fix was adding `as any` casts on the two update operators
(addTask and removeTask). That removes type safety on those calls, so a
corrected version could define a typed interface for the project document.
