/**
 * A small, silent carousel. Content is local and sources are linked per item;
 * no reading count or reward is inferred from the display interval.
 */
export const ADHKAR = Object.freeze([
    {
        id: 'tahlil',
        text: 'لا إله إلا الله',
        category: 'ذكر',
        source: { title: 'صحيح مسلم: 2137', url: 'https://sunnah.com/muslim:2137a' }
    },
    {
        id: 'tasbih',
        text: 'سبحان الله وبحمده، سبحان الله العظيم',
        category: 'ذكر',
        source: { title: 'صحيح البخاري: 7563', url: 'https://sunnah.com/bukhari:7563' }
    },
    {
        id: 'istighfar',
        text: 'أستغفر الله وأتوب إليه',
        category: 'ذكر',
        source: { title: 'صحيح البخاري: 6307', url: 'https://sunnah.com/bukhari:6307' }
    },
    {
        id: 'salawat',
        text: 'اللهم صل وسلم على نبينا محمد',
        category: 'دعاء',
        // A general supplication following the verse, not a verbatim hadith.
        source: {
            title: 'الصلاة على النبي · الأحزاب: 56',
            url: 'https://quran.com/33/56',
            note: 'صيغة دعاء عامة امتثالًا للأمر بالصلاة والسلام على النبي، وليست اقتباسًا حرفيًا من الآية أو حديث منسوب.'
        }
    },
    {
        id: 'hasanah',
        text: 'ربنا آتنا في الدنيا حسنة وفي الآخرة حسنة وقنا عذاب النار',
        category: 'دعاء',
        source: { title: 'القرآن الكريم · البقرة: 201', url: 'https://quran.com/2/201' }
    },
    {
        id: 'afw',
        text: 'اللهم إنك عفو تحب العفو فاعف عني',
        category: 'دعاء',
        source: { title: 'الترمذي: 3513 · حسن صحيح', url: 'https://dorar.net/hadith/sharh/110411' }
    },
    {
        id: 'hawqalah',
        text: 'لا حول ولا قوة إلا بالله',
        category: 'ذكر',
        source: { title: 'صحيح البخاري: 6384', url: 'https://sunnah.com/bukhari:6384' }
    }
].map(item => Object.freeze({ ...item, source: Object.freeze(item.source) })));

const activeSliders = new WeakMap();
const ROTATION_MS = 10000;
const FADE_MS = 150;

function safeSourceUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch {
        return '';
    }
}

/**
 * Mount once on a stable sidebar card. Only this card's slots are updated.
 * The clock option is a tiny setTimeout/clearTimeout interface for verification.
 */
