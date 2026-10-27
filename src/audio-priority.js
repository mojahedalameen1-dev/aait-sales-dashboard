const PRIORITY = Object.freeze({ routine: 1, admin: 2, prayer: 3 });

function normalizeExpiry(value) {
    if (value === Infinity || value === undefined || value === null) return Infinity;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
}

/** A small in-page, priority-aware audio arbiter. Active playback is never overlapped. */
export function createAudioPriorityQueue({ onIdle = () => {} } = {}) {
    let active = null;
    let sequence = 0;
    const queued = [];

    function drain() {
        if (active || !queued.length) return;
        queued.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        const task = queued.shift();
        if (task.expiresAt <= Date.now()) {
            task.resolve({ started: false, reason: 'expired' });
            drain();
            return;
        }
        active = task;
        task.started = true;
        Promise.resolve().then(task.run).then(
            result => task.resolve(result ?? { started: false, reason: 'no_result' }),
            () => task.resolve({ started: false, reason: 'playback_failed' })
        ).finally(() => {
            if (active === task) active = null;
            drain();
            if (!active && !queued.length) onIdle();
        });
    }

    function enqueue(level, run, { expiresAt = Infinity, onDeferred } = {}) {
        const priority = PRIORITY[level];
        if (!priority || typeof run !== 'function') return Promise.resolve({ started: false, reason: 'invalid_task' });
        return new Promise(resolve => {
            const task = { level, priority, run, expiresAt: normalizeExpiry(expiresAt), resolve, sequence: sequence++, started: false };
            const deferred = Boolean(active || queued.length);
            queued.push(task);
            if (deferred) onDeferred?.({ level, waitingFor: active?.level || null });
            drain();
        });
    }

    return Object.freeze({
        enqueue,
        get activeLevel() { return active?.level || null; },
        get queuedCount() { return queued.length; },
        hasHigherPriority(level) {
            const priority = PRIORITY[level];
            return queued.some(task => task.priority > priority) || Boolean(active && active.priority > priority);
        }
    });
}
