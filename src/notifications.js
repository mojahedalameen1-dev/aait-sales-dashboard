/**
 * notifications.js — Notification engine: timers, sound alerts (file-based), visual toasts
 * REFACTORED: Audio Queue System + Performance Cleanup
 */

import { getSettings, isDone, isCancelled } from './data.js';
import { getEngineerAudioPrefix, getEngineerProfile } from './config.js';
import { createIcons, AlertCircle, AlertTriangle, Bell, Info } from 'lucide';
import { ALERT_CATCHUP_MS, MEETING_REMINDER_MINUTES, shouldTriggerAlert } from './alert-timing.js';
import { AUDIO_STATE, createAudioDelivery } from './audio-delivery.js';

export { AUDIO_STATE };
const DELIVERED_STORAGE_KEY = 'aait_delivered_notifications';
const AUDIO_LEADER_LOCK = 'aait-notification-audio-leader';
const AUDIO_LEASE_KEY = 'aait_notification_audio_lease';
const AUDIO_LEASE_MS = 12000;
const audioTabId = globalThis.crypto?.randomUUID?.() || 'tab-' + Date.now() + '-' + Math.random();
let audioOwner = false;
let leaderRequestPending = false;
let releaseWebAudioLock = null;
let leaseConfirmation;
let usingLease = false;
let latestMeetingsById = new Map();
let onStateChange = () => {};
let timerInterval = null;
let loop = null;

const delivery = createAudioDelivery({
    canOwnAudio: isAudioDeliveryOwner,
    isEnabled: () => getSettings().soundEnabled,
    onState(state) {
        onStateChange(state);
        if (state === AUDIO_STATE.ENABLED) tryAcquireAudioLeadership();
    }
});

export function setAudioStateListener(listener) { onStateChange = listener || (() => {}); }
export function unlockAudio(options) { return delivery.unlock(options); }
export function stopAudioPlayback() { delivery.stop(); releaseAudioLeadership(); }
export function suspendAudioPlayback() { delivery.suspend(); releaseAudioLeadership(); }
export function reportAudioDiagnostic(event, details) { delivery.report(event, details); }
export function isAudioPlaybackEnabled() { return delivery.state === AUDIO_STATE.ENABLED && getSettings().soundEnabled; }
export function isAudioDeliveryOwner() {
    if (!loop) return true;
    if (!audioOwner || delivery.suspended) return false;
    if (!usingLease) return true;
    const lease = readAudioLease();
    return lease.id === audioTabId && lease.expiresAt > Date.now();
}
export function hasCompletedAudio(id, repetitions = 2) { return (delivery.getProgress(id)?.completed || 0) >= repetitions; }

export function resumeAudioPlayback(options) {
    delivery.wake(options);
    tryAcquireAudioLeadership();
    runNotificationTick();
}

export function playTestAlert(onResult, { onStarted, onDeferred } = {}) {
    return delivery.enqueue('routine', { clipUrl: '/sounds/m5.mp3', expiresAt: Date.now() + 90000, onStarted, onDeferred })
        .then(result => {
            onResult?.(result.completedRepetitions === 2);
            return result;
        });
}

export function playAnnouncementAudio(audioBlobOrLoader, options = {}) {
    return delivery.enqueue('admin', { ...options, loadRecording: () => typeof audioBlobOrLoader === 'function' ? audioBlobOrLoader() : audioBlobOrLoader });
}

export function playPrayerAnnouncement(audioBlobOrLoader, options = {}) {
    return delivery.enqueue('prayer', { ...options, loadRecording: () => typeof audioBlobOrLoader === 'function' ? audioBlobOrLoader() : audioBlobOrLoader });
}

