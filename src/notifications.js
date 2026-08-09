/**
 * notifications.js — Notification engine: timers, sound alerts (file-based), visual toasts
 * REFACTORED: Audio Queue System + Performance Cleanup
 */

import { getSettings, isDone, isCancelled, getCurrentTimeParts, formatTodayDate } from './data.js';
import { getEngineerAudioPrefix } from './config.js';
import { createIcons, AlertCircle, AlertTriangle, Bell, Info } from 'lucide';
import { ALERT_CATCHUP_MS, shouldTriggerAlert } from './alert-timing.js';

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
let _audioCtx = null;
let retainedAudioPlayer = null;
const SILENT_AUDIO = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';

// Track recently warned meetings to avoid spamming fallbacks
const recentlyWarnedMeetings = new Map(); // id -> timestamp
const DELIVERED_STORAGE_KEY = 'aait_delivered_notifications';
const AUDIO_FILES = ['a30.mp3', 'a5.mp3', 'm30.mp3', 'm5.mp3', 's30.mp3', 's5.mp3'];

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
}

/**
 * "Unlock" audio context. Called from user interaction.
 */
export function unlockAudio() {
    if (currentAudioState === AUDIO_STATE.ENABLED || _audioCtx) return;

    try {
        retainedAudioPlayer ||= new Audio();
        retainedAudioPlayer.preload = 'auto';
        retainedAudioPlayer.src = SILENT_AUDIO;
        const mediaUnlock = retainedAudioPlayer.play().then(() => {
            retainedAudioPlayer.pause();
            retainedAudioPlayer.currentTime = 0;
        });

        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const contextUnlock = _audioCtx.state === 'running' ? Promise.resolve() : _audioCtx.resume();

        Promise.all([mediaUnlock, contextUnlock]).then(() => {
            updateAudioState(AUDIO_STATE.ENABLED);
            _audioCtx.close();
            _audioCtx = null;
            preloadAudioFiles();
            processQueue();
        }).catch(() => {
            updateAudioState(AUDIO_STATE.FAILED);
            _audioCtx?.close?.();
            _audioCtx = null;
        });
    } catch (e) {
        _audioCtx = null;
        const silent = retainedAudioPlayer || new Audio();
        retainedAudioPlayer = silent;
        silent.src = SILENT_AUDIO;
        const fallback = setTimeout(() => {
            updateAudioState(AUDIO_STATE.ENABLED);
            processQueue();
        }, 300);
        silent.onended = () => { clearTimeout(fallback); updateAudioState(AUDIO_STATE.ENABLED); processQueue(); };
        silent.play().catch(() => { clearTimeout(fallback); updateAudioState(AUDIO_STATE.FAILED); });
    }
}

function preloadAudioFiles() {
    for (const filename of AUDIO_FILES) {
        const audio = new Audio(`/sounds/${filename}`);
        audio.preload = 'auto';
        audio.load();
    }
}

export function playTestAlert() {
    enqueueAudio({ filename: 'm5.mp3', meetingId: 'audio-test' });
}

/**
 * Add audio task to queue
 */
function enqueueAudio(task) {
    const { soundEnabled } = getSettings();
    if (!soundEnabled) return false;

    console.log(`[Queue] Queued: ${task.filename || task}`);
    playQueue.push({
        ...task,
        repetitionsRemaining: Math.max(1, task.repetitionsRemaining || 2),
        deliveryConfirmed: false
    });
    processQueue();
    return true;
}

/**
 * Process the Audio Queue (STRICT MODE: Files Only)
 */
