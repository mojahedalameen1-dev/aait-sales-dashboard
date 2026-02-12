/**
 * notifications.js — Notification engine: timers, TTS, sound alerts, visual toasts
 */

import { getSettings, isDone } from './data.js';

// ========================================
// 🔊 Audio Context & Sound Generation
// ========================================

let audioCtx = null;
let audioUnlocked = false;
let cachedVoices = [];

// Preload voices to avoid empty array issue
if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => {
        cachedVoices = window.speechSynthesis.getVoices();
        console.log('🗣️ Voices loaded:', cachedVoices.length);
    };
}

/**
 * Initialize AudioContext (must be called from user gesture)
 */
export function unlockAudio() {
    if (audioCtx) return;

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();

    // Play a silent buffer to unlock
    const buffer = audioCtx.createBuffer(1, 1, 22050);
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start(0);

    audioUnlocked = true;
    console.log('🔊 Audio unlocked');
}

/**
 * Generate a notification chime sound
 * @param {'info'|'warning'|'critical'} level
 */
export function playChime(level = 'info') {
    try {
        const { soundEnabled } = getSettings();
        if (!soundEnabled || !audioCtx || !audioUnlocked) return;

        const now = audioCtx.currentTime;

        // Create oscillator
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain(); // Modern API

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        switch (level) {
            case 'critical':
                osc.type = 'square';
                osc.frequency.setValueAtTime(880, now);
                osc.frequency.setValueAtTime(1100, now + 0.15);
                osc.frequency.setValueAtTime(880, now + 0.3);
                osc.frequency.setValueAtTime(1100, now + 0.45);
                gain.gain.setValueAtTime(0.15, now);
                gain.gain.linearRampToValueAtTime(0, now + 0.6);
                osc.start(now);
                osc.stop(now + 0.6);
                break;
            case 'warning':
                osc.type = 'sine';
                osc.frequency.setValueAtTime(660, now);
                osc.frequency.setValueAtTime(880, now + 0.2);
                gain.gain.setValueAtTime(0.12, now);
                gain.gain.linearRampToValueAtTime(0.08, now + 0.2);
                gain.gain.linearRampToValueAtTime(0, now + 0.5);
                osc.start(now);
                osc.stop(now + 0.5);
                break;
            default:
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(523, now);      // C5
                osc.frequency.setValueAtTime(659, now + 0.15); // E5
                osc.frequency.setValueAtTime(784, now + 0.3); // G5
                gain.gain.setValueAtTime(0.08, now);
                gain.gain.linearRampToValueAtTime(0.05, now + 0.3);
                gain.gain.linearRampToValueAtTime(0, now + 0.6);
                osc.start(now);
                osc.stop(now + 0.6);
        }
    } catch (err) {
        console.error('🔈 Audio play error:', err);
    }
}

// ========================================
// 🗣️ Text-to-Speech (TTS)
// ========================================

/**
 * Speak a meeting notification in Arabic using Web Speech API
 */
