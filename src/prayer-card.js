import {
    PRAYERS, PRAYER_CITIES, getPrayerCity, getRiyadhDate,
    formatPrayerTime, formatPrayerCountdown, createPrayerService
} from './prayer-times.js';
import { getPrayerPresentation } from './prayer-experience.js';

/** Owns the one schedule snapshot used by both the visible card and its audio alerts. */
export function createPrayerCard(container, { city = 'riyadh', now = () => new Date(), service = createPrayerService(), getIqamaSettings = () => null } = {}) {
    if (!container) return { tick() {}, setCity() {}, refresh() {}, getSnapshot: () => null, destroy() {} };
    let selectedCity = getPrayerCity(city)?.id || 'riyadh';
    let payload = null;
    let loading = false;
    let destroyed = false;
    let version = 0;
    let day = '';
    let signature = '';
    let retryAt = 0;
    let readyAt = Infinity;
    const slots = Object.fromEntries([
        'prayer-name', 'prayer-time', 'prayer-countdown', 'prayer-city-label',
        'prayer-day-label', 'prayer-timeline', 'prayer-status', 'prayer-retry',
        'prayer-phase-label', 'prayer-countdown-caption', 'prayer-next-detail'
    ].map(id => [id, container.querySelector(`#${id}`)]));
    const set = (id, value) => { if (slots[id] && slots[id].textContent !== value) slots[id].textContent = value; };

    function render(time) {
        const view = getPrayerPresentation(payload, time, getIqamaSettings());
        if (payload && !payload.stale) set('prayer-status', view.iqama ? 'الإقامة حسب الجدول اليدوي المعتمد في إعدادات اللوحة' : 'وفق طريقة أم القرى · بتوقيت السعودية');
        const next = view.prayer;
        container.dataset.phase = view.phase;
        set('prayer-phase-label', view.heading);
        set('prayer-countdown-caption', view.caption);
        const countdown = slots['prayer-countdown'];
        countdown?.classList.toggle('is-message', Boolean(view.message));
        countdown?.classList.toggle('en-nums', !view.message);
        countdown?.setAttribute('role', view.message ? 'status' : 'timer');
        countdown?.setAttribute('aria-label', view.message || (view.phase === 'waiting-iqama' ? `المتبقي على إقامة صلاة ${next?.label}` : 'المتبقي للصلاة القادمة'));
        const following = slots['prayer-next-detail'];
        if (following) {
            following.hidden = !view.next;
            following.textContent = view.next ? `الصلاة التالية: ${view.next.label} · ${formatPrayerTime(view.next.time)}${view.next.isTomorrow ? ' · غدًا' : ''}` : '';
        }
        set('prayer-city-label', getPrayerCity(selectedCity).label);
        if (!next) {
            set('prayer-countdown', '--:--:--');
            set('prayer-time', '--:--');
            set('prayer-day-label', '');
            if (payload) {
                set('prayer-name', 'بانتظار مواقيت الصلاة القادمة');
                set('prayer-status', 'نعيد المحاولة لتحميل المواقيت الصحيحة');
                container.classList.add('has-warning');
            }
        } else {
            set('prayer-name', next.label);
            set('prayer-time', formatPrayerTime(next.time));
            set('prayer-day-label', view.phase === 'waiting-iqama' ? 'موعد الأذان اليوم' : next.isTomorrow ? 'غدًا' : 'اليوم');
            set('prayer-countdown', view.message || formatPrayerCountdown(view.countdownMs));
        }
        const displayDate = next?.date || getRiyadhDate(time);
        const schedule = payload?.days.find(item => item.date === displayDate);
        const nextSignature = [selectedCity, displayDate, next?.key, view.phase, JSON.stringify(schedule?.timings)].join('|');
        if (signature === nextSignature) return;
        signature = nextSignature;
        const list = slots['prayer-timeline'];
        if (!list) return;
        const fragment = document.createDocumentFragment();
        for (const prayer of PRAYERS) {
            const item = document.createElement('li');
            const label = document.createElement('span');
            const timing = document.createElement('time');
            label.textContent = prayer.label;
            timing.className = 'en-nums';
            timing.textContent = formatPrayerTime(schedule?.timings[prayer.key]);
            if (schedule) timing.dateTime = `${schedule.date}T${schedule.timings[prayer.key]}:00+03:00`;
            if (next?.key === prayer.key) {
                item.className = ['adhan', 'waiting-iqama', 'iqama'].includes(view.phase) ? 'is-current' : 'is-next';
                item.setAttribute('aria-current', 'true');
                const state = document.createElement('small');
                state.className = 'prayer-timeline-state';
                state.textContent = item.className === 'is-current' ? 'الآن' : 'التالي';
                item.append(state);
            }
            item.append(label, timing);
            fragment.append(item);
        }
        list.replaceChildren(fragment);
        list.setAttribute('aria-label', next?.isTomorrow ? 'مواقيت الصلوات الخمس غدًا' : 'مواقيت الصلوات الخمس اليوم');
    }

    async function load(force = false) {
        if (destroyed || loading) return;
        const requestVersion = version;
        loading = true;
        container.setAttribute('aria-busy', 'true');
        if (!payload) set('prayer-name', 'جاري تحميل المواقيت');
        try {
            const result = await service.load(selectedCity, { force });
            if (destroyed || requestVersion !== version) return;
            payload = result;
            if (!Number.isFinite(readyAt)) readyAt = now().getTime();
            container.classList.remove('has-error');
            container.classList.toggle('has-warning', Boolean(result.stale));
            slots['prayer-retry'].hidden = !result.stale;
            set('prayer-status', result.stale ? result.warning || 'تُعرض آخر مواقيت محفوظة لهذا التاريخ' : 'وفق طريقة أم القرى · بتوقيت السعودية');
            retryAt = Date.now() + (result.stale ? 5 * 60000 : 12 * 60 * 60000);
        } catch (error) {
            if (destroyed || requestVersion !== version) return;
            container.classList.add('has-error', 'has-warning');
            slots['prayer-retry'].hidden = false;
            set('prayer-name', 'تعذر تحميل المواقيت');
            set('prayer-status', error.message || 'تعذر الاتصال بمصدر المواقيت');
            retryAt = Date.now() + 60000;
        } finally {
            if (!destroyed && requestVersion === version) {
                loading = false;
                container.setAttribute('aria-busy', 'false');
                render(now());
            }
        }
    }

    function tick(time = now()) {
        if (destroyed) return;
        const currentDay = getRiyadhDate(time);
        if (day !== currentDay) {
            day = currentDay;
            void load();
        } else if (!loading && Date.now() >= retryAt) void load();
        render(time);
    }
    const retry = () => void load(true);
    slots['prayer-retry']?.addEventListener('click', retry);
    tick();
    return {
        tick,
        setCity(value) {
            const nextCity = getPrayerCity(value);
            if (!nextCity || nextCity.id === selectedCity || destroyed) return;
            version++;
            loading = false;
            selectedCity = nextCity.id;
            payload = null;
            readyAt = Infinity;
            signature = '';
            retryAt = 0;
            container.classList.remove('has-error', 'has-warning');
            set('prayer-status', 'جاري تحميل مواقيت المدينة');
            render(now());
            void load();
        },
        refresh: () => load(true),
        getSnapshot: () => ({ payload, city: selectedCity, readyAt }),
        destroy() { destroyed = true; version++; slots['prayer-retry']?.removeEventListener('click', retry); }
    };
}

export function populatePrayerCities(select, currentCity = 'riyadh') {
    if (!select) return;
    select.replaceChildren(...PRAYER_CITIES.map(city => {
        const option = document.createElement('option');
        option.value = city.id;
        option.textContent = city.label;
        return option;
    }));
    select.value = getPrayerCity(currentCity)?.id || 'riyadh';
}
