import { isAudioPlaybackEnabled, playAnnouncementAudio } from './notifications.js';
import { createAnnouncementAudioCache, requestPersistentAudioStorage } from './announcement-audio-cache.js';
import { createAnnouncementAssetLoader } from './announcement-audio-assets.js';

const BOARD_AUTH_KEY = 'aait_board_anonymous_auth_v1';
const PROCESSED_KEY = 'aait_board_processed_calls_v1';
const RECEIVE_WINDOW_MS = 120000;

function readStoredJson(storage, key, fallback) {
    try { return JSON.parse(storage.getItem(key) || 'null') || fallback; }
    catch { return fallback; }
}

function saveProcessed(storage, id) {
    const values = readStoredJson(storage, PROCESSED_KEY, []);
    if (!values.includes(id)) values.push(id);
    try { storage.setItem(PROCESSED_KEY, JSON.stringify(values.slice(-120))); }
    catch { /* The receiver also keeps an in-page set when browser storage is blocked. */ }
}

function createAnnouncementSurface() {
    const surface = document.createElement('section');
    surface.id = 'board-call-announcement';
    surface.className = 'board-call-announcement';
    surface.hidden = true;
    surface.setAttribute('role', 'status');
    surface.setAttribute('aria-live', 'assertive');
    surface.setAttribute('aria-atomic', 'true');
    const panel = document.createElement('div');
    panel.className = 'board-call-panel';
    const symbol = document.createElement('span');
    symbol.className = 'board-call-symbol';
    symbol.setAttribute('aria-hidden', 'true');
    symbol.innerHTML = '<i data-lucide="radio-tower"></i>';
    const copy = document.createElement('div');
    copy.className = 'board-call-copy';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'board-call-eyebrow';
    eyebrow.textContent = 'نداء داخلي';
    const employee = document.createElement('strong');
    employee.className = 'board-call-employee';
    const reason = document.createElement('span');
    reason.className = 'board-call-reason';
    const status = document.createElement('small');
    status.className = 'board-call-status';
    copy.append(eyebrow, employee, reason, status);
    panel.append(symbol, copy);
    surface.append(panel);
    surface._slots = { employee, reason, status };
    document.body.append(surface);
    return surface;
}

