import test from 'node:test';
import assert from 'node:assert/strict';
import { toEnglishDigits, isSafeMeetingUrl } from '../src/utils.js';

test('display digits are always normalized to English numerals', () => {
    assert.equal(toEnglishDigits('موعد ١٢:٣٠ والتذكرة AA۷۸۹'), 'موعد 12:30 والتذكرة AA789');
    assert.equal(toEnglishDigits(2026), '2026');
});

test('company ticket links and Google Meet links are allowed, unsafe URL schemes remain blocked', () => {
    assert.equal(isSafeMeetingUrl('https://aaait.sa/odoo/crm/81925'), true);
    assert.equal(isSafeMeetingUrl('https://meet.google.com/abc-defg-hij'), true);
    assert.equal(isSafeMeetingUrl('javascript:alert(1)'), false);
    assert.equal(isSafeMeetingUrl('https://example.invalid/ticket'), false);
});