export function speakMeetingAlert(meeting, minutesBefore) {
    try {
        const { soundEnabled } = getSettings();
        if (!soundEnabled || !window.speechSynthesis) return;

        let timeText = '';
        if (minutesBefore <= 1) {
            timeText = 'سيبدأ الآن';
        } else if (minutesBefore <= 5) {
            timeText = 'سيبدأ بعد قليل';
        } else {
            timeText = `سيبدأ بعد ${minutesBefore} دقائق`;
        }

        const teamName = meeting.team || 'الفريق';
        const projectName = meeting.project?.split(' - ')[0] || 'المشروع';

        const phrase = `تنبيه: اجتماع ${teamName} مع ${projectName} ${timeText}`;
        console.log("🔊 Attempting to speak:", phrase);

        const utterance = new SpeechSynthesisUtterance(phrase);
        utterance.lang = 'ar-SA';
        utterance.rate = 0.95;
        utterance.pitch = 1;
        utterance.volume = 1;

        // Try to find an Arabic voice
        const voices = cachedVoices.length > 0 ? cachedVoices : window.speechSynthesis.getVoices();
        const arabicVoice = voices.find(v => v.lang.startsWith('ar'));
        if (arabicVoice) {
            utterance.voice = arabicVoice;
        }

        // Cancel any ongoing speech
        window.speechSynthesis.cancel();

        // Small delay to ensure cancel takes effect
        setTimeout(() => {
            window.speechSynthesis.speak(utterance);
        }, 100);
    } catch (err) {
        console.error('🗣️ TTS error:', err);
    }
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
    toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <div class="toast-body">
      <div class="toast-title"></div> <!-- Set via textContent below -->
      <div class="toast-message"></div> <!-- Set via textContent below -->
    </div>
    <button class="toast-close" onclick="this.closest('.notification-toast').classList.add('exiting'); setTimeout(() => this.closest('.notification-toast')?.remove(), 300)">✕</button>
  `;

    // Securely set text content to prevent XSS
    toast.querySelector('.toast-title').textContent = title;
    toast.querySelector('.toast-message').textContent = message;

    container.prepend(toast);

    // Auto-dismiss
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

// Track which meetings already triggered notifications
const notifiedMeetings = new Set();
let lastNotifiedDate = new Date().toDateString();
const ALERT_INTERVALS = [10, 5, 1];

// Reset notifications daily to prevent unbounded growth
function resetNotificationsIfNewDay() {
    const today = new Date().toDateString();
    if (today !== lastNotifiedDate) {
        notifiedMeetings.clear();
        lastNotifiedDate = today;
        console.log('🔄 Daily notification reset');
    }
}

export function checkMeetingTimers(meetings, todayDate) {
    resetNotificationsIfNewDay();
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const todayMeetings = meetings.filter(m => m.date === todayDate && m.time && !isDone(m));

    for (const meeting of todayMeetings) {
        const [h, min] = meeting.time.split(':').map(Number);
        if (isNaN(h) || isNaN(min)) continue;

        const meetingMinutes = h * 60 + min;
        const diff = meetingMinutes - nowMinutes;

        for (const interval of ALERT_INTERVALS) {
            const key = `${meeting.id} -${interval} `;

            // Fire notification if we're within range of this interval
            // And specifically only if diff is positive (future)
            if (diff === interval && !notifiedMeetings.has(key)) {
                notifiedMeetings.add(key);
                triggerMeetingNotification(meeting, diff);
            }
            // Also catch missed notifications if within last minute (e.g. system was asleep)
            else if (diff < interval && diff > (interval - 1) && !notifiedMeetings.has(key)) {
                notifiedMeetings.add(key);
                triggerMeetingNotification(meeting, diff);
            }
        }
    }
}

function triggerMeetingNotification(meeting, minutesUntil) {
    let level = 'info';
    let icon = '🔔';

    if (minutesUntil <= 1) {
        level = 'critical';
        icon = '🚨';
    } else if (minutesUntil <= 5) {
        level = 'warning';
        icon = '⚠️';
    }

    // 1. Play chime (checks settings internally)
    playChime(level);

    // 2. Show visual toast (always shows)
    const timeText = minutesUntil <= 1 ? 'يبدأ الآن!' : `بعد ${minutesUntil} دقائق`;
    showToast({
        title: meeting.project || 'اجتماع قادم',
        message: `${meeting.team || ''} — ${timeText} `,
        level,
        icon
    });

    // 3. Speak TTS (checks settings internally)
    if (minutesUntil <= 5) {
        setTimeout(() => {
            speakMeetingAlert(meeting, minutesUntil);
        }, 1000);
    }

    // 4. Push Notification
    sendPushNotification(meeting);
}

/**
 * Trigger browser push notification
 */
function sendPushNotification(meeting) {
    if (!("Notification" in window)) return;

    if (Notification.permission === "granted") {
        new Notification(`اجتماع قادم: ${meeting.project} `, {
            body: `العميل: ${meeting.clientStatus} | الفريق: ${meeting.team} \nالوقت: ${meeting.time} `,
            silent: true
        });
    }
}

// ========================================
// 🔁 Timer Loop
// ========================================

let timerInterval = null;

export function startNotificationLoop(getMeetings, getTodayDate, onTick) {
    if (timerInterval) clearInterval(timerInterval);

    // Check every 30 seconds
    timerInterval = setInterval(() => {
        const meetings = getMeetings();
        const today = getTodayDate();
        checkMeetingTimers(meetings, today);
        if (onTick) onTick();
    }, 30 * 1000);

    // Initial check
    const meetings = getMeetings();
    const today = getTodayDate();
    checkMeetingTimers(meetings, today);
}

export function testNotification() {
    playChime('warning');
    showToast({
        title: 'اختبار الإشعارات',
        message: 'تجربة الصوت والصورة... (Sound Check)',
        level: 'info',
        icon: '🔊'
    });
    setTimeout(() => {
        speakMeetingAlert({
            team: 'فريق الاختبار',
            project: 'تجربة النظام الصوتية'
        }, 5);
    }, 700);
}

/**
 * Request browser notification permission
 */
export function requestNotificationPermission() {
    if (!("Notification" in window)) return;
    Notification.requestPermission().then(permission => {
        console.log('🔔 Notification permission:', permission);
    });
}