async function firebaseIdentityRequest(config, resource, values) {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/${resource}?key=${encodeURIComponent(config.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
        cache: 'no-store'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || 'تعذر تهيئة اتصال شاشة العرض');
    return payload;
}

async function getScreenToken(config, storage, forceRefresh = false) {
    let session = readStoredJson(storage, BOARD_AUTH_KEY, null);
    if (!forceRefresh && session?.idToken && session.expiresAt > Date.now() + 30000) return session.idToken;
    if (session?.refreshToken) {
        const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(config.apiKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
            cache: 'no-store'
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && payload.id_token) {
            session = { idToken: payload.id_token, refreshToken: payload.refresh_token, uid: payload.user_id || session.uid, expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000 };
            storage.setItem(BOARD_AUTH_KEY, JSON.stringify(session));
            return session.idToken;
        }
    }
    session = await firebaseIdentityRequest(config, 'accounts:signUp', { returnSecureToken: true });
    const saved = { idToken: session.idToken, refreshToken: session.refreshToken, uid: session.localId, expiresAt: Date.now() + Number(session.expiresIn || 3600) * 1000 };
    storage.setItem(BOARD_AUTH_KEY, JSON.stringify(saved));
    return saved.idToken;
}

export function createCallReceiver({ storage = globalThis.localStorage, onConnectionChange = () => {}, audioCache = createAnnouncementAudioCache(), loadStaticAsset = createAnnouncementAssetLoader() } = {}) {
    let destroyed = false;
    let retryDelay = 1800;
    let retryTimer = null;
    let announcementTimer = null;
    let announcementHideTimer = null;
    let currentAnnouncementId = null;
    let announcementExpiresAt = 0;
    let config = null;
    let surface = null;
    let audioQueue = [];
    let audioBusy = false;
    let eventCache = new Map();
    let currentStreamReader = null;
    const acknowledgementChains = new Map();
    const sessionStartedAt = Date.now();
    const seenEventIds = new Set();

    function acknowledge(eventId, status) {
        const previous = acknowledgementChains.get(eventId) || Promise.resolve();
        const next = previous.catch(() => {}).then(async () => {
            try {
                const idToken = await getScreenToken(config, storage);
                await fetch('/api/control/ack', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
                    body: JSON.stringify({ eventId, status }),
                    cache: 'no-store'
                });
            } catch { /* Status is informative only; playback is never repeated to retry an acknowledgement. */ }
        });
        acknowledgementChains.set(eventId, next);
        void next.finally(() => { if (acknowledgementChains.get(eventId) === next) acknowledgementChains.delete(eventId); });
        return next;
    }

    function renderCall(event, state) {
        surface ||= createAnnouncementSurface();
        surface._slots.employee.textContent = event.employeeName || 'الموظف المحدد';
        surface._slots.reason.textContent = event.callType === 'office' ? 'يرجى الحضور إلى المكتب' : 'يرجى الدخول إلى الاجتماع';
        surface._slots.status.textContent = state;
        if (currentAnnouncementId !== event.id) {
            if (announcementTimer) clearTimeout(announcementTimer);
            if (announcementHideTimer) clearTimeout(announcementHideTimer);
            currentAnnouncementId = event.id;
            announcementExpiresAt = Date.now() + 10000;
            const announcementId = event.id;
            announcementTimer = setTimeout(() => {
                if (currentAnnouncementId !== announcementId) return;
                surface?.classList.add('is-hiding');
                announcementTimer = null;
                announcementHideTimer = setTimeout(() => {
                    if (surface && currentAnnouncementId === announcementId) surface.hidden = true;
                    announcementHideTimer = null;
                }, 450);
            }, 10000);
        }
        if (Date.now() >= announcementExpiresAt) return;
        surface.hidden = false;
        surface.classList.remove('is-hiding');
    }

    function markDisplayed(event) {
        if (globalThis.navigator?.locks?.request) {
            let callbackStarted = false;
            void globalThis.navigator.locks.request(`aait-call-delivery-${event.id}`, { ifAvailable: true }, lock => {
                callbackStarted = true;
                if (lock && !destroyed) markDisplayedOnce(event);
            }).catch(() => { if (!callbackStarted && !destroyed) markDisplayedOnce(event); });
            return;
        }
        markDisplayedOnce(event);
    }

    function markDisplayedOnce(event) {
        const alreadyProcessed = readStoredJson(storage, PROCESSED_KEY, []);
        if (seenEventIds.has(event.id) || alreadyProcessed.includes(event.id)) return;
        if (Number(event.expiresAt) <= Date.now() || Number(event.createdAt) < Math.max(sessionStartedAt - RECEIVE_WINDOW_MS, Date.now() - RECEIVE_WINDOW_MS)) return;
        // Persist before UI/audio so reloads and reconnects never replay this event.
        seenEventIds.add(event.id);
        saveProcessed(storage, event.id);
        const canPlay = ['pending', 'ready'].includes(event.audioStatus) && /^[a-f0-9]{64}$/.test(event.audioCacheKey || '');
        renderCall(event, canPlay ? 'جاري توصيل النداء الصوتي…' : 'ظهر النداء على الشاشة');
        void acknowledge(event.id, 'displayed');
        if (canPlay) {
            audioQueue.push({ event, expiresAt: Date.now() + 45000 });
            if (!isAudioPlaybackEnabled()) {
                surface._slots.status.textContent = 'الصوت مقفل؛ فعّل الصوت من الشريط السفلي';
                setTimeout(() => {
                    const item = audioQueue.find(entry => entry.event.id === event.id);
                    if (!item || isAudioPlaybackEnabled()) return;
                    audioQueue = audioQueue.filter(entry => entry.event.id !== event.id);
                    surface._slots.status.textContent = 'ظهر النداء، لكن المتصفح منع تشغيل الصوت';
                    void acknowledge(event.id, 'audio_failed');
                }, 45000);
            }
            void processAudioQueue();
        } else {
            surface._slots.status.textContent = event.audioStatus === 'not_configured'
                ? 'ظهر النداء؛ الصوت غير مهيأ على الخادم'
                : 'ظهر النداء؛ تعذّر تجهيز الصوت';
            void acknowledge(event.id, 'audio_failed');
        }
    }

    async function processAudioQueue() {
        if (audioBusy || !audioQueue.length || !isAudioPlaybackEnabled() || destroyed) return;
        audioBusy = true;
        const item = audioQueue.shift();
        try {
            if (item.expiresAt <= Date.now()) {
                void acknowledge(item.event.id, 'audio_failed');
                return;
            }
            const cachedAudio = await audioCache.getOrCreate({
                cacheKey: item.event.audioCacheKey,
                callType: item.event.callType,
                loadAsset: () => loadStaticAsset(item.event.audioCacheKey),
                loadGenerated: async () => {
                    const idToken = await getScreenToken(config, storage);
                    const audioUrl = new URL('/api/control/audio', window.location.origin);
                    audioUrl.searchParams.set('key', item.event.audioCacheKey);
                    audioUrl.searchParams.set('event', item.event.id);
                    const response = await fetch(audioUrl, {
                        headers: { Authorization: `Bearer ${idToken}` }, cache: 'no-store'
                    });
                    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('audio/wav')) {
                        throw new Error('تعذر تحميل ملف صوت النداء');
                    }
                    return response.blob();
                }
            });
            if (cachedAudio.warning) {
                console.warn('[Audio cache] تعذّر حفظ الصوت محليًا؛ لن يؤثر ذلك على تشغيل النداء الحالي.');
            }
            const result = await playAnnouncementAudio(cachedAudio.blob, {
                onStarted: () => {
                    renderCall(item.event, 'بدأ تشغيل الصوت على شاشة العرض');
                    void acknowledge(item.event.id, 'audio_started');
                }
            });
            if (!result.started) {
                surface._slots.status.textContent = 'ظهر النداء، لكن المتصفح منع تشغيل الصوت';
                void acknowledge(item.event.id, 'audio_failed');
            }
        } catch {
            renderCall(item.event, 'ظهر النداء، لكن تعذّر تجهيز الصوت على شاشة العرض');
            void acknowledge(item.event.id, 'audio_failed');
        } finally {
            audioBusy = false;
            if (audioQueue.length) void processAudioQueue();
        }
    }

    function applyStreamUpdate(eventName, payload) {
        if (!payload || !['put', 'patch'].includes(eventName)) return;
        const path = String(payload.path || '/').split('/').filter(Boolean);
        const data = payload.data;
        if (!path.length) {
            if (eventName === 'put') eventCache = new Map();
            if (data && typeof data === 'object') {
                for (const [id, value] of Object.entries(data)) {
                    const current = eventCache.get(id) || {};
                    if (value && typeof value === 'object') eventCache.set(id, eventName === 'patch' ? { ...current, ...value } : value);
                    else eventCache.delete(id);
                    const next = eventCache.get(id);
                    if (next?.id === id) markDisplayed(next);
                }
            }
            return;
        }
        const [id, ...fields] = path;
        if (fields.length) {
            const current = eventCache.get(id) || {};
            const field = fields[0];
            if (data === null) delete current[field];
            else current[field] = data;
            eventCache.set(id, current);
        } else if (data === null) {
            eventCache.delete(id);
        } else {
            const current = eventCache.get(id) || {};
            eventCache.set(id, eventName === 'patch' ? { ...current, ...data } : data);
        }
        const next = eventCache.get(id);
        if (next?.id === id) markDisplayed(next);
    }

    async function consumeStream() {
        let forceRefresh = false;
        while (!destroyed) {
            try {
                const idToken = await getScreenToken(config, storage, forceRefresh);
                forceRefresh = false;
                const url = `${config.databaseUrl.replace(/\/$/, '')}/${config.feedPath}.json?auth=${encodeURIComponent(idToken)}`;
                const response = await fetch(url, { headers: { Accept: 'text/event-stream' }, cache: 'no-store', redirect: 'follow' });
                if (!response.ok || !response.body) throw Object.assign(new Error('تعذر فتح بث شاشة العرض'), { status: response.status });
                retryDelay = 1800;
                onConnectionChange(true);
                const reader = response.body.getReader();
                currentStreamReader = reader;
                const decoder = new TextDecoder();
                let buffer = '';
                let eventName = 'message';
                let dataLines = [];
                const dispatch = () => {
                    if (eventName === 'auth_revoked') {
                        forceRefresh = true;
                        throw new Error('screen-token-expired');
                    }
                    if (eventName === 'cancel') throw new Error('database-read-not-authorized');
                    if (dataLines.length) {
                        try { applyStreamUpdate(eventName, JSON.parse(dataLines.join('\n'))); }
                        catch (error) { if (error.message === 'screen-token-expired' || error.message === 'database-read-not-authorized') throw error; }
                    }
                    eventName = 'message';
                    dataLines = [];
                };
                while (!destroyed) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let newline;
                    while ((newline = buffer.indexOf('\n')) !== -1) {
                        const line = buffer.slice(0, newline).replace(/\r$/, '');
                        buffer = buffer.slice(newline + 1);
                        if (!line) dispatch();
                        else if (line.startsWith(':')) continue;
                        else if (line.startsWith('event:')) eventName = line.slice(6).trim();
                        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
                    }
                }
                currentStreamReader = null;
                if (!destroyed) throw new Error('انقطع بث النداءات');
            } catch (error) {
                onConnectionChange(false);
                if (destroyed) break;
                if (error.message.includes('token-expired') || error.status === 401) forceRefresh = true;
                console.warn('[Call receiver] اتصال شاشة العرض غير متاح؛ ستتم إعادة المحاولة.');
                await new Promise(resolve => { retryTimer = setTimeout(resolve, retryDelay); });
                retryDelay = Math.min(15000, Math.round(retryDelay * 1.7));
            }
        }
    }

    async function start() {
        void requestPersistentAudioStorage();
        try {
            const response = await fetch('/api/control/config', { cache: 'no-store' });
            const payload = await response.json();
            if (!response.ok || !payload.firebaseConfigured || !payload.firebase?.databaseUrl || !payload.firebase?.apiKey) {
                onConnectionChange(false);
                return;
            }
            config = {
                databaseUrl: payload.firebase.databaseUrl,
                apiKey: payload.firebase.apiKey,
                feedPath: String(payload.firebase.feedPath || 'calls/public').split('/').map(encodeURIComponent).join('/')
            };
            await getScreenToken(config, storage);
            void consumeStream();
        } catch {
            onConnectionChange(false);
        }
    }

    void start();
    return {
        notifyAudioEnabled: processAudioQueue,
        destroy() {
            destroyed = true;
            if (retryTimer) clearTimeout(retryTimer);
            if (announcementTimer) clearTimeout(announcementTimer);
            if (announcementHideTimer) clearTimeout(announcementHideTimer);
            void currentStreamReader?.cancel().catch(() => {});
            surface?.remove();
            surface = null;
        }
    };
}
