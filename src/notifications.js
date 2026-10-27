/**
 * notifications.js — Notification engine: timers, sound alerts (file-based), visual toasts
 * REFACTORED: Audio Queue System + Performance Cleanup
 */

import { getSettings, isDone, isCancelled, getCurrentTimeParts, formatTodayDate } from './data.js';
import { getEngineerAudioPrefix, getEngineerProfile } from './config.js';
import { createIcons, AlertCircle, AlertTriangle, Bell, Info } from 'lucide';
import { ALERT_CATCHUP_MS, MEETING_REMINDER_MINUTES, shouldTriggerAlert } from './alert-timing.js';
import { createAudioPriorityQueue } from './audio-priority.js';
import { createPrayerAudioSequence } from './prayer-audio-assets.js';

// ========================================
// 🔊 Audio System (Queue Based)
// ========================================

/**
 * Audio States
 */
export const AUDIO_STATE = {
    LOCKED: 'locked',
    ENABLED: 'enabled',
    FAILED: 'failed'
};

const playQueue = [];
let isPlaying = false;
let currentAudioState = AUDIO_STATE.LOCKED;
let onStateChangeCallback = null;
let audioUnlockPromise = null;
let retainedAudioPlayer = null;
let activeAudioTask = null;
let announcementPlayer = null;
let announcementObjectUrl = '';
const SILENT_AUDIO = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';

// Track recently warned meetings to avoid spamming fallbacks
const recentlyWarnedMeetings = new Map(); // id -> timestamp
const DELIVERED_STORAGE_KEY = 'aait_delivered_notifications';
const PLAY_COUNTS_STORAGE_KEY = 'aait_notification_play_counts';
const AUDIO_LEADER_LOCK = 'aait-notification-audio-leader';
const AUDIO_LEASE_KEY = 'aait_notification_audio_lease';
const AUDIO_LEASE_MS = 12000;
const AUDIO_FILES = ['a', 'm', 's'].flatMap(prefix => MEETING_REMINDER_MINUTES.map(minutes => `${prefix}${minutes}.mp3`));
const audioTabId = globalThis.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let playbackGeneration = 0;
let activeSafetyTimeout = null;
let queueAdvanceTimeout = null;
let latestMeetingsById = new Map();
let isAudioLeader = false;
let releaseWebAudioLock = null;
let leaderRetryInterval = null;
let leaseRenewInterval = null;
let leaseConfirmationTimeout = null;
const priorityAudioQueue = createAudioPriorityQueue({ onIdle: () => processQueue() });

/**
 * Set a callback for UI updates when audio state changes
 */
export function setAudioStateListener(callback) {
    onStateChangeCallback = callback;
}

function updateAudioState(newState) {
    if (currentAudioState === newState) return;
    currentAudioState = newState;
    console.log(`[Audio] State changed to: ${newState}`);
    if (onStateChangeCallback) onStateChangeCallback(newState);
    if (newState === AUDIO_STATE.ENABLED && getSettings().soundEnabled) tryAcquireAudioLeadership();
    else releaseAudioLeadership();
}

/**
 * "Unlock" audio context. Called from user interaction.
 */
export function unlockAudio() {
    if (currentAudioState === AUDIO_STATE.ENABLED) return Promise.resolve(true);
    if (audioUnlockPromise) return audioUnlockPromise;

    try {
        retainedAudioPlayer ||= new Audio();
        retainedAudioPlayer.preload = 'auto';
        retainedAudioPlayer.src = SILENT_AUDIO;
        audioUnlockPromise = retainedAudioPlayer.play().then(() => {
            retainedAudioPlayer.pause();
            retainedAudioPlayer.currentTime = 0;
            updateAudioState(AUDIO_STATE.ENABLED);
            preloadAudioFiles();
            processQueue();
            return true;
        }).catch(error => {
            console.warn('[Audio] Unlock failed:', error);
            updateAudioState(error?.name === 'NotAllowedError' ? AUDIO_STATE.LOCKED : AUDIO_STATE.FAILED);
            return false;
        }).finally(() => {
            audioUnlockPromise = null;
        });

        return audioUnlockPromise;
    } catch (e) {
        console.warn('[Audio] Unlock setup failed:', e);
        audioUnlockPromise = null;
        updateAudioState(AUDIO_STATE.FAILED);
        return Promise.resolve(false);
    }
}

function preloadAudioFiles() {
    for (const filename of AUDIO_FILES) {
        const audio = new Audio(`/sounds/${filename}`);
        audio.preload = 'auto';
        audio.load();
    }
}