export function getPriorityAudioState() {
    return { active: delivery.activeLevel, queued: delivery.queuedCount };
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

const triggeredNotifications = new Set();
const attemptedNotifications = new Set();
const pendingNotifications = new Set();
let lastNotifiedDate = null;

function reloadDelivered(date) {
    try {
        const stored = JSON.parse(localStorage.getItem(DELIVERED_STORAGE_KEY) || '{}');
        if (stored.date === date && Array.isArray(stored.keys)) {
            for (const key of stored.keys) triggeredNotifications.add(key);
        }
    } catch { /* Storage can be unavailable. */ }
}

function persistDeliveredNotifications(date) {
    try {
        reloadDelivered(date);
        localStorage.setItem(DELIVERED_STORAGE_KEY, JSON.stringify({ date, keys: [...triggeredNotifications] }));
    } catch { /* Current-tab dedupe remains active. */ }
}

function updateNotificationDate(date) {
    if (lastNotifiedDate === date) return;
    lastNotifiedDate = date;
    triggeredNotifications.clear();
    attemptedNotifications.clear();
    pendingNotifications.clear();
    reloadDelivered(date);
}

function getMeetingAudioGroup(meeting, todayDate, minutesType) {
    const [hours, minutes] = (meeting.time || '').split(':').map(Number);
    if (!Number.isInteger(hours) || hours < 0 || hours > 23 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;
    const startSeconds = hours * 3600 + minutes * 60;
    const start = Date.parse(todayDate.replaceAll('/', '-') + 'T00:00:00+03:00') + startSeconds * 1000;
    if (!Number.isFinite(start)) return null;
    const engineer = getEngineerProfile(meeting.team);
    const engineerKey = engineer?.id || 'unknown';
    const dueAt = start - minutesType * 60000;
    return {
        start, dueAt, expiresAt: dueAt + ALERT_CATCHUP_MS, prefix: getEngineerAudioPrefix(meeting.team),
        id: 'meeting:' + todayDate + ':' + engineerKey + ':' + startSeconds + ':' + minutesType
    };
}

function isMeetingReminderRelevant(meeting, group, date, minutesType) {
    const current = latestMeetingsById.get(meeting.id);
    return current?.date === date && !isDone(current) && !isCancelled(current)
        && getMeetingAudioGroup(current, date, minutesType)?.id === group.id;
}

export function checkMeetingTimers(meetings, todayDate, now = Date.now()) {
    latestMeetingsById = new Map(meetings.map(item => [item.id, item]));
    if (!getSettings().soundEnabled || !isAudioDeliveryOwner() || delivery.suspended) return;
    updateNotificationDate(todayDate);
    const groups = new Map();
    for (const meeting of meetings) {
        if (meeting.date !== todayDate || !meeting.time || isDone(meeting) || isCancelled(meeting)) continue;
        for (const minutesType of MEETING_REMINDER_MINUTES) {
            const group = getMeetingAudioGroup(meeting, todayDate, minutesType);
            if (!group || !shouldTriggerAlert((group.start - now) / 1000, minutesType * 60, ALERT_CATCHUP_MS)) continue;
            if (!groups.has(group.id)) groups.set(group.id, { ...group, minutesType, meetings: [] });
            groups.get(group.id).meetings.push(meeting);
        }
    }

    for (const group of groups.values()) {
        if (attemptedNotifications.has(group.id)) continue;
        const { meetings: items, minutesType } = group;
        const repetitions = items.length > 1 ? 1 : 2;
        if (items.every(item => triggeredNotifications.has(item.id + '_' + minutesType + 'min'))
            || hasCompletedAudio(group.id, repetitions)) continue;
        attemptedNotifications.add(group.id);
        const meeting = items[0];
        showMeetingReminder(meeting, minutesType, Math.max(0, Math.round((group.start - now) / 60000)));
        if (!group.prefix) continue;
        pendingNotifications.add(group.id);
        void delivery.enqueue('routine', {
            id: group.id, expiresAt: group.expiresAt, repetitions, clipUrl: '/sounds/' + group.prefix + minutesType + '.mp3',
            isRelevant: () => items.some(item => isMeetingReminderRelevant(item, group, todayDate, minutesType)),
            onCompleted() {
                if (lastNotifiedDate !== todayDate) return;
                for (const item of items) {
                    if (isMeetingReminderRelevant(item, group, todayDate, minutesType)) {
                        triggeredNotifications.add(item.id + '_' + minutesType + 'min');
                    }
                }
                persistDeliveredNotifications(todayDate);
            }
        }).finally(() => pendingNotifications.delete(group.id));
    }
}

export function updateReminderMeetings(meetings = []) {
    latestMeetingsById = new Map(meetings.map(item => [item.id, item]));
    runNotificationTick();
    delivery.kick();
}

/** Returns the next undelivered spoken reminder so the sidebar can expose it. */
export function getNextAudioReminder(meetings, todayDate) {
    if (!getSettings().soundEnabled) return { state: 'muted' };

    updateNotificationDate(todayDate);
    const now = Date.now();
    const candidates = [];
    for (const meeting of meetings) {
        if (meeting.date !== todayDate || !meeting.time || isDone(meeting) || isCancelled(meeting)) continue;
        for (const minutesType of MEETING_REMINDER_MINUTES) {
            const group = getMeetingAudioGroup(meeting, todayDate, minutesType);
            if (!group?.prefix || group.expiresAt <= now || (attemptedNotifications.has(group.id) && !pendingNotifications.has(group.id))
                || triggeredNotifications.has(meeting.id + '_' + minutesType + 'min')) continue;
            candidates.push({ meeting, minutesType, secondsUntil: Math.max(0, Math.ceil((group.dueAt - now) / 1000)) });
        }
    }
    candidates.sort((a, b) => a.secondsUntil - b.secondsUntil || a.minutesType - b.minutesType);
    return candidates[0] ? { state: 'scheduled', ...candidates[0] } : { state: 'none' };
}

function showMeetingReminder(meeting, minutesType, diff) {

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
}

function sendPushNotification(meeting, timeText) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
        // The notification system must not be a second audio player.
        new Notification('تنبيه: ' + meeting.project, { body: (meeting.team || 'الفريق') + ' - ' + timeText, silent: true });
    } catch { /* Desktop notifications are optional. */ }
}

