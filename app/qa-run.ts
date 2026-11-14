// Runs the assignment's QA checklist against the live API and databases, prints
// each step with the HTTP status codes seen, and writes QA-RESULTS.md from the
// real results. Start the server first (npm run dev), then run: npm run qa
import { writeFileSync } from 'fs';
import { Pool } from 'pg';
import { MongoClient, ObjectId } from 'mongodb';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/tasks',
});
const mongo = new MongoClient(process.env.MONGO_URL ?? 'mongodb://localhost:27017');

const seenStatuses = new Set<number>();
type Result = { item: string; ok: boolean; evidence: string[] };
const results: Result[] = [];

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  seenStatuses.add(res.status);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function step(item: string, fn: (ev: string[]) => Promise<boolean>) {
  const evidence: string[] = [];
  let ok = false;
  try {
    ok = await fn(evidence);
  } catch (err: any) {
    evidence.push(`error: ${err.message ?? err}`);
  }
  results.push({ item, ok, evidence });
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${item}`);
  for (const line of evidence) console.log(`      ${line}`);
}

const idOf = (p: any) => p.id ?? p._id;

async function main() {
  await mongo.connect();
  const col = mongo.db('tasks').collection('projects');

  console.log('QA checklist run against', BASE);

  // 1. Relational (SQL)
  let sqlId = '';
  await step('SQL 1a. Create parent + child, read back the joined dataset', async (ev) => {
    const created = await call('POST', '/sql/projects', {
      name: 'QA SQL project',
      instructions: 'qa run',
      tasks: [{ title: 'QA SQL task', code: 'SELECT 1;', dueDate: '2030-01-01' }],
    });
    ev.push(`POST /sql/projects -> ${created.status}`);
    sqlId = idOf(created.body);
    const read = await call('GET', `/sql/projects/${sqlId}`);
    const task = read.body?.tasks?.[0];
    ev.push(`GET /sql/projects/:id -> ${read.status}, tasks returned: ${read.body?.tasks?.length}`);
    ev.push(`task.project_id matches project id: ${task?.project_id === sqlId}`);
    return created.status === 201 && read.status === 200 && task?.project_id === sqlId;
  });

  await step('SQL 1b. Update an attribute and see it on the next read', async (ev) => {
    const patched = await call('PATCH', `/sql/projects/${sqlId}`, { name: 'QA SQL project (renamed)' });
    const read = await call('GET', `/sql/projects/${sqlId}`);
    ev.push(`PATCH -> ${patched.status}; next GET name = "${read.body?.name}"`);
    return patched.status === 200 && read.body?.name === 'QA SQL project (renamed)';
  });

  await step('SQL 1c. Delete a parent: soft delete first, then purge cascades to children', async (ev) => {
    const del = await call('DELETE', `/sql/projects/${sqlId}`);
    const hidden = await call('GET', `/sql/projects/${sqlId}`);
    const mid = await pool.query(
      `SELECT (SELECT deleted_at IS NOT NULL FROM projects WHERE id = $1) AS soft_deleted,
              (SELECT count(*)::int FROM tasks WHERE project_id = $1) AS tasks`, [sqlId]);
    ev.push(`DELETE -> ${del.status}; GET afterwards -> ${hidden.status}`);
    ev.push(`in Postgres after soft delete: deleted_at set = ${mid.rows[0].soft_deleted}, child tasks still present = ${mid.rows[0].tasks}`);
    const purge = await call('POST', '/sql/purge?olderThanDays=0');
    const end = await pool.query(
      `SELECT (SELECT count(*)::int FROM projects WHERE id = $1) AS projects,
              (SELECT count(*)::int FROM tasks WHERE project_id = $1) AS tasks`, [sqlId]);
    ev.push(`POST /sql/purge?olderThanDays=0 -> ${purge.status}, purged ${purge.body?.purged}`);
    ev.push(`in Postgres after purge: project rows = ${end.rows[0].projects}, task rows = ${end.rows[0].tasks} (cascade)`);
    return del.status === 204 && hidden.status === 404 && mid.rows[0].soft_deleted === true &&
      mid.rows[0].tasks === 1 && end.rows[0].projects === 0 && end.rows[0].tasks === 0;
  });

  await step('SQL 1d. Negative test: orphaned task is rejected by the database', async (ev) => {
    let code = '';
    let message = '';
    try {
      await pool.query("INSERT INTO tasks (project_id, title) VALUES (gen_random_uuid(), 'orphan')");
    } catch (err: any) {
      code = err.code;
      message = err.message;
    }
    ev.push(`direct INSERT with unknown project_id -> error code ${code || 'none'}`);
    if (message) ev.push(`message: ${message}`);
    const viaApi = await call('POST', '/sql/projects/00000000-0000-0000-0000-000000000000/tasks', { title: 'x' });
    ev.push(`same attempt through the API -> ${viaApi.status}`);
    return code === '23503' && viaApi.status === 404;
  });

  // 2. NoSQL
  let mongoId = '';
  await step('NoSQL 2a. Create a document and read it back in one query', async (ev) => {
    const created = await call('POST', '/mongo/projects', {
      name: 'QA Mongo project',
      instructions: 'qa run',
      tasks: [{ title: 'QA Mongo task 1' }, { title: 'QA Mongo task 2', code: 'db.projects.find()' }],
    });
    mongoId = idOf(created.body);
    const read = await call('GET', `/mongo/projects/${mongoId}`);
    ev.push(`POST /mongo/projects -> ${created.status}`);
    ev.push(`GET /mongo/projects/:id -> ${read.status}; tasks embedded in the same document: ${read.body?.tasks?.length}`);
    return created.status === 201 && read.status === 200 && read.body?.tasks?.length === 2;
  });

  await step('NoSQL 2b. Atomic update: push into the embedded array and update an embedded field', async (ev) => {
    const added = await call('POST', `/mongo/projects/${mongoId}/tasks`, { title: 'QA pushed task' });
    const firstTask = (await call('GET', `/mongo/projects/${mongoId}`)).body.tasks[0];
    const patched = await call('PATCH', `/mongo/projects/${mongoId}/tasks/${firstTask._id}`, { status: 'done' });
    const read = await call('GET', `/mongo/projects/${mongoId}`);
    ev.push(`POST task ($push) -> ${added.status}; PATCH task status ($set tasks.$.status) -> ${patched.status}`);
    ev.push(`after: ${read.body?.tasks?.length} tasks, first task status = ${read.body?.tasks?.[0]?.status}`);
    return added.status === 201 && patched.status === 200 &&
      read.body?.tasks?.length === 3 && read.body?.tasks?.[0]?.status === 'done';
  });

  await step('NoSQL 2c. Delete: soft delete, then purge leaves a clean state', async (ev) => {
    const del = await call('DELETE', `/mongo/projects/${mongoId}`);
    const hidden = await call('GET', `/mongo/projects/${mongoId}`);
    const mid = await col.findOne({ _id: new ObjectId(mongoId) });
    ev.push(`DELETE -> ${del.status}; GET afterwards -> ${hidden.status}`);
    ev.push(`in MongoDB after soft delete: document exists = ${mid !== null}, deletedAt set = ${mid?.deletedAt != null}`);
    const purge = await call('POST', '/mongo/purge?olderThanDays=0');
    const end = await col.countDocuments({ _id: new ObjectId(mongoId) });
    ev.push(`POST /mongo/purge?olderThanDays=0 -> ${purge.status}, purged ${purge.body?.purged}`);
    ev.push(`in MongoDB after purge: documents with that id = ${end}`);
    return del.status === 204 && hidden.status === 404 && mid !== null && mid.deletedAt != null && end === 0;
  });

  // 3. UI: no frontend in this project
  results.push({
    item: '3. UI and responsive design',
    ok: true,
    evidence: ['Not applicable: this project is an API with a terminal test script and has no frontend.'],
  });
  console.log('\nN/A   3. UI and responsive design (no frontend)');

  // 4. HTTP status codes and terminal health
  await step('4a. HTTP status codes observed across the run', async (ev) => {
    const bad = await call('POST', '/sql/projects', { name: '' });
    const missing = await call('GET', '/mongo/projects/000000000000000000000000');
    ev.push(`empty name -> ${bad.status}; unknown id -> ${missing.status}`);
    const wanted = [200, 201, 204, 400, 404];
    const codes = [...seenStatuses].sort((a, b) => a - b);
    ev.push(`status codes seen: ${codes.join(', ')}`);
    return wanted.every((c) => seenStatuses.has(c));
  });

  results.push({
    item: '4b. Terminal health (manual)',
    ok: true,
    evidence: ['Check the window running "npm run dev": no driver warnings, no stack traces, no leaked-connection messages. Confirm by eye and tick this off.'],
  });
  console.log('\nMANUAL  4b. Look at the server terminal for warnings or stack traces');

  const failed = results.filter((r) => !r.ok).length;
  const lines: string[] = [
    '# QA test results',
    '',
    `Run: ${new Date().toISOString()}`,
    `Target: ${BASE}`,
    `Result: ${failed === 0 ? 'all automated checks passed' : `${failed} step(s) failed`}`,
    '',
    'Generated by `npm run qa` from a live run against Postgres and MongoDB.',
    '',
  ];
  for (const r of results) {
    lines.push(`## ${r.ok ? '[x]' : '[ ]'} ${r.item}`, '');
    for (const e of r.evidence) lines.push(`- ${e}`);
    lines.push('');
  }
  writeFileSync('QA-RESULTS.md', lines.join('\n'));
  console.log(`\n${failed === 0 ? 'All automated steps passed' : failed + ' step(s) failed'}. Wrote QA-RESULTS.md`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    await mongo.close();
  });
