import { createSign, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
    ADMIN_ROLES,
    firebaseDatabaseReadWithEtag,
    firebaseDatabaseRequest,
    getFirebaseClientConfig,
    parseAdminMap,
    setFirebaseSessionCookie
} from './shared.js';

const scrypt = promisify(scryptCallback);
const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const CUSTOM_TOKEN_AUDIENCE = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
const REQUIRED_ROLE_IDS = Object.keys(ADMIN_ROLES);

function base64Url(value) {
    return Buffer.from(value).toString('base64url');
}

function getAccount() {
    try { return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || ''); }
    catch { return null; }
}

export function validateNewPassword(password) {
    return typeof password === 'string'
        && password.length >= 14
        && password.length <= 128
        && Buffer.byteLength(password, 'utf8') <= 256;
}

export async function hashAdminPassword(password, salt = randomBytes(16)) {
    if (!validateNewPassword(password)) throw Object.assign(new Error('استخدم كلمة مرور من 14 إلى 128 حرفًا'), { statusCode: 400 });
    const digest = await scrypt(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${Buffer.from(digest).toString('base64url')}`;
}

export async function verifyAdminPassword(password, encodedHash) {
    if (typeof password !== 'string' || typeof encodedHash !== 'string' || encodedHash.length > 256) return false;
    const parts = encodedHash.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt'
        || Number(parts[1]) !== SCRYPT_N || Number(parts[2]) !== SCRYPT_R || Number(parts[3]) !== SCRYPT_P) return false;
    let salt;
    let expected;
    try {
        salt = Buffer.from(parts[4], 'base64url');
        expected = Buffer.from(parts[5], 'base64url');
    } catch { return false; }
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = Buffer.from(await scrypt(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }));
    return timingSafeEqual(actual, expected);
}

function assertThreeAdminAccounts() {
    const adminMap = parseAdminMap();
    if (!adminMap || Object.keys(adminMap).length !== REQUIRED_ROLE_IDS.length
        || REQUIRED_ROLE_IDS.some(roleId => !Object.values(adminMap).some(entry => entry.role === roleId))) {
        throw Object.assign(new Error('إعداد المسؤولين غير مكتمل'), { statusCode: 503 });
    }
    return adminMap;
}

export function getAdminPasswordSetup(adminMap, passwordsByUid) {
    if (!adminMap || !passwordsByUid || typeof passwordsByUid !== 'object') return null;
    const entries = Object.entries(adminMap);
    if (entries.length !== REQUIRED_ROLE_IDS.length || entries.some(([uid]) => !validateNewPassword(passwordsByUid[uid]))) return null;
    const passwords = entries.map(([uid]) => passwordsByUid[uid]);
    if (new Set(passwords).size !== REQUIRED_ROLE_IDS.length) return null;
    return entries;
}

export async function initializeAdminPasswords(passwordsByUid) {
    const adminMap = assertThreeAdminAccounts();
    const entries = getAdminPasswordSetup(adminMap, passwordsByUid);
    if (!entries) throw Object.assign(new Error('يلزم إعداد 3 كلمات مرور مختلفة، طول كل منها 14 حرفًا على الأقل'), { statusCode: 400 });
    const current = await firebaseDatabaseReadWithEtag('controlAuth/admins');
    if (current.data && Object.keys(current.data).length) {
        throw Object.assign(new Error('تم إعداد كلمات مرور المسؤولين مسبقًا؛ لم يتم تغيير أي بيانات'), { statusCode: 409 });
    }
    const records = {};
    for (const [uid, entry] of entries) {
        records[uid] = {
            passwordHash: await hashAdminPassword(passwordsByUid[uid]),
            sessionVersion: 1,
            role: entry.role,
            updatedAt: Date.now()
        };
    }
    await firebaseDatabaseRequest('controlAuth/admins', 'PUT', records, { 'if-match': current.etag });
    return { initialized: true, adminCount: entries.length };
}

export async function matchAdminPassword(password, adminMap, records) {
    if (!validateNewPassword(password) || !adminMap || !records) return null;
    const entries = Object.entries(adminMap);
    if (entries.length !== REQUIRED_ROLE_IDS.length
        || REQUIRED_ROLE_IDS.some(roleId => !entries.some(([, entry]) => entry.role === roleId))
        || entries.some(([uid]) => !records[uid]?.passwordHash || !Number.isSafeInteger(records[uid]?.sessionVersion))) return null;
    const matches = await Promise.all(entries.map(async ([uid, entry]) =>
        await verifyAdminPassword(password, records[uid].passwordHash) ? { uid, roleId: entry.role } : null));
    const authenticated = matches.filter(Boolean);
    return authenticated.length === 1 ? authenticated[0] : null;
}

export async function authenticateAdminPassword(password) {
    const adminMap = assertThreeAdminAccounts();
    const config = getFirebaseClientConfig();
    if (!config.firebaseConfigured || !config.serviceConfigured) throw Object.assign(new Error('إعداد الدخول الآمن غير مكتمل'), { statusCode: 503 });
    const records = await firebaseDatabaseRequest('controlAuth/admins');
    const match = await matchAdminPassword(password, adminMap, records);
    if (!match) return null;
    return { ...match, sessionVersion: records[match.uid].sessionVersion };
}

export function createFirebaseCustomToken(uid, sessionVersion, now = Math.floor(Date.now() / 1000)) {
    const account = getAccount();
    if (!account?.client_email || !account?.private_key || !/^[A-Za-z0-9:_-]{8,128}$/.test(uid)
        || !Number.isSafeInteger(sessionVersion) || sessionVersion < 1) {
        throw Object.assign(new Error('إعداد حساب خدمة Firebase غير مكتمل'), { statusCode: 503 });
    }
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64Url(JSON.stringify({
        iss: account.client_email,
        sub: account.client_email,
        aud: CUSTOM_TOKEN_AUDIENCE,
        iat: now,
        exp: now + 3600,
        uid,
        claims: { sessionVersion }
    }));
    const unsigned = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(account.private_key).toString('base64url')}`;
}

export async function establishFirebaseSession(uid, sessionVersion, request, response, sessionExpiresAt) {
    const config = getFirebaseClientConfig();
    if (!config.firebaseConfigured) throw Object.assign(new Error('إعداد Firebase غير مكتمل'), { statusCode: 503 });
    const customToken = createFirebaseCustomToken(uid, sessionVersion);
    const result = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(config.firebase.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }),
        signal: AbortSignal.timeout(8000)
    });
    const credentials = await result.json().catch(() => ({}));
    if (!result.ok || !credentials.idToken || !credentials.refreshToken) {
        throw Object.assign(new Error('تعذر إنشاء جلسة Firebase'), { statusCode: 502 });
    }
    setFirebaseSessionCookie(response, request, {
        idToken: credentials.idToken,
        refreshToken: credentials.refreshToken
    }, sessionExpiresAt);
    return { expiresIn: credentials.expiresIn };
}

