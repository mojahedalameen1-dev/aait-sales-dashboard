const DEFAULT_PUBLISH_KEY = '2PACX-1vRMptn5kgbKPmukUxf-9os30G_B3HpvenSged4a5D3GcIS8UgAu9inlHRwe2gq28A';
const TIME_ZONE = 'Asia/Riyadh';
const ARABIC_MONTH_NAMES = [
    'يناير', 'فبراير', 'مارس', 'ابريل', 'مايو', 'يونيو',
    'يوليو', 'اغسطس', 'سبتمبر', 'اكتوبر', 'نوفمبر', 'ديسمبر'
];

export function getCurrentSheetName() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${ARABIC_MONTH_NAMES[Number(values.month) - 1]} ${values.year}`;
}

export function normalizeArabic(value = '') {
    return value
        .normalize('NFKD')
        .replace(/[\u064B-\u065F\u0670]/g, '')
        .replace(/[أإآ]/g, 'ا')
        .trim()
        .toLowerCase();
}

export function extractSheets(html) {
    const sheets = [];
    const pattern = /items\.push\(\{name:\s*"([^"]+)"[\s\S]*?gid:\s*"(-?\d+)"/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
        sheets.push({ name: match[1], gid: match[2] });
    }
    return sheets;
}

export default async function handler(request, response) {
    if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return response.status(405).json({ error: 'Method not allowed' });
    }

    const requestedKey = typeof request.query?.key === 'string' ? request.query.key.trim() : '';
    const publishKey = /^2PACX-[A-Za-z0-9_-]+$/.test(requestedKey)
        ? requestedKey
        : process.env.GOOGLE_SHEETS_PUBLISH_KEY || DEFAULT_PUBLISH_KEY;

    try {
        const sheetName = getCurrentSheetName();
        const htmlUrl = `https://docs.google.com/spreadsheets/d/e/${publishKey}/pubhtml`;
        const htmlResponse = await fetch(htmlUrl, { signal: AbortSignal.timeout(12000) });
        if (!htmlResponse.ok) throw new Error(`Sheets index returned ${htmlResponse.status}`);

        const sheets = extractSheets(await htmlResponse.text());
        const target = sheets.find(sheet => normalizeArabic(sheet.name) === normalizeArabic(sheetName));
        if (!target) {
            return response.status(404).json({
                error: `تعذر العثور على تبويب ${sheetName}`,
                sheetName,
                availableSheets: sheets.map(sheet => sheet.name).slice(-6)
            });
        }

        const csvUrl = `https://docs.google.com/spreadsheets/d/e/${publishKey}/pub?gid=${target.gid}&single=true&output=csv`;
        const csvResponse = await fetch(csvUrl, { signal: AbortSignal.timeout(12000) });
        if (!csvResponse.ok) throw new Error(`Sheets CSV returned ${csvResponse.status}`);

        const csvText = await csvResponse.text();
        if (csvText.trim().startsWith('<')) throw new Error('Google Sheets returned HTML instead of CSV');

        response.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
        return response.status(200).json({ csvText, sheetName, gid: target.gid });
    } catch (error) {
        return response.status(502).json({ error: 'تعذر الاتصال بمصدر الاجتماعات', detail: error.message });
    }
}
