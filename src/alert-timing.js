export const ALERT_CATCHUP_MS = 10 * 60 * 1000;

export function shouldTriggerAlert(diffSeconds, thresholdSeconds, catchupMs = ALERT_CATCHUP_MS) {
    const alertAgeMs = (thresholdSeconds - diffSeconds) * 1000;
    const graceAfterStartSeconds = thresholdSeconds === 5 * 60 ? 5 * 60 : 0;
    return diffSeconds >= -graceAfterStartSeconds
        && alertAgeMs >= 0
        && alertAgeMs <= catchupMs;
}