export function playTestAlert(onResult) {
    enqueueAudio({ filename: 'm5.mp3', meetingId: 'audio-test', onDelivered: onResult });
}

export function isAudioPlaybackEnabled() {
    return currentAudioState === AUDIO_STATE.ENABLED && getSettings().soundEnabled;
}

/** Play a private server-generated announcement only after the page's audio was unlocked. */
export function playAnnouncementAudio(audioBlob, { onStarted, onDeferred, expiresAt = Infinity } = {}) {
    if (!(audioBlob instanceof Blob) || !isAudioPlaybackEnabled()) return { started: false, reason: 'locked' };
    return priorityAudioQueue.enqueue('admin', () => playAnnouncementAudioNow(audioBlob, { onStarted, expiresAt }), { expiresAt, onDeferred });
}

async function playAnnouncementAudioNow(audioBlob, { onStarted, expiresAt = Infinity } = {}) {
    if (expiresAt <= Date.now()) return { started: false, reason: 'expired' };
    if (!(audioBlob instanceof Blob) || !isAudioPlaybackEnabled()) return { started: false, reason: 'locked' };
    stopRoutineAudioForPriority();
    announcementPlayer?.pause?.();
    if (announcementObjectUrl) URL.revokeObjectURL(announcementObjectUrl);
    announcementObjectUrl = URL.createObjectURL(audioBlob);
    announcementPlayer = new Audio(announcementObjectUrl);
    announcementPlayer.preload = 'auto';
    announcementPlayer.volume = 1;

    return new Promise(resolve => {
        const player = announcementPlayer;
        let started = false;
        let settled = false;
        const finish = result => {
            if (settled) return;
            settled = true;
            player.removeEventListener('playing', handleStarted);
            player.removeEventListener('ended', handleEnded);
            player.removeEventListener('error', handleError);
            if (announcementPlayer === player) {
                announcementPlayer = null;
                if (announcementObjectUrl) URL.revokeObjectURL(announcementObjectUrl);
                announcementObjectUrl = '';
            }
            resolve(result);
        };
        const handleStarted = () => {
            if (started) return;
            started = true;
            onStarted?.();
        };
        const handleEnded = () => finish({ started });
        const handleError = () => finish({ started, reason: 'playback_failed' });
        player.addEventListener('playing', handleStarted);
        player.addEventListener('ended', handleEnded);
        player.addEventListener('error', handleError);
        player.play().catch(() => finish({ started: false, reason: 'playback_blocked' }));
    });
}

function stopRoutineAudioForPriority() {
    // Prayer and admin speech take priority over scheduled meeting reminder files.
    playbackGeneration++;
    if (activeSafetyTimeout) clearTimeout(activeSafetyTimeout);
    if (queueAdvanceTimeout) clearTimeout(queueAdvanceTimeout);
    activeSafetyTimeout = null;
    queueAdvanceTimeout = null;
    for (const task of playQueue.splice(0)) task.onDelivered?.(false);
    activeAudioTask?.onDelivered?.(false);
    activeAudioTask = null;
    isPlaying = false;
    if (retainedAudioPlayer) {
        retainedAudioPlayer.onended = null;
        retainedAudioPlayer.onerror = null;
        retainedAudioPlayer.pause?.();
        try { retainedAudioPlayer.currentTime = 0; } catch { /* ignored */ }
    }
}

/** A short, calm chime that must finish before the prayer speech asset begins. */
async function playPrayerBeepNow() {
    if (!isAudioPlaybackEnabled()) return { started: false, reason: 'locked' };
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return { started: false, reason: 'unsupported' };
    let context;
    try {
        context = new AudioContextClass();
        await context.resume();
        const now = context.currentTime;
        const master = context.createGain();
        master.gain.setValueAtTime(0.0001, now);
        master.gain.exponentialRampToValueAtTime(0.14, now + 0.08);
        master.gain.exponentialRampToValueAtTime(0.0001, now + 1.65);
        master.connect(context.destination);
        for (const [index, frequency] of [660, 880, 660].entries()) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const start = now + index * 0.48;
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(frequency, start);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.8, start + 0.035);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
            oscillator.connect(gain);
            gain.connect(master);
            oscillator.start(start);
            oscillator.stop(start + 0.42);
        }
        await new Promise(resolve => globalThis.setTimeout(resolve, 1450));
        await context.close().catch(() => {});
        return { started: true };
    } catch {
        if (context && context.state !== 'closed') void context.close().catch(() => {});
        return { started: false, reason: 'playback_failed' };
    }
}

