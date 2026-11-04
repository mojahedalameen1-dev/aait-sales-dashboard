export const APP_TIME_ZONE = 'Asia/Riyadh';
export const DEFAULT_MEETING_DURATION_MINUTES = 60;

export const ENGINEERS = [
    {
        id: 'mojahed',
        label: 'م.مجاهد',
        aliases: ['مجاهد', 'mojahed'],
        theme: 'mojahed',
        color: '#2962FF',
        audioPrefix: 'm'
    },
    {
        id: 'ashraf',
        label: 'م.أشرف',
        aliases: ['أشرف', 'اشرف', 'ashraf'],
        theme: 'ashraf',
        color: '#00C853',
        audioPrefix: 'a'
    },
    {
        id: 'shady',
        label: 'م.شادي',
        aliases: ['شادي', 'shady'],
        theme: 'shady',
        color: '#C6242C',
        audioPrefix: 's'
    },
    {
        id: 'hossam',
        label: 'م.حسام',
        aliases: ['حسام', 'hossam', 'hussam'],
        theme: 'hossam',
        color: '#FF6D00',
        meetingReminderAudioEnabled: false,
        audioPrefix: null
    }
];

export function getEngineerProfile(teamName = '') {
    const normalized = String(teamName).trim().toLowerCase();
    return ENGINEERS.find(engineer => engineer.aliases.some(alias => normalized.includes(alias.toLowerCase()))) || null;
}

export function getEngineerTheme(teamName) {
    return getEngineerProfile(teamName)?.theme || 'default';
}

export function getEngineerColor(teamName) {
    return getEngineerProfile(teamName)?.color || '#334155';
}

export function getEngineerAudioPrefix(teamName) {
    const profile = getEngineerProfile(teamName);
    if (profile?.meetingReminderAudioEnabled === false) return null;
    return profile?.audioPrefix || null;
}

export function isEngineerMeetingReminderAudioEnabled(teamName) {
    return getEngineerProfile(teamName)?.meetingReminderAudioEnabled !== false;
}

export function getEngineerLabel(teamName) {
    return getEngineerProfile(teamName)?.label || String(teamName || '').trim();
}
