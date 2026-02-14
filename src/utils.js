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
    if (count === 0) return 'لا توجد اجتماعات';
    if (count === 1) return 'اجتماع واحد';
    if (count === 2) return 'اجتماعان';
    if (count >= 3 && count <= 10) return `${count} اجتماعات`;
    return `${count} اجتماع`;
}
/**
 * Generates a simple, stable hash for a string.
 * Used for content-based meeting IDs.
 */
export function generateHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
}