/** Priority order is prayer announcement, administrator call, then normal reminders. */
export function playPrayerAnnouncement(audioBlobOrLoader, { onStarted, onDeferred, expiresAt = Infinity } = {}) {
    if (!isAudioPlaybackEnabled()) return Promise.resolve({ started: false, reason: 'locked' });
    return priorityAudioQueue.enqueue('prayer', async () => {
        if (expiresAt <= Date.now()) return { started: false, reason: 'expired' };
        stopRoutineAudioForPriority();
        const audioBlob = typeof audioBlobOrLoader === 'function' ? await audioBlobOrLoader() : audioBlobOrLoader;
        if (expiresAt <= Date.now()) return { started: false, reason: 'expired' };
        const playSequence = createPrayerAudioSequence({
            playBeep: playPrayerBeepNow,
            playSpeech: blob => playAnnouncementAudioNow(blob, { onStarted, expiresAt })
        });
        return playSequence(audioBlob);
    }, { expiresAt, onDeferred });
}

/** Backward-compatible short chime used only by existing integrations. */
export function playPrayerReminder({ expiresAt = Infinity } = {}) {
    if (!isAudioPlaybackEnabled()) return Promise.resolve({ started: false, reason: 'locked' });
    return priorityAudioQueue.enqueue('prayer', playPrayerBeepNow, { expiresAt });
}

export function getPriorityAudioState() {
    return { active: priorityAudioQueue.activeLevel, queued: priorityAudioQueue.queuedCount };
}

/**
 * Add audio task to queue
 */
function enqueueAudio(task) {
    const { soundEnabled } = getSettings();
    if (!soundEnabled) return false;

    const deliveryKeys = task.deliveryKeys || [];
    const startedCount = getMaxStartedCount(deliveryKeys);
    const requestedPlays = Math.max(1, task.repetitionsRemaining || 2);
    const remainingPlays = Math.min(requestedPlays, Math.max(0, 2 - startedCount));
    if (remainingPlays === 0) return false;

    console.log(`[Queue] Queued: ${task.filename || task}`);
    playQueue.push({
        ...task,
        repetitionsRemaining: remainingPlays,
        deliveryConfirmed: false
    });
    processQueue();
    return true;
}

export function stopAudioPlayback() {
    playbackGeneration++;
    if (activeSafetyTimeout) clearTimeout(activeSafetyTimeout);
    if (queueAdvanceTimeout) clearTimeout(queueAdvanceTimeout);
    activeSafetyTimeout = null;
    queueAdvanceTimeout = null;

    const cancelled = playQueue.splice(0);
    if (activeAudioTask) cancelled.push(activeAudioTask);
    const seen = new Set();
    for (const task of cancelled) {
        if (seen.has(task)) continue;
        seen.add(task);
        task.onDelivered?.(false);
    }
    if (retainedAudioPlayer) {
        retainedAudioPlayer.onended = null;
        retainedAudioPlayer.onerror = null;
        retainedAudioPlayer.pause?.();
    }
    if (retainedAudioPlayer) retainedAudioPlayer.currentTime = 0;
    announcementPlayer?.pause?.();
    announcementPlayer = null;
    if (announcementObjectUrl) URL.revokeObjectURL(announcementObjectUrl);
    announcementObjectUrl = '';
    activeAudioTask = null;
    isPlaying = false;
    updateAudioState(AUDIO_STATE.LOCKED);
}

/**
 * Process the Audio Queue (STRICT MODE: Files Only)
 */
