import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseMeetingGridLayout, getMeetingLayoutMode } from '../src/meeting-layout.js';

const viewportCases = [
    { width: 1920, height: 1080 },
    { width: 1600, height: 900 },
    { width: 1366, height: 768 },
    { width: 1905, height: 915 }
];
const meetingCounts = [9, 20, 35, 50];

function estimateGridBox({ width, height }, mode) {
    const sidebar = Math.min(440, Math.max(340, width * 0.224));
    const safeMargin = Math.min(48, Math.max(24, width * 0.022));
    const mainPadding = height <= 820 ? 6 : 8;
    const inset = height <= 820
        ? { normal: 8, compact: 6, ultra: 4 }[mode]
        : { normal: 12, compact: 8, ultra: 5 }[mode];
    return {
        width: width - sidebar - safeMargin - 2 * mainPadding - 2 * inset,
        height: height - 2 * mainPadding - 2 * inset
    };
}

test('meeting counts select the requested presentation modes', () => {
    assert.equal(getMeetingLayoutMode(1), 'normal');
    assert.equal(getMeetingLayoutMode(12), 'normal');
    assert.equal(getMeetingLayoutMode(13), 'compact');
    assert.equal(getMeetingLayoutMode(25), 'compact');
    assert.equal(getMeetingLayoutMode(26), 'ultra');
    assert.equal(getMeetingLayoutMode(50), 'ultra');
});

for (const viewport of viewportCases) {
    for (const count of meetingCounts) {
        test(`${count} meetings fit ${viewport.width}x${viewport.height}`, () => {
            const mode = getMeetingLayoutMode(count);
            const box = estimateGridBox(viewport, mode);
            const layout = chooseMeetingGridLayout({ count, ...box, mode });
            assert.equal(layout.columns * layout.rows >= count, true);
            assert.equal(layout.rows, Math.ceil(count / layout.columns));
            assert.equal(layout.cardWidth > 0, true);
            assert.equal(layout.cardHeight > 0, true);
            assert.equal(layout.fits, true, `selected ${layout.columns}x${layout.rows}, ${Math.round(layout.cardWidth)}x${Math.round(layout.cardHeight)} px`);
        });
    }
}
