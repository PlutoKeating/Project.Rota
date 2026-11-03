import { DatabaseSync, backup } from 'node:sqlite';
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node storage/backup.mjs <destination.sqlite>');
const db = new DatabaseSync((process.env.DATA_DIR ?? './.data') + '/rota.sqlite');
await backup(db, destination);
db.close();
