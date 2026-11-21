# Japan Earthquake, Tsunami & Weather Warning Feed (JMA)

Get **official disaster information from the Japan Meteorological Agency (JMA, 気象庁)** as clean, structured JSON — earthquakes, seismic intensity, tsunami warnings, volcano reports and weather warnings — straight from JMA's public XML feeds. No API key, no browser, no scraping of web pages.

Run it once for research, or put it on a schedule with **monitoring mode** to receive only new reports (e.g. "every earthquake of intensity 4 or more" or "any warning whose title or summary mentions Tokyo").

## What you get

For every report:

- Feed metadata: type (`title`), publish time, JMA summary text, link to the source XML
- Parsed report header: report title, report / target time, event ID, info type (発表 / 訂正 / 取消), headline text
- Headline areas and kinds — e.g. which warnings (大雨警報, 波浪注意報 …) apply to which areas
- **Earthquakes:** origin time, hypocenter name, latitude / longitude, depth (km), magnitude, max seismic intensity (震度), intensity by prefecture and area
- **Tsunami:** forecast areas with category (津波警報 / 津波注意報 …) and expected max height
- Fixed comments (e.g. "この地震による津波の心配はありません。")

## Use cases

- **Business continuity / logistics:** trigger alerts or workflows when strong shaking or warnings hit regions where you have sites, warehouses or routes
- **Insurance & risk analytics:** collect a structured history of earthquakes with coordinates, magnitude and intensity
- **Media & apps:** feed disaster news tickers, dashboards and chatbots with authoritative data
- **AI agents:** give an agent a reliable tool for "what disasters are happening in Japan right now?"

## Input examples

Earthquakes of intensity 4 or more in the last few days:

```json
{
  "feeds": ["eqvol"],
  "longFeed": true,
  "titles": ["震源・震度に関する情報"],
  "minIntensity": "4"
}
```

Monitoring: new weather warnings / advisories whose title or summary text mentions Tokyo (schedule every 5 minutes). Keyword matching is plain text search on the feed title and summary:

```json
{
  "feeds": ["extra"],
  "titles": ["気象警報"],
  "keywords": ["東京都"],
  "onlyNew": true,
  "stateKey": "tokyo-warnings"
}
```

Tsunami information only, summaries without downloading each report:

```json
{ "feeds": ["eqvol"], "longFeed": true, "titles": ["津波"], "fetchDetails": false }
```

### Useful report titles

| Title (contains) | Meaning |
|---|---|
| `震源・震度に関する情報` | Earthquake hypocenter + intensity (most complete earthquake report) |
| `震度速報` | Seismic intensity flash report (first minutes, no hypocenter yet) |
| `震源に関する情報` | Hypocenter only |
| `津波` | Tsunami warnings / advisories / forecasts |
| `噴火` | Eruption reports and volcano warnings |
| `気象警報` | Weather warnings and advisories |
| `記録的短時間大雨` | Record short-term heavy rain |

## Output example

```json
{
  "feed": "eqvol",
  "title": "震源・震度に関する情報",
  "updated": "2026-11-21T10:12:24Z",
  "summary": "【震源・震度情報】２１日１９時０９分ころ、地震がありました。",
  "xmlUrl": "https://www.data.jma.go.jp/developer/xml/data/20261121101224_0_VXSE53_010000.xml",
  "reportTitle": "震源・震度情報",
  "eventId": "20261121190909",
  "infoType": "発表",
  "originTime": "2026-11-21T19:09:00+09:00",
  "hypocenter": "房総半島南方沖",
  "latitude": 34.0,
  "longitude": 140.4,
  "depthKm": 20,
  "magnitude": 4.9,
  "magnitudeType": "Mj",
  "maxIntensity": "2",
  "intensityByPrefecture": [{ "prefecture": "東京都", "maxIntensity": "2", "areas": [] }],
  "tsunamiForecast": [],
  "comments": ["この地震による津波の心配はありません。"],
  "source": "Japan Meteorological Agency (気象庁) disaster information XML"
}
```

Seismic intensity uses the JMA scale as strings: `1, 2, 3, 4, 5-, 5+, 6-, 6+, 7` (5- = 5弱, 5+ = 5強).

## Notes

- **Feed windows:** the short feeds hold only the latest reports (roughly the last 10+ minutes, updated every minute or so). Long feeds (`longFeed: true`) cover several days. For monitoring, schedule the Actor about every 5 minutes with the short feed and `onlyNew: true`; reports that failed to download are retried on the next run. After an outage or a paused schedule, run once with `longFeed: true` (same `stateKey`) to catch up.
- Temporary errors (server errors, network problems) never make the Actor give up on a report; it is retried on every run. A report is only given up (recorded in the state store as dropped) after 5 runs in which it returned HTTP 404 or could not be parsed. To fetch such a report anyway, run once with `onlyNew: false` **and** `longFeed: true` (the report must still be listed in a feed; this also re-outputs reports you already received). If it has left the long feed too, open the report URL from the warning log directly.
- `maxDetailRequests` caps the HTTP requests for report downloads per run (retries included). In monitoring mode, entries that were not processed (cap, `maxItems` or failed downloads) are saved as *pending* in the state store and processed by later runs even after they disappear from the short feed. A run summary is saved as `RUN_SUMMARY` in the default key-value store.
- When the pay-per-event spending limit is reached, the run stops with a warning and monitoring keeps the remaining reports pending for the next run.
- A single earthquake usually produces several reports (intensity flash → hypocenter → hypocenter + intensity, sometimes corrections). Use `eventId` to group them.
- Requests are made one at a time with a delay (default 1 s) to be gentle with JMA's servers.
- This Actor is **not** an early-warning system. JMA's public feeds can lag by minutes; never rely on it for life-safety decisions.

## Data source & terms

Data: Japan Meteorological Agency, disaster information XML (気象庁防災情報XML), published for re-use (including commercial use) under the Public Data License 1.0 (公共データ利用規約 第1.0版). When you publish or redistribute the data, credit the source (e.g. "出典：気象庁ホームページ"), indicate if you edited it, and do not present edited information as if it were issued by JMA, in line with the [JMA website terms of use](https://www.jma.go.jp/jma/kishou/info/coment.html) / [English](https://www.jma.go.jp/jma/en/copyright.html). This Actor **edits** the source data (it converts JMA XML into JSON fields and drops some elements), so if you publish its output, state that it was processed from JMA data (e.g. "気象庁防災情報XML（元電文: <xmlUrl>）を加工して作成"), state who is responsible for the processing (e.g. "編集・加工の責任は〇〇にあります" / "Processed by <your organisation>, which is responsible for the edits"), and keep the meaning of warnings intact (do not omit a warning's area, cancellation or correction status). Each record includes `xmlUrl` pointing to the original report. See also JMA's [notes on using the XML](https://xml.kishou.go.jp/considerationforxml.pdf). This Actor is not affiliated with or endorsed by JMA.

---

## 日本語の概要

気象庁防災情報XML（PULL型フィード、登録不要）から、地震（震源・マグニチュード・震度・都道府県別震度）、津波、火山、気象警報・注意報を構造化 JSON で取得します。`onlyNew` を有効にしてスケジュール実行すると、前回以降の新しい情報だけを出力するので、BCP・物流・保険向けのアラートに使えます。利用時は気象庁の利用規約に従い、出典を明記してください。緊急地震速報の代わりにはなりません。
