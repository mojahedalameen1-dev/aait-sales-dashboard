import { APP_TIME_ZONE, DEFAULT_MEETING_DURATION_MINUTES } from './config.js';

// ========================================
// 🔧 SETTINGS & CONFIG
// ========================================

const STORAGE_KEY_SETTINGS = 'aait_settings';
const STORAGE_KEY_DATA = 'aait_meetings_data';
const STORAGE_KEY_LAST_SYNC = 'aait_last_sync';
const STORAGE_KEY_SOURCE = 'aait_meetings_source';
const FETCH_TIMEOUT_MS = 15000;
const STALE_AFTER_MS = 5 * 60 * 1000;
const LOCAL_TAB_GIDS = {
    '2026-02': '951085024',
    '2026-03': '1826079126',
    '2026-04': '507439430',
    '2026-05': '1614080437',
    '2026-07': '1446268678',
    '2026-08': '474705831'
};

const DEFAULT_SETTINGS = {
    sheetId: '', // User must provide this
    refreshInterval: 1,
    soundEnabled: true
};

/**
 * Get current settings from localStorage or defaults
 */
export function getSettings() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY_SETTINGS);
        return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS;
    } catch {
        return DEFAULT_SETTINGS;
    }
}

/**
 * Save settings to localStorage
 */
export function updateSettings(newSettings) {
    const current = getSettings();
    const updated = { ...current, ...newSettings };
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(updated));
    return updated;
}

// ========================================
// 📊 Meeting Data Model
// ========================================

/**
 * @typedef {Object} Meeting
 * @property {string} id          — Unique identifier
 * @property {string} date        — Normalised Date YYYY/MM/DD
 * @property {string} time        — Normalised Time HH:MM (24h)
 * @property {string} project     — Project summary/name
 * @property {string} team        — Responsible team/person
 * @property {string} via         — Meeting channel
 * @property {string} status      — Meeting status
 * @property {string} ticketUrl   — CRM ticket URL
 * @property {string} meetUrl     — Google Meet URL
 * @property {string} clientStatus— Client status
 */

// ========================================
// 📥 CSV Fetch & Parse
// ========================================

// Default Publish Key (for /d/e/ format — only this works publicly)
const DEFAULT_PUBLISH_KEY = '2PACX-1vRMptn5kgbKPmukUxf-9os30G_B3HpvenSged4a5D3GcIS8UgAu9inlHRwe2gq28A';

const ARABIC_MONTH_NAMES = [
    'يناير', 'فبراير', 'مارس', 'ابريل', 'مايو', 'يونيو',
    'يوليو', 'اغسطس', 'سبتمبر', 'اكتوبر', 'نوفمبر', 'ديسمبر'
];

function getZonedDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: APP_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

export function getCurrentMonthInfo(date = new Date()) {
    const parts = getZonedDateParts(date);
    const monthIndex = Number(parts.month) - 1;
    return {
        key: `${parts.year}-${parts.month}`,
        sheetName: `${ARABIC_MONTH_NAMES[monthIndex]} ${parts.year}`,
        year: parts.year,
        month: parts.month
    };
}

function getActivePublishKey() {
    const { sheetId } = getSettings();
    return (sheetId && /^2PACX-[A-Za-z0-9_-]+$/.test(sheetId)) ? sheetId : DEFAULT_PUBLISH_KEY;
}

/**
 * Fetch CSV from Google Sheets (publish key format only)
 * Regular sheet IDs require auth and cause CORS errors, so only 2PACX- keys are accepted.
 */
async function fetchCSV() {
    const activeKey = getActivePublishKey();
    const monthInfo = getCurrentMonthInfo();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const apiResponse = await fetch(`/api/meetings?key=${encodeURIComponent(activeKey)}`, {
            cache: 'no-store',
            signal: controller.signal
        });
        const contentType = apiResponse.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const payload = await apiResponse.json();
            if (!apiResponse.ok) throw new Error(payload.error || 'تعذر جلب بيانات الاجتماعات');
            return {
                text: payload.csvText,
                monthInfo,
                sourceKey: `${activeKey}:${monthInfo.key}`,
                sheetName: payload.sheetName || monthInfo.sheetName
            };
        }

        const localGid = LOCAL_TAB_GIDS[monthInfo.key];
        if (!localGid) throw new Error(`تعذر العثور على تبويب ${monthInfo.sheetName}`);
        const fallbackUrl = `https://docs.google.com/spreadsheets/d/e/${activeKey}/pub?gid=${localGid}&single=true&output=csv&_t=${Date.now()}`;
        const response = await fetch(fallbackUrl, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`فشل الاتصال: ${response.status}`);
        const text = await response.text();
        if (text.trim().startsWith('<')) throw new Error('الملف غير متاح أو غير منشور');
        return { text, monthInfo, sourceKey: `${activeKey}:${monthInfo.key}`, sheetName: monthInfo.sheetName };
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('انتهت مهلة الاتصال بمصدر البيانات');
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Robust CSV parser using state machine to handle quoted fields and multiline values.
 */
