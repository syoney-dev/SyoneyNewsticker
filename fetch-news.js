'use strict';
// Yahoo!ニュースの主要トピックスを取得して latest_news.md を作る。
//   見出し・リンク: 公式 RSS（主要トピックス）
//   要約文:         各トピックページに載っている要約（meta description）
// 単体でも `node fetch-news.js [件数] [出力先]` で実行できる。
const fs = require('fs');
const path = require('path');

const RSS_URL = 'https://news.yahoo.co.jp/rss/topics/top-picks.xml';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LED-News-Ticker' };
const TIMEOUT_MS = 15000;

async function getText(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} の取得に失敗しました (HTTP ${res.status})`);
  return res.text();
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const clean = (s) => decodeEntities(s).replace(/\s+/g, ' ').trim();

function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const link = (m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    if (!title || !link) continue;
    items.push({ title: clean(title), link: clean(link).replace(/\?source=rss$/, '') });
  }
  return items;
}

function pickSummary(html) {
  const m = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)
    || html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i);
  if (!m) return '';
  const text = clean(m[1]);
  // Yahoo 側で文の途中で切られていることがあるので、そのときは … を付ける
  return /[。．！？!?」』）)…]$/.test(text) ? text : `${text}…`;
}

function toMarkdown(items, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}/${p(now.getMonth() + 1)}/${p(now.getDate())}`;
  const time = `${p(now.getHours())}:${p(now.getMinutes())}`;
  const lines = [`# ${date} 主要ニュース`, '', `取得元: https://news.yahoo.co.jp/ （取得時刻 ${time}）`, ''];
  items.forEach((it, i) => {
    // 見出しや要約に md の記号が混ざってもティッカーの読み取りが崩れないようにする
    lines.push(`## ${i + 1}. ${it.title.replace(/^#+\s*/, '')}`);
    lines.push(it.summary.replace(/^#+\s*/, '') || '（要約を取得できませんでした）');
    lines.push(`[記事リンク](${it.link})`);
    lines.push('');
  });
  return lines.join('\n');
}

// 取得して file に書き出す。1件も取れなかったときは例外にして、前のファイルを残す
async function fetchNews({ count = 5, file } = {}) {
  const items = parseRss(await getText(RSS_URL)).slice(0, count);
  if (!items.length) throw new Error('RSS にニュースが見つかりませんでした');
  for (const it of items) {
    try {
      it.summary = pickSummary(await getText(it.link));
    } catch (e) {
      it.summary = '';
      console.error(e.message);
    }
  }
  // 書きかけのファイルをティッカーが読まないよう、一時ファイルに書いてから置き換える
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, toMarkdown(items), 'utf8');
  fs.renameSync(tmp, file);
  return items;
}

module.exports = { fetchNews, parseRss, pickSummary, toMarkdown };

if (require.main === module) {
  const count = Number(process.argv[2]) || 5;
  const file = path.resolve(process.argv[3] || path.join(__dirname, 'latest_news.md'));
  fetchNews({ count, file })
    .then((items) => {
      console.log(`${file} に ${items.length} 件書き出しました`);
      items.forEach((it, i) => console.log(`${i + 1}. ${it.title}`));
    })
    .catch((e) => {
      console.error('ニュースを取得できませんでした:', e.message);
      process.exitCode = 1;
    });
}