async function processQueue() {
    if (isPlaying || playQueue.length === 0) return;
    
    if (currentAudioState !== AUDIO_STATE.ENABLED) {
        console.warn('[Queue] Waiting for Audio Unlock...');
        return;
    }

    let safetyTimeout = null;
    const finish = (delay = 2000) => {
        if (safetyTimeout) clearTimeout(safetyTimeout);
        setTimeout(() => {
            isPlaying = false;
            processQueue();
        }, delay);
    };

    isPlaying = true;
    const task = playQueue.shift();
    const filename = task.filename || task;
    let settled = false;

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

    safetyTimeout = setTimeout(() => {
        console.warn('[Queue] Safety timeout — skipping stalled audio task');
        retainedAudioPlayer?.pause?.();
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
            console.log('[Queue] Stage: Completed');
            confirmDelivery(true);
            if (task.repetitionsRemaining > 1) {
                playQueue.unshift({
                    ...task,
                    repetitionsRemaining: task.repetitionsRemaining - 1,
                    deliveryConfirmed: true
                });
                settle(2500);
            } else {
                settle(500);
            }
        };

        audio.onerror = () => {
            console.error(`[Queue] Stage: Failed (File NOT FOUND: ${filename}). Skipping.`);
            confirmDelivery(false);
            settle(0);
        };

        await audio.play().catch((err) => {
            if (err.name === 'NotAllowedError') {
                playQueue.unshift(task);
                updateAudioState(AUDIO_STATE.LOCKED);
            } else {
                console.error('[Queue] Play Error:', err);
                confirmDelivery(false);
            }
            settle(500);
        });
    } catch (e) {
        console.error('[Queue] Unexpected Error:', e);
        confirmDelivery(false);
        settle(500);
    }
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

    createIcons({ icons: { AlertCircle, AlertTriangle, Bell, Info } });

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
    localStorage.setItem(DELIVERED_STORAGE_KEY, JSON.stringify({
        date: formatTodayDate(),
        keys: [...triggeredNotifications]
    }));
}

function markNotificationDelivered(key) {
    pendingNotifications.delete(key);
    triggeredNotifications.add(key);
    persistDeliveredNotifications();
}

export function checkMeetingTimers(meetings, todayDate) {
    // يُمسح عند تغيير اليوم فقط
    const today = todayDate;
    if (lastNotifiedDate !== today) {
        triggeredNotifications.clear();
        pendingNotifications.clear();
        lastNotifiedDate = today;
        persistDeliveredNotifications();
    }

    const now = new Date();
    const nowParts = getCurrentTimeParts(now);
    const nowSeconds = nowParts.hours * 3600 + nowParts.minutes * 60 + nowParts.seconds;

    const todayMeetings = meetings.filter(m => m.date === todayDate && m.time);

    for (const meeting of todayMeetings) {
        if (isDone(meeting) || isCancelled(meeting)) continue;

        const [h, min] = meeting.time.split(':').map(Number);
        if (isNaN(h) || isNaN(min)) continue;

        const meetingSeconds = h * 3600 + min * 60;
        const diffSeconds = meetingSeconds - nowSeconds;

        const prefix = getEngineerPrefix(meeting.team);

        if (shouldTriggerAlert(diffSeconds, 30 * 60, ALERT_CATCHUP_MS)) {
            const key = `${meeting.id}_30min`;
            if (!triggeredNotifications.has(key) && !pendingNotifications.has(key)) {
                pendingNotifications.add(key);
                const queued = triggerAlert(meeting, prefix, 30, Math.max(0, Math.round(diffSeconds / 60)), () => markNotificationDelivered(key));
                if (!queued) markNotificationDelivered(key);
            }
        }

        if (shouldTriggerAlert(diffSeconds, 5 * 60, ALERT_CATCHUP_MS)) {
            const key = `${meeting.id}_5min`;
            if (!triggeredNotifications.has(key) && !pendingNotifications.has(key)) {
                pendingNotifications.add(key);
                const queued = triggerAlert(meeting, prefix, 5, Math.max(0, Math.round(diffSeconds / 60)), () => markNotificationDelivered(key));
                if (!queued) markNotificationDelivered(key);
            }
        }
    }
}

function triggerAlert(meeting, prefix, minutesType, diff, onDelivered) {
    let audioQueued = false;
    if (prefix) {
        const filename = `${prefix}${minutesType}.mp3`;
        audioQueued = enqueueAudio({ filename, meetingId: meeting.id, repetitionsRemaining: 2, onDelivered });
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

export function startNotificationLoop(getMeetings, getTodayDate, onTick) {
    if (timerInterval) clearInterval(timerInterval);

    // لوب كل 10 ثواني لدقة ±10 ثواني بدل من ±30 ثانية
    timerInterval = setInterval(() => {
        const meetings = getMeetings();
        const today = getTodayDate();
        checkMeetingTimers(meetings, today);
        if (onTick) onTick();
    }, 10 * 1000);

    const meetings = getMeetings();
    const today = getTodayDate();
    checkMeetingTimers(meetings, today);
}

export function requestNotificationPermission() {
    if (!("Notification" in window)) return Promise.resolve('unsupported');
    if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
    return Notification.requestPermission().then(permission => {
        console.log('🔔 Notification permission:', permission);
        return permission;
    });
}
