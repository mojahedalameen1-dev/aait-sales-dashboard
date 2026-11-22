import { createAudioOutput } from './audio-output.js';
import { createAudioPriorityQueue } from './audio-priority.js';
import { createAlertAudioSequence } from './alert-audio-sequence.js';

export const AUDIO_STATE = Object.freeze({ LOCKED: 'locked', ENABLED: 'enabled', FAILED: 'failed' });
const PROBE = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';
const PROGRESS_KEY = 'aait_audio_completed_clips_v1';
const RETRY_DELAYS = [2000, 8000];

export function createAudioDelivery({
    storage = () => globalThis.localStorage,
    now = Date.now,
    createPlayer,
    canOwnAudio = () => true,
    isEnabled = () => true,
    onState = () => {},
    onDiagnostic = (event, details) => {
        const log = event === 'attempt_failed' || event === 'delivery_failed' ? console.warn : console.info;
        log(`[Audio] ${event}`, details);
    }
} = {}) {
    let state = AUDIO_STATE.LOCKED;
    let suspended = false;
    let generation = 0;
    let probe;
    let probeFromGesture = false;
    const jobs = new Map();
    const localProgress = new Map();
    const recoveryWaiters = new Set();
    const report = (event, details = {}) => onDiagnostic(event, {
        ...details, audioState: state, visibility: globalThis.document?.visibilityState || 'unknown', suspended
    });
    const output = createAudioOutput({ createPlayer, report });
    const queue = createAudioPriorityQueue({
        now,
        canStart: () => !probe && !suspended && state !== AUDIO_STATE.LOCKED && isEnabled() && canOwnAudio()
    });

    function update(next) {
        if (state === next) return;
        state = next;
        report('state', { state });
        try { onState(state); } catch { report('state_callback_failed'); }
    }

    function notifyRecovery() {
        for (const wake of [...recoveryWaiters]) wake(true);
    }

    function waitForRecovery(expiresAt) {
        if (!Number.isFinite(expiresAt)) return Promise.resolve(false);
        return new Promise(resolve => {
            const wake = recovered => {
                clearTimeout(timer);
                recoveryWaiters.delete(wake);
                resolve(recovered);
            };
            const timer = setTimeout(() => wake(false), Math.max(0, expiresAt - now()));
            recoveryWaiters.add(wake);
        });
    }

    function readStored() {
        try { return JSON.parse(storage()?.getItem(PROGRESS_KEY) || '{}') || {}; } catch { return {}; }
    }

    function getProgress(id) {
        if (!id) return null;
        const stored = readStored()[id];
        const memory = localProgress.get(id);
        const record = (stored?.completed || 0) > (memory?.completed || 0) ? stored : memory || stored;
        return record?.expiresAt > now() ? record : null;
    }

    function saveProgress(id, progress, expiresAt) {
        if (!id || !Number.isFinite(expiresAt)) return;
        const item = { completed: progress.completed, lastCompletedAt: progress.lastCompletedAt, expiresAt };
        for (const [key, value] of localProgress) if (value.expiresAt <= now()) localProgress.delete(key);
        localProgress.set(id, item);
        try {
            const entries = Object.entries(readStored()).filter(([key, value]) => key !== id && value?.expiresAt > now());
            storage()?.setItem(PROGRESS_KEY, JSON.stringify(Object.fromEntries([...entries.slice(-299), [id, item]])));
        } catch { /* In-memory progress is still available in this tab. */ }
    }

    function unlock({ userGesture = false } = {}) {
        if (!isEnabled() || suspended) return Promise.resolve(false);
        if (state === AUDIO_STATE.ENABLED) return Promise.resolve(true);
        if (probe) {
            if (!userGesture || probeFromGesture) return probe;
            output.cancel('superseded');
        }
        if (output.busy) return Promise.resolve(false);
        probeFromGesture = userGesture;
        const attempt = output.play(PROBE, { kind: 'activation', probe: true }).then(result => {
            if (probe !== attempt) return false;
            if (!result.reason) {
                update(AUDIO_STATE.ENABLED);
                if (userGesture) notifyRecovery();
            }
            else if (result.reason === 'autoplay_blocked') update(AUDIO_STATE.LOCKED);
            else if (!suspended && result.reason !== 'interrupted') update(AUDIO_STATE.FAILED);
            return !result.reason;
        }).finally(() => {
            if (probe === attempt) {
                probe = null;
                queue.kick();
            }
        });
        probe = attempt;
        return probe;
    }

    function enqueue(level, options) {
        const { id, expiresAt = Infinity, isRelevant = () => true, onDeferred, onStarted, onCompleted, clipUrl,
            loadRecording, repetitions = 2 } = options;
        if (id && jobs.has(id)) return jobs.get(id);
        const expectedRepetitions = repetitions;
        const epoch = generation;
        const progress = { completed: 0, beep: false, lastCompletedAt: 0 };
        let recording;
        let attempts = 0;
        let lastRecoveryAttempt = 0;
        let speechStarted = false;
        const resultFor = (reason, extra = {}) => ({
            started: speechStarted || progress.completed > 0, completedRepetitions: progress.completed, expectedRepetitions, reason, ...extra
        });
        const transferable = () => epoch === generation && !suspended && canOwnAudio() && isEnabled();
        const relevant = () => now() < expiresAt && isRelevant();
        const canContinue = () => transferable() && state !== AUDIO_STATE.LOCKED && relevant();

        async function play(src, kind, extra = {}) {
            if (!canContinue()) return { started: false, reason: 'expired' };
            const outcome = await output.play(src, { kind, ...extra, onStarted: () => {
                update(AUDIO_STATE.ENABLED);
                extra.onStarted?.();
            } });
            if (outcome.reason === 'autoplay_blocked') update(AUDIO_STATE.LOCKED);
            else if (outcome.completed) update(AUDIO_STATE.ENABLED);
            else if (!['suspended', 'interrupted', 'busy'].includes(outcome.reason)) update(AUDIO_STATE.FAILED);
            return outcome;
        }

        async function attempt() {
            const stored = getProgress(id);
            if (stored && stored.completed > progress.completed) Object.assign(progress, stored, { beep: false });
            if (progress.completed >= repetitions) return resultFor(undefined, { alreadyCompleted: true });
            if (!canContinue()) return resultFor('expired');
            if (!clipUrl && !recording) {
                let timer;
                try {
                    const timeout = new Promise((_, reject) => {
                        timer = setTimeout(() => reject(Object.assign(new Error('load deadline'), { code: 'audio_load_timeout' })),
                            Math.max(1, Math.min(40000, expiresAt - now())));
                    });
                    recording = await Promise.race([Promise.resolve().then(loadRecording), timeout]);
                } catch (error) {
                    report('source_failed', { level, reason: error?.code || 'speech_load_failed', httpStatus: error?.status });
                    const retryable = !error?.status || error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
                    return resultFor(error?.code === 'audio_load_timeout' ? 'audio_load_timeout'
                        : retryable ? 'speech_load_failed' : 'speech_source_rejected', { retryAt: error?.retryAt });
                } finally { clearTimeout(timer); }
            }
            if (!clipUrl && !(recording instanceof Blob)) {
                recording = null;
                return resultFor('speech_unavailable');
            }
            const speechUrl = clipUrl || URL.createObjectURL(recording);
            try {
                return await createAlertAudioSequence({
                    playBeep: clipUrl ? null : () => play('/sounds/beeb.mp3', 'beep', { volume: 0.35 }),
                    playSpeech: (_, repetition) => play(speechUrl, level, { onStarted: () => {
                        speechStarted = true;
                        onStarted?.(repetition);
                    } }),
                    canContinue, total: repetitions, progress, now,
                    silenceMs: clipUrl ? 2500 : 3000,
                    onProgress: () => saveProgress(id, progress, expiresAt)
                })(recording || new Blob());
            } finally { if (!clipUrl) URL.revokeObjectURL(speechUrl); }
        }

        async function run() {
            let readyAt = 0;
            let outcome;
            while (epoch === generation && relevant()) {
                outcome = await queue.enqueue(level, attempt, { readyAt, expiresAt, onDeferred: readyAt === 0 ? onDeferred : undefined });
                if (outcome.completedRepetitions === repetitions) {
                    if (!outcome.alreadyCompleted) {
                        try { onCompleted?.(outcome); } catch { report('completion_callback_failed', { level }); }
                    }
                    return outcome;
                }
                if (epoch !== generation || !relevant()) break;
                if (outcome.reason === 'autoplay_blocked' || outcome.reason === 'suspended'
                    || state === AUDIO_STATE.LOCKED || (!transferable() && outcome.reason === 'expired')) {
                    readyAt = 0;
                    continue;
                }
                if (!['media_error', 'play_rejected', 'playback_timeout', 'ended_without_playing',
                    'speech_load_failed', 'speech_unavailable', 'audio_load_timeout'].includes(outcome.reason)) break;
                if (attempts >= RETRY_DELAYS.length) {
                    if (!await waitForRecovery(expiresAt) || epoch !== generation) break;
                    // A real recovery signal can retry, but not in a tight cycle
                    // and never earlier than a provider's Retry-After.
                    readyAt = Math.max(now(), lastRecoveryAttempt + 10000, Number(outcome.retryAt) || 0);
                    lastRecoveryAttempt = readyAt;
                } else readyAt = Math.max(now() + RETRY_DELAYS[attempts++], Number(outcome.retryAt) || 0);
                report('retry_scheduled', { level, reason: outcome.reason, attempt: attempts + 1 });
            }
            outcome = resultFor(epoch !== generation ? 'interrupted' : !relevant() ? 'expired' : outcome?.reason || 'expired');
            report('delivery_failed', { level, reason: outcome.reason, completedRepetitions: progress.completed });
            return outcome;
        }

        const promise = run().finally(() => { if (id && jobs.get(id) === promise) jobs.delete(id); });
        if (id) jobs.set(id, promise);
        return promise;
    }

    return {
        enqueue, unlock, getProgress, report,
        get state() { return state; },
        get suspended() { return suspended; },
        get activeLevel() { return queue.activeLevel; },
        get queuedCount() { return queue.queuedCount; },
        wake({ recovery = false } = {}) {
            suspended = false;
            if (recovery) notifyRecovery();
            queue.kick();
        },
        kick: queue.kick,
        suspend() {
            suspended = true;
            report('lifecycle_frozen');
            output.cancel('suspended');
            queue.kick();
        },
        stop() {
            generation++;
            output.cancel('interrupted');
            queue.cancelPending();
            for (const wake of [...recoveryWaiters]) wake(false);
            update(AUDIO_STATE.LOCKED);
        }
    };
}
