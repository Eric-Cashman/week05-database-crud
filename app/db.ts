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
  code?: string | null;
};

// How long a soft-deleted project is kept before it is purged.
export const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 30);

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
    const projects = mongoDb.collection('projects');
    await projects.createIndex({ 'tasks.dueDate': 1 });
    // TTL index: MongoDB removes a project automatically once deletedAt is older
    // than the retention period. Projects where deletedAt is null are never expired.
    await projects.createIndex(
      { deletedAt: 1 },
      { expireAfterSeconds: RETENTION_DAYS * 86400 }
    );
  }
  return mongoDb;
}

export async function closeAll(): Promise<void> {
  await pg.end();
  await mongoClient.close();
}