async function processQueue() {
    if (isPlaying || playQueue.length === 0 || priorityAudioQueue.activeLevel || priorityAudioQueue.queuedCount) return;
    if (playQueue[0]?.meetingId !== 'audio-test' && !hasCurrentAudioLeadership()) return;
    
    if (currentAudioState !== AUDIO_STATE.ENABLED) {
        console.warn('[Queue] Waiting for Audio Unlock...');
        return;
    }

    const generation = playbackGeneration;
    const finish = (delay = 2000) => {
        if (activeSafetyTimeout) clearTimeout(activeSafetyTimeout);
        activeSafetyTimeout = null;
        queueAdvanceTimeout = setTimeout(() => {
            if (generation !== playbackGeneration) return;
            queueAdvanceTimeout = null;
            isPlaying = false;
            processQueue();
        }, delay);
    };

    if (!getSettings().soundEnabled) {
        stopAudioPlayback();
        return;
    }

    isPlaying = true;
    const task = playQueue.shift();
    activeAudioTask = task;
    const filename = task.filename || task;
    let settled = false;

    // Array#filter passes the index as the predicate's second argument. Keep the
    // default `allowExhausted = false` explicit so later reminders cannot skip
    // the two-play delivery cap just because they are later in the array.
    const validReminders = (task.reminders || []).filter(reminder => isReminderStillValid(reminder));
    if (task.reminders?.length && validReminders.length === 0) {
        activeAudioTask = null;
        confirmTask(task, false);
        finish(0);
        return;
    }
    if (validReminders.length) {
        task.deliveryKeys = validReminders.map(reminder => reminder.key);
        task.reminders = validReminders;
    }

    const availablePlays = Math.max(0, 2 - getMaxStartedCount(task.deliveryKeys || []));
    task.repetitionsRemaining = Math.min(task.repetitionsRemaining, availablePlays);
    if (!task.repetitionsRemaining) {
        activeAudioTask = null;
        confirmTask(task, false);
        finish(0);
        return;
    }

    const confirmDelivery = success => {
        if (task.deliveryConfirmed) return;
        task.deliveryConfirmed = true;
        task.onDelivered?.(success);
    };

    const settle = (delay = 500) => {
        if (settled) return;
        settled = true;
        finish(delay);
    };

    activeSafetyTimeout = setTimeout(() => {
        if (generation !== playbackGeneration) return;
        console.warn('[Queue] Safety timeout — skipping stalled audio task');
        retainedAudioPlayer?.pause?.();
        retainedAudioPlayer && (retainedAudioPlayer.onended = null);
        retainedAudioPlayer && (retainedAudioPlayer.onerror = null);
        activeAudioTask = null;
        confirmDelivery(false);
        settle(0);
    }, 90000);

    try {
        const audioPath = `/sounds/${filename}`;
        console.log(`[Queue] Stage: Playing -> ${filename}`);

        const audio = retainedAudioPlayer || new Audio();
        retainedAudioPlayer = audio;
        audio.pause();
        audio.currentTime = 0;
        audio.src = audioPath;
        audio.load();
        audio.onended = () => {
            if (generation !== playbackGeneration) return;
            console.log('[Queue] Stage: Completed');
            if (task.repetitionsRemaining > 1) {
                task.repetitionsRemaining--;
                playQueue.unshift({
                    ...task,
                    deliveryConfirmed: false
                });
                activeAudioTask = null;
                settle(2500);
            } else {
                activeAudioTask = null;
                confirmDelivery(true);
                settle(500);
            }
        };

        audio.onerror = () => {
            if (generation !== playbackGeneration) return;
            console.error(`[Queue] Stage: Failed (File NOT FOUND: ${filename}). Skipping.`);
            activeAudioTask = null;
            updateAudioState(AUDIO_STATE.FAILED);
            confirmDelivery(false);
            settle(0);
        };

        await audio.play().then(() => {
            if (generation === playbackGeneration) recordStartedPlay(task);
        }).catch((err) => {
            if (generation !== playbackGeneration) return;
            if (err.name === 'NotAllowedError') {
                playQueue.unshift(task);
                updateAudioState(AUDIO_STATE.LOCKED);
            } else {
                console.error('[Queue] Play Error:', err);
                activeAudioTask = null;
                updateAudioState(AUDIO_STATE.FAILED);
                confirmDelivery(false);
            }
            settle(500);
        });
    } catch (e) {
        if (generation !== playbackGeneration) return;
        console.error('[Queue] Unexpected Error:', e);
        activeAudioTask = null;
        updateAudioState(AUDIO_STATE.FAILED);
        confirmDelivery(false);
        settle(500);
    }
}

function confirmTask(task, success) {
    if (task.deliveryConfirmed) return;
    task.deliveryConfirmed = true;
    task.onDelivered?.(success);
}

/**
 * Map Arabic Name to Audio File Prefix
 * UPDATED: Added Hossam ( حـسام ) -> 'a'
 */
function getEngineerPrefix(teamName) {
    return getEngineerAudioPrefix(teamName);
}

// ========================================
// 🔔 Visual Toast Notifications
// ========================================

const TOAST_DURATION = 15000; // 15 seconds

