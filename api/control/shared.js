import { createHmac, createSign, createVerify, timingSafeEqual } from 'node:crypto';
import { fetchCurrentMeetingsCsv } from '../meetings.js';
import { mapRowsToMeetings, parseCSV, formatTodayDate, getMeetingTimingState, isCancelled, isDone } from '../../src/data.js';
import { isSafeMeetingUrl } from '../../src/utils.js';

export const CONTROL_EMPLOYEES = Object.freeze([
    { id: 'mojahed', name: 'م. مجاهد', aliases: ['مجاهد', 'mojahed'], tone: '#8d6bff' },
    { id: 'mahmoud', name: 'م. محمود', aliases: ['محمود', 'mahmoud'], tone: '#f6b94a' },
    { id: 'ashraf', name: 'م. أشرف', aliases: ['أشرف', 'اشرف', 'ashraf'], tone: '#3896ff' },
    { id: 'hossam', name: 'م. حسام', aliases: ['حسام', 'hossam', 'hussam'], tone: '#00c98a' },
    { id: 'shady', name: 'م. شادي', aliases: ['شادي', 'shady'], tone: '#ef5da8' }
]);

export const ADMIN_ROLES = Object.freeze({
    general_manager: { label: 'المدير العام', office: true, meeting: false, callerName: 'الأستاذ محمد الزهراني' },
    business_development_manager: { label: 'مدير تطوير الأعمال', office: true, meeting: true, callerName: 'المهندس محمد القحطاني' },
    deputy_general_manager: { label: 'نائب المدير العام', office: true, meeting: true, callerName: 'الأستاذ محمد العتيبي' }
});

const REQUIRED_ADMIN_ROLE_IDS = Object.freeze(Object.keys(ADMIN_ROLES));
const LOGIN_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT_ATTEMPTS = 5;
const SESSION_COOKIE_NAME = 'aait_control_session';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

const FIREBASE_CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';
let firebaseCertificates = { values: null, expiresAt: 0 };
let serviceAccessToken = { value: '', expiresAt: 0 };

export function getFirebaseClientConfig() {
    const apiKey = process.env.FIREBASE_WEB_API_KEY?.trim() || '';
    const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || '';
    const databaseUrl = process.env.FIREBASE_DATABASE_URL?.trim() || '';
    let validDatabaseUrl = false;
    try {
        const parsed = new URL(databaseUrl);
        validDatabaseUrl = parsed.protocol === 'https:'
            && !parsed.username && !parsed.password
            && (parsed.hostname.endsWith('.firebaseio.com') || parsed.hostname.endsWith('.firebasedatabase.app'));
    } catch { /* missing or malformed setup */ }
    const firebaseConfigured = Boolean(apiKey && projectId && validDatabaseUrl);
    const serviceConfigured = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim());
    const adminMap = parseAdminMap();
    const adminsConfigured = Boolean(adminMap
        && Object.keys(adminMap).length === REQUIRED_ADMIN_ROLE_IDS.length
        && REQUIRED_ADMIN_ROLE_IDS.every(roleId => Object.values(adminMap).some(entry => entry.role === roleId))
        && new Set(Object.values(adminMap).map(entry => entry.role)).size === REQUIRED_ADMIN_ROLE_IDS.length);
    const rateLimitConfigured = (process.env.CALL_AUTH_RATE_LIMIT_SECRET?.trim().length || 0) >= 32;
    const sessionConfigured = (process.env.CALL_AUTH_SESSION_SECRET?.trim().length || 0) >= 32;
    return {
        firebaseConfigured,
        serviceConfigured,
        adminsConfigured,
        rateLimitConfigured,
        sessionConfigured,
        speechConfigured: Boolean(process.env.AZURE_SPEECH_KEY?.trim() && process.env.AZURE_SPEECH_REGION?.trim()),
        firebase: firebaseConfigured ? { apiKey, projectId, databaseUrl: databaseUrl.replace(/\/$/, '') } : null,
        missing: [
            ...(!apiKey ? ['FIREBASE_WEB_API_KEY'] : []),
            ...(!projectId ? ['FIREBASE_PROJECT_ID'] : []),
            ...(!validDatabaseUrl ? ['FIREBASE_DATABASE_URL'] : []),
            ...(!serviceConfigured ? ['FIREBASE_SERVICE_ACCOUNT_JSON'] : []),
            ...(!adminsConfigured ? ['CALL_ADMIN_UIDS_JSON'] : []),
            ...(!rateLimitConfigured ? ['CALL_AUTH_RATE_LIMIT_SECRET'] : []),
            ...(!sessionConfigured ? ['CALL_AUTH_SESSION_SECRET'] : [])
        ]
    };
}

