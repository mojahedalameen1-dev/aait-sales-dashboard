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
    canContinue = () => true
}) {
    return async audioBlob => {
        if (!(audioBlob instanceof Blob)) return { started: false, reason: 'speech_unavailable', repetitions: 0, completedRepetitions: 0 };
        let started = 0;
        let completed = 0;
        let lastResult = null;

        for (let repetition = 1; repetition <= ALERT_AUDIO_REPETITIONS; repetition++) {
            if (!canContinue()) return result('expired');

            const beep = await playBeep({ repetition, total: ALERT_AUDIO_REPETITIONS });
            if (!beep?.started || beep.completed !== true || beep.reason) {
                return result(beep?.reason || 'beep_playback_failed');
            }

            if (!canContinue()) return result('expired');
            lastResult = await playSpeech(audioBlob, { repetition, total: ALERT_AUDIO_REPETITIONS });
            if (lastResult?.started) started++;
            if (!lastResult?.completed || lastResult.reason) {
                return result(lastResult?.reason || 'speech_playback_failed');
            }
            completed++;

            if (repetition < ALERT_AUDIO_REPETITIONS) {
                await wait(ALERT_AUDIO_REPEAT_SILENCE_MS);
                if (!canContinue()) return result('expired');
            }
        }

        return {
            ...lastResult,
            started: started > 0,
            repetitions: started,
            completedRepetitions: completed,
            expectedRepetitions: ALERT_AUDIO_REPETITIONS
        };

        function result(reason) {
            return {
                ...(lastResult || {}),
                started: started > 0,
                reason,
                repetitions: started,
                completedRepetitions: completed,
                expectedRepetitions: ALERT_AUDIO_REPETITIONS
            };
        }
    };
}
