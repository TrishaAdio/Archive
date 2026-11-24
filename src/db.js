import { MongoClient } from "mongodb";

const DURABLE_WRITE = { w: "majority", j: true, wtimeoutMS: 10000 };

async function connectDatabase({ mongoUri, mongoDbName }) {
  const client = new MongoClient(mongoUri, {
    retryWrites: true,
    retryReads: true,
    writeConcern: DURABLE_WRITE,
    readConcern: { level: "majority" },
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 50,
  });

  await client.connect();
  const db = client.db(mongoDbName);

  const collections = {
    accessKeys: db.collection("access_keys"),
    sessions: db.collection("sessions"),
    categories: db.collection("categories"),
    archives: db.collection("archives"),
    videos: db.collection("videos"),
    counters: db.collection("counters"),
    progress: db.collection("watch_progress"),
    likes: db.collection("likes"),
    viewMarks: db.collection("view_marks"),
    broadcasts: db.collection("broadcasts"),
    broadcastAcks: db.collection("broadcast_acks"),
    auditLog: db.collection("audit_log"),
  };

  await Promise.all([
    collections.accessKeys.createIndexes([
      { key: { keyHash: 1 }, name: "keyHash_unique", unique: true },
      { key: { categoryCode: 1, planExpiresAt: 1 }, name: "category_expiry" },
      { key: { planExpiresAt: 1 }, name: "planExpiresAt" },
      { key: { boundIp: 1 }, name: "boundIp", sparse: true },
    ]),
    collections.sessions.createIndexes([
      { key: { keyId: 1 }, name: "keyId" },
      { key: { lastSeenAt: -1 }, name: "lastSeenAt" },
      { key: { expiresAt: 1 }, name: "session_ttl", expireAfterSeconds: 0 },
    ]),
    collections.categories.createIndexes([
      { key: { code: 1 }, name: "code_unique", unique: true },
    ]),
    collections.archives.createIndexes([
      { key: { categoryCode: 1, createdAt: -1 }, name: "category_created" },
      { key: { categoryCode: 1, slug: 1 }, name: "category_slug_unique", unique: true },
    ]),
    collections.videos.createIndexes([
      { key: { archiveId: 1, seq: 1 }, name: "archive_seq_unique", unique: true },
      { key: { archiveId: 1, relPath: 1 }, name: "archive_path_unique", unique: true },
      { key: { archiveId: 1, viewCount: -1, seq: 1 }, name: "archive_popularity" },
    ]),
    collections.progress.createIndexes([
      { key: { keyId: 1, videoId: 1 }, name: "key_video_unique", unique: true },
      { key: { keyId: 1, updatedAt: -1 }, name: "key_recent" },
    ]),
    collections.likes.createIndexes([
      { key: { keyId: 1, videoId: 1 }, name: "key_video_unique", unique: true },
      { key: { videoId: 1 }, name: "videoId" },
    ]),
    collections.viewMarks.createIndexes([
      { key: { keyId: 1, videoId: 1 }, name: "key_video_unique", unique: true },
      { key: { expiresAt: 1 }, name: "view_mark_ttl", expireAfterSeconds: 0 },
    ]),
    collections.broadcasts.createIndexes([
      { key: { active: 1, createdAt: -1 }, name: "active_created" },
    ]),
    collections.broadcastAcks.createIndexes([
      { key: { broadcastId: 1, keyId: 1 }, name: "broadcast_key_unique", unique: true },
    ]),
    collections.auditLog.createIndexes([{ key: { createdAt: -1 }, name: "createdAt" }]),
  ]);

  return { client, db, collections };
}

export { connectDatabase, DURABLE_WRITE };
