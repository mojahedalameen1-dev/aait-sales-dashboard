export const ALERT_AUDIO_REPETITIONS = 2;
export const ALERT_AUDIO_REPEAT_SILENCE_MS = 3000;

/**
 * Runs the shared alert sequence. Playback callbacks resolve only after their
 * media element's `ended` event, so the gap begins after speech really ends.
 */
export function createAlertAudioSequence({
    playBeep,
    playSpeech,
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    canContinue = () => true,
    progress = { completed: 0, beep: false, lastCompletedAt: 0 },
    onProgress = () => {},
    now = Date.now,
    total = ALERT_AUDIO_REPETITIONS,
    silenceMs = ALERT_AUDIO_REPEAT_SILENCE_MS
}) {
    return async audioBlob => {
        if (!(audioBlob instanceof Blob)) return { started: false, reason: 'speech_unavailable', repetitions: 0, completedRepetitions: 0 };
        let started = 0;
        let completed = progress.completed;
        const firstRepetition = completed + 1;
        let lastResult = null;

        for (let repetition = firstRepetition; repetition <= total; repetition++) {
            if (!canContinue()) return result('expired');
            if (completed && repetition === firstRepetition && progress.lastCompletedAt && !progress.beep) {
                const remaining = silenceMs - (now() - progress.lastCompletedAt);
                if (remaining > 0) await wait(remaining);
                if (!canContinue()) return result('expired');
            }
            if (playBeep && !progress.beep) {
                const beep = await playBeep({ repetition, total });
                if (!beep?.started || beep.completed !== true || beep.reason) {
                    return result(beep?.reason || 'beep_playback_failed');
                }
                progress.beep = true;
            }

            if (!canContinue()) return result('expired');
            lastResult = await playSpeech(audioBlob, { repetition, total });
            if (lastResult?.started) started++;
            if (!lastResult?.completed || lastResult.reason) {
                return result(lastResult?.reason || 'speech_playback_failed');
            }
            completed++;
            progress.completed = completed;
            progress.beep = false;
            progress.lastCompletedAt = now();
            onProgress(progress);

            if (repetition < total) {
                await wait(silenceMs);
                if (!canContinue()) return result('expired');
            }
        }

        return {
            ...lastResult,
            started: started > 0 || completed > 0,
            repetitions: started,
            completedRepetitions: completed,
            expectedRepetitions: total
        };

        function result(reason) {
            return {
                ...(lastResult || {}),
                started: started > 0 || completed > 0,
                reason,
                repetitions: started,
                completedRepetitions: completed,
                expectedRepetitions: total
            };
        }
    };
}
