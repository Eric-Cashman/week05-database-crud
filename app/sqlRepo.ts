import { pg, TaskInput } from './db';

// Soft-deleted projects (deleted_at set) are invisible to every read and write below.
const PROJECT_WITH_TASKS = `
  SELECT p.*,
         COALESCE(
           json_agg(t ORDER BY t.due_date) FILTER (WHERE t.id IS NOT NULL),
           '[]'
         ) AS tasks
  FROM projects p
  LEFT JOIN tasks t ON t.project_id = p.id
  WHERE p.id = $1 AND p.deleted_at IS NULL
  GROUP BY p.id`;

export async function createProject(
  name: string,
  instructions: string,
  tasks: TaskInput[] = []
) {
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO projects (name, instructions) VALUES ($1, $2) RETURNING id',
      [name, instructions]
    );
    const projectId: string = rows[0].id;
    for (const t of tasks) {
      await client.query(
        `INSERT INTO tasks (project_id, title, status, due_date, code)
         VALUES ($1, $2, COALESCE($3, 'todo'), $4, $5)`,
        [projectId, t.title, t.status ?? null, t.dueDate ?? null, t.code ?? null]
      );
    }
    await client.query('COMMIT');
    return getProject(projectId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listProjects() {
  const { rows } = await pg.query(
    `SELECT p.*, COUNT(t.id)::int AS task_count
     FROM projects p
     LEFT JOIN tasks t ON t.project_id = p.id
     WHERE p.deleted_at IS NULL
     GROUP BY p.id
     ORDER BY p.created_at DESC`
  );
  return rows;
}

export async function getProject(id: string) {
  const { rows } = await pg.query(PROJECT_WITH_TASKS, [id]);
  return rows[0] ?? null;
}

export async function updateProject(
  id: string,
  fields: { name?: string; instructions?: string }
) {
  const { rows } = await pg.query(
    `UPDATE projects
     SET name = COALESCE($2, name),
         instructions = COALESCE($3, instructions),
         updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [id, fields.name ?? null, fields.instructions ?? null]
  );
  return rows[0] ?? null;
}

// Soft delete: marks the project deleted. Its tasks are NOT touched, so nothing cascades yet.
export async function deleteProject(id: string): Promise<boolean> {
  const { rowCount } = await pg.query(
    `UPDATE projects SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}

export async function restoreProject(id: string): Promise<boolean> {
  const { rowCount } = await pg.query(
    `UPDATE projects SET deleted_at = NULL, updated_at = now()
     WHERE id = $1 AND deleted_at IS NOT NULL`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}

// Hard delete of projects soft-deleted more than `days` days ago.
// This is the moment ON DELETE CASCADE removes their tasks.
export async function purgeDeleted(days: number): Promise<number> {
  const { rowCount } = await pg.query(
    `DELETE FROM projects
     WHERE deleted_at IS NOT NULL
       AND deleted_at < now() - make_interval(days => $1::int)`,
    [days]
  );
  return rowCount ?? 0;
}

export async function addTask(projectId: string, t: TaskInput) {
  // The EXISTS guard also blocks adding tasks to a soft-deleted project.
  const { rows } = await pg.query(
    `INSERT INTO tasks (project_id, title, status, due_date, code)
     SELECT $1::uuid, $2::text, COALESCE($3::text, 'todo'), $4::date, $5::text
     WHERE EXISTS (SELECT 1 FROM projects WHERE id = $1::uuid AND deleted_at IS NULL)
     RETURNING *`,
    [projectId, t.title, t.status ?? null, t.dueDate ?? null, t.code ?? null]
  );
  return rows[0] ?? null;
}

export async function updateTaskStatus(
  projectId: string,
  taskId: string,
  status: string
): Promise<boolean> {
  const { rowCount } = await pg.query(
    `UPDATE tasks SET status = $3, updated_at = now()
     WHERE id = $2 AND project_id = $1
       AND EXISTS (SELECT 1 FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL)`,
    [projectId, taskId, status]
  );
  return (rowCount ?? 0) > 0;
}

export async function removeTask(
  projectId: string,
  taskId: string
): Promise<boolean> {
  const { rowCount } = await pg.query(
    `DELETE FROM tasks
     WHERE id = $2 AND project_id = $1
       AND EXISTS (SELECT 1 FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL)`,
    [projectId, taskId]
  );
  return (rowCount ?? 0) > 0;
}
