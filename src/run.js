import { pushDataWithinLimit } from './charging.js';
import {
    FEEDS, SOURCE, INTENSITY_ORDER, feedUrl, parseFeed, parseReport, entryMatches, meetsMinIntensity, sanitize,
} from './jma.js';

const USER_AGENT = 'jma-disaster-feed-actor/1.0';
const MAX_SEEN_IDS = 20000;

class InputError extends Error {}

const MAX_PENDING = 10000;
const MAX_FAILURES = 5; // a report that fails this many runs in a row is dropped (e.g. permanently removed)

export async function run({ actor, fetch, log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    /**
     * GET with retries. `budget` = { used, limit } counts every HTTP attempt (including retries);
     * no attempt is made once the budget is exhausted.
     */
    async function fetchText(url, { retries = 3, budget = null } = {}) {
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (budget && budget.used >= budget.limit) {
                throw Object.assign(new Error('request budget exhausted'), { budgetExhausted: true });
            }
            if (budget) budget.used++;
            try {
                const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
                if (res.ok) return await res.text();
                if (res.status === 404) throw Object.assign(new Error(`HTTP 404 for ${url}`), { fatal: true });
                lastErr = new Error(`HTTP ${res.status} for ${url}`);
            } catch (err) {
                if (err.fatal) throw err;
                lastErr = err;
            }
            if (attempt < retries && !(budget && budget.used >= budget.limit)) {
                const wait = 2000 * 2 ** attempt;
                log.warning(`Request failed (${sanitize(lastErr.message)}), retrying in ${wait / 1000}s`);
                await sleep(wait);
            } else if (budget && budget.used >= budget.limit) {
                break;
            }
        }
        // Server errors and network problems are temporary: they never count towards dropping an entry.
        throw Object.assign(lastErr ?? new Error(`request to ${url} failed`), { transient: true });
    }

    await actor.init();

    try {
        const input = (await actor.getInput()) ?? {};
        const feeds = input.feeds?.length ? input.feeds : ['eqvol'];
        const longFeed = input.longFeed ?? false;
        const titles = (input.titles ?? []).map((s) => s.trim()).filter(Boolean);
        const keywords = (input.keywords ?? []).map((s) => s.trim()).filter(Boolean);
        const hoursBack = Number(input.hoursBack ?? 0);
        const fetchDetails = input.fetchDetails ?? true;
        const minIntensity = input.minIntensity || null;
        const onlyNew = input.onlyNew ?? false;
        const stateKey = input.stateKey || 'default';
        if (!/^[a-zA-Z0-9_-]{1,50}$/.test(stateKey)) {
            throw new InputError('stateKey may only contain letters, digits, "-" and "_" (max 50 characters).');
        }
        const maxItems = Math.max(1, Math.min(Number(input.maxItems ?? 200), 5000));
        const intervalMs = Math.max(500, Number(input.requestIntervalMs ?? 1000));
        const maxDetailRequests = Math.max(1, Math.min(Number(input.maxDetailRequests ?? 300), 5000));

        const badFeeds = feeds.filter((f) => !FEEDS.includes(f));
        if (badFeeds.length) throw new InputError(`Unknown feed(s): ${badFeeds.join(', ')}. Allowed: ${FEEDS.join(', ')}`);
        if (minIntensity && !INTENSITY_ORDER.includes(minIntensity)) {
            throw new InputError(`Invalid minIntensity "${minIntensity}". Allowed: ${INTENSITY_ORDER.join(', ')}`);
        }
        if (minIntensity && !fetchDetails) {
            throw new InputError('minIntensity requires fetchDetails = true (intensity is read from the detailed XML).');
        }
        const since = hoursBack > 0 ? new Date(Date.now() - hoursBack * 3600_000) : null;


        // State for monitoring mode: ids already handled, plus entries matched earlier but not yet handled
        // (failed downloads, budget or maxItems overflow). Pending entries survive even after they drop out
        // of the short feed.
        const store = onlyNew ? await actor.openKeyValueStore('jma-disaster-feed-state') : null;
        const seen = new Set(onlyNew ? ((await store.getValue(`seen-${stateKey}`)) ?? []) : []);
        const pendingIn = onlyNew ? ((await store.getValue(`pending-${stateKey}`)) ?? []) : [];
        // Entries given up after MAX_FAILURES failed runs; not re-added while they stay in the feed.
        const dropped = new Set(onlyNew ? ((await store.getValue(`dropped-${stateKey}`)) ?? []) : []);
        if (onlyNew) log.info(`Monitoring mode: ${seen.size} seen, ${pendingIn.length} pending entries (state key "${stateKey}").`);

        // 1) Read feeds.
        const byId = new Map();
        for (const [i, feed] of feeds.entries()) {
            if (i > 0) await sleep(intervalMs);
            const url = feedUrl(feed, longFeed);
            const entries = parseFeed(await fetchText(url));
            log.info(`Feed "${feed}"${longFeed ? ' (long)' : ''}: ${entries.length} entries`);
            for (const e of entries) {
                if (e.entryId && !byId.has(e.entryId) && entryMatches(e, { titles, keywords, since })) {
                    byId.set(e.entryId, { feed, ...e });
                }
            }
        }
        // Pending entries keep their failure count even when the same entry is still in the feed.
        for (const e of pendingIn) {
            if (!e?.entryId) continue;
            const current = byId.get(e.entryId);
            if (current) Object.assign(current, { failCount: e.failCount ?? 0, permanentFails: e.permanentFails ?? 0 });
            else byId.set(e.entryId, e);
        }

        const candidates = [...byId.values()]
            .filter((e) => !seen.has(e.entryId) && !dropped.has(e.entryId))
            // Entries that failed before go last, so one broken report cannot block newer ones.
            .sort((a, b) => (a.failCount ?? 0) - (b.failCount ?? 0) || String(b.updated).localeCompare(String(a.updated)));
        log.info(`${candidates.length} entries to process${onlyNew ? ' (new or pending)' : ''}.`);

        // 2) Optionally fetch each report and push. An entry counts as handled once it was output, or parsed
        // and filtered out by minIntensity. In monitoring mode unhandled entries are kept as pending.
        const handled = new Set();
        const budget = { used: 0, limit: maxDetailRequests };
        let pushed = 0;
        let failed = 0;
        let chargeLimitReached = false;
        for (const entry of candidates) {
            if (pushed >= maxItems) break;
            let record = { ...entry };
            if (fetchDetails) {
                if (budget.used >= budget.limit) {
                    log.warning(`Reached maxDetailRequests (${maxDetailRequests} HTTP requests); remaining entries are left for a later run.`);
                    break;
                }
                await sleep(intervalMs);
                try {
                    record = { ...record, ...parseReport(await fetchText(entry.xmlUrl, { budget })) };
                } catch (err) {
                    if (err.budgetExhausted) break;
                    failed++;
                    // failCount orders retries (failed entries go last); permanentFails (404, unparseable
                    // report) decides when an entry is given up. Temporary errors never drop an entry.
                    entry.failCount = (entry.failCount ?? 0) + 1;
                    if (!err.transient) entry.permanentFails = (entry.permanentFails ?? 0) + 1;
                    log.warning(`Could not read report ${entry.xmlUrl}: ${sanitize(err.message)}`);
                    // Without the parsed report the intensity filter cannot be evaluated, and in monitoring mode
                    // the entry is retried next run instead of being output without details.
                    if (minIntensity || onlyNew) continue;
                    record.detailError = sanitize(err.message);
                }
            }
            delete record.failCount;
            delete record.permanentFails;
            if (meetsMinIntensity(record, minIntensity)) {
                const result = await pushDataWithinLimit(actor, { ...record, source: SOURCE });
                chargeLimitReached = result?.eventChargeLimitReached === true;
                if (chargeLimitReached) log.warning('Pay-per-event charge limit reached. Stopping dataset output.');
                if (chargeLimitReached && result.chargedCount === 0) break;
                pushed++;
            }
            handled.add(entry.entryId);
            if (chargeLimitReached) break;
        }

        const unhandled = candidates.filter((e) => !handled.has(e.entryId));
        let savedPending = 0;
        if (onlyNew) {
            for (const id of handled) seen.add(id);
            await store.setValue(`seen-${stateKey}`, [...seen].slice(-MAX_SEEN_IDS));
            const giveUp = unhandled.filter((e) => (e.permanentFails ?? 0) >= MAX_FAILURES);
            for (const e of giveUp) {
                log.warning(`Giving up on ${e.xmlUrl} after ${MAX_FAILURES} permanent failures (404 or unreadable report). To fetch it later, run once with onlyNew = false and longFeed = true, or open the URL directly.`);
                dropped.add(e.entryId);
            }
            await store.setValue(`dropped-${stateKey}`, [...dropped].slice(-MAX_SEEN_IDS));
            const keep = unhandled.filter((e) => (e.permanentFails ?? 0) < MAX_FAILURES);
            if (keep.length > MAX_PENDING) {
                log.warning(`${keep.length - MAX_PENDING} oldest pending entries dropped (limit ${MAX_PENDING}); run with longFeed to backfill.`);
            }
            savedPending = Math.min(keep.length, MAX_PENDING);
            await store.setValue(`pending-${stateKey}`, keep.slice(0, MAX_PENDING));
        }

        const summary = {
            processed: candidates.length, pushed, failedReports: failed, detailHttpRequests: budget.used,
            unhandled: unhandled.length,
        };
        if (chargeLimitReached) summary.stopReason = 'spendingLimit';
        await actor.setValue('RUN_SUMMARY', summary);
        if (pushed === 0 && onlyNew) log.info(`No new reports output (${savedPending} pending for the next run).`);
        else if (pushed === 0 && !chargeLimitReached) log.warning('No entries matched. Try a different feed, wider filters or longFeed = true.');
        log.info(`Done. Pushed ${pushed} records${failed ? `, ${failed} report(s) could not be fetched or parsed` : ''}${unhandled.length ? `, ${unhandled.length} not processed` : ''}.`);
        if (!chargeLimitReached && failed > 0 && pushed === 0 && handled.size === 0) {
            throw new Error(`All ${failed} report download(s) failed; JMA may be temporarily unavailable.`);
        }
        await actor.exit();
    } catch (err) {
        // Log only a sanitized message: stack traces and some error messages contain local file paths.
        const msg = sanitize(err.message);
        log.error(err instanceof InputError ? `Invalid input: ${msg}` : msg);
        await actor.fail(msg);
    }
}