export function parseAdminMap() {
    const raw = process.env.CALL_ADMIN_UIDS_JSON?.trim();
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null;
        return Object.fromEntries(Object.entries(parsed).filter(([uid, entry]) =>
            /^[A-Za-z0-9:_-]{8,128}$/.test(uid)
            && entry && typeof entry === 'object'
            && Object.hasOwn(ADMIN_ROLES, entry.role)
        ));
    } catch {
        return null;
    }
}

function decodeJwtPart(part) {
    try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); }
    catch { return null; }
}

async function getFirebaseCertificates() {
    if (firebaseCertificates.values && firebaseCertificates.expiresAt > Date.now()) return firebaseCertificates.values;
    const response = await fetch(FIREBASE_CERT_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('تعذر التحقق من جلسة Firebase');
    const values = await response.json();
    const maxAge = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/i)?.[1]) || 3600;
    firebaseCertificates = { values, expiresAt: Date.now() + Math.max(60, maxAge - 60) * 1000 };
    return values;
}

export async function verifyFirebaseIdToken(idToken, { allowAnonymous = false } = {}) {
    const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
    if (!projectId || typeof idToken !== 'string' || idToken.length > 8192) throw new Error('جلسة الدخول غير صالحة');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('جلسة الدخول غير صالحة');
    const header = decodeJwtPart(parts[0]);
    const claims = decodeJwtPart(parts[1]);
    if (!header || header.alg !== 'RS256' || !header.kid || !claims) throw new Error('جلسة الدخول غير صالحة');
    const now = Math.floor(Date.now() / 1000);
    if (claims.aud !== projectId
        || claims.iss !== `https://securetoken.google.com/${projectId}`
        || typeof claims.sub !== 'string' || !claims.sub
        || claims.sub !== claims.user_id && claims.user_id !== undefined
        || !Number.isFinite(claims.exp) || claims.exp <= now
        || !Number.isFinite(claims.iat) || claims.iat > now + 60) {
        throw new Error('انتهت صلاحية جلسة الدخول أو لم تعد صالحة');
    }
    const certificates = await getFirebaseCertificates();
    const certificate = certificates[header.kid];
    if (!certificate) {
        firebaseCertificates.expiresAt = 0;
        throw new Error('تعذر التحقق من توقيع جلسة الدخول');
    }
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    if (!verifier.verify(certificate, Buffer.from(parts[2], 'base64url'))) throw new Error('توقيع جلسة الدخول غير صالح');
    const provider = claims.firebase?.sign_in_provider;
    if (provider === 'anonymous' && !allowAnonymous) throw new Error('هذه الجلسة لا تملك صلاحية مسؤول');
    if (allowAnonymous && provider !== 'anonymous') throw new Error('جلسة شاشة العرض غير صالحة');
    return claims;
}

export function getAdminActor(claims) {
    const map = parseAdminMap();
    if (!map) return null;
    const entry = map[claims?.uid || claims?.sub];
    if (!entry) return null;
    const role = ADMIN_ROLES[entry.role];
    if (!role) return null;
    return { uid: claims.uid || claims.sub, roleId: entry.role, roleLabel: role.label, permissions: { office: role.office, meeting: role.meeting } };
}

export function isCurrentAdminSession(claims, record) {
    return Number.isSafeInteger(claims?.sessionVersion) && claims.sessionVersion >= 1
        && Number.isSafeInteger(record?.sessionVersion) && record.sessionVersion >= 1
        && claims.sessionVersion === record.sessionVersion;
}