export function showToast({ title, message, level = 'info', icon = '🔔' }) {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `notification-toast ${level}`;

    const iconMap = {
        'info': 'info',
        'warning': 'alert-triangle',
        'critical': 'alert-circle'
    };
    const lucideIcon = iconMap[level] || 'bell';

    toast.innerHTML = `
    <span class="toast-icon"><i data-lucide="${lucideIcon}"></i></span>
    <div class="toast-body">
      <div class="toast-title"></div>
      <div class="toast-message"></div>
    </div>
    <button class="toast-close" type="button" aria-label="إغلاق التنبيه">✕</button>
  `;

    toast.querySelector('.toast-title').textContent = title;
    toast.querySelector('.toast-message').textContent = message;
    toast.querySelector('.toast-close').addEventListener('click', () => {
        toast.classList.add('exiting');
        setTimeout(() => toast.remove(), 300);
    });

    container.prepend(toast);

    createIcons({ root: container, icons: { AlertCircle, AlertTriangle, Bell, Info } });
    container.querySelectorAll('svg[data-lucide]').forEach(icon => icon.removeAttribute('data-lucide'));

    setTimeout(() => {
        if (toast.parentElement) {
            toast.classList.add('exiting');
            setTimeout(() => toast.remove(), 300);
        }
    }, TOAST_DURATION);
}

// ========================================
// ⏰ Meeting Timer / Notification Engine
// ========================================

const triggeredNotifications = new Set(loadDeliveredNotifications());
const pendingNotifications = new Set();
let lastNotifiedDate = formatTodayDate();

function loadDeliveredNotifications() {
    try {
        const stored = JSON.parse(localStorage.getItem(DELIVERED_STORAGE_KEY) || '{}');
        const today = formatTodayDate();
        return stored.date === today && Array.isArray(stored.keys) ? stored.keys : [];
    } catch {
        return [];
    }
}

function persistDeliveredNotifications() {
    try {
        localStorage.setItem(DELIVERED_STORAGE_KEY, JSON.stringify({
            date: formatTodayDate(),
            keys: [...triggeredNotifications]
        }));
    } catch (error) {
        console.warn('[Audio] Could not persist delivered reminders:', error);
    }
}

function getStartedPlayCounts() {
    try {
        const stored = JSON.parse(localStorage.getItem(PLAY_COUNTS_STORAGE_KEY) || '{}');
        return stored.date === formatTodayDate() && stored.counts && typeof stored.counts === 'object'
            ? stored.counts
            : {};
    } catch {
        return {};
    }
}

function getMaxStartedCount(keys = []) {
    const counts = getStartedPlayCounts();
    return keys.reduce((highest, key) => Math.max(highest, Number(counts[key]) || 0), 0);
}

function recordStartedPlay(task) {
    const keys = task.deliveryKeys || [];
    if (!keys.length) return;
    const counts = getStartedPlayCounts();
    for (const key of keys) counts[key] = (Number(counts[key]) || 0) + 1;
    try {
        localStorage.setItem(PLAY_COUNTS_STORAGE_KEY, JSON.stringify({ date: formatTodayDate(), counts }));
    } catch (error) {
        console.warn('[Audio] Could not persist reminder playback:', error);
    }
}

function isReminderStillValid(reminder, allowExhausted = false) {
    const meeting = latestMeetingsById.get(reminder.meetingId);
    if (!meeting || meeting.date !== formatTodayDate() || !meeting.time || isDone(meeting) || isCancelled(meeting)) return false;
    if (!allowExhausted && (getStartedPlayCounts()[reminder.key] || 0) >= 2) return false;

    const [hours, minutes] = meeting.time.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return false;
    const now = getCurrentTimeParts(new Date());
    const diffSeconds = hours * 3600 + minutes * 60 - (now.hours * 3600 + now.minutes * 60 + now.seconds);
    return shouldTriggerAlert(diffSeconds, reminder.minutesType * 60, ALERT_CATCHUP_MS);
}

function cancelObsoleteQueuedReminders() {
    for (let index = playQueue.length - 1; index >= 0; index--) {
        const task = playQueue[index];
        if (!task.reminders?.length) continue;
        const valid = task.reminders.filter(reminder => isReminderStillValid(reminder));
        const validKeys = new Set(valid.map(reminder => reminder.key));
        for (const reminder of task.reminders) {
            if (!validKeys.has(reminder.key)) pendingNotifications.delete(reminder.key);
        }
        if (!valid.length) {
            playQueue.splice(index, 1);
            confirmTask(task, false);
            continue;
        }
        task.reminders = valid;
        task.deliveryKeys = valid.map(reminder => reminder.key);
    }
}

