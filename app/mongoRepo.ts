import { Document, ObjectId } from 'mongodb';
import { getMongoDb, TaskInput } from './db';

async function projects() {
  return (await getMongoDb()).collection<Document>('projects');
}

function toId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

function buildTask(t: TaskInput): Document {
  const now = new Date();
  return {
    _id: new ObjectId(),
    title: t.title,
    status: t.status ?? 'todo',
    dueDate: t.dueDate ? new Date(t.dueDate) : null,
    code: t.code ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

// Every query filters on deletedAt: null, which hides soft-deleted projects.
// (A null filter also matches documents where the field is missing.)

export async function createProject(
  name: string,
  instructions: string,
  tasks: TaskInput[] = []
) {
  const now = new Date();
  const col = await projects();
  const { insertedId } = await col.insertOne({
    name,
    instructions,
    tasks: tasks.map(buildTask),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  return col.findOne({ _id: insertedId });
}

export async function listProjects() {
  const col = await projects();
  return col.find({ deletedAt: null }).sort({ createdAt: -1 }).toArray();
}

export async function getProject(id: string) {
  const _id = toId(id);
  if (!_id) return null;
  return (await projects()).findOne({ _id, deletedAt: null });
}

export async function updateProject(
  id: string,
  fields: { name?: string; instructions?: string }
) {
  const _id = toId(id);
  if (!_id) return null;
  const $set: Document = { updatedAt: new Date() };
  if (fields.name !== undefined) $set.name = fields.name;
  if (fields.instructions !== undefined) $set.instructions = fields.instructions;
  return (await projects()).findOneAndUpdate(
    { _id, deletedAt: null },
    { $set },
    { returnDocument: 'after' }
  );
}

// Soft delete: the document stays, with its embedded tasks, until purged or TTL-expired.
export async function deleteProject(id: string): Promise<boolean> {
  const _id = toId(id);
  if (!_id) return false;
  const now = new Date();
  const { matchedCount } = await (await projects()).updateOne(
    { _id, deletedAt: null },
    { $set: { deletedAt: now, updatedAt: now } }
  );
  return matchedCount > 0;
}

export async function restoreProject(id: string): Promise<boolean> {
  const _id = toId(id);
  if (!_id) return false;
  const { matchedCount } = await (await projects()).updateOne(
    { _id, deletedAt: { $ne: null } },
    { $set: { deletedAt: null, updatedAt: new Date() } }
  );
  return matchedCount > 0;
}

// Manual purge for demos and tests. In normal operation the TTL index on deletedAt
// removes expired documents on its own (see db.ts). Tasks are embedded, so they go with the document.
export async function purgeDeleted(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { deletedCount } = await (await projects()).deleteMany({
    deletedAt: { $lt: cutoff },
  });
  return deletedCount;
}

export async function addTask(projectId: string, t: TaskInput) {
  const _id = toId(projectId);
  if (!_id) return null;
  const task = buildTask(t);
  const result = await (await projects()).updateOne(
    { _id, deletedAt: null },
    // cast needed: the driver's PushOperator typing rejects nested-array pushes on Document
    { $push: { tasks: task }, $set: { updatedAt: new Date() } } as any
  );
  return result.matchedCount > 0 ? task : null;
}

export async function updateTaskStatus(
  projectId: string,
  taskId: string,
  status: string
): Promise<boolean> {
  const _id = toId(projectId);
  const taskOid = toId(taskId);
  if (!_id || !taskOid) return false;
  const now = new Date();
  const { matchedCount } = await (await projects()).updateOne(
    { _id, deletedAt: null, 'tasks._id': taskOid },
    {
      $set: {
        'tasks.$.status': status,
        'tasks.$.updatedAt': now,
        updatedAt: now,
      },
    }
  );
  return matchedCount > 0;
}

export async function removeTask(
  projectId: string,
  taskId: string
): Promise<boolean> {
  const _id = toId(projectId);
  const taskOid = toId(taskId);
  if (!_id || !taskOid) return false;
  const { modifiedCount } = await (await projects()).updateOne(
    { _id, deletedAt: null },
    // cast needed: same PullOperator typing limitation as addTask
    { $pull: { tasks: { _id: taskOid } }, $set: { updatedAt: new Date() } } as any
  );
  return modifiedCount > 0;
}
