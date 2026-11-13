import { Pool, types } from 'pg';
import { Db, MongoClient } from 'mongodb';

// Return SQL DATE columns as plain 'YYYY-MM-DD' strings. By default pg turns them
// into JS Dates at local midnight, which shifts the day when serialized to JSON
// and would make derived priority disagree with the Mongo engine.
types.setTypeParser(1082, (value: string) => value);

export type TaskInput = {
  title: string;
  status?: string;
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
