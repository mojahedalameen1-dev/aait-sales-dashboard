import test from 'node:test';
import assert from 'node:assert/strict';
import { createRiyadhPrayerAlerts } from '../src/prayer-alerts.js';
import { getIqamaEvents, getVerifiedIqamaProfile, validateIqamaProfile } from '../src/prayer-iqama.js';

function memoryStorage() {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

function timings() {
    return { Fajr: '04:30', Dhuhr: '12:00', Asr: '15:10', Maghrib: '17:45', Isha: '19:15' };
}

function validProfile(date = '2026-10-24', overrides = {}) {
    return {
        enabled: true, confirmed: true, source: 'تأكيد مسجد الشركة', verifiedAt: date,
        intervals: { Fajr: 15, Dhuhr: 15, Asr: 15, Maghrib: 10, Isha: 15 },
        ...overrides
    };
}

async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); }

test('adhan is emitted once and persisted using a stable prayer-kind event id', async () => {
    const date = '2026-10-24';
    const due = Date.parse(`${date}T12:00:00+03:00`);
    let current = new Date(due - 1000);
    const storage = memoryStorage();
    const alerts = [];
    const service = { load: async () => ({ days: [{ date, timings: timings() }] }) };
    const scheduler = createRiyadhPrayerAlerts({ storage, service, now: () => current, onAlert: event => alerts.push(event) });
    await settle();
    current = new Date(due);
    scheduler.tick(current);
    scheduler.tick(new Date(due + 1000));
    await settle();
    scheduler.destroy();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'adhan');
    assert.equal(alerts[0].id, `riyadh:${date}:Dhuhr:adhan`);
    assert.ok(JSON.parse(storage.getItem('aait_prayer_alerts_riyadh_v1')).includes(alerts[0].id));
});

test('two visible tabs share an exclusive event lock and produce only one playback request', async () => {
    const date = '2026-10-24';
    const due = Date.parse(`${date}T12:00:00+03:00`);
    let current = new Date(due - 1000);
    const storage = memoryStorage();
    const held = new Set();
    const locks = { request: async (name, options, callback) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        try { return await callback({ name }); }
        finally { held.delete(name); }
    } };
    const service = { load: async () => ({ days: [{ date, timings: timings() }] }) };
    const first = [];
    const second = [];
    const one = createRiyadhPrayerAlerts({ storage, service, now: () => current, locks, onAlert: event => first.push(event) });
    const two = createRiyadhPrayerAlerts({ storage, service, now: () => current, locks, onAlert: event => second.push(event) });
    await settle();
    current = new Date(due);
    one.tick(current);
    two.tick(current);
    await settle();
    one.destroy();
    two.destroy();
    assert.equal(first.length + second.length, 1);
});

test('existing persisted adhan markers remain honored after the scheduler version upgrade', async () => {
    const date = '2026-10-24';
    const due = Date.parse(`${date}T12:00:00+03:00`);
    let current = new Date(due - 1000);
    const storage = memoryStorage();
    storage.setItem('aait_prayer_alerts_riyadh_v1', JSON.stringify([`${date}:Dhuhr`]));
    const alerts = [];
    const scheduler = createRiyadhPrayerAlerts({
        storage, service: { load: async () => ({ days: [{ date, timings: timings() }] }) },
        now: () => current, onAlert: event => alerts.push(event)
    });
    await settle();
    current = new Date(due);
    scheduler.tick(current);
    await settle();
    scheduler.destroy();
    assert.equal(alerts.length, 0);
});

test('iqama schedule is inactive until each profile is confirmed with fresh source and all five intervals', () => {
    const date = '2026-10-24';
    const schedule = { date, timings: timings() };
    assert.equal(getVerifiedIqamaProfile({ regular: validProfile(date, { confirmed: false }) }, date), null);
    assert.equal(getVerifiedIqamaProfile({ regular: validProfile('2024-01-01') }, date), null);
    assert.equal(getVerifiedIqamaProfile({ regular: validProfile(date, { source: '' }) }, date), null);
    assert.equal(getVerifiedIqamaProfile({ regular: validProfile(date, { intervals: { Fajr: 15 } }) }, date), null);
    const events = getIqamaEvents(schedule, date, { regular: validProfile(date) });
    assert.equal(events.length, 5);
    assert.equal(events[0].verifiedSource, 'تأكيد مسجد الشركة');
    assert.equal(events[0].verifiedAt, date);
});