function refreshDeliveredFromStorage(value) {
    try {
        const stored = JSON.parse(value || '{}');
        triggeredNotifications.clear();
        if (stored.date === formatTodayDate() && Array.isArray(stored.keys)) {
            for (const key of stored.keys) triggeredNotifications.add(key);
        }
    } catch {
        // Ignore malformed data written by an interrupted older version.
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener('storage', event => {
        if (event.key === DELIVERED_STORAGE_KEY) refreshDeliveredFromStorage(event.newValue);
        if (event.key === AUDIO_LEASE_KEY && isAudioLeader) {
            try {
                const lease = JSON.parse(event.newValue || '{}');
                if (lease.id !== audioTabId) isAudioLeader = false;
            } catch {
                isAudioLeader = false;
            }
        }
    });
}

const notificationAttempts = new Map();
const notificationRetryAt = new Map();

function canAttemptNotification(key) {
    const now = Date.now();
    if ((notificationRetryAt.get(key) || 0) > now) return false;
    const attempts = (notificationAttempts.get(key) || 0) + 1;
    if (attempts > 3) return false;
    notificationAttempts.set(key, attempts);
    notificationRetryAt.set(key, now + 30000);
    return true;
}

function markNotificationDelivered(key, success = true) {
    pendingNotifications.delete(key);
    if (success) {
        triggeredNotifications.add(key);
        notificationAttempts.delete(key);
        notificationRetryAt.delete(key);
        persistDeliveredNotifications();
    }
}

export function checkMeetingTimers(meetings, todayDate) {
    updateReminderMeetings(meetings);
    if (!getSettings().soundEnabled) return;

    const today = todayDate;
    if (lastNotifiedDate !== today) {
        triggeredNotifications.clear();
        pendingNotifications.clear();
        notificationAttempts.clear();
        notificationRetryAt.clear();
        lastNotifiedDate = today;
        persistDeliveredNotifications();
    }

    const now = new Date();
    const nowParts = getCurrentTimeParts(now);
    const nowSeconds = nowParts.hours * 3600 + nowParts.minutes * 60 + nowParts.seconds;
    const todayMeetings = meetings.filter(m => m.date === todayDate && m.time && !isDone(m) && !isCancelled(m));
    const engineerGroups = new Map();

    for (const meeting of todayMeetings) {
        const [h, min] = meeting.time.split(':').map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(min)) continue;
        const meetingSeconds = h * 3600 + min * 60;
        const diffSeconds = meetingSeconds - nowSeconds;
        const prefix = getEngineerPrefix(meeting.team);
        const engineerProfile = getEngineerProfile(meeting.team);
        const engineerKey = engineerProfile?.id || String(meeting.team || 'unknown')
            .normalize('NFKD')
            .replace(/[\u064B-\u065F\u0670]/g, '')
            .trim()
            .toLowerCase();
        for (const minutesType of MEETING_REMINDER_MINUTES) {
            if (!shouldTriggerAlert(diffSeconds, minutesType * 60, ALERT_CATCHUP_MS)) continue;
            const key = `${meeting.id}_${minutesType}min`;
            if (triggeredNotifications.has(key) || pendingNotifications.has(key)
                || getStartedPlayCounts()[key] >= 2 || !canAttemptNotification(key)) continue;
            // Collapse only genuinely simultaneous meetings for this engineer.
            // Separate meetings can become due in the same catch-up window and
            // must retain their own reminder.
            const groupKey = `${engineerKey}:${meetingSeconds}:${minutesType}`;
            const list = engineerGroups.get(groupKey) || [];
            list.push({ meeting, meetingId: meeting.id, prefix, minutesType, diff: Math.max(0, Math.round(diffSeconds / 60)), key });
            engineerGroups.set(groupKey, list);
        }
    }

    // One reminder per engineer, start time, and alert stage. Simultaneous
    // meetings share a single spoken call and a single toast/push notification.
    for (const candidates of engineerGroups.values()) {
        candidates.sort((a, b) => a.minutesType - b.minutesType || a.diff - b.diff);
        const selected = candidates[0];
        for (const item of candidates) pendingNotifications.add(item.key);
        const onDelivered = success => candidates.forEach(item => markNotificationDelivered(item.key, success));
        const queued = triggerAlert(selected.meeting, selected.prefix, selected.minutesType, selected.diff, onDelivered, candidates);
        if (!queued) {
            // Muted audio or an unknown engineer is an intentional no-audio result.
            const intentionalSilence = !selected.prefix;
            onDelivered(intentionalSilence);
        }
    }
}

