import { firebaseDatabaseRequest, getFirebaseClientConfig, parseAdminMap } from './shared.js';
import { getPrayerAudioManifest } from './prayer-audio.js';

export default async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return response.status(405).json({ error: 'Method not allowed' });
    }
    const config = getFirebaseClientConfig();
    let adminPasswordsConfigured = false;
    if (config.firebaseConfigured && config.serviceConfigured && config.adminsConfigured) {
        try {
            const admins = parseAdminMap();
            const records = await firebaseDatabaseRequest('controlAuth/admins');
            adminPasswordsConfigured = Boolean(admins && records
                && Object.keys(admins).length === 3
                && Object.keys(records).length === 3
                && Object.keys(records).every(uid => Object.hasOwn(admins, uid))
                && Object.entries(admins).every(([uid]) => typeof records[uid]?.passwordHash === 'string'
                    && /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/.test(records[uid].passwordHash)
                    && Number.isSafeInteger(records[uid]?.sessionVersion)));
        } catch { adminPasswordsConfigured = false; }
    }
    const missing = [...new Set([...config.missing, ...(!adminPasswordsConfigured ? ['CONTROL_ADMIN_PASSWORDS'] : [])])];
    return response.status(200).json({
        firebaseConfigured: config.firebaseConfigured,
        serviceConfigured: config.serviceConfigured,
        adminsConfigured: config.adminsConfigured,
        rateLimitConfigured: config.rateLimitConfigured,
        sessionConfigured: config.sessionConfigured,
        adminPasswordsConfigured,
        speechConfigured: config.speechConfigured,
        prayerAudio: getPrayerAudioManifest(),
        firebase: config.firebase,
        missing
    });
}
