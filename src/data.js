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
    refreshInterval: 1, // Minutes
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
const GID = '951085024';

/**
 * Fetch CSV from Google Sheets (publish key format only)
 * Regular sheet IDs require auth and cause CORS errors, so only 2PACX- keys are accepted.
 */
async function fetchCSV() {
    const { sheetId } = getSettings();

    // Only use user ID if it's a valid publish key (starts with 2PACX-)
    const activeKey = (sheetId && sheetId.startsWith('2PACX-')) ? sheetId : DEFAULT_PUBLISH_KEY;
    const url = `https://docs.google.com/spreadsheets/d/e/${activeKey}/pub?gid=${GID}&single=true&output=csv`;

    const response = await fetch(`${url}&_t=${Date.now()}`, { cache: "no-store" });

    if (!response.ok) {
        throw new Error(`فشل الاتصال: ${response.status}`);
    }

    return await response.text();
}

/**
 * Smarter CSV parser: splits by line then by comma, handling quoted fields
 */
function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    const result = [];

    for (const line of lines) {
        const fields = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (ch === ',' && !inQuotes) {
                fields.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
        fields.push(current.trim());
        result.push(fields);
    }

    return result;
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
    const dateField = (row[0] || '').trim();
    if (!dateField || !/\d/.test(dateField)) return false;

    // If most other fields are empty, it's likely a date header
    const nonEmptyFields = row.slice(1).filter(f => (f || '').trim() !== '');
    return nonEmptyFields.length <= 1;
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

        // Heuristic if no AM/PM indicator is present
        if (!isPM && !isAM) {
            // 8, 9, 10, 11 => ص (AM)
            // 12, 1, 2, 3, 4, 5, 6, 7 => م (PM)
            if (h >= 1 && h <= 7) {
                h += 12;
            } else if (h === 12) {
                h = 12; // 12 PM
            }
            // 8-11 remains as is (AM)
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
    let id = 0;

    for (const row of filledRows) {
        if (isDateHeaderRow(row)) continue;

        // Check minimum columns existence
        const project = (row[1] || '').trim();  // B column
        const time = (row[3] || '').trim();     // C column (الساعة)

        if (!project && !time) continue;

        id++;
        meetings.push({
            id: `m-${id}`,
            date: normalizeDate((row[0] || '').trim()),
            project: project,
            team: (row[2] || '').trim(),
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
 * Update logic for startAutoSync to allow restarting if interval changes
 */
let syncIntervalId = null;

export function stopAutoSync() {
    if (syncIntervalId) {
        clearInterval(syncIntervalId);
        syncIntervalId = null;
    }
}

export function startAutoSync(callback) {
    stopAutoSync(); // Stop existing if any

    const { refreshInterval } = getSettings();
    const intervalMs = Math.max(0.25, parseFloat(refreshInterval)) * 60 * 1000;

    const poll = async () => {
        const result = await fetchMeetings();
        callback(result);
    };

    // Initial fetch called immediately
    poll();

    // Schedule next
    syncIntervalId = setInterval(poll, intervalMs);

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
    // Handle Arabic "تم" (including zero-width chars or spaces)
    return /تم|نجاح|complete|done|finish/i.test(s);
}

export function getNextMeeting(meetings) {
    const today = formatTodayDate();
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // 1. Get Today's Meetings that are NOT "Done"
    const pendingToday = meetings.filter(m => {
        if (m.date !== today) return false;
        return !isDone(m);
    });

    if (pendingToday.length === 0) return null;

    // 2. Split into FUTURE and OVERDUE groups
    const futureMeetings = [];
    const overdueMeetings = [];

    for (const m of pendingToday) {
        const [h, min] = m.time.split(':').map(Number);
        const meetingMinutes = h * 60 + min;
        if (meetingMinutes >= nowMinutes) {
            futureMeetings.push(m);
        } else if (meetingMinutes >= (nowMinutes - 60)) {
            // Only include overdue if within last 60 min
            overdueMeetings.push(m);
        }
    }

    // 3. PRIORITY: Future meetings FIRST, then overdue as fallback
    const sortByTime = (a, b) => {
        const [h1, mm1] = a.time.split(':').map(Number);
        const [h2, mm2] = b.time.split(':').map(Number);
        return (h1 * 60 + mm1) - (h2 * 60 + mm2);
    };

    let targetMeetings;
    let isOverdue = false;

    if (futureMeetings.length > 0) {
        // Show the nearest FUTURE meeting
        futureMeetings.sort(sortByTime);
        targetMeetings = futureMeetings;
        isOverdue = false;
    } else if (overdueMeetings.length > 0) {
        // No future meetings — fall back to the most recent overdue
        overdueMeetings.sort(sortByTime);
        targetMeetings = overdueMeetings;
        isOverdue = true;
    } else {
        return null;
    }

    const targetTime = targetMeetings[0].time;
    const batch = targetMeetings.filter(m => m.time === targetTime);

    // Metrics
    const [hBatch, minBatch] = targetTime.split(':').map(Number);
    const meetingMinutes = hBatch * 60 + minBatch;
    const diff = meetingMinutes - nowMinutes;

    return {
        meetings: batch,
        time: targetTime,
        minutesUntil: diff,
        totalMinutes: meetingMinutes,
        isOverdue: isOverdue
    };
}

export function getStatusIcon(via, status) {
    const v = (via || '').toLowerCase();
    const s = (status || '').toLowerCase();

    // 1. Check Status first for "External"
    if (s.includes('خارجي') || v.includes('خارجي')) return '🚗';
    if (s.includes('سيارة') || v.includes('سيارة')) return '🚗';

    // 2. Check Via
    if (v.includes('بعد') || v.includes('remote') || v.includes('zoom') || v.includes('meet')) return '🎥';
    if (v.includes('حضوري') || v.includes('مكتب') || v.includes('office')) return '🏢';

    // Default fallback based on status text if Via is ambiguous
    if (s.includes('حضوري')) return '🏢';

    return '📅'; // Generic calendar default
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
