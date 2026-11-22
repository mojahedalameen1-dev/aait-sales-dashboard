import { hasCompletedAudio, isAudioDeliveryOwner, isAudioPlaybackEnabled, playAnnouncementAudio, reportAudioDiagnostic } from './notifications.js';
import { createAnnouncementAudioCache, requestPersistentAudioStorage } from './announcement-audio-cache.js';
import { createAnnouncementAssetLoader } from './announcement-audio-assets.js';
import { createPrayerAudioResolver } from './prayer-audio-resolver.js';

const BOARD_AUTH_KEY = 'aait_board_anonymous_auth_v1';
const PROCESSED_KEY = 'aait_board_processed_calls_v1';
const RECEIVE_WINDOW_MS = 120000;

function audioResponseError(response) {
    const header = response.headers.get('Retry-After');
    const retryAfter = header && (Number.isFinite(Number(header)) ? Date.now() + Number(header) * 1000 : Date.parse(header));
    return Object.assign(new Error('تعذر تحميل ملف الصوت'), { status: response.status, retryAt: retryAfter || 0 });
}

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

function eventExpiry(event, fallback = Date.now() + 45000) {
    const raw = event?.expiresAt;
    const numeric = typeof raw === 'number' ? raw : Number(raw);
    const parsed = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
        cache: 'no-store', signal: AbortSignal.timeout(10000)
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
            cache: 'no-store', signal: AbortSignal.timeout(10000)
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
    let eventCache = new Map();
    let currentStreamReader = null;
    let suspended = false;
    let streamRequest = null;
    let streamTask = null;
    let configRequest = null;
    let tokenRequest = null;
    let wakeRetry = null;
    const acknowledgementChains = new Map();
    const seenEventIds = new Map();

    function screenToken(force = false) {
        if (!tokenRequest) tokenRequest = getScreenToken(config, storage, force).finally(() => { tokenRequest = null; });
        return tokenRequest;
    }

    function acknowledge(eventId, status) {
        const previous = acknowledgementChains.get(eventId) || Promise.resolve();
        const next = previous.catch(() => {}).then(async () => {
            try {
                const idToken = await screenToken();
                await fetch('/api/control/ack', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
                    body: JSON.stringify({ eventId, status }),
                    cache: 'no-store', signal: AbortSignal.timeout(10000)
                });
            } catch { /* Status is informative only; playback is never repeated to retry an acknowledgement. */ }
        });
        acknowledgementChains.set(eventId, next);
        void next.finally(() => { if (acknowledgementChains.get(eventId) === next) acknowledgementChains.delete(eventId); });
        return next;
    }

    function renderCall(event, state, { keepVisible = false } = {}) {
        surface ||= createAnnouncementSurface();
        surface._slots.employee.textContent = event.employeeName || 'الموظف المحدد';
        surface._slots.reason.textContent = event.callType === 'office' ? 'يرجى الحضور إلى المكتب' : 'يرجى الدخول إلى الاجتماع';
        surface._slots.status.textContent = state;
        if (currentAnnouncementId !== event.id) {
            if (announcementTimer) clearTimeout(announcementTimer);
            if (announcementHideTimer) clearTimeout(announcementHideTimer);
            announcementTimer = null;
            announcementHideTimer = null;
            currentAnnouncementId = event.id;
            announcementExpiresAt = 0;
        }
        if (keepVisible) {
            if (announcementTimer) clearTimeout(announcementTimer);
            if (announcementHideTimer) clearTimeout(announcementHideTimer);
            announcementTimer = null;
            announcementHideTimer = null;
            announcementExpiresAt = Infinity;
        } else if (!announcementTimer && !announcementHideTimer) {
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
        if (destroyed || seenEventIds.has(event.id)
            || (event.statusVerified === true && ['audio_completed', 'audio_failed'].includes(event.status))) return;
        const createdAt = Number(event.createdAt);
        const expiresAt = Math.min(eventExpiry(event), createdAt + RECEIVE_WINDOW_MS);
        if (!Number.isFinite(createdAt) || expiresAt <= Date.now()) return;
        if (readStoredJson(storage, PROCESSED_KEY, []).includes(event.id)) return;
        for (const [id, deadline] of seenEventIds) if (deadline <= Date.now()) seenEventIds.delete(id);
        seenEventIds.set(event.id, expiresAt);

        const canPlay = ['pending', 'ready'].includes(event.audioStatus) && /^[a-f0-9]{64}$/.test(event.audioCacheKey || '');
        if (!canPlay) {
            renderCall(event, event.audioStatus === 'not_configured'
                ? 'ظهر النداء؛ الصوت غير مهيأ على الخادم'
                : 'ظهر النداء؛ تعذّر تجهيز الصوت');
            void acknowledge(event.id, 'displayed');
            if (isAudioDeliveryOwner()) void acknowledge(event.id, 'audio_failed');
            return;
        }

        renderCall(event, isAudioPlaybackEnabled() ? 'جاري توصيل النداء الصوتي…' : 'اضغط داخل صفحة العرض للسماح بالصوت');
        void acknowledge(event.id, 'displayed');
        const audioId = 'admin:' + event.id;
        let ownedAttempt = false;
        const audio = playAnnouncementAudio(async () => {
            ownedAttempt = true;
            const cachedAudio = await audioCache.getOrCreate({
                cacheKey: event.audioCacheKey,
                callType: event.callType,
                loadAsset: () => loadStaticAsset(event.audioCacheKey),
                loadGenerated: async () => {
                    const idToken = await screenToken();
                    const audioUrl = new URL('/api/control/audio', window.location.origin);
                    audioUrl.searchParams.set('key', event.audioCacheKey);
                    audioUrl.searchParams.set('event', event.id);
                    const response = await fetch(audioUrl, {
                        headers: { Authorization: 'Bearer ' + idToken }, cache: 'no-store',
                        signal: AbortSignal.timeout(35000)
                    });
                    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('audio/wav')) {
                        throw audioResponseError(response);
                    }
                    return response.blob();
                }
            });
            if (cachedAudio.warning) reportAudioDiagnostic('cache_write_unavailable', { level: 'admin' });
            return cachedAudio.blob;
        }, {
            id: audioId,
            expiresAt,
            isRelevant: () => {
                const current = eventCache.get(event.id);
                return !destroyed && Boolean(current) && !(current.statusVerified === true && current.status === 'audio_completed');
            },
            onDeferred: ({ waitingFor }) => {
                if (currentAnnouncementId === event.id && waitingFor && isAudioDeliveryOwner()) {
                    renderCall(event, waitingFor === 'prayer' ? 'مؤجل حتى انتهاء تنبيه الصلاة' : 'مؤجل حتى ينتهي الصوت الحالي');
                }
            },
            onStarted: ({ repetition, total }) => {
                renderCall(event, 'يُشغّل النداء · ' + repetition + ' من ' + total, { keepVisible: true });
                if (repetition === 1) void acknowledge(event.id, 'audio_started');
            },
            onCompleted: () => renderCall(event, 'اكتمل تشغيل النداء مرتين')
        });
        void audio.then(result => {
            if (destroyed) return;
            if (result.completedRepetitions === 2 || hasCompletedAudio(audioId)) {
                saveProcessed(storage, event.id);
                if (ownedAttempt || isAudioDeliveryOwner()) void acknowledge(event.id, 'audio_completed');
            } else if (ownedAttempt || isAudioDeliveryOwner()) {
                if (currentAnnouncementId === event.id) {
                    renderCall(event, result.reason === 'expired'
                        ? 'انتهت مهلة النداء قبل اكتمال الصوت'
                        : 'لم يكتمل تشغيل النداء على شاشة العرض');
                }
                if (result.reason !== 'interrupted') void acknowledge(event.id, 'audio_failed');
            }
        }).catch(() => reportAudioDiagnostic('delivery_callback_failed', { level: 'admin' }));
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
        while (!destroyed && !suspended) {
            let watchdog;
            const controller = new AbortController();
            streamRequest = controller;
            const armWatchdog = () => {
                clearTimeout(watchdog);
                watchdog = setTimeout(() => controller.abort('stream_idle'), 90000);
            };
            try {
                await configure();
                if (destroyed || suspended || controller.signal.aborted) return;
                const idToken = await screenToken(forceRefresh);
                forceRefresh = false;
                const url = `${config.databaseUrl.replace(/\/$/, '')}/${config.feedPath}.json?auth=${encodeURIComponent(idToken)}`;
                armWatchdog();
                const response = await fetch(url, { headers: { Accept: 'text/event-stream' }, cache: 'no-store', redirect: 'follow', signal: controller.signal });
                if (!response.ok || !response.body || !/^text\/event-stream\b/i.test(response.headers.get('Content-Type') || '')) {
                    throw Object.assign(new Error('تعذر فتح بث شاشة العرض'), { status: response.status, code: 'stream_unavailable' });
                }
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
                        throw Object.assign(new Error('screen-token-expired'), { code: 'firebase_token_expired' });
                    }
                    if (eventName === 'cancel') throw Object.assign(new Error('database-read-not-authorized'), { code: 'firebase_read_cancelled' });
                    if (dataLines.length) {
                        try { applyStreamUpdate(eventName, JSON.parse(dataLines.join('\n'))); }
                        catch (error) { if (error.message === 'screen-token-expired' || error.message === 'database-read-not-authorized') throw error; }
                    }
                    eventName = 'message';
                    dataLines = [];
                };
                while (!destroyed && !suspended && !controller.signal.aborted) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (destroyed || suspended) break;
                    armWatchdog();
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
                if (!destroyed && !suspended) throw new Error('انقطع بث النداءات');
            } catch (error) {
                onConnectionChange(false);
                if (destroyed || suspended) break;
                if (error?.message?.includes('token-expired') || error?.status === 401) forceRefresh = true;
                reportAudioDiagnostic('call_feed_retry', {
                    reason: controller.signal.reason === 'stream_idle' ? 'stream_idle' : error?.code || error?.name || 'stream_closed',
                    httpStatus: error?.status, delayMs: retryDelay
                });
            } finally {
                clearTimeout(watchdog);
                controller.abort();
                void currentStreamReader?.cancel().catch(() => {});
                currentStreamReader = null;
                if (streamRequest === controller) streamRequest = null;
            }
            if (destroyed || suspended) break;
            await new Promise(resolve => {
                wakeRetry = resolve;
                retryTimer = setTimeout(resolve, retryDelay);
            });
            clearTimeout(retryTimer);
            retryTimer = null;
            wakeRetry = null;
            retryDelay = Math.min(15000, Math.round(retryDelay * 1.7));
        }
    }

    function configure() {
        if (config) return Promise.resolve(config);
        if (!configRequest) configRequest = (async () => {
            const response = await fetch('/api/control/config', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
            const payload = await response.json();
            if (!response.ok || !payload.firebaseConfigured || !payload.firebase?.databaseUrl || !payload.firebase?.apiKey) {
                throw Object.assign(new Error('إعداد اتصال العرض غير متاح'), { status: response.status });
            }
            return (config = {
                databaseUrl: payload.firebase.databaseUrl,
                apiKey: payload.firebase.apiKey,
                prayerAudio: payload.prayerAudio,
                feedPath: String(payload.firebase.feedPath || 'calls/public').split('/').map(encodeURIComponent).join('/')
            });
        })().finally(() => { configRequest = null; });
        return configRequest;
    }

    function resume() {
        if (destroyed) return;
        suspended = false;
        wakeRetry?.();
        if (!streamTask) streamTask = consumeStream().finally(() => {
            streamTask = null;
            if (!destroyed && !suspended) resume();
        });
    }

    function suspend() {
        suspended = true;
        streamRequest?.abort('suspended');
        void currentStreamReader?.cancel().catch(() => {});
        wakeRetry?.();
    }

    void requestPersistentAudioStorage();
    resume();
    const loadPrayerAudio = createPrayerAudioResolver({
        audioCache,
        getManifest: async () => (await configure())?.prayerAudio,
        loadGenerated: async ({ key, kind, cacheKey }) => {
            if (destroyed || !config) throw new Error('اتصال شاشة العرض غير متاح');
            const idToken = await screenToken();
            const query = new URLSearchParams({ key, kind, cache: cacheKey });
            const response = await fetch(`/api/control/prayer-audio?${query}`, {
                headers: { Authorization: `Bearer ${idToken}` }, cache: 'no-store', signal: AbortSignal.timeout(18000)
            });
            if (!response.ok || response.headers.get('X-Audio-Cache-Key') !== cacheKey
                || !response.headers.get('content-type')?.toLowerCase().startsWith('audio/wav')) {
                throw audioResponseError(response);
            }
            return response.blob();
        }
    });
    return {
        loadPrayerAudio,
        async authorizeDisplay() {
            await configure();
            const displayToken = await screenToken();
            const result = await fetch('/api/control/display', {
                method: 'POST', credentials: 'same-origin', cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ displayToken }), signal: AbortSignal.timeout(12000)
            });
            if (!result.ok) throw Object.assign(new Error('تعذر اعتماد شاشة العرض'), { status: result.status });
        },
        resume,
        suspend,
        destroy() {
            destroyed = true;
            suspend();
            if (announcementTimer) clearTimeout(announcementTimer);
            if (announcementHideTimer) clearTimeout(announcementHideTimer);
            surface?.remove();
            surface = null;
        }
    };
}
