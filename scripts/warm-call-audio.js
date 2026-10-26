import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT, loadLocalEnvironment, requireProviderConfirmation } from './audio-env.js';
import { ADMIN_ROLES, CONTROL_EMPLOYEES } from '../server/control/shared.js';
import { makeCallText } from '../server/control/calls.js';
import {
    getSpeechSettings,
    isValidWav,
    MAX_WAV_BYTES,
    prepareSpeechRequest,
    synthesizeGroqSpeech
} from '../server/control/audio-cache.js';

const assetDirectory = resolve(PROJECT_ROOT, 'public/audio/calls');

async function readExistingWav(path) {
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_WAV_BYTES) return { exists: true, valid: false };
        const bytes = await readFile(path);
        return { exists: true, valid: isValidWav(bytes), bytes };
    } catch (error) {
        if (error.code === 'ENOENT') return { exists: false, valid: false };
        throw error;
    }
}

/** Publish complete bytes atomically without ever replacing an existing WAV. */
async function writeImmutableWav(path, bytes) {
    if (!isValidWav(bytes)) throw new Error('Invalid WAV');
    const temporary = resolve(assetDirectory, `.partial-${randomUUID()}.wav`);
    let handle;
    let temporaryCreated = false;
    try {
        handle = await open(temporary, 'wx', 0o644);
        temporaryCreated = true;
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = null;
        // A hard link creates the final pathname atomically and fails with
        // EEXIST instead of replacing a previous voice/version asset.
        await link(temporary, path);
    } finally {
        await handle?.close().catch(() => {});
        if (temporaryCreated) {
            await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
    }
}

/** Index every validated immutable version already present; never delete WAVs. */
export async function writeStaticAudioManifest(directory = assetDirectory) {
    const keys = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.wav$/.test(entry.name)) continue;
        if ((await readExistingWav(resolve(directory, entry.name))).valid) keys.push(entry.name.slice(0, -4));
    }
    keys.sort();
    const path = resolve(directory, 'manifest.json');
    const content = `${JSON.stringify({ version: 1, keys }, null, 2)}\n`;
    if (await readFile(path, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; }) === content) return keys;
    const temporary = resolve(directory, `.manifest-${randomUUID()}.json`);
    let handle;
    try {
        handle = await open(temporary, 'wx', 0o644);
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporary, path);
    } finally {
        await handle?.close().catch(() => {});
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return keys;
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const totals = { hits: 0, misses: 0, failures: 0, bytes: 0 };
    try {
        // A dry run deliberately skips .env.local and every service call.
        if (!dryRun) {
            requireProviderConfirmation();
            if (!process.argv.includes('--approve-all-15')) throw new Error('Bulk voice approval is required');
            await loadLocalEnvironment();
            if (!process.env.GROQ_API_KEY?.trim()) throw new Error('Groq is not configured');
        }
        const settings = getSpeechSettings({
            GROQ_VOICE: process.env.GROQ_VOICE,
            GROQ_SPEECH_CONFIG_VERSION: process.env.GROQ_SPEECH_CONFIG_VERSION
        });
        const requests = Object.values(ADMIN_ROLES).flatMap(role => CONTROL_EMPLOYEES.map(employee =>
            prepareSpeechRequest(makeCallText(employee, 'office', role.callerName), settings)));
        if (requests.length !== 15 || new Set(requests.map(request => request.cacheKey)).size !== 15) {
            throw new Error('Unexpected fixed-phrase combinations');
        }
        if (!dryRun) await mkdir(assetDirectory, { recursive: true });

        // Sequential by design: never create a burst of provider requests.
        for (const request of requests) {
            const path = resolve(assetDirectory, `${request.cacheKey}.wav`);
            try {
                const existing = await readExistingWav(path);
                if (existing.valid) {
                    totals.hits++;
                    totals.bytes += existing.bytes.length;
                    continue;
                }
                totals.misses++;
                if (existing.exists) {
                    // Preserve even an invalid existing asset for manual review.
                    totals.failures++;
                    continue;
                }
                if (dryRun) continue;
                const wav = await synthesizeGroqSpeech(request.text, request.settings);
                if (!isValidWav(wav)) throw new Error('Invalid WAV');
                try {
                    await writeImmutableWav(path, wav);
                    totals.bytes += wav.length;
                } catch (error) {
                    // Another local run may have won the create-only write.
                    if (error.code !== 'EEXIST') throw error;
                    const concurrent = await readExistingWav(path);
                    if (!concurrent.valid) throw new Error('Invalid existing WAV');
                    totals.bytes += concurrent.bytes.length;
                }
            } catch {
                totals.failures++;
            }
        }
        if (!dryRun) await writeStaticAudioManifest();
        if (totals.failures) process.exitCode = 1;
    } catch {
        totals.failures++;
        process.exitCode = 1;
    }

    // Counts only: never log phrases, employee names, credentials or provider bodies.
    process.stdout.write(`${JSON.stringify({ dryRun, ...totals })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
