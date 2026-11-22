import { createPrayerAlerts } from '../../src/prayer-alerts.js';
import {
    isAudioDeliveryOwner, playAnnouncementAudio, playPrayerAnnouncement, playTestAlert, resumeAudioPlayback,
    setAudioStateListener, startNotificationLoop, suspendAudioPlayback, unlockAudio
} from '../../src/notifications.js';

const secondary = new URL(location.href).searchParams.has('tab');
const tab = secondary ? 'secondary' : 'primary';
const run = new Date().toISOString();
const out = document.getElementById('out');
const realInfo = console.info.bind(console);
const realWarn = console.warn.bind(console);
const stages = [5, 15, 30];
const requested = new Set();
let hiddenAt = 0;
let syntheticClock = 0;
let prayer;
const markers = new Map();
const storage = { getItem: key => markers.get(key), setItem: (key, val) => markers.set(key, val) };

function record(type, detail = {}) {
    const event = { tab, run, type, visibility: document.visibilityState, time: Date.now(), ...detail };
    out.textContent += JSON.stringify(event) + '\n';
    fetch('/__audio-test/events', { method: 'POST', body: JSON.stringify(event), keepalive: true }).catch(() => {});
}

for (const [name, original] of [['info', realInfo], ['warn', realWarn]]) {
    console[name] = (message, detail, ...rest) => {
        original(message, detail, ...rest);
        if (typeof message === 'string' && message.startsWith('[Audio]')) record(message.slice(8), detail);
    };
}

function recording() {
    const count = 3200, rate = 16000;
    const bytes = new ArrayBuffer(44 + count * 2);
    const view = new DataView(bytes);
    const tag = (word, offset) => [...word].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    tag('RIFF', 0); view.setUint32(4, bytes.byteLength - 8, true); tag('WAVE', 8); tag('fmt ', 12);
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag('data', 36); view.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++) view.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 440 / rate) * 2400, true);
    return new Blob([bytes], { type: 'audio/wav' });
}
const signal = recording();
const expiry = () => Date.now() + 120000;
const delivery = (name, work) => {
    record('due', { name, leader: isAudioDeliveryOwner(), backgroundMs: hiddenAt ? Date.now() - hiddenAt : 0 });
    return work.then(result => { record('result', { name, result }); return result; });
};

function check() {
    if (!hiddenAt || secondary) return;
    const elapsed = Date.now() - hiddenAt;
    if (elapsed >= 1000 && !requested.has('first')) {
        requested.add('first');
        syntheticClock = Date.parse('2026-11-21T14:50:00+03:00');
        prayer.tick(new Date(syntheticClock));
        for (let i = 1; i <= 2; i++) {
            const name = 'local-admin-' + i;
            void delivery(name, playAnnouncementAudio(signal, { id: run + name, expiresAt: expiry() }));
        }
    }
    for (const minutes of stages) {
        if (elapsed < minutes * 60000 || requested.has(minutes)) continue;
        requested.add(minutes);
        const name = 'background-' + minutes + 'm';
        void delivery(name, playPrayerAnnouncement(signal, { id: run + name, expiresAt: hiddenAt + minutes * 60000 + 120000 }));
    }
}

startNotificationLoop(() => [], () => '2026/11/21', check);
setAudioStateListener(state => record('state_observed', { state }));
void unlockAudio().then(allowed => record('initial_probe', { allowed }));
prayer = createPrayerAlerts({
    storage, locks: null, now: () => new Date(syntheticClock || Date.parse('2026-11-21T14:49:58+03:00')),
    getSnapshot: () => ({ payload: { city: 'riyadh', days: [{ date: '2026-11-21',
        timings: { Fajr: '05:00', Dhuhr: '11:40', Asr: '14:50', Maghrib: '17:10', Isha: '18:40' } }] } }),
    onAlert: () => delivery('scheduled-prayer', playPrayerAnnouncement(signal, { id: run + 'prayer', expiresAt: expiry() }))
});
document.getElementById('unlock').addEventListener('click', () => {
    void unlockAudio({ userGesture: true }).then(allowed => record('trusted_probe', { allowed }));
    if (!secondary) void playTestAlert(ok => record('test_clip', { ok }));
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden && !hiddenAt) hiddenAt = Date.now();
    record('visibility_changed', { hiddenAt, leader: isAudioDeliveryOwner() });
    resumeAudioPlayback();
    check();
});
document.addEventListener('freeze', () => { record('freeze'); suspendAudioPlayback(); });
document.addEventListener('resume', () => { record('resume'); resumeAudioPlayback(); check(); });
record('loaded', { browser: navigator.userAgent, dev: import.meta.env.DEV });