export function parseCSV(csvText) {
    const records = [];
    let fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const ch = csvText[i];
        const next = csvText[i + 1];

        if (ch === '"') {
            if (inQuotes && next === '"') {
                // Escaped quote inside field
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            fields.push(current.trim());
            current = '';
        } else if ((ch === '\n' || (ch === '\r' && next === '\n')) && !inQuotes) {
            // End of record — only when NOT inside quotes
            if (ch === '\r') i++; // skip \n after \r
            fields.push(current.trim());
            // Clean \r\n from any field values before pushing
            records.push(fields.map(f => f.replace(/\r\n|\r|\n/g, ' ').trim()));
            fields = [];
            current = '';
        } else if (ch === '\r' && !inQuotes) {
            // standalone \r
            fields.push(current.trim());
            records.push(fields.map(f => f.replace(/\r\n|\r|\n/g, ' ').trim()));
            fields = [];
            current = '';
        } else {
            // Inside quoted field: replace \r\n with space to clean the value
            if (ch === '\r' && next === '\n' && inQuotes) {
                current += ' ';
                i++;
            } else if ((ch === '\n' || ch === '\r') && inQuotes) {
                current += ' ';
            } else {
                current += ch;
            }
        }
    }

    // Push last record if file doesn't end with newline
    if (current || fields.length > 0) {
        fields.push(current.trim());
        records.push(fields.map(f => f.replace(/\r\n|\r|\n/g, ' ').trim()));
    }

    return records;
}

/**
 * 🔑 Forward Fill Algorithm
 */
function forwardFillDates(rows) {
    let currentDate = '';

    return rows.map(row => {
        const dateField = (row[0] || '').trim();
        // Check if this looks like a date (contains / or - and digits)
        if (dateField && /\d/.test(dateField) && (/\//.test(dateField) || /-/.test(dateField))) {
            currentDate = dateField;
        }
        // Return row with filled date
        return [currentDate, ...row.slice(1)];
    });
}

/**
 * Detect if a row is a date header row (only date, rest empty)
 */
function isDateHeaderRow(row) {
    const project = (row[1] || '').trim();
    const time    = (row[3] || '').trim();  // D column (الوقت)

    // If no project AND no time, it's a structural/header row
    return !project && !time;
}

/**
 * Parse time string to 24h format with AM/PM support
 */
function createStableMeetingId(value) {
    let hashA = 0xdeadbeef;
    let hashB = 0x41c6ce57;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        hashA = Math.imul(hashA ^ code, 2654435761);
        hashB = Math.imul(hashB ^ code, 1597334677);
    }
    hashA = Math.imul(hashA ^ (hashA >>> 16), 2246822507) ^ Math.imul(hashB ^ (hashB >>> 13), 3266489909);
    hashB = Math.imul(hashB ^ (hashB >>> 16), 2246822507) ^ Math.imul(hashA ^ (hashA >>> 13), 3266489909);
    return `m-${(hashB >>> 0).toString(36)}${(hashA >>> 0).toString(36)}`;
}

