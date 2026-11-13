import { Pool } from 'pg';
import { Db, MongoClient } from 'mongodb';

export type TaskInput = {
  title: string;
  status?: string;
  priority?: number;
  dueDate?: string | null;
};

export const pg = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/tasks',
});

const mongoClient = new MongoClient(
  process.env.MONGO_URL ?? 'mongodb://localhost:27017'
);

let mongoDb: Db | undefined;

export async function getMongoDb(): Promise<Db> {
  if (!mongoDb) {
    await mongoClient.connect();
    mongoDb = mongoClient.db('tasks');
    await mongoDb.collection('projects').createIndex({ 'tasks.dueDate': 1 });
  }
  return mongoDb;
}

export async function closeAll(): Promise<void> {
  await pg.end();
  await mongoClient.close();
}
