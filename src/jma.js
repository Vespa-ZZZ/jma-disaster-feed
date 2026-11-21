// Pure helpers for the JMA disaster information XML (PULL) feeds.
// Feed docs: https://xml.kishou.go.jp/  Terms: https://www.jma.go.jp/jma/kishou/info/coment.html
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const FEED_BASE = 'https://www.data.jma.go.jp/developer/xml/feed/';
export const FEEDS = ['regular', 'extra', 'eqvol', 'other'];
export const SOURCE = 'Japan Meteorological Agency (気象庁) disaster information XML';

// JMA seismic intensity scale, in ascending order.
export const INTENSITY_ORDER = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'];

const ARRAY_TAGS = new Set([
    'entry', 'Information', 'Item', 'Area', 'Pref', 'City', 'IntensityStation', 'Kind', 'Category',
]);

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ARRAY_TAGS.has(name),
});

const text = (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'object') return v['#text'] !== undefined ? String(v['#text']) : null;
    const s = String(v).trim();
    return s === '' ? null : s;
};
/** Numeric value or null (missing, empty, "NaN" and other non-numbers are null, never 0). */
export const num = (v) => {
    const s = text(v);
    if (s === null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};
const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

export function feedUrl(name, long = false) {
    if (!FEEDS.includes(name)) throw new Error(`Unknown feed "${name}". Allowed: ${FEEDS.join(', ')}`);
    return `${FEED_BASE}${name}${long ? '_l' : ''}.xml`;
}

const XML_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;

function parseStrict(xml, what) {
    const src = String(xml ?? '');
    const valid = XMLValidator.validate(src);
    if (valid !== true) throw new Error(`Malformed ${what} XML: ${valid.err?.msg ?? 'invalid'} (line ${valid.err?.line ?? '?'})`);
    if (XML_ENTITY.test(src.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ''))) {
        throw new Error(`Malformed ${what} XML: undefined entity reference`);
    }
    const doc = parser.parse(src);
    const roots = Object.keys(doc).filter((k) => k !== '?xml');
    if (roots.length !== 1 || Array.isArray(doc[roots[0]])) throw new Error(`Malformed ${what} XML: expected exactly one root element`);
    return doc;
}

/** Parse an Atom feed into plain entries. */
export function parseFeed(xml) {
    const doc = parseStrict(xml, 'feed');
    if (!doc.feed) throw new Error('Not an Atom feed (missing <feed> element)');
    const entries = arr(doc.feed.entry);
    if (entries.some((e) => !text(e?.id))) throw new Error('Feed contains an entry without <id>');
    return entries.map((e) => {
        const link = arr(e.link).find((l) => l?.['@_href']) ?? e.link;
        return {
            entryId: text(e.id),
            title: text(e.title),
            updated: text(e.updated),
            publisher: text(e.author?.name),
            summary: text(e.content),
            xmlUrl: link?.['@_href'] ?? text(e.id),
        };
    });
}

/** "+34.0+140.4-20000/" -> { latitude: 34, longitude: 140.4, depthKm: 20 } */
export function parseCoordinate(raw) {
    const s = text(raw);
    if (!s) return { latitude: null, longitude: null, depthKm: null };
    const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+)?\//.exec(s);
    if (!m) return { latitude: null, longitude: null, depthKm: null };
    return {
        latitude: Number(m[1]),
        longitude: Number(m[2]),
        depthKm: m[3] !== undefined ? Math.abs(Number(m[3])) / 1000 : null,
    };
}

export function intensityRank(v) {
    return v == null ? -1 : INTENSITY_ORDER.indexOf(String(v));
}

function parseHeadlineItems(headline) {
    const items = [];
    for (const info of arr(headline?.Information)) {
        for (const item of arr(info.Item)) {
            items.push({
                informationType: info['@_type'] ?? null,
                kinds: arr(item.Kind).map((k) => text(k.Name)).filter(Boolean),
                areas: arr(item.Areas?.Area).map((a) => text(a.Name)).filter(Boolean),
            });
        }
    }
    return items;
}

function parseEarthquake(body) {
    const eq = body?.Earthquake;
    if (!eq) return null;
    const hypo = eq.Hypocenter?.Area ? arr(eq.Hypocenter.Area)[0] : eq.Hypocenter;
    const coord = parseCoordinate(hypo?.Coordinate);
    const magRaw = eq.Magnitude;
    const magVal = num(magRaw);
    return {
        originTime: text(eq.OriginTime),
        hypocenter: text(hypo?.Name),
        ...coord,
        magnitude: magVal,
        magnitudeType: magRaw?.['@_type'] ?? null,
        magnitudeDescription: magRaw?.['@_description'] ?? null,
    };
}

