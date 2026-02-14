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
    if (parts.isDual) return parts.text;
    return `${parts.num} ${parts.text}`.trim();
}

/**
 * Returns meeting parts for UI logic (number/text/dual state)
 * @param {number} count 
 * @returns {{num: string, text: string, isDual: boolean}}
 */
export function getArabicMeetingParts(count) {
    if (count === 0) return { num: '0', text: 'اجتماع', isDual: false };
    if (count === 1) return { num: '1', text: 'اجتماع', isDual: false };
    if (count === 2) return { num: '', text: 'اجتماعان', isDual: true };
    if (count >= 3 && count <= 10) return { num: String(count), text: 'اجتماعات', isDual: false };
    return { num: String(count), text: 'اجتماع', isDual: false };
}
