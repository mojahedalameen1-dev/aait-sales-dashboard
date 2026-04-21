/**
 * Utility functions for AAIT Sales Dashboard
 */

/**
 * Escapes HTML characters to prevent XSS attacks.
 * @param {string} str - The string to escape.
 * @returns {string} - The escaped string.
 */
export function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
/**
 * Formats meeting count according to Arabic grammar rules (Counting Rules).
 * @param {number} count 
 * @returns {string}
 */
export function formatMeetingCount(count) {
    const parts = getArabicMeetingParts(count);
    if (parts.isDual || parts.isZero || parts.isSingle) return parts.text;
    return `${parts.num} ${parts.text}`.trim();
}

/**
 * Returns meeting parts for UI logic (number/text/dual state)
 * @param {number} count 
 * @returns {{num: string, text: string, isDual: boolean, isZero: boolean, isSingle: boolean}}
 */
export function getArabicMeetingParts(count) {
    if (count === 0) return { num: '0', text: 'لا اجتماعات', isDual: false, isZero: true, isSingle: false };
    if (count === 1) return { num: '1', text: 'اجتماع واحد', isDual: false, isZero: false, isSingle: true };
    if (count === 2) return { num: '', text: 'اجتماعان', isDual: true, isZero: false, isSingle: false };
    
    if (count >= 3 && count <= 10) {
        return { num: String(count), text: 'اجتماعات', isDual: false, isZero: false, isSingle: false };
    }
    
    // 11+ suffix becomes "اجتماعاً" (singular accusative)
    return { num: String(count), text: 'اجتماع', isDual: false, isZero: false, isSingle: false };
}
/**
 * Returns a short engineer label from a team name string.
 * Used for display in meeting cards.
 */
export function getEngineerShortName(team) {
    if (!team) return '';
    if (/مجاهد/i.test(team))       return 'م.مجاهد';
    if (/أشرف|اشرف/i.test(team))   return 'م.أشرف';
    if (/شادي/i.test(team))         return 'م.شادي';
    if (/حسام/i.test(team))         return 'م.حسام';
    return team;
}
