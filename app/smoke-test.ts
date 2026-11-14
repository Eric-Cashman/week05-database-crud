import { Pool } from 'pg';
import { MongoClient, ObjectId } from 'mongodb';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let failures = 0;

const directPool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/tasks',
});
const directMongo = new MongoClient(process.env.MONGO_URL ?? 'mongodb://localhost:27017');

function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log('      ', detail);
  }
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const idOf = (p: any) => p.id ?? p._id;

// Local calendar date, N days from today, as YYYY-MM-DD.
function dayFromToday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

async function runEngine(engine: 'sql' | 'mongo') {
  console.log(`\n=== ${engine.toUpperCase()} ===`);

  const created = await call('POST', `/${engine}/projects`, {
    name: 'Smoke test project',
    instructions: 'created by smoke-test.ts',
    tasks: [{ title: 'First task', dueDate: '2026-12-01' }],
  });
  check('create project returns 201', created.status === 201, created);
  const id = idOf(created.body);

  const read = await call('GET', `/${engine}/projects/${id}`);
  check('read by id returns 200 with embedded/joined tasks',
    read.status === 200 && read.body.tasks?.length === 1, read);

  const list = await call('GET', `/${engine}/projects`);
  check('list returns 200 and includes the project',
    list.status === 200 && list.body.some((p: any) => idOf(p) === id));

  const patched = await call('PATCH', `/${engine}/projects/${id}`, { name: 'Renamed' });
  check('update project name returns 200', patched.status === 200 && patched.body.name === 'Renamed');

  const added = await call('POST', `/${engine}/projects/${id}/tasks`, { title: 'Second task' });
  check('add task returns 201', added.status === 201, added);
  const taskId = idOf(added.body);

  const status = await call('PATCH', `/${engine}/projects/${id}/tasks/${taskId}`, { status: 'done' });
  check('update task status returns 200', status.status === 200, status);

  const after = await call('GET', `/${engine}/projects/${id}`);
  const second = after.body.tasks.find((t: any) => idOf(t) === taskId);
  check('status change visible on next read', second?.status === 'done', second);

  const bad = await call('POST', `/${engine}/projects`, { name: '' });
  check('empty name returns 400', bad.status === 400);

  const orphan = await call('POST', `/${engine}/projects/does-not-exist/tasks`, { title: 'x' });
  check('add task to missing project returns 400 or 404', [400, 404].includes(orphan.status), orphan);

  const del = await call('DELETE', `/${engine}/projects/${id}`);
  check('delete project returns 204', del.status === 204);

  const gone = await call('GET', `/${engine}/projects/${id}`);
  check('deleted project returns 404', gone.status === 404);

  await priorityTests(engine);
  await codeAndSoftDeleteTests(engine);
}

async function priorityTests(engine: 'sql' | 'mongo') {
  const made = await call('POST', `/${engine}/projects`, {
    name: 'Priority test project',
    tasks: [
      { title: 'overdue', dueDate: dayFromToday(-2) },
      { title: 'tomorrow', dueDate: dayFromToday(1) },
      { title: 'in 5 days', dueDate: dayFromToday(5) },
      { title: 'in 30 days', dueDate: dayFromToday(30) },
      { title: 'no due date' },
    ],
  });
  check('priority test project created', made.status === 201, made);
  const pid = idOf(made.body);
  const read = await call('GET', `/${engine}/projects/${pid}`);
  const byTitle = (title: string) => read.body.tasks.find((t: any) => t.title === title)?.priority;

  check('overdue task is high', byTitle('overdue') === 'high', byTitle('overdue'));
  check('task due tomorrow is high', byTitle('tomorrow') === 'high', byTitle('tomorrow'));
  check('task due in 5 days is medium', byTitle('in 5 days') === 'medium', byTitle('in 5 days'));
  check('task due in 30 days is low', byTitle('in 30 days') === 'low', byTitle('in 30 days'));
  check('task with no due date is low', byTitle('no due date') === 'low', byTitle('no due date'));

  await call('DELETE', `/${engine}/projects/${pid}`);
}

