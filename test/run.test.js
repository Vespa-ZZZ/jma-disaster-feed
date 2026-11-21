import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feedUrl } from '../src/jma.js';
import { run } from '../src/run.js';

const FEED_URL = feedUrl('eqvol');
const SEEN_KEY = 'seen-default';
const PENDING_KEY = 'pending-default';
const REPORT_XML = readFileSync(new URL('./fixtures/VXSE53.xml', import.meta.url), 'utf8');
const reportUrl = (id) => `https://reports.example.invalid/${id}.xml`;

const blockedFetch = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Tests must use the injected fetch');
});
after(() => {
    blockedFetch.mock.restore();
    assert.equal(blockedFetch.mock.callCount(), 0);
});

function makeFeed(ids) {
    // List entries newest first. Their timestamps persist when the runner saves them to pending.
    const entries = ids.map((id, index) => `
      <entry>
        <id>${id}</id>
        <updated>${new Date(Date.UTC(2026, 0, ids.length - index)).toISOString()}</updated>
        <link href="${reportUrl(id)}"/>
      </entry>`);
    return `<feed xmlns="http://www.w3.org/2005/Atom"><title>Test feed</title>${entries.join('')}</feed>`;
}

async function runActor({ entries = [], reports = {}, input = {}, state = new Map(), feedError } = {}) {
    const requests = [];
    const records = [];
    const values = new Map();
    const lifecycle = [];
    const warnings = [];
    const errors = [];
    const reportStatuses = new Map(Object.entries(reports).map(([id, status]) => [reportUrl(id), status]));
    const fetch = async (url) => {
        requests.push(url);
        if (url === FEED_URL) {
            if (feedError) throw feedError;
            return new Response(makeFeed(entries));
        }
        const status = reportStatuses.get(url);
        assert.ok(status, `Unexpected request for ${url}`);
        return new Response(status === 200 ? REPORT_XML : null, { status });
    };
    const actor = {
        async init() { lifecycle.push('init'); },
        async getInput() { return { onlyNew: true, ...input }; },
        async openKeyValueStore(name) {
            assert.equal(name, 'jma-disaster-feed-state');
            return {
                async getValue(key) { return structuredClone(state.get(key) ?? null); },
                async setValue(key, value) { state.set(key, structuredClone(value)); },
            };
        },
        async pushData(record) { records.push(structuredClone(record)); },
        async setValue(key, value) { values.set(key, structuredClone(value)); },
        async exit() { lifecycle.push('exit'); },
        async fail(message) { lifecycle.push('fail', message); },
    };
    const log = {
        info() {},
        warning(message) { warnings.push(message); },
        error(message) { errors.push(message); },
    };

    await run({ actor, fetch, log, sleep: async () => {} });
    return { requests, records, summary: values.get('RUN_SUMMARY'), lifecycle, warnings, errors };
}

test('monitoring an unchanged feed produces no new reports on the second run', async () => {
    const state = new Map();
    const first = await runActor({ state, entries: ['first'], reports: { first: 200 } });
    assert.deepEqual(first.lifecycle, ['init', 'exit']);
    assert.deepEqual(first.requests, [FEED_URL, reportUrl('first')]);
    assert.deepEqual(first.records.map(({ entryId }) => entryId), ['first']);
    assert.equal(first.records[0].maxIntensity, '2');
    assert.deepEqual(state.get(SEEN_KEY), ['first']);
    assert.deepEqual(state.get(PENDING_KEY), []);

    const second = await runActor({ state, entries: ['first'] });
    assert.deepEqual(second.lifecycle, ['init', 'exit']);
    assert.deepEqual(second.requests, [FEED_URL]);
    assert.deepEqual(second.records, []);
    assert.deepEqual(second.summary, {
        processed: 0, pushed: 0, failedReports: 0, detailHttpRequests: 0, unhandled: 0,
    });
});

test('a report returning 503 stays unread and can be processed after it leaves the feed', async () => {
    const state = new Map();
    const first = await runActor({
        state, entries: ['unavailable', 'available'], reports: { unavailable: 503, available: 200 },
    });
    assert.deepEqual(first.lifecycle, ['init', 'exit']);
    assert.deepEqual(first.requests, [FEED_URL, ...Array(4).fill(reportUrl('unavailable')), reportUrl('available')]);
    assert.deepEqual(first.records.map(({ entryId }) => entryId), ['available']);
    assert.deepEqual(state.get(SEEN_KEY), ['available']);
    assert.deepEqual(state.get(PENDING_KEY).map(({ entryId, failCount }) => [entryId, failCount]), [['unavailable', 1]]);

    const second = await runActor({ state, entries: ['available'], reports: { unavailable: 200 } });
    assert.deepEqual(second.lifecycle, ['init', 'exit']);
    assert.deepEqual(second.requests, [FEED_URL, reportUrl('unavailable')]);
    assert.deepEqual(second.records.map(({ entryId }) => entryId), ['unavailable']);
    assert.deepEqual(state.get(SEEN_KEY), ['available', 'unavailable']);
    assert.deepEqual(state.get(PENDING_KEY), []);
});