export function bearerToken(request) {
    const authorization = request.headers?.authorization || request.headers?.Authorization || '';
    return /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || '';
}

function sessionSecret() {
    const secret = process.env.CALL_AUTH_SESSION_SECRET?.trim() || '';
    if (secret.length < 32) throw Object.assign(new Error('إعداد جلسة الدخول غير مكتمل'), { statusCode: 503 });
    return secret;
}

function cookieValue(request, name) {
    const header = String(request.headers?.cookie || request.headers?.Cookie || '');
    for (const piece of header.split(';')) {
        const separator = piece.indexOf('=');
        if (separator < 0 || piece.slice(0, separator).trim() !== name) continue;
        return piece.slice(separator + 1).trim();
    }
    return '';
}

function encodeSession(session) {
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    const signature = createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function decodeSession(value) {
    const separator = value.lastIndexOf('.');
    if (separator < 1) return null;
    const payload = value.slice(0, separator);
    let signature;
    try { signature = Buffer.from(value.slice(separator + 1), 'base64url'); } catch { return null; }
    const expected = createHmac('sha256', sessionSecret()).update(payload).digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    const session = decodeJwtPart(payload);
    if (!session || typeof session.idToken !== 'string' || typeof session.refreshToken !== 'string'
        || !Number.isFinite(session.sessionExpiresAt)) return null;
    return session;
}

function cookieAttributes(request, maxAge) {
    const forwardedProto = String(request.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
    const secure = forwardedProto === 'https' || request.socket?.encrypted || process.env.VERCEL === '1';
    return `${SESSION_COOKIE_NAME}=; Path=/api/control; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function setFirebaseSessionCookie(response, request, credentials, sessionExpiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000) {
    const session = { idToken: credentials.idToken, refreshToken: credentials.refreshToken, sessionExpiresAt };
    const maxAge = Math.max(0, Math.floor((sessionExpiresAt - Date.now()) / 1000));
    const forwardedProto = String(request.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
    const secure = forwardedProto === 'https' || request.socket?.encrypted || process.env.VERCEL === '1';
    response.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeSession(session)}; Path=/api/control; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

export function clearFirebaseSessionCookie(response, request) {
    response.setHeader('Set-Cookie', cookieAttributes(request, 0));
}

async function firebaseIdTokenFromRequest(request, response) {
    const authorization = bearerToken(request);
    if (authorization) return authorization;
    const encoded = cookieValue(request, SESSION_COOKIE_NAME);
    if (!encoded) throw Object.assign(new Error('يلزم تسجيل الدخول'), { statusCode: 401 });
    let session;
    try { session = decodeSession(encoded); }
    catch { session = null; }
    if (!session || session.sessionExpiresAt <= Date.now()) {
        clearFirebaseSessionCookie(response, request);
        throw Object.assign(new Error('انتهت صلاحية جلسة الدخول؛ سجّل الدخول مرة ثانية'), { statusCode: 401 });
    }
    const tokenClaims = decodeJwtPart(session.idToken.split('.')[1] || '');
    if (Number(tokenClaims?.exp) > Math.floor(Date.now() / 1000) + 60) return session.idToken;
    const apiKey = process.env.FIREBASE_WEB_API_KEY?.trim();
    if (!apiKey) throw Object.assign(new Error('إعداد Firebase غير مكتمل'), { statusCode: 503 });
    const refreshed = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
        signal: AbortSignal.timeout(8000)
    });
    const result = await refreshed.json().catch(() => ({}));
    if (!refreshed.ok || !result.id_token || !result.refresh_token) {
        clearFirebaseSessionCookie(response, request);
        throw Object.assign(new Error('انتهت صلاحية جلسة الدخول؛ سجّل الدخول مرة ثانية'), { statusCode: 401 });
    }
    setFirebaseSessionCookie(response, request, { idToken: result.id_token, refreshToken: result.refresh_token }, session.sessionExpiresAt);
    return result.id_token;
}

export async function requireAdmin(request, response) {
    const config = getFirebaseClientConfig();
    if (!config.firebaseConfigured || !config.adminsConfigured) {
        const error = new Error('لم يتم إعداد Firebase وصلاحيات المسؤولين بعد');
        error.statusCode = 503;
        throw error;
    }
    const claims = await verifyFirebaseIdToken(await firebaseIdTokenFromRequest(request, response));
    const actor = getAdminActor(claims);
    if (!actor) {
        const error = new Error('هذا الحساب غير مخوّل لإرسال النداءات');
        error.statusCode = 403;
        throw error;
    }
    if (!isCurrentAdminSession(claims, await firebaseDatabaseRequest(`controlAuth/admins/${actor.uid}`))) {
        const error = new Error('انتهت صلاحية جلسة الدخول؛ سجّل الدخول مرة ثانية');
        error.statusCode = 401;
        throw error;
    }
    return actor;
}

export async function readJsonBody(request) {
    if (request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body)) return request.body;
    let text = '';
    for await (const chunk of request) {
        text += chunk.toString();
        if (text.length > 12000) throw Object.assign(new Error('حجم الطلب أكبر من المسموح'), { statusCode: 413 });
    }
    try { return text ? JSON.parse(text) : {}; }
    catch { throw Object.assign(new Error('بيانات الطلب غير صالحة'), { statusCode: 400 }); }
}

export function sendError(response, error, fallback = 'تعذر إكمال الطلب') {
    const statusCode = Number(error?.statusCode) || 500;
    if (statusCode >= 500) console.error('[control-api]', error?.message || fallback);
    return response.status(statusCode).json({ error: statusCode >= 500 && statusCode !== 503 ? fallback : error.message });
}

export async function loadFreshMeetings() {
    const source = await fetchCurrentMeetingsCsv();
    const rows = parseCSV(source.csvText);
    const meetings = mapRowsToMeetings(rows);
    if (!meetings.length) throw Object.assign(new Error('مصدر الاجتماعات لم يُرجع اجتماعات قابلة للقراءة'), { statusCode: 502 });
    return { meetings, fetchedAt: source.fetchedAt, sheetName: source.sheetName };
}

export function normalizeEmployeeText(value = '') {
    return String(value).normalize('NFKD')
        .replace(/[\u064B-\u065F\u0670]/g, '')
        .replace(/[أإآ]/g, 'ا').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
        .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function meetingAssignedToEmployee(meeting, employee) {
    const assigned = normalizeEmployeeText(meeting?.team);
    return employee.aliases.some(alias => assigned.includes(normalizeEmployeeText(alias)));
}

export function getActiveMeetingsForEmployee(meetings, employeeId, now = new Date()) {
    const employee = CONTROL_EMPLOYEES.find(item => item.id === employeeId);
    if (!employee) return [];
    return meetings.filter(meeting => meetingAssignedToEmployee(meeting, employee)
        && !isCancelled(meeting) && !isDone(meeting, now)
        && getMeetingTimingState(meeting, now).state === 'running');
}

function getEndTime(time) {
    const [hours, minutes] = String(time || '').split(':').map(Number);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
    const total = hours * 60 + minutes + 60;
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function sanitizeMeetingForAdmin(meeting) {
    return {
        id: meeting.id,
        date: meeting.date,
        time: meeting.time,
        expectedEndTime: getEndTime(meeting.time),
        project: meeting.project || '',
        team: meeting.team || '',
        via: meeting.via || '',
        status: meeting.status || '',
        clientStatus: meeting.clientStatus || '',
        ticketUrl: isSafeMeetingUrl(meeting.ticketUrl) ? meeting.ticketUrl : '',
        meetUrl: isSafeMeetingUrl(meeting.meetUrl) ? meeting.meetUrl : ''
    };
}

export function listSelectableMeetings(meetings, now = new Date()) {
    const today = formatTodayDate(now);
    return meetings.filter(meeting => meeting.date === today
        && !isCancelled(meeting) && !isDone(meeting, now)
        && ['upcoming', 'running'].includes(getMeetingTimingState(meeting, now).state))
        .map(sanitizeMeetingForAdmin);
}

export function getBusyMeetingDetails(meetings, employeeId, now = new Date()) {
    return getActiveMeetingsForEmployee(meetings, employeeId, now).map(meeting => ({
        ...sanitizeMeetingForAdmin(meeting),
        durationMinutes: 60
    }));
}

function base64Url(value) {
    return Buffer.from(value).toString('base64url');
}

async function getServiceAccountAccessToken() {
    if (serviceAccessToken.value && serviceAccessToken.expiresAt > Date.now() + 30000) return serviceAccessToken.value;
    let account;
    try { account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || ''); }
    catch { account = null; }
    if (!account?.client_email || !account?.private_key) throw Object.assign(new Error('تخزين Firebase غير مهيأ'), { statusCode: 503 });
    if (account.token_uri && account.token_uri !== 'https://oauth2.googleapis.com/token') {
        throw Object.assign(new Error('عنوان خدمة Firebase غير صالح'), { statusCode: 503 });
    }
    const tokenUri = 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
        iss: account.client_email,
        scope: TOKEN_SCOPE,
        aud: tokenUri,
        iat: now,
        exp: now + 3600
    }))}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const assertion = `${unsigned}.${signer.sign(account.private_key).toString('base64url')}`;
    const response = await fetch(tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
        signal: AbortSignal.timeout(8000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.access_token) throw Object.assign(new Error('تعذر الاتصال بخدمة Firebase'), { statusCode: 502 });
    serviceAccessToken = { value: result.access_token, expiresAt: Date.now() + (Number(result.expires_in) || 3600) * 1000 };
    return serviceAccessToken.value;
}

export async function firebaseDatabaseRequest(path, method = 'GET', body, extraHeaders = {}) {
    const config = getFirebaseClientConfig();
    if (!config.firebaseConfigured) throw Object.assign(new Error('إعدادات Firebase غير مكتملة'), { statusCode: 503 });
    const token = await getServiceAccountAccessToken();
    const base = config.firebase.databaseUrl.replace(/\/$/, '');
    const response = await fetch(`${base}/${path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}.json`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error('تعذر حفظ بيانات Firebase'), { statusCode: response.status === 412 ? 412 : 502 });
    return data;
}

export async function firebaseDatabaseReadWithEtag(path) {
    const config = getFirebaseClientConfig();
    if (!config.firebaseConfigured) throw Object.assign(new Error('إعدادات Firebase غير مكتملة'), { statusCode: 503 });
    const token = await getServiceAccountAccessToken();
    const base = config.firebase.databaseUrl.replace(/\/$/, '');
    const response = await fetch(`${base}/${path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}.json`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Firebase-ETag': 'true' },
        signal: AbortSignal.timeout(10000)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !response.headers.get('etag')) throw Object.assign(new Error('تعذر قراءة بيانات Firebase'), { statusCode: 502 });
    return { data, etag: response.headers.get('etag') };
}

export function getClientAddressKey(request) {
    const secret = process.env.CALL_AUTH_RATE_LIMIT_SECRET?.trim() || '';
    if (secret.length < 32) throw Object.assign(new Error('حماية محاولات الدخول غير مهيأة'), { statusCode: 503 });
    const forwarded = request.headers?.['x-forwarded-for'] || request.headers?.['X-Forwarded-For'] || '';
    const address = String(forwarded).split(',')[0].trim() || request.socket?.remoteAddress || 'unknown';
    return createHmac('sha256', secret).update(String(address)).digest('hex');
}

export async function consumeLoginAttempt(addressKey, now = Date.now()) {
    const path = 'controlAuth/loginRateLimits';
    for (let attempt = 0; attempt < 5; attempt++) {
        const current = await firebaseDatabaseReadWithEtag(path);
        const records = current.data && typeof current.data === 'object' && !Array.isArray(current.data) ? current.data : {};
        const activeRecords = Object.fromEntries(Object.entries(records).filter(([, record]) =>
            Number(record?.windowStartedAt) + LOGIN_LIMIT_WINDOW_MS > now && Number.isFinite(Number(record?.attempts))));
        const record = activeRecords[addressKey];
        const activeWindow = Number(record?.windowStartedAt) + LOGIN_LIMIT_WINDOW_MS > now;
        const windowStartedAt = activeWindow ? Number(record.windowStartedAt) : now;
        const attempts = activeWindow ? Number(record?.attempts || 0) : 0;
        if (attempts >= LOGIN_LIMIT_ATTEMPTS) {
            return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowStartedAt + LOGIN_LIMIT_WINDOW_MS - now) / 1000)) };
        }
        try {
            activeRecords[addressKey] = { windowStartedAt, attempts: attempts + 1 };
            if (Object.keys(activeRecords).length > 5000) {
                throw Object.assign(new Error('حماية محاولات الدخول مشغولة حاليًا'), { statusCode: 503 });
            }
            await firebaseDatabaseRequest(path, 'PUT', activeRecords, { 'if-match': current.etag });
            return { allowed: true, remaining: LOGIN_LIMIT_ATTEMPTS - attempts - 1 };
        } catch (error) {
            if (error.statusCode !== 412) throw error;
        }
    }
    throw Object.assign(new Error('تعذر التحقق من محاولات الدخول'), { statusCode: 503 });
}

export async function clearLoginAttempts(addressKey) {
    const path = 'controlAuth/loginRateLimits';
    for (let attempt = 0; attempt < 5; attempt++) {
        const current = await firebaseDatabaseReadWithEtag(path);
        const records = current.data && typeof current.data === 'object' && !Array.isArray(current.data) ? current.data : {};
        const activeRecords = Object.fromEntries(Object.entries(records).filter(([, record]) =>
            Number(record?.windowStartedAt) + LOGIN_LIMIT_WINDOW_MS > Date.now() && Number.isFinite(Number(record?.attempts))));
        delete activeRecords[addressKey];
        try {
            await firebaseDatabaseRequest(path, 'PUT', activeRecords, { 'if-match': current.etag });
            return;
        } catch (error) {
            if (error.statusCode !== 412) throw error;
        }
    }
    throw Object.assign(new Error('تعذر تحديث محاولات الدخول'), { statusCode: 503 });
}

export async function synthesizeArabicSpeech(text) {
    const key = process.env.AZURE_SPEECH_KEY?.trim();
    const region = process.env.AZURE_SPEECH_REGION?.trim();
    if (!key || !region) return { audioBase64: '', status: 'not_configured' };
    const voice = process.env.AZURE_SPEECH_VOICE?.trim() || 'ar-SA-HamedNeural';
    if (!/^[a-z0-9]+$/i.test(region) || !/^[A-Za-z0-9-]{3,64}$/.test(voice)) return { audioBase64: '', status: 'failed' };
    const escaped = String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
    const xml = `<speak version="1.0" xml:lang="ar-SA"><voice xml:lang="ar-SA" name="${voice}">${escaped}</voice></speak>`;
    const response = await fetch(`https://${encodeURIComponent(region)}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
            'User-Agent': 'aait-sales-control'
        },
        body: xml,
        signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) return { audioBase64: '', status: 'failed' };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 1024 * 1024) return { audioBase64: '', status: 'failed' };
    return { audioBase64: bytes.toString('base64'), status: 'ready' };
}

export async function getOrCreateSpeech(text) {
    const { createHash } = await import('node:crypto');
    const cacheKey = createHash('sha256').update(text).digest('hex');
    const cachePath = `audioCache/${cacheKey}`;
    try {
        const cached = await firebaseDatabaseRequest(cachePath);
        if (cached?.audioBase64 && Number(cached.expiresAt) > Date.now()) {
            return { audioBase64: cached.audioBase64, status: 'ready', cached: true };
        }
    } catch { /* the visual call must still be sent if speech cache is unavailable */ }
    try {
        const generated = await synthesizeArabicSpeech(text);
        if (generated.status === 'ready') {
            try {
                await firebaseDatabaseRequest(cachePath, 'PUT', {
                    audioBase64: generated.audioBase64,
                    createdAt: Date.now(),
                    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
                });
            } catch { /* use this in-memory result even if cache persistence fails */ }
        }
        return generated;
    } catch {
        return { audioBase64: '', status: 'failed' };
    }
}