export function updateReminderMeetings(meetings = []) {
    latestMeetingsById = new Map(meetings.map(meeting => [meeting.id, meeting]));
    cancelObsoleteQueuedReminders();
}

/** Returns the next undelivered spoken reminder so the sidebar can expose it. */
export function getNextAudioReminder(meetings, todayDate) {
    if (!getSettings().soundEnabled) return { state: 'muted' };

    const nowParts = getCurrentTimeParts(new Date());
    const nowSeconds = nowParts.hours * 3600 + nowParts.minutes * 60 + nowParts.seconds;
    const candidates = [];

    for (const meeting of meetings.filter(item => item.date === todayDate && item.time && !isDone(item) && !isCancelled(item))) {
        const [hours, minutes] = meeting.time.split(':').map(Number);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) continue;
        const diffSeconds = (hours * 3600 + minutes * 60) - nowSeconds;

        for (const minutesType of MEETING_REMINDER_MINUTES) {
            const key = `${meeting.id}_${minutesType}min`;
            if (triggeredNotifications.has(key) || pendingNotifications.has(key) || getStartedPlayCounts()[key] >= 2) continue;
            const secondsUntil = diffSeconds - minutesType * 60;
            if (secondsUntil < -(ALERT_CATCHUP_MS / 1000)) continue;
            candidates.push({ meeting, minutesType, secondsUntil: Math.max(0, secondsUntil) });
        }
    }

    candidates.sort((a, b) => a.secondsUntil - b.secondsUntil || a.minutesType - b.minutesType);
    return candidates[0] ? { state: 'scheduled', ...candidates[0] } : { state: 'none' };
}
function triggerAlert(meeting, prefix, minutesType, diff, onDelivered, reminders = []) {
    let audioQueued = false;
    if (prefix) {
        const filename = `${prefix}${minutesType}.mp3`;
        audioQueued = enqueueAudio({
            filename,
            meetingId: meeting.id,
            minutesType,
            reminders,
            deliveryKeys: reminders.map(reminder => reminder.key),
            // A simultaneous pair is one call; a single meeting keeps the
            // existing two-play reminder behavior.
            repetitionsRemaining: reminders.length > 1 ? 1 : 2,
            onDelivered: success => {
                const validKeys = new Set(reminders.filter(reminder => isReminderStillValid(reminder, true)).map(reminder => reminder.key));
                for (const item of reminders) {
                    if (validKeys.has(item.key)) markNotificationDelivered(item.key, success);
                    else pendingNotifications.delete(item.key);
                }
            }
        });
    } else {
        console.warn(`[Audio] No mapping found for engineer: "${meeting.team}" (id: ${meeting.id}). Skipping sound.`);
    }

    const timeText = diff <= 1 ? 'سيبدأ الآن' : `بعد ${diff} دقيقة`;
    let level = 'info';
    let icon = 'bell';

    if (minutesType === 5) {
        level = 'warning';
        icon = 'alert-triangle';
    }

    showToast({
        title: meeting.project || 'تنبيه اجتماع',
        message: `${meeting.team || ''} — ${timeText}`,
        level,
        icon
    });

    sendPushNotification(meeting, timeText);
    return audioQueued;
}

function sendPushNotification(meeting, timeText) {
    if (!("Notification" in window)) return;

    if (Notification.permission === "granted") {
        new Notification(`تنبيه: ${meeting.project}`, {
            body: `${meeting.team || 'الفريق'} - ${timeText}`,
            silent: currentAudioState === AUDIO_STATE.ENABLED
        });
    }
}

// ========================================
// 🔁 Timer Loop
// ========================================

let timerInterval = null;
let visibilityListener = null;

function setAudioLeader(active) {
    isAudioLeader = active;
    if (active) {
        runNotificationTick();
        return;
    }
    if (leaseRenewInterval) clearInterval(leaseRenewInterval);
    leaseRenewInterval = null;
    if (leaseConfirmationTimeout) clearTimeout(leaseConfirmationTimeout);
    leaseConfirmationTimeout = null;
}

function readAudioLease() {
    try {
        return JSON.parse(localStorage.getItem(AUDIO_LEASE_KEY) || '{}');
    } catch {
        return {};
    }
}