test('maxDetailRequests counts each retry and leaves unattempted reports pending', async () => {
    const state = new Map();
    const result = await runActor({
        state, entries: ['retrying', 'waiting'], reports: { retrying: 503 }, input: { maxDetailRequests: 2 },
    });
    assert.deepEqual(result.requests, [FEED_URL, reportUrl('retrying'), reportUrl('retrying')]);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.summary, {
        processed: 2, pushed: 0, failedReports: 1, detailHttpRequests: 2, unhandled: 2,
    });
    assert.deepEqual(state.get(PENDING_KEY).map(({ entryId, failCount }) => [entryId, failCount]), [
        ['retrying', 1], ['waiting', undefined],
    ]);
});

test('a permanent 404 leaves newer work unblocked and is dropped after five failed runs', async () => {
    const state = new Map();
    for (let attempt = 1; attempt <= 5; attempt++) {
        const available = `available-${attempt}`;
        const entries = attempt === 1 ? ['missing', available] : [available];
        const result = await runActor({ state, entries, reports: { missing: 404, [available]: 200 } });
        assert.deepEqual(result.lifecycle, ['init', 'exit']);
        // On the first run the 404 comes first by timestamp. Once pending, its failCount sends it last.
        const expected = attempt === 1 ? ['missing', available] : [available, 'missing'];
        assert.deepEqual(result.requests, [FEED_URL, ...expected.map(reportUrl)]);
        assert.deepEqual(result.records.map(({ entryId }) => entryId), [available]);
        assert.ok(!state.get(SEEN_KEY).includes('missing'));
        const pending = state.get(PENDING_KEY).map(({ entryId, failCount }) => [entryId, failCount]);
        assert.deepEqual(pending, attempt < 5 ? [['missing', attempt]] : []);
    }
    const next = await runActor({ state });
    assert.deepEqual(next.lifecycle, ['init', 'exit']);
    assert.deepEqual(next.requests, [FEED_URL]);
});

test('a 404 that stays in the feed keeps its failure count, is dropped after five runs and not re-added', async () => {
    const state = new Map();
    for (let attempt = 1; attempt <= 5; attempt++) {
        const available = `fresh-${attempt}`;
        const result = await runActor({ state, entries: [available, 'stuck'], reports: { stuck: 404, [available]: 200 } });
        assert.deepEqual(result.records.map(({ entryId }) => entryId), [available]);
        const pending = state.get(PENDING_KEY).map(({ entryId, failCount }) => [entryId, failCount]);
        assert.deepEqual(pending, attempt < 5 ? [['stuck', attempt]] : []);
        assert.ok(result.records.every((r) => !('failCount' in r)));
    }
    assert.deepEqual(state.get('dropped-default'), ['stuck']);
    const next = await runActor({ state, entries: ['stuck'] });
    assert.deepEqual(next.requests, [FEED_URL]);
});

test('temporary 503 errors never drop a report, and the recovered record has no internal counters', async () => {
    const state = new Map();
    for (let attempt = 1; attempt <= 6; attempt++) {
        await runActor({ state, entries: [`ok-${attempt}`, 'flaky'], reports: { flaky: 503, [`ok-${attempt}`]: 200 } });
    }
    assert.deepEqual(state.get('dropped-default') ?? [], []);
    assert.deepEqual(state.get(PENDING_KEY).map(({ entryId }) => entryId), ['flaky']);
    const recovered = await runActor({ state, entries: [], reports: { flaky: 200 } });
    assert.deepEqual(recovered.records.map(({ entryId }) => entryId), ['flaky']);
    assert.ok(!('failCount' in recovered.records[0]) && !('permanentFails' in recovered.records[0]));
});

test('the actor fails when every report fails, with monitoring state and summary saved', async () => {
    const state = new Map([[SEEN_KEY, ['already-seen']]]);
    const result = await runActor({
        state, entries: ['missing', 'unavailable'], reports: { missing: 404, unavailable: 503 },
    });
    assert.deepEqual(result.lifecycle, ['init', 'fail', 'All 2 report download(s) failed; JMA may be temporarily unavailable.']);
    assert.deepEqual(result.requests, [FEED_URL, reportUrl('missing'), ...Array(4).fill(reportUrl('unavailable'))]);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.summary, {
        processed: 2, pushed: 0, failedReports: 2, detailHttpRequests: 5, unhandled: 2,
    });
    assert.deepEqual(state.get(SEEN_KEY), ['already-seen']);
    assert.deepEqual(state.get(PENDING_KEY).map(({ entryId, failCount }) => [entryId, failCount]), [
        ['missing', 1], ['unavailable', 1],
    ]);
});

test('local paths are redacted from retry warnings, the error log and the actor failure message', async () => {
    const winPath = ['C:', 'Users', 'test-user', 'report.xml'].join('\\');
    const unixPath = ['', 'home', 'test-user', 'feed.xml'].join('/');
    const result = await runActor({ feedError: new Error(`Could not read '${winPath}' or '${unixPath}'`) });

    const message = "Could not read '<path>' or '<path>'";
    assert.deepEqual(result.requests, Array(4).fill(FEED_URL));
    assert.deepEqual(result.warnings, [2, 4, 8].map((seconds) => `Request failed (${message}), retrying in ${seconds}s`));
    assert.deepEqual(result.errors, [message]);
    assert.deepEqual(result.lifecycle, ['init', 'fail', message]);
});
