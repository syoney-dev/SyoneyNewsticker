'use strict';
// 気象庁の天気予報（JSON）から主要都市の今日・明日の天気を取得して latest_weather.json を作る。
//   データ: https://www.jma.go.jp/bosai/forecast/data/forecast/<府県予報区コード>.json
// 単体でも `node fetch-weather.js [出力先]` で実行できる。
const fs = require('fs');
const path = require('path');

// 東京と、政令指定都市のある道府県（県庁所在地）
//   office: 府県予報区 / area: 天気・降水確率の一次細分区域 / station: 気温の地点
const CITIES = [
  { name: '札幌', office: '016000', area: '016010', station: '札幌' },
  { name: '仙台', office: '040000', area: '040010', station: '仙台' },
  { name: 'さいたま', office: '110000', area: '110010', station: 'さいたま' },
  { name: '千葉', office: '120000', area: '120010', station: '千葉' },
  { name: '東京', office: '130000', area: '130010', station: '東京' },
  { name: '横浜', office: '140000', area: '140010', station: '横浜' },
  { name: '新潟', office: '150000', area: '150010', station: '新潟' },
  { name: '静岡', office: '220000', area: '220010', station: '静岡' },
  { name: '名古屋', office: '230000', area: '230010', station: '名古屋' },
  { name: '京都', office: '260000', area: '260010', station: '京都' },
  { name: '大阪', office: '270000', area: '270000', station: '大阪' },
  { name: '神戸', office: '280000', area: '280010', station: '神戸' },
  { name: '岡山', office: '330000', area: '330010', station: '岡山' },
  { name: '広島', office: '340000', area: '340010', station: '広島' },
  { name: '福岡', office: '400000', area: '400010', station: '福岡' },
  { name: '熊本', office: '430000', area: '430010', station: '熊本' },
];

