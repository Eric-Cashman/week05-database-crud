import express, { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { closeAll, RETENTION_DAYS, TaskInput } from './db';
import { priorityFor } from './priority';
import * as sqlRepo from './sqlRepo';
import * as mongoRepo from './mongoRepo';

interface Repo {
  createProject(name: string, instructions: string, tasks?: TaskInput[]): Promise<any>;
  listProjects(): Promise<any[]>;
  getProject(id: string): Promise<any | null>;
  updateProject(id: string, f: { name?: string; instructions?: string }): Promise<any | null>;
  deleteProject(id: string): Promise<boolean>;
  restoreProject(id: string): Promise<boolean>;
  purgeDeleted(days: number): Promise<number>;
  addTask(projectId: string, t: TaskInput): Promise<any | null>;
  updateTaskStatus(projectId: string, taskId: string, status: string): Promise<boolean>;
  removeTask(projectId: string, taskId: string): Promise<boolean>;
}

const STATUSES = ['todo', 'in_progress', 'done'];

// Priority is not stored in either database. It is computed from the due date
// here, once, so SQL and Mongo responses always agree.
function withTaskPriority(task: any) {
  if (!task) return task;
  return { ...task, priority: priorityFor(task.due_date ?? task.dueDate) };
}

function withProjectPriorities(project: any) {
  if (!project || !Array.isArray(project.tasks)) return project;
  return { ...project, tasks: project.tasks.map(withTaskPriority) };
}

function taskError(t: any): string | null {
  if (!t || typeof t.title !== 'string' || !t.title.trim() || t.title.length > 200)
    return 'task title is required (max 200 chars)';
  if (t.status !== undefined && !STATUSES.includes(t.status))
    return `task status must be one of: ${STATUSES.join(', ')}`;
  if (t.dueDate != null && Number.isNaN(Date.parse(t.dueDate)))
    return 'task dueDate must be a valid date';
  if (t.code != null && (typeof t.code !== 'string' || t.code.length > 5000))
    return 'task code must be a string (max 5000 chars)';
  return null;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    fn(req, res).catch(next);

function buildRouter(repo: Repo): Router {
  const r = Router();

  r.post('/projects', wrap(async (req, res) => {
    const { name, instructions = '', tasks = [] } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 200)
      return res.status(400).json({ error: 'name is required (max 200 chars)' });
    if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be an array' });
    for (const t of tasks) {
      const err = taskError(t);
      if (err) return res.status(400).json({ error: err });
    }
    const created = await repo.createProject(name, String(instructions), tasks);
    res.status(201).json(withProjectPriorities(created));
  }));

  r.get('/projects', wrap(async (_req, res) => {
    const list = await repo.listProjects();
    res.json(list.map(withProjectPriorities));
  }));

  r.get('/projects/:id', wrap(async (req, res) => {
    const project = await repo.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'project not found' });
    res.json(withProjectPriorities(project));
  }));

  r.patch('/projects/:id', wrap(async (req, res) => {
    const { name, instructions } = req.body ?? {};
    if (name === undefined && instructions === undefined)
      return res.status(400).json({ error: 'provide name and/or instructions' });
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 200))
      return res.status(400).json({ error: 'name must be a non-empty string (max 200 chars)' });
    const updated = await repo.updateProject(req.params.id, { name, instructions });
    if (!updated) return res.status(404).json({ error: 'project not found' });
    res.json(withProjectPriorities(updated));
  }));

  // Soft delete.
  r.delete('/projects/:id', wrap(async (req, res) => {
    const ok = await repo.deleteProject(req.params.id);
    if (!ok) return res.status(404).json({ error: 'project not found' });
    res.status(204).end();
  }));

  r.post('/projects/:id/restore', wrap(async (req, res) => {
    const ok = await repo.restoreProject(req.params.id);
    if (!ok) return res.status(404).json({ error: 'no deleted project with that id' });
    res.json({ restored: true });
  }));

  // Hard-deletes projects soft-deleted more than olderThanDays ago (default: retention period).
  r.post('/purge', wrap(async (req, res) => {
    const raw = req.query.olderThanDays;
    const days = raw === undefined ? RETENTION_DAYS : Number(raw);
    if (!Number.isInteger(days) || days < 0)
      return res.status(400).json({ error: 'olderThanDays must be a non-negative integer' });
    res.json({ purged: await repo.purgeDeleted(days) });
  }));

  r.post('/projects/:id/tasks', wrap(async (req, res) => {
    const err = taskError(req.body);
    if (err) return res.status(400).json({ error: err });
    const task = await repo.addTask(req.params.id, req.body);
    if (!task) return res.status(404).json({ error: 'project not found' });
    res.status(201).json(withTaskPriority(task));
  }));

  r.patch('/projects/:id/tasks/:taskId', wrap(async (req, res) => {
    const { status } = req.body ?? {};
    if (!STATUSES.includes(status))
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    const ok = await repo.updateTaskStatus(req.params.id, req.params.taskId, status);
    if (!ok) return res.status(404).json({ error: 'task not found' });
    res.json({ updated: true });
  }));

  r.delete('/projects/:id/tasks/:taskId', wrap(async (req, res) => {
    const ok = await repo.removeTask(req.params.id, req.params.taskId);
    if (!ok) return res.status(404).json({ error: 'task not found' });
    res.status(204).end();
  }));

  return r;
}

const app = express();
app.use(express.json());
app.use('/sql', buildRouter(sqlRepo));
app.use('/mongo', buildRouter(mongoRepo));

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err.code === '22P02') return res.status(400).json({ error: 'invalid id format' });
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => console.log(`API listening on :${port}`));

process.on('SIGINT', async () => {
  server.close();
  await closeAll();
  process.exit(0);
});
