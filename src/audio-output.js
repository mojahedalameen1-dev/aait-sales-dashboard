// The same element is unlocked and used for all clips. An accepted play()
// request, a playing event and an ended event are separate observations.
export function createAudioOutput({ createPlayer = () => new Audio(), report = () => {} } = {}) {
    let player;
    let active;

    function play(src, { kind, volume = 1, probe = false, onStarted } = {}) {
        if (active) return Promise.resolve({ started: false, reason: 'busy' });
        return new Promise(resolve => {
            let started = false;
            let settled = false;
            let timeout;
            const finish = (reason, details = {}) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                player?.removeEventListener('playing', playing);
                player?.removeEventListener('ended', ended);
                player?.removeEventListener('error', error);
                active = null;
                if (probe || reason) player?.pause();
                if (reason) report('attempt_failed', { kind, reason, started, ...details });
                resolve({ started, completed: !reason && !probe, ...(reason ? { reason } : {}), ...details });
            };
            const playing = () => {
                if (started || settled) return;
                started = true;
                report('playing', { kind });
                try { onStarted?.(); } catch { /* Playback is independent of its status UI. */ }
            };
            const ended = () => {
                report('ended', { kind, started, audibility: 'unverified' });
                finish(probe || started ? undefined : 'ended_without_playing');
            };
            const error = () => {
                const mediaCode = player?.error?.code;
                report('error', { kind, mediaCode });
                finish(mediaCode === 3 || mediaCode === 4 ? 'invalid_media' : 'media_error', { mediaCode });
            };
            const rejected = exception => {
                const errorName = exception?.name || 'Error';
                report('play_rejected', { kind, errorName });
                finish(errorName === 'NotAllowedError' ? 'autoplay_blocked'
                    : errorName === 'NotSupportedError' ? 'invalid_media' : 'play_rejected', { errorName });
            };
            active = finish;
            try {
                player ||= createPlayer();
                player.preload = 'auto';
                player.volume = volume;
                if (player.getAttribute?.('src') !== src) player.src = src;
                try { player.currentTime = 0; } catch { /* A new source may not be seekable yet. */ }
                player.addEventListener('playing', playing);
                player.addEventListener('ended', ended);
                player.addEventListener('error', error);
                timeout = setTimeout(() => finish('playback_timeout'), probe ? 5000 : 45000);
                Promise.resolve(player.play()).then(() => {
                    if (!settled) report('play_resolved', { kind, probe });
                    if (probe) finish();
                }, rejected);
            } catch (exception) {
                rejected(exception);
            }
        });
    }

    return {
        play,
        cancel(reason = 'interrupted') { active?.(reason); },
        get busy() { return Boolean(active); }
    };
}
