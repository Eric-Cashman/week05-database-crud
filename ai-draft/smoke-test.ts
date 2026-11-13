import { Pool } from 'pg';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
let failures = 0;

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

async function runEngine(engine: 'sql' | 'mongo') {
  console.log(`\n=== ${engine.toUpperCase()} ===`);

  const created = await call('POST', `/${engine}/projects`, {
    name: 'Smoke test project',
    description: 'created by smoke-test.ts',
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
}

async function sqlConstraintTests() {
  console.log('\n=== SQL constraint tests (direct to Postgres) ===');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/tasks',
  });
  try {
    try {
      await pool.query(
        "INSERT INTO tasks (project_id, title) VALUES (gen_random_uuid(), 'orphan')"
      );
      check('orphan insert is rejected', false);
    } catch (err: any) {
      check('orphan insert is rejected (foreign key violation 23503)', err.code === '23503', err.code);
    }

    const { rows } = await pool.query(
      "INSERT INTO projects (name) VALUES ('cascade test') RETURNING id"
    );
    await pool.query("INSERT INTO tasks (project_id, title) VALUES ($1, 't1'), ($1, 't2')", [rows[0].id]);
    await pool.query('DELETE FROM projects WHERE id = $1', [rows[0].id]);
    const left = await pool.query('SELECT count(*)::int AS n FROM tasks WHERE project_id = $1', [rows[0].id]);
    check('deleting a project cascades to its tasks', left.rows[0].n === 0, left.rows[0]);
  } finally {
    await pool.end();
  }
}

(async () => {
  await runEngine('sql');
  await runEngine('mongo');
  await sqlConstraintTests();
  console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
