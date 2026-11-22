const PRIORITY = Object.freeze({ routine: 1, admin: 2, prayer: 3 });

function normalizeExpiry(value) {
    if (value === Infinity || value === undefined || value === null) return Infinity;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
}

/** A small in-page, priority-aware audio arbiter. Active playback is never overlapped. */
export function createAudioPriorityQueue({ onIdle = () => {}, canStart = () => true, now = Date.now } = {}) {
    let active = null;
    let sequence = 0;
    const queued = [];
    let timer;

    function drain() {
        clearTimeout(timer);
        timer = undefined;
        const current = now();
        for (let index = queued.length - 1; index >= 0; index--) {
            if (queued[index].expiresAt > current) continue;
            const [expired] = queued.splice(index, 1);
            expired.resolve({ started: false, reason: 'expired' });
        }
        if (!queued.length) return;
        queued.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        const index = active ? -1 : queued.findIndex(task => task.readyAt <= current && canStart(task.level));
        if (index < 0) {
            const next = Math.min(...queued.map(task => task.readyAt > current
                ? Math.min(task.readyAt, task.expiresAt) : task.expiresAt));
            if (Number.isFinite(next)) timer = setTimeout(drain, Math.min(2147483647, Math.max(1, next - current)));
        } else {
            const [task] = queued.splice(index, 1);
            active = task;
            Promise.resolve().then(task.run).then(
                result => task.resolve(result ?? { started: false, reason: 'no_result' }),
                () => task.resolve({ started: false, reason: 'playback_failed' })
            ).finally(() => {
                if (active === task) active = null;
                drain();
                if (!active && !queued.length) onIdle();
            });
            drain();
        }
    }

    function enqueue(level, run, { expiresAt = Infinity, readyAt = 0, onDeferred } = {}) {
        const priority = PRIORITY[level];
        if (!priority || typeof run !== 'function') return Promise.resolve({ started: false, reason: 'invalid_task' });
        return new Promise(resolve => {
            const task = { level, priority, run, expiresAt: normalizeExpiry(expiresAt), readyAt, resolve, sequence: sequence++ };
            const deferred = Boolean(active || queued.length || !canStart(level));
            queued.push(task);
            if (deferred) {
                try { onDeferred?.({ level, waitingFor: active?.level || null }); } catch { /* Status UI cannot halt the queue. */ }
            }
            drain();
        });
    }

    return Object.freeze({
        enqueue,
        kick: drain,
        cancelPending(reason = 'interrupted') {
            for (const task of queued.splice(0)) task.resolve({ started: false, reason });
            drain();
        },
        get activeLevel() { return active?.level || null; },
        get queuedCount() { return queued.length; },
        hasHigherPriority(level) {
            const priority = PRIORITY[level];
            return queued.some(task => task.priority > priority) || Boolean(active && active.priority > priority);
        }
    });
}