function normalizeDigits(value = '') {
    return String(value)
        .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
        .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

export function parseTimeStr(timeStr) {
    if (!timeStr) return '';

    const original = normalizeDigits(timeStr).trim();
    const originalHourToken = original.match(/\d{1,2}/)?.[0] || '';
    const isPM = /pm|م|مساء/i.test(original);
    const isAM = /am|ص|صباح/i.test(original);
    const cleaned = original.replace(/[^\d:]/g, '');
    const match = cleaned.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return '';

    let h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (m > 59 || h > 23) return '';

    // جدول التشغيل يستخدم 1:00..9:00 للفترة المسائية إذا لم تُذكر ص/م.
    if (!isPM && !isAM) {
        if (originalHourToken.length === 1 && h >= 1 && h <= 9) h += 12;
    } else {
        if (isPM && h < 12) h += 12;
        if (isAM && h === 12) h = 0;
    }

    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Normalize date to YYYY/MM/DD to ensure correct sorting
 */
export function normalizeDate(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.trim().split(/[/\-]/);

    if (parts.length === 3) {
        const p0 = parts[0].trim();
        const p1 = parts[1].trim();
        const p2 = parts[2].trim();

        // Check if year is first (YYYY/MM/DD)
        if (p0.length === 4) {
            return `${p0}/${p1.padStart(2, '0')}/${p2.padStart(2, '0')}`;
        }
        // Check if year is last (D/M/YYYY or M/D/YYYY)
        // Defaulting to D/M/YYYY as it's common in the region
        else if (p2.length === 4) {
            return `${p2}/${p1.padStart(2, '0')}/${p0.padStart(2, '0')}`;
        }
    }
    return dateStr.trim();
}

/**
 * Map parsed CSV rows to Meeting objects
 */
function mapRowsToMeetings(rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('مصدر البيانات فارغ');
    if (rows[0].length < 6) throw new Error('بنية أعمدة جدول الاجتماعات غير صحيحة');

    const dataRows = rows.slice(1);
    const filledRows = forwardFillDates(dataRows);

    const meetings = [];


    for (const row of filledRows) {
        if (isDateHeaderRow(row)) continue;

        // Check minimum columns existence
        const project = (row[1] || '').trim();  // B column: اسم المشروع
        const team    = (row[2] || '').trim();  // C column: الفريق / المهندس
        const time    = (row[3] || '').trim();  // D column: الساعة (الوقت)

        if (!project && !time) continue;

        const identitySource = [row[0], normalizedTime, project, team, (row[6] || '').trim()].join('|');
        const stableId = createStableMeetingId(identitySource);

        const normalizedTime = parseTimeStr(time);
        if (!normalizedTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(normalizedTime)) {
            console.warn('[Data] تم تجاهل اجتماع بوقت غير صالح:', { project, time });
            continue;
        }

        meetings.push({
            id: stableId,
            date: normalizeDate((row[0] || '').trim()),
            project: project,
            team: team,
            time: normalizedTime,
            via: (row[4] || '').trim(),
            status: (row[5] || '').trim(),
            ticketUrl: (row[6] || '').trim(),
            meetUrl: (row[7] || '').trim(),
            clientStatus: (row[8] || '').trim()
        });
    }

    return meetings;
}

// ========================================
// 💾 Local Storage Cache
// ========================================

function saveMeetings(meetings, sourceKey) {
    try {
        localStorage.setItem(STORAGE_KEY_DATA, JSON.stringify(meetings));
        localStorage.setItem(STORAGE_KEY_LAST_SYNC, new Date().toISOString());
        localStorage.setItem(STORAGE_KEY_SOURCE, sourceKey);
    } catch (e) {
        console.warn('LocalStorage save failed:', e);
    }
}

function loadCachedMeetings(sourceKey = null) {
    try {
        if (sourceKey && localStorage.getItem(STORAGE_KEY_SOURCE) !== sourceKey) return null;
        const data = localStorage.getItem(STORAGE_KEY_DATA);
        return data ? JSON.parse(data) : null;
    } catch {
        return null;
    }
}

function getLastSyncTime() {
    return localStorage.getItem(STORAGE_KEY_LAST_SYNC) || null;
}

// ========================================
// 🔄 Auto-Sync Logic
// ========================================

/**
 * Fetch and parse meetings
 */
export async function fetchMeetings() {
    const activeKey = getActivePublishKey();
    const monthInfo = getCurrentMonthInfo();
    const sourceKey = `${activeKey}:${monthInfo.key}`;

    try {
        const csvResult = await fetchCSV();
        const rows = parseCSV(csvResult.text);
        const meetings = mapRowsToMeetings(rows);

        const meetingsFromAnotherMonth = meetings.filter(meeting => meeting.date && !meeting.date.startsWith(`${monthInfo.year}/${monthInfo.month}/`));
        if (meetings.length > 0 && meetingsFromAnotherMonth.length === meetings.length) {
            throw new Error(`تعذر العثور على تبويب ${csvResult.sheetName}`);
        }

        saveMeetings(meetings, sourceKey);
        return {
            meetings,
            fromCache: false,
            stale: false,
            error: null,
            lastSync: getLastSyncTime(),
            sheetName: csvResult.sheetName
        };
    } catch (error) {
        console.error('Fetch error:', error);
        const cached = loadCachedMeetings(sourceKey);
        const lastSync = getLastSyncTime();
        const cacheAge = lastSync ? Date.now() - new Date(lastSync).getTime() : Infinity;
        return {
            meetings: cached || [],
            fromCache: true,
            stale: cacheAge > STALE_AFTER_MS,
            hasCache: Boolean(cached),
            error: error.message || 'تعذر تحديث البيانات',
            lastSync,
            sheetName: monthInfo.sheetName
        };
    }
}

/**
 * 🛰️ SYNC ENGINE & STABILITY CONTROL
 * 
 * ROOT CAUSE ANALYSIS: 
 * The synchronization loop issue ("Reversion Trap") occurs due to Google Sheets CDN/Cache lag.
 * When a meeting is marked 'Done' in the spreadsheet, the published CSV might intermittently 
 * serve an older version where the meeting is still 'Active'. This causes the app to flip-flop
 * because it thinks a user manually reverted the state.
 *
 * FIX: Empty-status meetings (no decision yet) are never flagged as reversions.
 * An empty cell means the meeting hasn't been processed — not that it was reverted from Done.
 */

let syncTimeoutId = null;
let consecutive400Errors = 0;
const reversionTracker = new Map(); // meetingId -> [timestamps]

/**
 * Cleanup old reversion records (> 60s)
 */
function cleanupReversionTracker() {
    const now = Date.now();
    for (const [id, timestamps] of reversionTracker.entries()) {
        const valid = timestamps.filter(t => now - t < 60000);
        if (valid.length === 0) {
            reversionTracker.delete(id);
        } else if (valid.length !== timestamps.length) {
            reversionTracker.set(id, valid);
        }
    }
}

export function stopAutoSync() {
    if (syncTimeoutId) {
        clearTimeout(syncTimeoutId);
        syncTimeoutId = null;
    }
}

export function startAutoSync(callback) {
    stopAutoSync();

    const { refreshInterval } = getSettings();
    const defaultIntervalMs = Math.max(1, parseFloat(refreshInterval)) * 60 * 1000;

    let latestRequestTime = 0;
    let lastKnownMeetings = loadCachedMeetings(`${getActivePublishKey()}:${getCurrentMonthInfo().key}`) || [];
    let isPolling = false;

    const poll = async () => {
        if (isPolling) return;
        isPolling = true;

        const thisRequestTime = Date.now();
        latestRequestTime = thisRequestTime;

        cleanupReversionTracker();

        try {
            const result = await fetchMeetings();

            if (result.error) {
                consecutive400Errors++;
                callback(result);
                isPolling = false;
                const backoffDelay = consecutive400Errors === 1
                    ? Math.max(defaultIntervalMs, 60000)
                    : consecutive400Errors === 2
                        ? Math.max(defaultIntervalMs, 120000)
                        : Math.max(defaultIntervalMs, 300000);
                scheduleNext(backoffDelay);
                return;
            }

            consecutive400Errors = 0;

            if (thisRequestTime !== latestRequestTime) {
                isPolling = false;
                scheduleNext(defaultIntervalMs);
                return;
            }

            // 🛡️ ANTI-FLAP CHECK
            if (lastKnownMeetings.length > 0 && result.meetings.length > 0) {
                const revertingMeetings = result.meetings.filter(newM => {
                    const oldM = lastKnownMeetings.find(m => m.id === newM.id);
                    if (!oldM) return false;
                    // 🔧 FIX: Empty status = meeting not yet processed, not a reversion
                    const newState = (newM.status || '').trim();
                    if (!newState) return false;
                    return isDone(oldM) && !isDone(newM) && !isCancelled(newM);
                });

                if (revertingMeetings.length > 0) {
                    const shouldSkipIds = new Set();
                    const shouldVerifyIds = new Set();
                    const now = Date.now();

                    for (const m of revertingMeetings) {
                        const history = reversionTracker.get(m.id) || [];
                        
                        if (history.length >= 3) {
                            // تجاوز الـ limit — لا تُضف للعداد، فقط تجاهل
                            console.warn(`[Sync] Flap limit reached for meeting: ${m.project}. Ignoring.`);
                            shouldSkipIds.add(m.id);
                        } else {
                            // لم يتجاوز — أضف للعداد وتحقق منه
                            history.push(now);
                            reversionTracker.set(m.id, history);
                            shouldVerifyIds.add(m.id);
                        }
                    }

                    // إذا لا يوجد شيء يحتاج تحقق، أكمل بشكل طبيعي
                    if (shouldVerifyIds.size === 0) {
                        lastKnownMeetings = result.meetings;
                        callback(result);
                        isPolling = false;
                        scheduleNext(defaultIntervalMs);
                        return;
                    }

                    // تحقق فقط من الاجتماعات غير المتجاوزة
                    console.warn('[Sync] Detected state reversion. Verifying...');
                    await new Promise(r => setTimeout(r, 1000));
                    const verifyResult = await fetchMeetings();

                    const isStillReverting = verifyResult.meetings.some(newM => {
                        if (!shouldVerifyIds.has(newM.id)) return false;
                        const oldM = lastKnownMeetings.find(m => m.id === newM.id);
                        // 🔧 FIX: Same guard in verification pass
                        const newState = (newM.status || '').trim();
                        if (!newState) return false;
                        return oldM && isDone(oldM) && !isDone(newM) && !isCancelled(newM);
                    });

                    if (isStillReverting) {
                        console.log('[Sync] Reversion verified. Updates confirmed.');
                        lastKnownMeetings = verifyResult.meetings;
                        callback(verifyResult);
                    } else {
                        console.warn('[Sync] CDN glitch. Keeping Done state.');
                    }

                    isPolling = false;
                    scheduleNext(defaultIntervalMs);
                    return;
                }
            }

            lastKnownMeetings = result.meetings;
            callback(result);
            isPolling = false;
            scheduleNext(defaultIntervalMs);

        } catch (err) {
            console.error('[Sync] Poll error:', err);
            isPolling = false;

            // 🪜 BACKOFF STRATEGY for 400 Errors (Rate Limiting)
            if (err.message.includes('400')) {
                consecutive400Errors++;
                let backoffDelay = defaultIntervalMs;
                
                if (consecutive400Errors === 1) backoffDelay = 60000;        // 1 minute
                else if (consecutive400Errors === 2) backoffDelay = 120000;  // 2 minutes
                else if (consecutive400Errors >= 3) backoffDelay = 300000;   // 5 minutes (Max)

                console.warn(`[Sync] Rate limited (400). Backing off for ${backoffDelay / 1000}s...`);
                scheduleNext(backoffDelay);
            } else {
                scheduleNext(defaultIntervalMs);
            }
        }
    };

    function scheduleNext(delay) {
        if (syncTimeoutId) clearTimeout(syncTimeoutId);
        syncTimeoutId = setTimeout(poll, delay);
    }

    poll();
    return stopAutoSync;
}

/**
 * Convert 24h time string to 12h format with Arabic suffixes (ص/م)
 * Uses English digits.
 */
export function formatTime12h(time24) {
    if (!time24) return '';
    try {
        const [hStr, mStr] = time24.split(':');
        let h = parseInt(hStr, 10);
        const suffix = h < 12 ? 'ص' : 'م';
        h = h % 12 || 12;
        return `${h}:${mStr} ${suffix}`;
    } catch (e) {
        return time24;
    }
}

export function groupByDate(meetings) {
    const today = formatTodayDate();
    const groups = new Map();

    // Get unique dates
    const dates = [...new Set(meetings.map(m => m.date))];

    // Sort: Today first, then descending by date
    dates.sort((a, b) => {
        if (a === today) return -1;
        if (b === today) return 1;
        return b.localeCompare(a);
    });

    for (const date of dates) {
        // Filter meetings for this date, keeping their original relative order (spreadsheet order)
        const dateMeetings = meetings.filter(m => m.date === date);
        if (dateMeetings.length > 0) {
            groups.set(date, dateMeetings);
        }
    }
    return groups;
}

export function formatTodayDate(date = new Date()) {
    const parts = getZonedDateParts(date);
    return `${parts.year}/${parts.month}/${parts.day}`;
}

export function getCurrentTimeParts(date = new Date()) {
    const parts = getZonedDateParts(date);
    return {
        hours: Number(parts.hour),
        minutes: Number(parts.minute),
        seconds: Number(parts.second)
    };
}

export function getMeetingTimingState(meeting, date = new Date()) {
    if (!meeting?.time) return { state: 'invalid', minutesUntil: Infinity };
    if (isCancelled(meeting)) return { state: 'cancelled', minutesUntil: Infinity };
    if (isDone(meeting)) return { state: 'done', minutesUntil: Infinity };

    const today = formatTodayDate(date);
    if (meeting.date !== today) return { state: 'other-day', minutesUntil: Infinity };

    const [hours, minutes] = meeting.time.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return { state: 'invalid', minutesUntil: Infinity };

    const nowParts = getCurrentTimeParts(date);
    const nowMinutes = nowParts.hours * 60 + nowParts.minutes + nowParts.seconds / 60;
    const startMinutes = hours * 60 + minutes;
    const duration = Number(meeting.durationMinutes) || DEFAULT_MEETING_DURATION_MINUTES;
    const minutesUntil = startMinutes - nowMinutes;

    const endMinutes = startMinutes + duration;
    if (minutesUntil > 0) return { state: 'upcoming', minutesUntil, startMinutes, endMinutes, duration };
    if (nowMinutes < endMinutes) return { state: 'running', minutesUntil, startMinutes, endMinutes, duration };
    return { state: 'overdue', minutesUntil, startMinutes, endMinutes, duration };
}

/**
 * THE GOLDEN RULE: Robust check for "Done" status.
 * Handles Arabic "تم" and common completion strings.
 */
export function isDone(meeting) {
    if (!meeting || !meeting.status) return false;
    const s = meeting.status
        .normalize('NFKD')
        .replace(/[\u064B-\u065F\u0670]/g, '')
        .trim()
        .toLowerCase();

    // Cancellation/postponement always wins over a generic "تم" token.
    if (isCancelled(meeting)) return false;
    return /^(تم|مكتمل|اكتمل|منجز|نجح|complete|completed|done|finished?)$/.test(s)
        || /^(تم\s+(التنفيذ|الاجتماع|الإنجاز))$/.test(s);
}

/**
 * Check if a meeting is cancelled/archived.
 * Handles Arabic "ملغي", "لم يتم" and common cancellation strings.
 */
export function isCancelled(meeting) {
    if (!meeting || !meeting.status) return false;
    const s = meeting.status
        .normalize('NFKD')
        .replace(/[\u064B-\u065F\u0670]/g, '')
        .trim()
        .toLowerCase();
    return /^(ملغي|ملغى|ملغاة|لم يتم|لم تتم|مؤجل|مؤجلة|تأجيل|تم التأجيل|تم الإلغاء|cancelled?|postponed?)$/.test(s);
}


// NOTE: getStatusIcon is not currently used in main.js rendering.
// Kept for potential future status badge feature.
export function getStatusIcon(via, status, hasMeetUrl = false) {
    // 1. Force Video if there's a meeting link
    if (hasMeetUrl) return 'video';

    const v = (via || '').toLowerCase();
    const s = (status || '').toLowerCase();

    // 2. Check Via for Remote/Video keywords (High Priority)
    if (v.includes('بعد') || v.includes('remote') || v.includes('zoom') || v.includes('meet')) return 'video';

    // 3. Check for External/Car (Medium Priority)
    if (s.includes('خارجي') || v.includes('خارجي') || s.includes('سيارة') || v.includes('سيارة')) return 'car';

    // 4. Check for Office/Building
    if (v.includes('حضوري') || v.includes('مكتب') || v.includes('office')) return 'building-2';
    if (s.includes('حضوري')) return 'building-2';

    return 'calendar'; // Generic calendar default
}

export { getLastSyncTime };

// ========================================
// 🎯 Demo Data
// ========================================

function getDemoMeetings() {
    const today = formatTodayDate();
    const now = new Date();

    const makeFutureTime = (offsetMinutes) => {
        const d = new Date(now.getTime() + offsetMinutes * 60000);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    return [
        {
            id: 'm-demo-1',
            date: today,
            project: 'تجربة النظام (Demo)',
            team: 'فريق المبيعات',
            time: makeFutureTime(10), // 10 mins from now
            via: 'عن بعد',
            status: 'خارجي',
            ticketUrl: '#',
            meetUrl: '#',
            clientStatus: 'نشط'
        },
        {
            id: 'm-demo-2',
            date: today,
            project: 'اجتماع المراجعة الأسبوعي',
            team: 'الإدارة',
            time: makeFutureTime(45),
            via: 'حضوري',
            status: 'حضوري',
            ticketUrl: '#',
            meetUrl: '#',
            clientStatus: ''
        }
    ];
}