function readAudioLease() {
    try { return JSON.parse(localStorage.getItem(AUDIO_LEASE_KEY) || '{}'); }
    catch { return {}; }
}

function setAudioOwner(active) {
    if (audioOwner !== active) reportAudioDiagnostic(active ? 'owner_acquired' : 'owner_released');
    audioOwner = active;
    if (active) {
        if (loop) reloadDelivered(loop.getTodayDate());
        runNotificationTick();
    }
    delivery.kick();
}

function tryAcquireAudioLeadership() {
    if (!loop || delivery.suspended || !getSettings().soundEnabled) return;
    if (delivery.state === AUDIO_STATE.LOCKED && !audioOwner) return;
    if (!usingLease && globalThis.navigator?.locks?.request) {
        if (audioOwner || leaderRequestPending) return;
        leaderRequestPending = true;
        void navigator.locks.request(AUDIO_LEADER_LOCK, { ifAvailable: true }, async lock => {
            if (!lock || !loop || delivery.suspended || delivery.state === AUDIO_STATE.LOCKED) return;
            const hold = new Promise(resolve => { releaseWebAudioLock = resolve; });
            setAudioOwner(true);
            await hold;
            releaseWebAudioLock = null;
            setAudioOwner(false);
        }).catch(() => {
            reportAudioDiagnostic('lock_unavailable');
            usingLease = true;
            if (loop && !delivery.suspended) keepAudioLease();
        }).finally(() => { leaderRequestPending = false; });
        return;
    }
    usingLease = true;
    keepAudioLease();
}

function keepAudioLease() {
    const lease = readAudioLease();
    if (lease.id !== audioTabId && lease.expiresAt > Date.now()) {
        if (audioOwner) {
            delivery.suspend();
            setAudioOwner(false);
            delivery.wake();
        }
        return;
    }
    try {
        localStorage.setItem(AUDIO_LEASE_KEY, JSON.stringify({ id: audioTabId, expiresAt: Date.now() + AUDIO_LEASE_MS }));
        if (!audioOwner && !leaseConfirmation) leaseConfirmation = setTimeout(() => {
            leaseConfirmation = null;
            if (!delivery.suspended && loop && readAudioLease().id === audioTabId) setAudioOwner(true);
        }, 120);
    } catch {
        reportAudioDiagnostic('lease_unavailable');
    }
}

function releaseAudioLeadership() {
    clearTimeout(leaseConfirmation);
    leaseConfirmation = null;
    if (audioOwner) setAudioOwner(false);
    releaseWebAudioLock?.();
    try {
        if (readAudioLease().id === audioTabId) localStorage.removeItem(AUDIO_LEASE_KEY);
    } catch { /* Storage can be unavailable. */ }
}

globalThis.window?.addEventListener?.('storage', event => {
    if (event.key !== AUDIO_LEASE_KEY || !usingLease || !audioOwner || isAudioDeliveryOwner()) return;
    delivery.suspend();
    setAudioOwner(false);
    delivery.wake();
});

function runNotificationTick() {
    if (loop && audioOwner && !delivery.suspended) checkMeetingTimers(loop.getMeetings(), loop.getTodayDate());
}

export function startNotificationLoop(getMeetings, getTodayDate, onTick) {
    if (timerInterval) clearInterval(timerInterval);
    loop = { getMeetings, getTodayDate };
    timerInterval = setInterval(() => {
        if (!getSettings().soundEnabled && delivery.state !== AUDIO_STATE.LOCKED) stopAudioPlayback();
        tryAcquireAudioLeadership();
        runNotificationTick();
        onTick?.();
    }, 3000);
    tryAcquireAudioLeadership();
    return () => {
        clearInterval(timerInterval);
        timerInterval = null;
        releaseAudioLeadership();
        loop = null;
    };
}

export function requestNotificationPermission() {
    if (!("Notification" in window)) return Promise.resolve('unsupported');
    if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
    return Notification.requestPermission().then(permission => {
        console.log('🔔 Notification permission:', permission);
        return permission;
    });
}
