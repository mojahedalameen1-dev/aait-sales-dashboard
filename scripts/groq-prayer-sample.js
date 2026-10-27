/** One isolated Riyadh prayer phrase sample; never writes into public assets or sends a board call. */
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getSpeechSettings, isValidWav, synthesizeGroqSpeech } from '../server/control/audio-cache.js';
import { parseEnvironment, PROJECT_ROOT, requireProviderConfirmation } from './audio-env.js';

const SAMPLE_TEXT = 'حان الآن وقت أذان صلاة الفجر.';
const SAMPLE_PATH = join(PROJECT_ROOT, '.audio-test', 'prayer-sample-fajr-adhan.wav');
const LOCK_PATH = join(PROJECT_ROOT, '.audio-test', 'prayer-sample.lock');

function inspectWav(bytes) {
    let channels = 0; let sampleRate = 0; let bitsPerSample = 0; let dataBytes = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const name = bytes.toString('ascii', offset, offset + 4);
        const size = bytes.readUInt32LE(offset + 4);
        if (name === 'fmt ' && size >= 16) {
            channels = bytes.readUInt16LE(offset + 10);
            sampleRate = bytes.readUInt32LE(offset + 12);
            bitsPerSample = bytes.readUInt16LE(offset + 22);
        }
        if (name === 'data') dataBytes = size;
        offset += 8 + size + size % 2;
    }
    const seconds = channels && sampleRate && bitsPerSample
        ? dataBytes / (sampleRate * channels * bitsPerSample / 8) : 0;
    return { channels, sampleRate, bitsPerSample, bytes: bytes.length, durationSeconds: Number(seconds.toFixed(2)) };
}

try {
    requireProviderConfirmation();
    await mkdir(join(PROJECT_ROOT, '.audio-test'), { recursive: true });
    try { await readFile(SAMPLE_PATH); throw new Error('العينة موجودة مسبقًا؛ لم يُرسل أي طلب جديد.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lock = await open(LOCK_PATH, 'wx', 0o600);
    try {
    const environmentText = await readFile(join(PROJECT_ROOT, '.env.local'), 'utf8');
    const environment = parseEnvironment(environmentText);
    const apiKey = environment.get('GROQ_API_KEY')?.trim();
    if (!/^gsk_[A-Za-z0-9]{20,}$/.test(apiKey || '')) throw new Error('لم يُرسل أي طلب: GROQ_API_KEY غير مضبوط في ملف المشروع.');
    const settings = getSpeechSettings({
        GROQ_VOICE: 'fahad',
        GROQ_SPEECH_CONFIG_VERSION: 'aait-prayer-ar-v1'
    });
    let audio;
    const startedAt = performance.now();
    try {
        audio = await synthesizeGroqSpeech(SAMPLE_TEXT, settings, { apiKey });
    } catch (error) {
        const code = error.code || 'unavailable';
        const status = Number.isInteger(error.providerStatus) ? error.providerStatus : null;
        console.error(JSON.stringify({ sample: 'fajr-adhan', voice: 'fahad', code, status }));
        throw new Error('فشل توليد العينة الصوتية.');
    }
    if (!isValidWav(audio)) throw new Error('رفض الاختبار ملفًا ليس WAV سليمًا.');
    await writeFile(SAMPLE_PATH, audio, { flag: 'wx', mode: 0o600 });
    const report = {
        sample: 'fajr-adhan', text: SAMPLE_TEXT, voice: settings.voice, model: settings.model,
        responseMs: Math.round(performance.now() - startedAt), ...inspectWav(audio)
    };
    console.log(JSON.stringify(report));
    } finally {
        await lock.close();
        await unlink(LOCK_PATH).catch(() => {});
    }
} catch (error) {
    console.error(error.message || 'تعذر إكمال عينة الصلاة.');
    process.exitCode = 1;
}
