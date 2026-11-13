import { pg, TaskInput } from './db';

const PROJECT_WITH_TASKS = `
  SELECT p.*,
         COALESCE(
           json_agg(t ORDER BY t.due_date) FILTER (WHERE t.id IS NOT NULL),
           '[]'
         ) AS tasks
  FROM projects p
  LEFT JOIN tasks t ON t.project_id = p.id
  WHERE p.id = $1
  GROUP BY p.id`;

export async function createProject(
  name: string,
  description: string,
  tasks: TaskInput[] = []
) {
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id',
      [name, description]
    );
    const projectId: string = rows[0].id;
    for (const t of tasks) {
      await client.query(
        `INSERT INTO tasks (project_id, title, status, due_date)
         VALUES ($1, $2, COALESCE($3, 'todo'), $4)`,
        [projectId, t.title, t.status ?? null, t.dueDate ?? null]
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
  fields: { name?: string; description?: string }
) {
  const { rows } = await pg.query(
    `UPDATE projects
     SET name = COALESCE($2, name),
         description = COALESCE($3, description),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, fields.name ?? null, fields.description ?? null]
  );
  return rows[0] ?? null;
}

export async function deleteProject(id: string): Promise<boolean> {
  const { rowCount } = await pg.query('DELETE FROM projects WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

export async function addTask(projectId: string, t: TaskInput) {
  try {
    const { rows } = await pg.query(
      `INSERT INTO tasks (project_id, title, status, due_date)
       VALUES ($1, $2, COALESCE($3, 'todo'), $4)
       RETURNING *`,
      [projectId, t.title, t.status ?? null, t.dueDate ?? null]
    );
    return rows[0];
  } catch (err: any) {
    if (err.code === '23503') return null; // foreign key violation: no such project
    throw err;
  }
}

export async function updateTaskStatus(
  projectId: string,
  taskId: string,
  status: string
): Promise<boolean> {
  const { rowCount } = await pg.query(
    `UPDATE tasks SET status = $3, updated_at = now()
     WHERE id = $2 AND project_id = $1`,
    [projectId, taskId, status]
  );
  return (rowCount ?? 0) > 0;
}

export async function removeTask(
  projectId: string,
  taskId: string
): Promise<boolean> {
  const { rowCount } = await pg.query(
    'DELETE FROM tasks WHERE id = $2 AND project_id = $1',
    [projectId, taskId]
  );
  return (rowCount ?? 0) > 0;
}
