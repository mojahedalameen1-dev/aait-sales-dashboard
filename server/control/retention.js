import { firebaseDatabaseRequest } from './shared.js';

const CLEANUP_LIMIT_PER_PATH = 40;
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;

/** Delete only known, expired call records. Never delete a Firebase subtree. */
export async function cleanupExpiredCalls({ request = firebaseDatabaseRequest, now = Date.now } = {}) {
    const cutoff = now();
    const collections = ['public', 'audioRequests'];
    const snapshots = await Promise.all(collections.map(name => request('calls/' + name)));
    const updates = {};
    for (const [index, name] of collections.entries()) {
        const expired = Object.entries(snapshots[index] || {}).filter(([id, record]) => CALL_ID_PATTERN.test(id)
            && Number.isFinite(record?.expiresAt) && record.expiresAt > 0 && record.expiresAt <= cutoff);
        for (const [id] of expired.slice(0, CLEANUP_LIMIT_PER_PATH)) {
            updates[name + '/' + id] = null;
        }
    }
    if (Object.keys(updates).length) await request('calls', 'PATCH', updates);
    return Object.keys(updates).length;
}
