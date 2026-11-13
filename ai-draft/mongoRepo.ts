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
    priority: t.priority ?? 2,
    dueDate: t.dueDate ? new Date(t.dueDate) : null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function createProject(
  name: string,
  description: string,
  tasks: TaskInput[] = []
) {
  const now = new Date();
  const col = await projects();
  const { insertedId } = await col.insertOne({
    name,
    description,
    tasks: tasks.map(buildTask),
    createdAt: now,
    updatedAt: now,
  });
  return col.findOne({ _id: insertedId });
}

export async function listProjects() {
  const col = await projects();
  return col.find().sort({ createdAt: -1 }).toArray();
}

export async function getProject(id: string) {
  const _id = toId(id);
  if (!_id) return null;
  return (await projects()).findOne({ _id });
}

export async function updateProject(
  id: string,
  fields: { name?: string; description?: string }
) {
  const _id = toId(id);
  if (!_id) return null;
  const $set: Document = { updatedAt: new Date() };
  if (fields.name !== undefined) $set.name = fields.name;
  if (fields.description !== undefined) $set.description = fields.description;
  return (await projects()).findOneAndUpdate(
    { _id },
    { $set },
    { returnDocument: 'after' }
  );
}

export async function deleteProject(id: string): Promise<boolean> {
  const _id = toId(id);
  if (!_id) return false;
  const { deletedCount } = await (await projects()).deleteOne({ _id });
  return deletedCount > 0;
}

export async function addTask(projectId: string, t: TaskInput) {
  const _id = toId(projectId);
  if (!_id) return null;
  const task = buildTask(t);
  const result = await (await projects()).updateOne(
    { _id },
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
    { _id, 'tasks._id': taskOid },
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
    { _id },
    // cast needed: same PullOperator typing limitation as addTask
    { $pull: { tasks: { _id: taskOid } }, $set: { updatedAt: new Date() } } as any
  );
  return modifiedCount > 0;
}