async function rawProject(engine: 'sql' | 'mongo', id: string) {
  if (engine === 'sql') {
    const p = await directPool.query('SELECT deleted_at FROM projects WHERE id = $1', [id]);
    const t = await directPool.query('SELECT count(*)::int AS n FROM tasks WHERE project_id = $1', [id]);
    return { exists: p.rows.length > 0, deleted: p.rows[0]?.deleted_at != null, taskCount: t.rows[0].n };
  }
  const doc = await directMongo.db('tasks').collection('projects').findOne({ _id: new ObjectId(id) });
  return { exists: doc !== null, deleted: doc?.deletedAt != null, taskCount: doc?.tasks?.length ?? 0 };
}

async function codeAndSoftDeleteTests(engine: 'sql' | 'mongo') {
  const made = await call('POST', `/${engine}/projects`, {
    name: 'Soft delete test',
    tasks: [{ title: 't1', code: 'console.log(1)' }, { title: 't2' }],
  });
  const pid = idOf(made.body);
  const t1 = made.body.tasks.find((t: any) => t.title === 't1');
  check('task code field round-trips', t1?.code === 'console.log(1)', t1);

  const del = await call('DELETE', `/${engine}/projects/${pid}`);
  check('soft delete returns 204', del.status === 204, del);
  check('soft-deleted project is hidden from read',
    (await call('GET', `/${engine}/projects/${pid}`)).status === 404);
  const list = await call('GET', `/${engine}/projects`);
  check('soft-deleted project is hidden from list', !list.body.some((p: any) => idOf(p) === pid));
  check('cannot add a task to a soft-deleted project',
    (await call('POST', `/${engine}/projects/${pid}/tasks`, { title: 'late' })).status === 404);

  const raw1 = await rawProject(engine, pid);
  check('soft-deleted project and its tasks still exist in the database',
    raw1.exists && raw1.deleted && raw1.taskCount === 2, raw1);

  const restored = await call('POST', `/${engine}/projects/${pid}/restore`);
  check('restore returns 200', restored.status === 200, restored);
  check('restored project is readable again',
    (await call('GET', `/${engine}/projects/${pid}`)).status === 200);

  await call('DELETE', `/${engine}/projects/${pid}`);
  const purge = await call('POST', `/${engine}/purge?olderThanDays=0`);
  check('purge returns 200 and removes at least one project',
    purge.status === 200 && purge.body.purged >= 1, purge);

  const raw2 = await rawProject(engine, pid);
  check(engine === 'sql'
    ? 'after purge the project row is gone and ON DELETE CASCADE removed its tasks'
    : 'after purge the document (with its embedded tasks) is gone',
    !raw2.exists && raw2.taskCount === 0, raw2);

  check('purge rejects a negative olderThanDays with 400',
    (await call('POST', `/${engine}/purge?olderThanDays=-1`)).status === 400);
}

async function sqlConstraintTests() {
  console.log('\n=== SQL constraint tests (direct to Postgres) ===');
  try {
    await directPool.query(
      "INSERT INTO tasks (project_id, title) VALUES (gen_random_uuid(), 'orphan')"
    );
    check('orphan insert is rejected', false);
  } catch (err: any) {
    check('orphan insert is rejected (foreign key violation 23503)', err.code === '23503', err.code);
  }

  try {
    const { rows } = await directPool.query("INSERT INTO projects (name) VALUES ('check test') RETURNING id");
    await directPool.query("INSERT INTO tasks (project_id, title, status) VALUES ($1, 'x', 'banana')", [rows[0].id]);
    check('invalid status is rejected', false);
  } catch (err: any) {
    check('invalid status is rejected (check violation 23514)', err.code === '23514', err.code);
  }
}

(async () => {
  await directMongo.connect();
  try {
    await runEngine('sql');
    await runEngine('mongo');
    await sqlConstraintTests();
  } finally {
    await directPool.end();
    await directMongo.close();
  }
  console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