function parseIntensity(body) {
    const obs = body?.Intensity?.Observation;
    if (!obs) return null;
    return {
        maxIntensity: text(obs.MaxInt),
        intensityByPrefecture: arr(obs.Pref).map((p) => ({
            prefecture: text(p.Name),
            maxIntensity: text(p.MaxInt),
            areas: arr(p.Area).map((a) => ({ area: text(a.Name), maxIntensity: text(a.MaxInt) })),
        })),
    };
}

function parseTsunami(body) {
    const fc = body?.Tsunami?.Forecast;
    if (!fc) return null;
    return arr(fc.Item).map((it) => {
        const h = it.MaxHeight?.TsunamiHeight;
        return {
            area: text(arr(it.Area)[0]?.Name),
            category: text(arr(arr(it.Category)[0]?.Kind)[0]?.Name),
            maxHeightM: num(h),
            maxHeightDescription: h?.['@_description'] ?? null,
            maxHeightCondition: h?.['@_condition'] ?? text(it.MaxHeight?.Condition) ?? null,
        };
    });
}

function parseComments(body) {
    const c = body?.Comments;
    if (!c) return [];
    const out = [];
    for (const key of ['WarningComment', 'ForecastComment', 'VarComment', 'FreeFormComment']) {
        for (const v of arr(c[key])) {
            const t = typeof v === 'string' ? v : text(v?.Text) ?? text(v);
            if (t) out.push(t);
        }
    }
    return out;
}

/** Parse a JMA report XML (any type). Returns flat, table-friendly fields. */
export function parseReport(xml) {
    const doc = parseStrict(xml, 'report');
    const r = doc.Report;
    if (!r) throw new Error('Not a JMA report (missing <Report> element)');
    if (!r.Control || !r.Head) throw new Error('Incomplete JMA report (missing <Control> or <Head>)');
    // Common fields present in every JMA report, including cancellations (取消).
    const missing = [['Control/Title', r.Control.Title], ['Head/Title', r.Head.Title], ['Head/InfoType', r.Head.InfoType]]
        .filter(([, v]) => text(v) === null).map(([k]) => k);
    if (missing.length) throw new Error(`Incomplete JMA report (missing ${missing.join(', ')})`);
    const control = r.Control ?? {};
    const head = r.Head ?? {};
    const body = r.Body ?? {};
    const eq = parseEarthquake(body);
    const intensity = parseIntensity(body);
    const tsunami = parseTsunami(body);
    return {
        reportTitle: text(head.Title) ?? text(control.Title),
        status: text(control.Status),
        publishingOffice: text(control.PublishingOffice),
        reportDateTime: text(head.ReportDateTime),
        targetDateTime: text(head.TargetDateTime),
        validDateTime: text(head.ValidDateTime),
        eventId: text(head.EventID),
        infoType: text(head.InfoType),
        infoKind: text(head.InfoKind),
        serial: text(head.Serial),
        headline: text(head.Headline?.Text),
        headlineItems: parseHeadlineItems(head.Headline),
        ...(eq ?? {}),
        maxIntensity: intensity?.maxIntensity ?? null,
        intensityByPrefecture: intensity?.intensityByPrefecture ?? [],
        tsunamiForecast: tsunami ?? [],
        comments: parseComments(body),
    };
}

/** Feed-level filters (no network needed). */
export function entryMatches(entry, { titles = [], keywords = [], since = null } = {}) {
    if (titles.length && !titles.some((t) => entry.title?.includes(t))) return false;
    if (keywords.length) {
        const hay = `${entry.title ?? ''}\n${entry.summary ?? ''}`;
        if (!keywords.some((k) => hay.includes(k))) return false;
    }
    if (since && entry.updated && new Date(entry.updated) < since) return false;
    return true;
}

export function meetsMinIntensity(record, minIntensity) {
    if (!minIntensity) return true;
    return intensityRank(record.maxIntensity) >= intensityRank(minIntensity);
}

/** Remove local file system paths from messages before they reach logs or the run status. */
export function sanitize(message) {
    return String(message)
        .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"`)]*/g, '<path>')
        .replace(/\/(?:home|Users|root|tmp|var|usr)\/[^\s'"`)]*/g, '<path>');
}
