const LAYOUT_PROFILES = {
    normal: { gap: 16, minCardWidth: 236, minCardHeight: 170, targetAspect: 1.45 },
    compact: { gap: 9, minCardWidth: 194, minCardHeight: 100, targetAspect: 1.65 },
    ultra: { gap: 5, minCardWidth: 160, minCardHeight: 54, targetAspect: 1.7 }
};

export function getMeetingLayoutMode(count) {
    if (count <= 12) return 'normal';
    if (count <= 25) return 'compact';
    return 'ultra';
}

/**
 * Choose the grid geometry that best fits the available card area.
 * Width and height must be the grid's content box after its sidebar and padding.
 */
export function chooseMeetingGridLayout({ count, width, height, mode = getMeetingLayoutMode(count) }) {
    const itemCount = Math.max(0, Math.floor(Number(count) || 0));
    const availableWidth = Math.max(0, Number(width) || 0);
    const availableHeight = Math.max(0, Number(height) || 0);
    const profile = LAYOUT_PROFILES[mode] || LAYOUT_PROFILES.normal;

    if (itemCount === 0) {
        return { mode, columns: 1, rows: 1, cardWidth: availableWidth, cardHeight: availableHeight, fits: true };
    }

    const maxColumns = Math.max(1, Math.min(itemCount,
        Math.floor((availableWidth + profile.gap) / (profile.minCardWidth + profile.gap)) || 1));
    let best = null;

    for (let columns = 1; columns <= maxColumns; columns++) {
        const rows = Math.ceil(itemCount / columns);
        const cardWidth = (availableWidth - profile.gap * (columns - 1)) / columns;
        const cardHeight = (availableHeight - profile.gap * (rows - 1)) / rows;
        const fits = cardWidth >= profile.minCardWidth && cardHeight >= profile.minCardHeight;
        const aspectRatio = cardWidth / Math.max(1, cardHeight);
        const aspectPenalty = Math.abs(Math.log(Math.max(0.01, aspectRatio) / profile.targetAspect));
        const sizePenalty = Math.max(0, profile.minCardWidth - cardWidth) / profile.minCardWidth
            + Math.max(0, profile.minCardHeight - cardHeight) / profile.minCardHeight;
        const unusedCells = columns * rows - itemCount;
        const sparseRowPenalty = (unusedCells / itemCount) * 6;
        const score = aspectPenalty + sizePenalty * 8 + sparseRowPenalty;

        if (!best || score < best.score) best = { mode, columns, rows, cardWidth, cardHeight, fits, score };
    }

    if (!best) {
        return { mode, columns: 1, rows: itemCount, cardWidth: availableWidth, cardHeight: availableHeight / itemCount, fits: false };
    }

    const { score, ...layout } = best;
    return layout;
}
