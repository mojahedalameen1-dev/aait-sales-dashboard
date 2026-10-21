import test from 'node:test';
import assert from 'node:assert/strict';
import { ADHKAR, createDhikrSlider } from '../src/adhkar.js';

class TestNode extends EventTarget {
    attributes = new Map();
    dataset = {};
    textContent = '';
    hidden = false;
    disabled = false;
    classes = new Set();
    classList = {
        add: value => this.classes.add(value),
        remove: value => this.classes.delete(value)
    };
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    querySelector(selector) { return this.slots?.[selector] || null; }
    contains(node) { return node === this || Object.values(this.slots || {}).includes(node); }
}

function fixture({ reducedMotion = false } = {}) {
    let now = 0;
    let timerId = 0;
    const timers = new Map();
    const clock = {
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); }
    };
    const motion = new TestNode();
    motion.matches = reducedMotion;
    const doc = new TestNode();
    doc.defaultView = { matchMedia: () => motion };
    const root = new TestNode();
    root.ownerDocument = doc;
    root.slots = Object.fromEntries(['text', 'category', 'source', 'position', 'prev', 'next', 'toggle-auto']
        .map(name => [`#dhikr-${name}`, new TestNode()]));
    const get = name => root.slots[`#dhikr-${name}`];
    function fire(target, name, values = {}) {
        const event = new Event(name, { cancelable: true });
        Object.entries(values).forEach(([key, value]) => Object.defineProperty(event, key, { value }));
        target.dispatchEvent(event);
        return event;
    }
    function advance(ms) {
        const target = now + ms;
        let count = 0;
        while (true) {
            const pending = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (!pending || pending[1].at > target) break;
            assert.ok(++count < 1000, 'scheduler must not spin');
            now = pending[1].at;
            timers.delete(pending[0]);
            pending[1].callback();
        }
        now = target;
    }
    return { root, doc, get, fire, advance, motion, timers, options: { clock, motion } };
}

test('dhikr starts with safe content and advances once per ten seconds', () => {
    const f = fixture();
    const slider = createDhikrSlider(f.root, f.options);
    assert.equal(f.get('text').textContent, ADHKAR[0].text);
    assert.equal(f.get('position').textContent, '1 / 7');
    f.advance(9999);
    assert.equal(f.get('text').textContent, ADHKAR[0].text);
    f.advance(151);
    assert.equal(f.get('text').textContent, ADHKAR[1].text);
    assert.equal(f.get('text').getAttribute('aria-live'), 'off');
    assert.equal(f.get('source').getAttribute('href'), ADHKAR[1].source.url);
    assert.equal(f.get('source').getAttribute('rel'), 'noopener noreferrer');
    assert.equal(f.get('position').textContent, '2 / 7');
    slider.destroy();
    assert.equal(f.timers.size, 0);
});

test('hover and keyboard focus pause rotation, then allow a full reading interval', () => {
    const f = fixture();
    const slider = createDhikrSlider(f.root, f.options);
    f.advance(8000);
    f.fire(f.root, 'pointerenter', { pointerType: 'mouse' });
    f.advance(30000);
    assert.equal(f.get('position').textContent, '1 / 7');
    f.fire(f.root, 'pointerleave');
    f.advance(9999);
    assert.equal(f.get('position').textContent, '1 / 7');
    f.fire(f.root, 'focusin');
    f.fire(f.get('next'), 'click');
    f.advance(150);
    assert.equal(f.get('position').textContent, '2 / 7');
    assert.equal(f.get('text').getAttribute('aria-live'), 'polite');
    f.advance(30000);
    assert.equal(f.get('position').textContent, '2 / 7');
    f.fire(f.root, 'focusout', { relatedTarget: null });
    f.advance(10150);
    assert.equal(f.get('position').textContent, '3 / 7');
    slider.destroy();
});

test('reduced motion defaults to manual control and pause toggle persists', () => {
    const f = fixture({ reducedMotion: true });
    const slider = createDhikrSlider(f.root, f.options);
    f.advance(60000);
    assert.equal(f.get('position').textContent, '1 / 7');
    assert.equal(f.root.dataset.rotation, 'paused');
    slider.previous();
    assert.equal(f.get('position').textContent, '7 / 7');
    assert.equal(f.root.classes.has('dhikr-is-changing'), false);
    f.fire(f.get('toggle-auto'), 'click');
    f.advance(10000);
    assert.equal(f.get('position').textContent, '1 / 7');
    f.fire(f.get('toggle-auto'), 'click');
    f.advance(30000);
    assert.equal(f.get('position').textContent, '1 / 7');
    assert.equal(f.get('toggle-auto').getAttribute('aria-pressed'), 'true');
    slider.destroy();
});

test('page visibility, replacement mounting and destroy clean up pending work', () => {
    const f = fixture();
    createDhikrSlider(f.root, f.options);
    f.doc.hidden = true;
    f.fire(f.doc, 'visibilitychange');
    assert.equal(f.timers.size, 0);
    f.advance(60000);
    assert.equal(f.get('position').textContent, '1 / 7');
    f.doc.hidden = false;
    f.fire(f.doc, 'visibilitychange');
    const second = createDhikrSlider(f.root, f.options);
    assert.equal(f.timers.size, 1, 'replacement must not leave duplicate rotation timers');
    f.fire(f.get('next'), 'click');
    second.destroy();
    assert.equal(f.timers.size, 0, 'destroy cancels rotation and pending fade');
    f.advance(60000);
    f.fire(f.get('next'), 'click');
    f.fire(f.doc, 'visibilitychange');
    assert.equal(f.get('position').textContent, '1 / 7');
    assert.equal(f.timers.size, 0, 'removed listeners must not schedule new work');
});

test('RTL arrow keys navigate correctly and unsafe source links are not exposed', () => {
    const f = fixture({ reducedMotion: true });
    const slider = createDhikrSlider(f.root, {
        ...f.options,
        items: [ADHKAR[0], { text: '<b>دعاء</b>', category: 'دعاء', source: { title: 'غير صالح', url: 'javascript:alert(1)' } }]
    });
    const event = f.fire(f.root, 'keydown', { key: 'ArrowLeft' });
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.get('text').textContent, '<b>دعاء</b>');
    assert.equal(f.get('source').hidden, true);
    assert.equal(f.get('source').getAttribute('href'), undefined);
    f.fire(f.root, 'keydown', { key: 'ArrowRight' });
    assert.equal(f.get('text').textContent, ADHKAR[0].text);
    slider.destroy();
});
