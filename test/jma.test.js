import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    feedUrl, parseFeed, parseReport, parseCoordinate, entryMatches, meetsMinIntensity, intensityRank,
} from '../src/jma.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('feedUrl builds short and long feed URLs and rejects unknown feeds', () => {
    assert.equal(feedUrl('eqvol'), 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml');
    assert.equal(feedUrl('extra', true), 'https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml');
    assert.throws(() => feedUrl('nope'), /Unknown feed/);
});

test('parseFeed extracts entries', () => {
    const entries = parseFeed(fx('feed-eqvol.xml'));
    assert.ok(entries.length > 5);
    const e = entries.find((x) => x.title === '震源・震度に関する情報');
    assert.ok(e);
    assert.match(e.xmlUrl, /^https:\/\/www\.data\.jma\.go\.jp\/developer\/xml\/data\/.+\.xml$/);
    assert.equal(e.publisher, '気象庁');
    assert.ok(e.updated);
});

test('parseFeed rejects non-feed XML', () => {
    assert.throws(() => parseFeed('<foo/>'), /Atom feed/);
});

test('parseCoordinate handles normal, shallow and missing values', () => {
    assert.deepEqual(parseCoordinate('+34.0+140.4-20000/'), { latitude: 34, longitude: 140.4, depthKm: 20 });
    assert.deepEqual(parseCoordinate('-12.5+170.25+0/'), { latitude: -12.5, longitude: 170.25, depthKm: 0 });
    assert.deepEqual(parseCoordinate('+35.1+139.2/'), { latitude: 35.1, longitude: 139.2, depthKm: null });
    assert.deepEqual(parseCoordinate(''), { latitude: null, longitude: null, depthKm: null });
    assert.deepEqual(parseCoordinate({ '#text': '+34.0+140.4-10000/', '@_description': 'x' }).depthKm, 10);
});

test('parseReport reads earthquake hypocenter / intensity report (VXSE53)', () => {
    const r = parseReport(fx('VXSE53.xml'));
    assert.equal(r.infoKind, '地震情報');
    assert.equal(r.eventId, '20261121190909');
    assert.equal(r.hypocenter, '房総半島南方沖');
    assert.equal(r.latitude, 34);
    assert.equal(r.longitude, 140.4);
    assert.equal(r.depthKm, 20);
    assert.equal(r.magnitude, 4.9);
    assert.equal(r.magnitudeType, 'Mj');
    assert.equal(r.maxIntensity, '2');
    assert.equal(r.intensityByPrefecture[0].prefecture, '東京都');
    assert.ok(r.comments.some((c) => c.includes('津波の心配はありません')));
});

test('parseReport reads a volcano ash forecast (VFVO53) without earthquake fields', () => {
    const r = parseReport(fx('VFVO53.xml'));
    assert.equal(r.infoKind, '降灰予報');
    assert.equal(r.maxIntensity, null);
    assert.equal(r.magnitude, undefined);
    assert.ok(r.headlineItems.length >= 1);
    assert.ok(r.headlineItems.some((i) => i.areas.length > 0));
});

test('parseReport handles unknown magnitude and tsunami forecast', () => {
    const xml = `<?xml version="1.0"?><Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
      <Control><Title>津波警報・注意報・予報a</Title><Status>通常</Status></Control>
      <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>津波注意報</Title><InfoType>発表</InfoType><InfoKind>津波警報・注意報・予報</InfoKind></Head>
      <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
        <Tsunami><Forecast><Item><Area><Name>伊豆諸島</Name></Area><Category><Kind><Name>津波注意報</Name></Kind></Category>
          <MaxHeight><jmx_eb:TsunamiHeight type="津波の高さ" unit="m" description="１ｍ">1</jmx_eb:TsunamiHeight></MaxHeight></Item></Forecast></Tsunami>
        <Earthquake><OriginTime>2026-01-01T00:00:00+09:00</OriginTime><Hypocenter><Area><Name>八丈島東方沖</Name>
          <jmx_eb:Coordinate description="震源要素不明"></jmx_eb:Coordinate></Area></Hypocenter>
          <jmx_eb:Magnitude type="Mj" condition="不明" description="Ｍ不明">NaN</jmx_eb:Magnitude></Earthquake>
      </Body></Report>`;
    const r = parseReport(xml);
    assert.equal(r.hypocenter, '八丈島東方沖');
    assert.equal(r.magnitude, null);
    assert.equal(r.latitude, null);
    assert.deepEqual(r.tsunamiForecast, [{ area: '伊豆諸島', category: '津波注意報', maxHeightM: 1, maxHeightDescription: '１ｍ', maxHeightCondition: null }]);
});

test('entryMatches applies title, keyword and time filters', () => {
    const e = { title: '震源・震度に関する情報', summary: '石川県能登地方で震度３', updated: '2026-11-21T10:00:00Z' };
    assert.equal(entryMatches(e, {}), true);
    assert.equal(entryMatches(e, { titles: ['震源'] }), true);
    assert.equal(entryMatches(e, { titles: ['降灰'] }), false);
    assert.equal(entryMatches(e, { keywords: ['東京', '石川'] }), true);
    assert.equal(entryMatches(e, { keywords: ['東京'] }), false);
    assert.equal(entryMatches(e, { since: new Date('2026-11-21T11:00:00Z') }), false);
    assert.equal(entryMatches(e, { since: new Date('2026-11-21T09:00:00Z') }), true);
});

