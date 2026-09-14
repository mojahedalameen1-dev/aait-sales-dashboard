import test from 'node:test';
import assert from 'node:assert/strict';
import { toEnglishDigits } from '../src/utils.js';

test('display digits are always normalized to English numerals', () => {
    assert.equal(toEnglishDigits('موعد ١٢:٣٠ والتذكرة AA۷۸۹'), 'موعد 12:30 والتذكرة AA789');
    assert.equal(toEnglishDigits(2026), '2026');
});