function acquireFallbackAudioLease() {
    const current = readAudioLease();
    if (current.expiresAt > Date.now() && current.id !== audioTabId) return;

    try {
        localStorage.setItem(AUDIO_LEASE_KEY, JSON.stringify({ id: audioTabId, expiresAt: Date.now() + AUDIO_LEASE_MS }));
        if (leaseConfirmationTimeout) clearTimeout(leaseConfirmationTimeout);
        leaseConfirmationTimeout = setTimeout(() => {
            if (readAudioLease().id !== audioTabId) return;
            setAudioLeader(true);
            if (!leaseRenewInterval) {
                leaseRenewInterval = setInterval(() => {
                    const lease = readAudioLease();
                    if (lease.id !== audioTabId) {
                        setAudioLeader(false);
                        return;
                    }
                    localStorage.setItem(AUDIO_LEASE_KEY, JSON.stringify({ id: audioTabId, expiresAt: Date.now() + AUDIO_LEASE_MS }));
                }, 4000);
            }
        }, 100);
    } catch (error) {
        console.warn('[Audio] Cross-tab coordination is unavailable:', error);
    }
}

function tryAcquireAudioLeadership() {
    if (isAudioLeader || currentAudioState !== AUDIO_STATE.ENABLED || !getSettings().soundEnabled) return;
    if (!globalThis.navigator?.locks?.request) {
        acquireFallbackAudioLease();
        return;
    }

    globalThis.navigator.locks.request(AUDIO_LEADER_LOCK, { ifAvailable: true }, async lock => {
        if (!lock) return;
        setAudioLeader(true);
        await new Promise(resolve => { releaseWebAudioLock = resolve; });
        releaseWebAudioLock = null;
        setAudioLeader(false);
    }).catch(error => {
        console.warn('[Audio] Lock API failed; using a local lease:', error);
        acquireFallbackAudioLease();
    });
}

function releaseAudioLeadership() {
    releaseWebAudioLock?.();
    releaseWebAudioLock = null;
    if (leaseRenewInterval) clearInterval(leaseRenewInterval);
    leaseRenewInterval = null;
    const lease = readAudioLease();
    if (lease.id === audioTabId) localStorage.removeItem(AUDIO_LEASE_KEY);
    setAudioLeader(false);
}

function hasCurrentAudioLeadership() {
    if (!isAudioLeader) return false;
    if (globalThis.navigator?.locks?.request) return true;
    const lease = readAudioLease();
    return lease.id === audioTabId && lease.expiresAt > Date.now();
}

function runNotificationTick() {
    if (isAudioLeader) {
        const meetings = latestMeetingsById.size ? [...latestMeetingsById.values()] : [];
        checkMeetingTimers(meetings, formatTodayDate());
    }
}

function stopNotificationLoop() {
    if (timerInterval) clearInterval(timerInterval);
    if (leaderRetryInterval) clearInterval(leaderRetryInterval);
    if (visibilityListener) document.removeEventListener('visibilitychange', visibilityListener);
    timerInterval = null;
    leaderRetryInterval = null;
    visibilityListener = null;
    releaseWebAudioLock?.();
    releaseWebAudioLock = null;
    setAudioLeader(false);
    const lease = readAudioLease();
    if (lease.id === audioTabId) localStorage.removeItem(AUDIO_LEASE_KEY);
}

export function startNotificationLoop(getMeetings, getTodayDate, onTick) {
    stopNotificationLoop();

    const tick = () => {
        if (isAudioLeader) {
            if (!getSettings().soundEnabled) {
                stopAudioPlayback();
                onTick?.();
                return;
            }
            const meetings = getMeetings();
            latestMeetingsById = new Map(meetings.map(meeting => [meeting.id, meeting]));
            checkMeetingTimers(meetings, getTodayDate());
        }
        onTick?.();
    };

    runNotificationTick = tick;
    timerInterval = setInterval(tick, 10 * 1000);
    leaderRetryInterval = setInterval(tryAcquireAudioLeadership, 3000);
    visibilityListener = () => {
        if (document.visibilityState === 'visible') {
            tryAcquireAudioLeadership();
            tick();
        }
    };
    document.addEventListener('visibilitychange', visibilityListener);

    tryAcquireAudioLeadership();
    return stopNotificationLoop;
}

export function requestNotificationPermission() {
    if (!("Notification" in window)) return Promise.resolve('unsupported');
    if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
    return Notification.requestPermission().then(permission => {
        console.log('🔔 Notification permission:', permission);
        return permission;
    });
}