test('meetsMinIntensity compares on the JMA scale', () => {
    assert.ok(intensityRank('5+') > intensityRank('5-'));
    assert.equal(meetsMinIntensity({ maxIntensity: '4' }, null), true);
    assert.equal(meetsMinIntensity({ maxIntensity: '4' }, '4'), true);
    assert.equal(meetsMinIntensity({ maxIntensity: '3' }, '4'), false);
    assert.equal(meetsMinIntensity({ maxIntensity: '6-' }, '5+'), true);
    assert.equal(meetsMinIntensity({ maxIntensity: null }, '1'), false);
});

test('num never turns missing values into 0', async () => {
    const { num } = await import('../src/jma.js');
    assert.equal(num(null), null);
    assert.equal(num(''), null);
    assert.equal(num('NaN'), null);
    assert.equal(num({ '@_description': 'x' }), null);
    assert.equal(num('0'), 0);
    assert.equal(num({ '#text': '4.5' }), 4.5);
});

test('tsunami height and magnitude without a value are null, not 0', () => {
    const xml = `<?xml version="1.0"?><Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
      <Control><Title>津波警報・注意報・予報a</Title></Control>
      <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>津波予報</Title><InfoType>発表</InfoType></Head>
      <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
        <Tsunami><Forecast><Item><Area><Name>北海道太平洋沿岸東部</Name></Area><Category><Kind><Name>津波予報（若干の海面変動）</Name></Kind></Category></Item>
        <Item><Area><Name>岩手県</Name></Area><Category><Kind><Name>大津波警報</Name></Kind></Category>
          <MaxHeight><jmx_eb:TsunamiHeight type="津波の高さ" unit="m" condition="巨大" description="巨大">NaN</jmx_eb:TsunamiHeight></MaxHeight></Item></Forecast></Tsunami>
        <Earthquake><Hypocenter><Area><Name>三陸沖</Name></Area></Hypocenter><jmx_eb:Magnitude type="Mj" description=""></jmx_eb:Magnitude></Earthquake>
      </Body></Report>`;
    const r = parseReport(xml);
    assert.equal(r.magnitude, null);
    assert.equal(r.tsunamiForecast[0].maxHeightM, null);
    assert.equal(r.tsunamiForecast[1].maxHeightM, null);
    assert.equal(r.tsunamiForecast[1].maxHeightCondition, '巨大');
});

test('truncated XML is rejected instead of producing empty records', () => {
    const feed = fx('feed-eqvol.xml');
    assert.throws(() => parseFeed(feed.slice(0, Math.floor(feed.length / 2))), /Malformed feed XML/);
    const rep = fx('VXSE53.xml');
    assert.throws(() => parseReport(rep.slice(0, Math.floor(rep.length / 2))), /Malformed report XML/);
    assert.throws(() => parseReport('<Report xmlns="x"><Control/></Report>'), /Incomplete JMA report/);
});

test('an empty but valid feed yields no entries', () => {
    assert.deepEqual(parseFeed('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title></feed>'), []);
});

test('entity validation ignores ampersands in XML comments and CDATA', () => {
    const xml = `<feed>
      <!-- Raw & and &unknown; with a CDATA opener <![CDATA[ -->
      <entry><id>report</id><content><![CDATA[A & B <!--]]></content></entry>
    </feed>`;
    assert.equal(parseFeed(xml)[0].summary, 'A & B <!--');
    assert.throws(() => parseFeed(xml.replace('</feed>', '<title>&unknown;</title></feed>')), /undefined entity reference/);
});

test('a cancellation report with a minimal body parses', () => {
    const xml = `<?xml version="1.0"?><Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
      <Control><Title>震源・震度に関する情報</Title><Status>通常</Status></Control>
      <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>震源・震度情報</Title><InfoType>取消</InfoType><EventID>1</EventID>
        <Headline><Text>先ほどの震源・震度情報を取り消します。</Text></Headline></Head>
      <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/"><Text>先ほどの震源・震度情報を取り消します。</Text></Body></Report>`;
    const r = parseReport(xml);
    assert.equal(r.infoType, '取消');
    assert.equal(r.maxIntensity, null);
    assert.deepEqual(r.tsunamiForecast, []);
});

test('XML with two roots, undefined entities or missing common fields is rejected', () => {
    const ok = '<Control><Title>t</Title></Control><Head xmlns="x"><Title>h</Title><InfoType>発表</InfoType></Head>';
    assert.doesNotThrow(() => parseReport(`<Report xmlns="r">${ok}</Report>`));
    assert.throws(() => parseReport(`<Report xmlns="r">${ok}</Report><Report xmlns="r">${ok}</Report>`), /Malformed|one root/);
    assert.throws(() => parseReport(`<Report xmlns="r">${ok.replace('<Title>h</Title>', '<Title>&bogus;</Title>')}</Report>`), /entity|Malformed/);
    assert.throws(() => parseReport('<Report xmlns="r"><Control><Foo/></Control><Head xmlns="x"><Bar/></Head></Report>'), /Incomplete JMA report \(missing/);
});

test('sanitize strips local paths from messages', async () => {
    const { sanitize } = await import('../src/jma.js');
    // Paths are assembled at runtime so this file itself never contains a user-home path.
    const winPath = ['C:', 'Users', 'someone', 'file.json'].join('\\');
    const unixPath = ['', 'home', 'someone', 'x.json'].join('/');
    assert.equal(sanitize(`EACCES: permission denied, open '${winPath}'`), "EACCES: permission denied, open '<path>'");
    assert.equal(sanitize(`ENOENT ${unixPath}`), 'ENOENT <path>');
    assert.equal(sanitize('HTTP 503 for https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml'), 'HTTP 503 for https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml');
});