async function updateAdminRecord(uid, updater) {
    const path = `controlAuth/admins/${uid}`;
    for (let attempt = 0; attempt < 5; attempt++) {
        const current = await firebaseDatabaseReadWithEtag(path);
        if (!current.data || !Number.isSafeInteger(current.data.sessionVersion) || current.data.sessionVersion < 1) {
            throw Object.assign(new Error('تعذر التحقق من جلسة المسؤول'), { statusCode: 503 });
        }
        const next = await updater(current.data);
        try {
            await firebaseDatabaseRequest(path, 'PUT', next, { 'if-match': current.etag });
            return next;
        } catch (error) {
            if (error.statusCode !== 412) throw error;
        }
    }
    throw Object.assign(new Error('تعذر تحديث جلسة المسؤول؛ حاول مرة أخرى'), { statusCode: 503 });
}

export async function revokeAdminSessions(uid) {
    return updateAdminRecord(uid, current => rotateAdminRecord(current));
}

export function rotateAdminRecord(current, changes = {}) {
    if (!Number.isSafeInteger(current?.sessionVersion) || current.sessionVersion < 1 || current.sessionVersion >= Number.MAX_SAFE_INTEGER) {
        throw Object.assign(new Error('تعذر التحقق من جلسة المسؤول'), { statusCode: 503 });
    }
    return { ...current, ...changes, sessionVersion: current.sessionVersion + 1, updatedAt: Date.now() };
}

export async function changeAdminPassword({ uid, currentPassword, newPassword }) {
    if (!validateNewPassword(newPassword)) throw Object.assign(new Error('استخدم كلمة مرور جديدة من 14 إلى 128 حرفًا'), { statusCode: 400 });
    const adminMap = assertThreeAdminAccounts();
    const recordMap = await firebaseDatabaseRequest('controlAuth/admins');
    if (!recordMap || Object.keys(recordMap).length !== REQUIRED_ROLE_IDS.length) {
        throw Object.assign(new Error('إعداد كلمات المرور غير مكتمل'), { statusCode: 503 });
    }
    const otherMatches = await Promise.all(Object.keys(adminMap).filter(otherUid => otherUid !== uid)
        .map(otherUid => verifyAdminPassword(newPassword, recordMap[otherUid]?.passwordHash)));
    if (otherMatches.some(Boolean)) throw Object.assign(new Error('يجب أن تختلف كلمة المرور عن كلمات مرور المسؤولين الآخرين'), { statusCode: 400 });
    const newHash = await hashAdminPassword(newPassword);
    return updateAdminRecord(uid, async current => {
        if (!await verifyAdminPassword(currentPassword, current.passwordHash)) {
            throw Object.assign(new Error('كلمة المرور الحالية غير صحيحة'), { statusCode: 401 });
        }
        if (await verifyAdminPassword(newPassword, current.passwordHash)) {
            throw Object.assign(new Error('اختر كلمة مرور جديدة مختلفة عن الحالية'), { statusCode: 400 });
        }
        return rotateAdminRecord(current, { passwordHash: newHash });
    });
}

export function publicRoleForAdmin(roleId) {
    return ADMIN_ROLES[roleId] || null;
}