export function createDhikrSlider(container, options = {}) {
    const noOp = { next() {}, previous() {}, pause() {}, resume() {}, destroy() {} };
    if (!container?.querySelector) return noOp;

    activeSliders.get(container)?.destroy();
    const doc = container.ownerDocument || globalThis.document;
    const view = doc?.defaultView || globalThis.window;
    const clock = options.clock || globalThis;
    const motion = options.motion || view?.matchMedia?.('(prefers-reduced-motion: reduce)');
    const items = (options.items || ADHKAR).filter(item => typeof item?.text === 'string' && item.text.trim());
    const text = container.querySelector('#dhikr-text');
    if (!text || items.length === 0) return noOp;

    const category = container.querySelector('#dhikr-category');
    const source = container.querySelector('#dhikr-source');
    const position = container.querySelector('#dhikr-position');
    const previousButton = container.querySelector('#dhikr-prev');
    const nextButton = container.querySelector('#dhikr-next');
    const toggleButton = container.querySelector('#dhikr-toggle-auto');
    const intervalMs = Math.max(1000, options.intervalMs || ROTATION_MS);
    const inactivityMs = Math.max(intervalMs, options.inactivityMs || intervalMs);
    const removers = [];
    let index = 0;
    let destroyed = false;
    let rotationTimer = null;
    let fadeTimer = null;
    let hovered = false;
    let focused = false;
    let pointerHeld = false;
    let manualPause = Boolean(motion?.matches);
    let reducedMotion = Boolean(motion?.matches);

    function listen(target, event, handler, eventOptions) {
        if (!target?.addEventListener) return;
        target.addEventListener(event, handler, eventOptions);
        removers.push(() => target.removeEventListener(event, handler, eventOptions));
    }

    function clearRotation() {
        if (rotationTimer !== null) clock.clearTimeout(rotationTimer);
        rotationTimer = null;
    }

    function clearFade() {
        if (fadeTimer !== null) clock.clearTimeout(fadeTimer);
        fadeTimer = null;
        container.classList.remove('dhikr-is-changing');
    }

    function canRotate() {
        return !destroyed && !manualPause && !hovered && !focused && !pointerHeld && !doc?.hidden && items.length > 1;
    }

    function updateRotationState() {
        container.dataset.rotation = canRotate() ? 'playing' : 'paused';
        if (toggleButton) {
            toggleButton.setAttribute('aria-pressed', String(manualPause));
            toggleButton.setAttribute('aria-label', manualPause ? 'تشغيل التبديل التلقائي للأذكار' : 'إيقاف التبديل التلقائي للأذكار');
            toggleButton.title = manualPause ? 'تشغيل التبديل التلقائي' : 'إيقاف التبديل التلقائي';
        }
    }

    function schedule(delay = intervalMs) {
        clearRotation();
        updateRotationState();
        if (!canRotate()) return;
        rotationTimer = clock.setTimeout(() => {
            rotationTimer = null;
            if (!canRotate()) return;
            select(index + 1, false);
            schedule();
        }, delay);
    }

    function render(announce) {
        const item = items[index];
        text.setAttribute('aria-live', announce ? 'polite' : 'off');
        text.textContent = item.text;
        if (category) category.textContent = item.category || 'ذكر';
        if (position) {
            position.textContent = `${index + 1} / ${items.length}`;
            position.setAttribute('aria-label', `${index + 1} من ${items.length}`);
        }
        if (source) {
            const href = safeSourceUrl(item.source?.url);
            source.textContent = item.source?.title || '';
            source.hidden = !href;
            source.title = item.source?.note || item.source?.title || '';
            if (href) source.setAttribute('href', href);
            else source.removeAttribute('href');
            source.setAttribute('target', '_blank');
            source.setAttribute('rel', 'noopener noreferrer');
        }
    }

    function select(nextIndex, announce = true) {
        if (destroyed) return;
        index = ((nextIndex % items.length) + items.length) % items.length;
        clearFade();
        if (reducedMotion) render(announce);
        else {
            container.classList.add('dhikr-is-changing');
            fadeTimer = clock.setTimeout(() => {
                fadeTimer = null;
                if (destroyed) return;
                render(announce);
                container.classList.remove('dhikr-is-changing');
            }, FADE_MS);
        }
    }

    function navigate(delta) {
        if (destroyed) return;
        select(index + delta, true);
        schedule(inactivityMs);
    }

    function pause() {
        if (destroyed) return;
        manualPause = true;
        schedule();
    }

    function resume() {
        if (destroyed) return;
        manualPause = false;
        schedule(inactivityMs);
    }

    previousButton?.setAttribute('aria-label', 'الذكر السابق');
    nextButton?.setAttribute('aria-label', 'الذكر التالي');
    previousButton?.setAttribute('aria-controls', 'dhikr-text');
    nextButton?.setAttribute('aria-controls', 'dhikr-text');
    if (previousButton) previousButton.disabled = items.length < 2;
    if (nextButton) nextButton.disabled = items.length < 2;
    container.setAttribute('aria-roledescription', 'عارض أذكار');
    text.setAttribute('aria-atomic', 'true');
    listen(previousButton, 'click', () => navigate(-1));
    listen(nextButton, 'click', () => navigate(1));
    listen(toggleButton, 'click', () => manualPause ? resume() : pause());
    listen(container, 'pointerenter', event => {
        if (event.pointerType === 'touch') return;
        hovered = true;
        schedule();
    });
    listen(container, 'pointerleave', () => { hovered = false; schedule(inactivityMs); });
    listen(container, 'pointerdown', () => { pointerHeld = true; schedule(); });
    const endPointerInteraction = () => {
        if (!pointerHeld) return;
        pointerHeld = false;
        schedule(inactivityMs);
    };
    listen(doc, 'pointerup', endPointerInteraction);
    listen(doc, 'pointercancel', endPointerInteraction);
    listen(container, 'focusin', () => { focused = true; schedule(); });
    listen(container, 'focusout', event => {
        focused = container.contains(event.relatedTarget);
        schedule(inactivityMs);
    });
    listen(container, 'keydown', event => {
        const target = event.target;
        if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '')) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            // In RTL, forward is to the left and previous is to the right.
            navigate(event.key === 'ArrowLeft' ? 1 : -1);
        } else schedule(inactivityMs);
    });
    listen(doc, 'visibilitychange', () => {
        if (doc.hidden) {
            clearFade();
            render(false);
        }
        schedule(inactivityMs);
    });
    const onMotionChange = event => {
        reducedMotion = event.matches;
        if (reducedMotion) {
            manualPause = true;
            clearFade();
            render(false);
        }
        schedule(inactivityMs);
    };
    if (motion?.addEventListener) listen(motion, 'change', onMotionChange);
    else if (motion?.addListener) {
        motion.addListener(onMotionChange);
        removers.push(() => motion.removeListener(onMotionChange));
    }

    const controller = {
        next: () => navigate(1),
        previous: () => navigate(-1),
        pause,
        resume,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            clearRotation();
            clearFade();
            removers.forEach(remove => remove());
            container.dataset.rotation = 'paused';
            activeSliders.delete(container);
        }
    };
    activeSliders.set(container, controller);
    render(false);
    schedule();
    return controller;
}