test('Friday Dhuhr is never used as a Jumuah iqama schedule', () => {
    const friday = '2026-10-23';
    const events = getIqamaEvents({ date: friday, timings: timings() }, friday, { regular: validProfile(friday) });
    assert.equal(events.length, 4);
    assert.equal(events.some(event => event.key === 'Dhuhr'), false);
});

test('Ramadan profile overrides regular only inside its manually verified date range', () => {
    const regular = validProfile('2026-10-24', { intervals: { Fajr: 10, Dhuhr: 10, Asr: 10, Maghrib: 10, Isha: 10 } });
    const ramadan = validProfile('2026-10-24', {
        startDate: '2027-02-01', endDate: '2027-03-02',
        intervals: { Fajr: 15, Dhuhr: 15, Asr: 15, Maghrib: 15, Isha: 15 }
    });
    const during = getVerifiedIqamaProfile({ regular, ramadan }, '2027-02-20');
    const outside = getVerifiedIqamaProfile({ regular, ramadan }, '2027-03-03');
    assert.equal(during.name, 'ramadan');
    assert.equal(during.intervals.Fajr, 15);
    assert.equal(outside.name, 'regular');
    assert.equal(validateIqamaProfile({ ...ramadan, endDate: '2027-03-15' }, 'ramadan', '2027-02-20').valid, false);
});

test('missed alerts after sleep are suppressed rather than played late', async () => {
    const date = '2026-10-24';
    const due = Date.parse(`${date}T12:00:00+03:00`);
    let current = new Date(due - 5000);
    const alerts = [];
    const scheduler = createRiyadhPrayerAlerts({
        storage: memoryStorage(), service: { load: async () => ({ days: [{ date, timings: timings() }] }) },
        now: () => current, onAlert: event => alerts.push(event)
    });
    await settle();
    current = new Date(due + 5000);
    scheduler.skipMissed(current);
    scheduler.tick(new Date(due + 6000));
    await settle();
    scheduler.destroy();
    assert.equal(alerts.length, 0);
});

test('a delayed prayer-times response cannot replay an already passed event', async () => {
    const date = '2026-10-24';
    const due = Date.parse(`${date}T12:00:00+03:00`);
    let current = new Date(due - 1000);
    let resolve;
    const service = { load: () => new Promise(done => { resolve = done; }) };
    const alerts = [];
    const scheduler = createRiyadhPrayerAlerts({ storage: memoryStorage(), service, now: () => current, onAlert: event => alerts.push(event) });
    await Promise.resolve();
    current = new Date(due + 1000);
    resolve({ days: [{ date, timings: timings() }] });
    await settle();
    scheduler.tick(current);
    await settle();
    scheduler.destroy();
    assert.equal(alerts.length, 0);
});

test('in-memory fallback still suppresses duplicate ticks when browser storage is unavailable', async () => {
    const date = '2026-10-24';
    const due = Date.parse(`${date}T12:00:00+03:00`);
    let current = new Date(due - 1000);
    const alerts = [];
    const storage = { getItem() { throw new Error('storage disabled'); }, setItem() { throw new Error('storage disabled'); } };
    const scheduler = createRiyadhPrayerAlerts({
        storage, service: { load: async () => ({ days: [{ date, timings: timings() }] }) },
        now: () => current, onAlert: event => alerts.push(event)
    });
    await settle();
    current = new Date(due);
    scheduler.tick(current);
    scheduler.tick(new Date(due + 1000));
    await settle();
    scheduler.destroy();
    assert.equal(alerts.length, 1);
});