// 気象庁の天気コード → 短い天気の表記（気象庁の予報ページの対応表より）
const TELOPS = {
  100: '晴', 101: '晴時々曇', 102: '晴一時雨', 103: '晴時々雨', 104: '晴一時雪', 105: '晴時々雪',
  106: '晴一時雨か雪', 107: '晴時々雨か雪', 108: '晴一時雨か雷雨', 110: '晴後時々曇', 111: '晴後曇', 112: '晴後一時雨',
  113: '晴後時々雨', 114: '晴後雨', 115: '晴後一時雪', 116: '晴後時々雪', 117: '晴後雪', 118: '晴後雨か雪',
  119: '晴後雨か雷雨', 120: '晴朝夕一時雨', 121: '晴朝の内一時雨', 122: '晴夕方一時雨', 123: '晴山沿い雷雨', 124: '晴山沿い雪',
  125: '晴午後は雷雨', 126: '晴昼頃から雨', 127: '晴夕方から雨', 128: '晴夜は雨', 130: '朝の内霧後晴', 131: '晴明け方霧',
  132: '晴朝夕曇', 140: '晴時々雨で雷を伴う', 160: '晴一時雪か雨', 170: '晴時々雪か雨', 181: '晴後雪か雨', 200: '曇',
  201: '曇時々晴', 202: '曇一時雨', 203: '曇時々雨', 204: '曇一時雪', 205: '曇時々雪', 206: '曇一時雨か雪',
  207: '曇時々雨か雪', 208: '曇一時雨か雷雨', 209: '霧', 210: '曇後時々晴', 211: '曇後晴', 212: '曇後一時雨',
  213: '曇後時々雨', 214: '曇後雨', 215: '曇後一時雪', 216: '曇後時々雪', 217: '曇後雪', 218: '曇後雨か雪',
  219: '曇後雨か雷雨', 220: '曇朝夕一時雨', 221: '曇朝の内一時雨', 222: '曇夕方一時雨', 223: '曇日中時々晴', 224: '曇昼頃から雨',
  225: '曇夕方から雨', 226: '曇夜は雨', 228: '曇昼頃から雪', 229: '曇夕方から雪', 230: '曇夜は雪', 231: '曇海上海岸は霧か霧雨',
  240: '曇時々雨で雷を伴う', 250: '曇時々雪で雷を伴う', 260: '曇一時雪か雨', 270: '曇時々雪か雨', 281: '曇後雪か雨', 300: '雨',
  301: '雨時々晴', 302: '雨時々止む', 303: '雨時々雪', 304: '雨か雪', 306: '大雨', 308: '雨で暴風を伴う',
  309: '雨一時雪', 311: '雨後晴', 313: '雨後曇', 314: '雨後時々雪', 315: '雨後雪', 316: '雨か雪後晴',
  317: '雨か雪後曇', 320: '朝の内雨後晴', 321: '朝の内雨後曇', 322: '雨朝晩一時雪', 323: '雨昼頃から晴', 324: '雨夕方から晴',
  325: '雨夜は晴', 326: '雨夕方から雪', 327: '雨夜は雪', 328: '雨一時強く降る', 329: '雨一時みぞれ', 340: '雪か雨',
  350: '雨で雷を伴う', 361: '雪か雨後晴', 371: '雪か雨後曇', 400: '雪', 401: '雪時々晴', 402: '雪時々止む',
  403: '雪時々雨', 405: '大雪', 406: '風雪強い', 407: '暴風雪', 409: '雪一時雨', 411: '雪後晴',
  413: '雪後曇', 414: '雪後雨', 420: '朝の内雪後晴', 421: '朝の内雪後曇', 422: '雪昼頃から雨', 423: '雪夕方から雨',
  425: '雪一時強く降る', 426: '雪後みぞれ', 427: '雪一時みぞれ', 450: '雪で雷を伴う',
};

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LED-News-Ticker' };
const TIMEOUT_MS = 15000;
const LINK = 'https://www.jma.go.jp/bosai/forecast/';

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} の取得に失敗しました (HTTP ${res.status})`);
  return res.json();
}

// 「晴後曇」→「晴のち曇」のように読みやすくする
function telop(code, fallback) {
  const t = TELOPS[code];
  if (t) return t.replace(/後/g, 'のち');
  return String(fallback || '').replace(/\s+/g, '').slice(0, 10);
}

// 1都市ぶんの予報を日付ごと（YYYY-MM-DD）にまとめる
function forecastByDate(data, city) {
  const ts = data[0].timeSeries;
  const days = {};
  const day = (date) => (days[date] = days[date] || {});

  const w = ts[0].areas.find((a) => a.area.code === city.area) || ts[0].areas[0];
  ts[0].timeDefines.forEach((t, i) => { day(t.slice(0, 10)).weather = telop(w.weatherCodes[i], w.weathers && w.weathers[i]); });

  const p = ts[1].areas.find((a) => a.area.code === city.area) || ts[1].areas[0];
  ts[1].timeDefines.forEach((t, i) => {
    const v = Number(p.pops[i]);
    if (p.pops[i] === '' || !Number.isFinite(v)) return;
    const d = day(t.slice(0, 10));
    d.pop = Math.max(d.pop ?? 0, v);
  });

  // 気温は 0時の枠 = 最低、9時の枠 = 最高
  const s = ts[2].areas.find((a) => a.area.name === city.station) || ts[2].areas[0];
  ts[2].timeDefines.forEach((t, i) => {
    const v = Number(s.temps[i]);
    if (s.temps[i] === '' || !Number.isFinite(v)) return;
    const d = day(t.slice(0, 10));
    if (t.slice(11, 13) === '09') d.max = v;
    else d.min = v;
  });
  // その日の朝を過ぎた発表では最低気温の枠に最高気温が入るので、そのときは最低気温なしとする
  for (const d of Object.values(days)) if (d.min !== undefined && d.max !== undefined && d.min >= d.max) delete d.min;
  return days;
}

// 例: 東京：曇時々晴 29℃/20℃ 降水30%
function formatCity(name, d) {
  const parts = [`${name}：${d.weather}`];
  if (d.max !== undefined && d.min !== undefined) parts.push(`${d.max}℃/${d.min}℃`);
  else if (d.max !== undefined) parts.push(`最高${d.max}℃`);
  else if (d.min !== undefined) parts.push(`最低${d.min}℃`);
  if (d.pop !== undefined) parts.push(`降水${d.pop}%`);
  return parts.join(' ');
}

// 取得して file に書き出す。1都市も取れなかったときは例外にして、前のファイルを残す
async function fetchWeather({ file } = {}) {
  const cache = {};
  const perDate = {};
  for (const city of CITIES) {
    try {
      cache[city.office] = cache[city.office] || await getJson(`https://www.jma.go.jp/bosai/forecast/data/forecast/${city.office}.json`);
      for (const [date, d] of Object.entries(forecastByDate(cache[city.office], city))) {
        if (!d.weather) continue;
        (perDate[date] = perDate[date] || []).push(formatCity(city.name, d));
      }
    } catch (e) {
      console.error(`${city.name}の天気を取得できませんでした:`, e.message);
    }
  }
  if (!Object.keys(perDate).length) throw new Error('天気を1都市も取得できませんでした');

  // 都市のあいだは全角スペースで区切る
  const days = {};
  for (const [date, list] of Object.entries(perDate)) days[date] = list.join('　');
  const result = { fetchedAt: new Date().toISOString(), link: LINK, days };

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return result;
}

module.exports = { fetchWeather, forecastByDate, formatCity, CITIES };

if (require.main === module) {
  const file = path.resolve(process.argv[2] || path.join(__dirname, 'latest_weather.json'));
  fetchWeather({ file })
    .then((r) => {
      console.log(`${file} に書き出しました`);
      for (const [date, text] of Object.entries(r.days)) console.log(`${date}: ${text}`);
    })
    .catch((e) => {
      console.error('天気を取得できませんでした:', e.message);
      process.exitCode = 1;
    });
}
