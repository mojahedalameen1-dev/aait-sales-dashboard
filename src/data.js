/**
 * data.js — Data layer: Settings management, CSV fetch, robust parsing, local cache
 */

// ========================================
// 🔧 SETTINGS & CONFIG
// ========================================

const STORAGE_KEY_SETTINGS = 'aait_settings';
const STORAGE_KEY_DATA = 'aait_meetings_data';
const STORAGE_KEY_LAST_SYNC = 'aait_last_sync';

const DEFAULT_SETTINGS = {
    sheetId: '', // User must provide this
    refreshInterval: 1, // 1 minute (prevents 400 rate limiting)
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

/**
 * 🗓️ خريطة التبويبات الشهرية — MONTHLY TAB MAP
 * أضف GID كل شهر جديد هنا بسطر واحد فقط:
 * 'YYYY-MM': 'GID'
 *
 * كيف تجد رقم GID؟
 * 1. افتح Google Sheets
 * 2. انتقل للتبويب الذي تريده
 * 3. انظر للرابط في المتصفح: ?gid=XXXXXXXX
 * 4. الرقم بعد gid= هو ما تحتاجه
 */
const SHEET_TAB_GIDS = {
    '2026-02': '951085024',    // فبراير 2026
    '2026-03': '1826079126',   // مارس 2026 ✅
    '2026-04': '507439430',    // أبريل 2026 
    '2026-05': '1614080437',   // مايو 2026 🆕
};

/**
 * اختر GID بناءً على الشهر الحالي تلقائياً.
 * إذا لم يوجد GID للشهر الحالي، يرجع لآخر شهر مُعرَّف.
 */
function getCurrentMonthGID() {
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // بحث مباشر عن الشهر الحالي
    if (SHEET_TAB_GIDS[key]) {
        console.log(`[Sheets] ✅ تبويب الشهر الحالي: ${key} → GID: ${SHEET_TAB_GIDS[key]}`);
        return SHEET_TAB_GIDS[key];
    }

    // Fallback: آخر شهر مُعرَّف في الخريطة
    const keys = Object.keys(SHEET_TAB_GIDS).sort();
    const lastKey = keys[keys.length - 1];
    console.warn(`[Sheets] ⚠️ لا يوجد GID للشهر ${key}، جاري استخدام آخر تبويب: ${lastKey}`);
    return SHEET_TAB_GIDS[lastKey] || null;
}

/**
 * Fetch CSV from Google Sheets (publish key format only)
 * Regular sheet IDs require auth and cause CORS errors, so only 2PACX- keys are accepted.
 */
async function fetchCSV() {
    const { sheetId } = getSettings();

    // Only use user ID if it's a valid publish key (starts with 2PACX-)
    const activeKey = (sheetId && sheetId.startsWith('2PACX-')) ? sheetId : DEFAULT_PUBLISH_KEY;

    // 🗓️ اختيار GID تلقائياً بناءً على الشهر الحالي
    const activeGID = getCurrentMonthGID();
    const url = `https://docs.google.com/spreadsheets/d/e/${activeKey}/pub?gid=${activeGID}&single=true&output=csv`;

    const response = await fetch(`${url}&_t=${Date.now()}`, { cache: "no-store" });

    if (!response.ok) {
        throw new Error(`فشل الاتصال: ${response.status}`);
    }

    const text = await response.text();

    // 🛡️ Safety Check: Google Sheets sometimes returns HTML (200 OK) if the sheet is not found/private
    if (text.trim().startsWith('<')) {
        throw new Error('الملف غير متاح أو غير منشور (HTML Response)');
    }

    return text;
}

/**
 * Robust CSV parser using state machine to handle quoted fields and multiline values.
 */
function parseCSV(csvText) {
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
function parseTimeStr(timeStr) {
    if (!timeStr) return '';

    let cleaned = timeStr.trim();

    // Check for AM/PM indicators before stripping non-digits
    const isPM = /pm|م|مساء/i.test(cleaned);
    const isAM = /am|ص|صباح/i.test(cleaned);

    // Remove Arabic/extra chars, normalize
    cleaned = cleaned.replace(/[^\d:]/g, '');

    // Handle H:MM or HH:MM
    const match = cleaned.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
        let h = parseInt(match[1], 10);
        const m = match[2];

        // Smarter Heuristic (The 10 AM Rule)
        if (!isPM && !isAM) {
            // If hour < 10, treat as PM (e.g. 8:00 -> 20:00)
            // If hour >= 10, treat as AM (e.g. 10:00 -> 10:00, 11:00 -> 11:00)
            // Note: 12:00 remains 12:00 (Noon)
            // ⚠️ HEURISTIC: Hours below 10 are assumed PM (e.g. 8:00 → 20:00).
        // This works because all current meetings are in the afternoon.
        // If a morning meeting (before 10 AM) is ever added to the sheet,
        // it MUST include an explicit AM/ص indicator, otherwise it will be 
        // incorrectly converted to PM.
        if (h < 10) {
                h += 12;
            } else if (h === 12) {
                h = 12; // 12 PM (Noon) explicitly
            }
        } else {
            // 12-hour to 24-hour conversion if indicator IS present
            if (isPM && h < 12) h += 12;
            if (isAM && h === 12) h = 0;
        }

        return `${String(h).padStart(2, '0')}:${m}`;
    }

    return timeStr.trim();
}

/**
 * Normalize date to YYYY/MM/DD to ensure correct sorting
 */
function normalizeDate(dateStr) {
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
    // Skip header row usually, but sometimes Google Sheets CSV includes title first.
    // We'll rely on smart filtering below.

    const dataRows = rows.slice(1); // Assume row 1 is headers
    const filledRows = forwardFillDates(dataRows);

    const meetings = [];


    for (const row of filledRows) {
        if (isDateHeaderRow(row)) continue;

        // Check minimum columns existence
        const project = (row[1] || '').trim();  // B column: اسم المشروع
        const team    = (row[2] || '').trim();  // C column: الفريق / المهندس
        const time    = (row[3] || '').trim();  // D column: الساعة (الوقت)

        if (!project && !time) continue;

        // BUG-02: Stable ID Generation
        const stableId = btoa(unescape(encodeURIComponent(`${row[0]}-${time}-${project}`))).substring(0, 12).replace(/\//g, '_');

        meetings.push({
            id: stableId,
            date: normalizeDate((row[0] || '').trim()),
            project: project,
            team: team,
            time: parseTimeStr(time),
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

function saveMeetings(meetings) {
    try {
        localStorage.setItem(STORAGE_KEY_DATA, JSON.stringify(meetings));
        localStorage.setItem(STORAGE_KEY_LAST_SYNC, new Date().toISOString());
    } catch (e) {
        console.warn('LocalStorage save failed:', e);
    }
}

function loadCachedMeetings() {
    try {
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
    try {
        const csvText = await fetchCSV();
        const rows = parseCSV(csvText);
        const meetings = mapRowsToMeetings(rows);

        saveMeetings(meetings);
        return { meetings, fromCache: false, error: null };
    } catch (error) {
        console.error('Fetch error:', error);
        const cached = loadCachedMeetings();
        return {
            meetings: cached || getDemoMeetings(),
            fromCache: true,
            error: error.message
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
    let lastKnownMeetings = loadCachedMeetings() || [];
    let isPolling = false;

    const poll = async () => {
        if (isPolling) return;
        isPolling = true;

        const thisRequestTime = Date.now();
        latestRequestTime = thisRequestTime;

        cleanupReversionTracker();

        try {
            const result = await fetchMeetings();
            
            // On Success: Reset backoff
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

export function formatTodayDate() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`; // YYYY/MM/DD
}

/**
 * THE GOLDEN RULE: Robust check for "Done" status.
 * Handles Arabic "تم" and common completion strings.
 */
export function isDone(meeting) {
    if (!meeting || !meeting.status) return false;
    const s = meeting.status.trim();

    // 1. Exclude "Not Done" / "Cancelled" explicit phrases to avoid overlap
    // "لم يتم" contains "تم", so we must check this first!
    if (/لم يتم|not|fail/i.test(s)) return false;

    // 2. Check for positive completion
    return /تم|نجاح|complete|done|finish/i.test(s);
}

/**
 * Check if a meeting is cancelled/archived.
 * Handles Arabic "ملغي", "لم يتم" and common cancellation strings.
 */
export function isCancelled(meeting) {
    if (!meeting || !meeting.status) return false;
    const s = meeting.status.trim().toLowerCase();
    return /ملغ|لم يتم|cancel|postpone|مؤجل/i.test(s);
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
