'use strict';
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const { AppBar } = require('./appbar');
const { fetchNews } = require('./fetch-news');
const { fetchWeather } = require('./fetch-weather');

const APP_DIR = __dirname;
const CONFIG_PATH = path.join(APP_DIR, 'config.json');

// config.json に書かれていない項目はこの値を使う
const DEFAULTS = {
  scrollSpeed: 40,          // 1秒あたりに流れるドット数（大きいほど速い）
  fontSize: 32,             // 1文字の高さ(px)。ウィンドウの高さはこれに合わせて自動で決まる
  titleHoldSeconds: 1.5,    // タイトルが出てから本文が流れ始めるまでの秒数
  itemIntervalSeconds: 1.0, // 本文が流れ切ってから次のニュースに切り替わるまでの秒数
  newsDir: '.',             // ニュースの md を探すフォルダ（このアプリのフォルダからの相対パス可）
  newsFile: '',             // 特定の md を表示したいときに指定（空なら newsDir の latest_news.md）
  dotRows: 16,              // 1行あたりの縦ドット数（文字の細かさ）
  dotFill: 0.78,            // ドットの直径（ドット間隔に対する割合）
  lineGapDots: 3,           // 1行目と2行目の間のドット数
  paddingDots: 3,           // 上下左右の余白ドット数
  showUnlitDots: true,      // 消灯しているドットもうっすら表示する
  glow: 0.55,               // LED のにじみ（0で無効）
  backgroundOpacity: 0.6,   // 背景の不透明度（1=真っ黒、0=完全に透明）
  fontFamily: '"MS Gothic", "Osaka-Mono", monospace',
  fontWeight: 'normal',
  dotThreshold: 0.45,       // 文字をドット化するときのしきい値（小さいほど太る）
  colors: {
    title: '#ff8a1c',
    body: '#39ff5a',
    unlit: '#171717',
    background: '#000000',
  },
  alwaysOnTop: true,
  reserveScreenSpace: true, // 画面の上端/下端をティッカー用に確保し、他のウィンドウが重ならないようにする（Windows）
  autoFetch: true,          // Yahoo!ニュースから自動でニュースを取得して latest_news.md を上書きする
  fetchIntervalMinutes: 60, // 自動取得の間隔（分）。起動時とスリープ復帰時にも取得する
  newsCount: 5,             // 取得するニュースの件数
  weatherEnabled: true,     // ニュースを流し終えたら「全国の天気」を流す（気象庁の予報）
  weatherSwitchHour: 18,    // この時刻からは明日の天気を流す
};

let win = null;
let tray = null;
let config = null;
let news = { file: null, heading: '', items: [] };
let weather = null; // latest_weather.json の中身 { fetchedAt, link, days: { 'YYYY-MM-DD': '東京：…　大阪：…' } }
let paused = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---- 設定 ----
const clamp = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    // 書きかけで壊れているときは前回の設定を使い続ける
    if (config) {
      console.error('config.json を読み込めませんでした:', e.message);
      return config;
    }
  }
  const c = { ...DEFAULTS, ...raw, colors: { ...DEFAULTS.colors, ...(raw.colors || {}) } };
  c.scrollSpeed = clamp(c.scrollSpeed, 1, 2000, DEFAULTS.scrollSpeed);
  c.fontSize = clamp(c.fontSize, 8, 300, DEFAULTS.fontSize);
  c.dotRows = Math.round(clamp(c.dotRows, 7, 64, DEFAULTS.dotRows));
  c.dotFill = clamp(c.dotFill, 0.2, 1, DEFAULTS.dotFill);
  c.lineGapDots = Math.round(clamp(c.lineGapDots, 0, 64, DEFAULTS.lineGapDots));
  c.paddingDots = Math.round(clamp(c.paddingDots, 0, 64, DEFAULTS.paddingDots));
  c.titleHoldSeconds = clamp(c.titleHoldSeconds, 0, 600, DEFAULTS.titleHoldSeconds);
  c.itemIntervalSeconds = clamp(c.itemIntervalSeconds, 0, 600, DEFAULTS.itemIntervalSeconds);
  c.glow = clamp(c.glow, 0, 2, DEFAULTS.glow);
  c.backgroundOpacity = clamp(c.backgroundOpacity, 0, 1, DEFAULTS.backgroundOpacity);
  c.dotThreshold = clamp(c.dotThreshold, 0.05, 0.95, DEFAULTS.dotThreshold);
  c.fetchIntervalMinutes = clamp(c.fetchIntervalMinutes, 5, 24 * 60, DEFAULTS.fetchIntervalMinutes);
  c.newsCount = Math.round(clamp(c.newsCount, 1, 20, DEFAULTS.newsCount));
  c.weatherSwitchHour = Math.round(clamp(c.weatherSwitchHour, 0, 24, DEFAULTS.weatherSwitchHour));
  return c;
}

// ティッカーを置いている画面の作業領域（横幅はいつもこの幅いっぱい）
let area = null;

// フォントサイズからウィンドウの大きさとドット配置を決める
function computeLayout(c) {
  const pitch = c.fontSize / c.dotRows; // 1ドットの間隔(px)
  const rows = c.paddingDots * 2 + c.dotRows * 2 + c.lineGapDots;
  const height = Math.ceil(rows * pitch);
  const width = area.width;
  return { pitch, width, height, cols: Math.ceil(width / pitch), rows };
}

// ---- ニュース ----
function findNewsFile(c) {
  if (c.newsFile) return path.resolve(APP_DIR, c.newsFile);
  const dir = path.resolve(APP_DIR, c.newsDir);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f) && !/^readme\.md$/i.test(f));
  } catch {
    return null;
  }
  if (!files.length) return null;
  // ルーティンが毎回上書きする latest_news.md を最優先
  const latest = files.find((f) => /^latest_news\.md$/i.test(f));
  if (latest) return path.join(dir, latest);
  // なければ日付で始まるファイル（例: 20260923_today_news.md）を優先して、名前の新しい順
  const dated = files.filter((f) => /^\d{8}/.test(f));
  const pool = (dated.length ? dated : files).sort().reverse();
  return path.join(dir, pool[0]);
}

function stripMarkdown(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .trim();
}

function parseNews(text) {
  const items = [];
  let heading = '';
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) { heading = stripMarkdown(h1[1]); continue; }
    const h2 = line.match(/^##\s+(?:\d+\s*[.．)）:：]\s*)?(.+)$/);
    if (h2) {
      cur = { title: stripMarkdown(h2[1]), body: [], link: '' };
      items.push(cur);
      continue;
    }
    if (!cur) continue;
    const link = line.match(/^\s*\[[^\]]*\]\((https?:\/\/[^)\s]+)\)\s*$/);
    if (link) { cur.link = link[1]; continue; }
    if (/^\s*#/.test(line) || !line.trim()) continue;
    cur.body.push(stripMarkdown(line));
  }
  return {
    heading,
    items: items.map((it) => ({ ...it, body: it.body.join(' ').replace(/\s+/g, ' ').trim() })),
  };
}

function loadNews() {
  const file = findNewsFile(config);
  if (!file) {
    news = { file: null, heading: '', items: [] };
    return;
  }
  try {
    news = { file, ...parseNews(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    console.error('ニュースを読み込めませんでした:', e.message);
    news = { file, heading: '', items: [] };
  }
}

// ---- 天気 ----
function weatherFile() {
  return path.join(path.resolve(APP_DIR, config.newsDir), 'latest_weather.json');
}

function loadWeather() {
  try {
    weather = JSON.parse(fs.readFileSync(weatherFile(), 'utf8'));
  } catch {
    weather = null;
  }
}

// ニュースのあとに流す「全国の天気」。今日か明日かは流すときに画面側で決める
function displayItems() {
  const items = [...news.items];
  if (config.weatherEnabled && weather && weather.days) {
    items.push({ kind: 'weather', days: weather.days, link: weather.link || '' });
  }
  return items;
}

// ---- ウィンドウ ----
const STATE_PATH = () => path.join(app.getPath('userData'), 'state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH(), 'utf8')); } catch { return {}; }
}

function saveState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  try { fs.writeFileSync(STATE_PATH(), JSON.stringify({ x: b.x, y: b.y, edge: dock && dock.edge })); } catch {}
}

// ---- 画面の領域の確保（AppBar） ----
let appbar = null;
let dock = null;      // { point: その画面の中の1点, edge: 'top' | 'bottom' }
let dragging = false;
let closing = false;  // 終了中は置き直さない（領域の解除で画面の変更通知が来るため）

function dockEnabled() {
  return !!config.reserveScreenSpace && AppBar.available();
}

// ウィンドウのある位置から、上端と下端のどちらに寄せるかを決める
function dockFromPoint(point) {
  const d = screen.getDisplayNearestPoint(point).bounds;
  return { point, edge: point.y < d.y + d.height / 2 ? 'top' : 'bottom' };
}

function placeDocked() {
  const display = screen.getDisplayNearestPoint(dock.point);
  const { height } = computeLayout(config);
  const rc = appbar.dock(display, dock.edge, height);
  if (!rc) return false;
  const prevWidth = area && area.width;
  area = rc;
  win.setBounds({ x: rc.x, y: rc.y, width: rc.width, height });
  if (area.width !== prevWidth) send('layout', computeLayout(config));
  return true;
}

// point がある画面の横幅いっぱいに、高さ y で置いたときの位置と大きさ
// （縦は画面からはみ出さないように直す）
function boundsOn(point, y) {
  area = screen.getDisplayNearestPoint(point).workArea;
  const { width, height } = computeLayout(config);
  const top = Math.min(Math.max(Math.round(y), area.y), area.y + Math.max(0, area.height - height));
  return { x: area.x, y: top, width, height };
}

// 画面の幅が変わったら、表示中のニュースはそのままでドット配置だけ作り直してもらう
function placeWindow(point, y) {
  const prevWidth = area && area.width;
  win.setBounds(boundsOn(point, y));
  if (area.width !== prevWidth) send('layout', computeLayout(config));
}

function payload() {
  return {
    config,
    layout: computeLayout(config),
    news: { heading: news.heading, items: displayItems(), file: news.file ? path.basename(news.file) : '' },
    paused,
  };
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function windowCenter() {
  const b = win.getBounds();
  return { x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) };
}

function applyWindowSize() {
  if (dragging || closing || !win || win.isDestroyed()) return;
  if (dockEnabled()) {
    if (!dock) dock = dockFromPoint(windowCenter());
    if (placeDocked()) {
      win.setAlwaysOnTop(!!config.alwaysOnTop, 'floating');
      return;
    }
  }
  if (appbar) appbar.unregister();
  placeWindow(windowCenter(), win.getBounds().y);
  win.setAlwaysOnTop(!!config.alwaysOnTop, 'floating');
}

function createWindow() {
  const st = loadState();
  const primary = screen.getPrimaryDisplay().workArea;
  // 初回は画面の一番下（タスクバーのすぐ上）
  const start = Number.isFinite(st.x) && Number.isFinite(st.y)
    ? boundsOn({ x: st.x + 1, y: st.y + 1 }, st.y)
    : boundsOn({ x: primary.x + 1, y: primary.y + 1 }, primary.y + primary.height);

  win = new BrowserWindow({
    ...start,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: !!config.alwaysOnTop,
    transparent: true,        // 背景を半透明にするため（濃さは backgroundOpacity）
    hasShadow: false,
    backgroundColor: '#00000000',
    useContentSize: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(!!config.alwaysOnTop, 'floating');

  appbar = new AppBar(win, {
    onPosChanged: () => applyWindowSize(),
    // 全画面の動画やゲームの上には出しゃばらない
    onFullscreen: (full) => win.setAlwaysOnTop(!full && !!config.alwaysOnTop, 'floating'),
  });
  if (st.edge === 'top' || st.edge === 'bottom') dock = { point: windowCenter(), edge: st.edge };
  applyWindowSize();
  win.on('close', () => {
    closing = true;
    appbar.unregister();
  });

  win.once('ready-to-show', () => win.showInactive());
  win.loadFile('index.html');
}

// ---- メニュー ----
function buildMenu(link) {
  return Menu.buildFromTemplate([
    {
      label: 'このニュースの記事を開く',
      enabled: !!link,
      click: () => openLink(link),
    },
    { label: '次のニュースへ', click: () => send('command', { type: 'next' }) },
    {
      label: '一時停止',
      type: 'checkbox',
      checked: paused,
      click: (item) => {
        paused = item.checked;
        send('command', { type: 'pause', value: paused });
        refreshTray();
      },
    },
    { type: 'separator' },
    { label: 'ニュースを今すぐ取得', click: () => fetchLatest() },
    { label: 'ニュースを読み込み直す', click: () => { loadNews(); send('news', payload().news); } },
    { label: '設定ファイルを開く', click: () => shell.openPath(CONFIG_PATH) },
    { label: 'ニュースのフォルダを開く', click: () => shell.openPath(path.resolve(APP_DIR, config.newsDir)) },
    { type: 'separator' },
    {
      label: 'ログイン時に起動',
      type: 'checkbox',
      visible: process.platform !== 'linux',
      checked: process.platform !== 'linux' && app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() },
  ]);
}

let currentLink = '';
function refreshTray() {
  if (tray) tray.setContextMenu(buildMenu(currentLink));
}

// 16x16 のトレイアイコンをコードで描く（上段オレンジ・下段グリーンのLED）
function makeTrayIcon() {
  const S = 16;
  const buf = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      let rgb = [16, 16, 16];
      const onDot = x >= 2 && x <= 13 && x % 2 === 0;
      if (onDot && (y === 4 || y === 6)) rgb = [255, 138, 28];
      if (onDot && (y === 10 || y === 12) && x >= 4) rgb = [57, 255, 90];
      buf[i] = rgb[2]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[0]; buf[i + 3] = 255; // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('LEDニュースティッカー');
  refreshTray();
}

function openLink(url) {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
}

// ---- ファイル監視（設定やニュースを書き換えたら自動で反映） ----
const watchers = [];
function debounce(fn, ms) {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}

// ---- ニュースの自動取得 ----
let fetchTimer = null;
let fetching = false;

// 取得したニュースの書き出し先（newsFile 指定があればそこ、なければ newsDir の latest_news.md）
function fetchTarget() {
  return config.newsFile
    ? path.resolve(APP_DIR, config.newsFile)
    : path.join(path.resolve(APP_DIR, config.newsDir), 'latest_news.md');
}

// ニュースと天気を取得する。書き出すとフォルダ監視が気づいて表示も更新される
// どちらかが失敗しても、もう片方は取得し、失敗したほうは前の内容のまま
async function fetchLatest() {
  if (fetching) return;
  fetching = true;
  try {
    await fetchNews({ count: config.newsCount, file: fetchTarget() });
  } catch (e) {
    console.error('ニュースを取得できませんでした:', e.message);
  }
  if (config.weatherEnabled) {
    try {
      await fetchWeather({ file: weatherFile() });
    } catch (e) {
      console.error('天気を取得できませんでした:', e.message);
    }
  }
  fetching = false;
}

function scheduleFetch() {
  clearInterval(fetchTimer);
  fetchTimer = null;
  if (config.autoFetch) fetchTimer = setInterval(fetchLatest, config.fetchIntervalMinutes * 60 * 1000);
}

const onConfigChange = debounce(() => {
  const before = JSON.stringify([config.newsDir, config.newsFile]);
  const fetchBefore = JSON.stringify([config.autoFetch, config.fetchIntervalMinutes]);
  config = loadConfig();
  applyWindowSize();
  if (JSON.stringify([config.autoFetch, config.fetchIntervalMinutes]) !== fetchBefore) scheduleFetch();
  if (config.weatherEnabled && !weather) fetchLatest();
  if (JSON.stringify([config.newsDir, config.newsFile]) !== before) {
    loadNews();
    setupWatchers();
  }
  send('config', payload());
}, 250);

const onNewsChange = debounce(() => {
  loadNews();
  loadWeather();
  send('news', payload().news);
}, 400);

function setupWatchers() {
  while (watchers.length) watchers.pop().close();
  const newsDir = config.newsFile
    ? path.dirname(path.resolve(APP_DIR, config.newsFile))
    : path.resolve(APP_DIR, config.newsDir);
  const dirs = new Set([APP_DIR, newsDir]);
  for (const dir of dirs) {
    try {
      // エディタは一時ファイル経由で保存することが多いので、ファイルではなくフォルダを見る
      watchers.push(fs.watch(dir, (_ev, name) => {
        if (!name) return;
        const full = path.join(dir, name.toString());
        if (full === CONFIG_PATH) onConfigChange();
        if (/\.md$/i.test(full) && path.dirname(full) === newsDir) onNewsChange();
        if (/^latest_weather\.json$/i.test(path.basename(full)) && path.dirname(full) === newsDir) onNewsChange();
      }));
    } catch (e) {
      console.error('フォルダを監視できませんでした:', dir, e.message);
    }
  }
}

// ---- IPC ----
ipcMain.handle('init', () => payload());

// ドラッグは縦方向だけ。マウスが別の画面に入ったらその画面の幅いっぱいに移る
// 領域を確保しているときは、ドラッグ中だけ確保を外し、離したら近いほうの端（上か下）に寄せる
ipcMain.on('move', (_e, y) => {
  if (!win || win.isDestroyed()) return;
  if (!dragging) {
    dragging = true;
    appbar.unregister();
  }
  placeWindow(screen.getCursorScreenPoint(), y);
});

ipcMain.on('move-end', () => {
  dragging = false;
  if (dockEnabled()) dock = dockFromPoint(windowCenter());
  applyWindowSize();
  saveState();
});

ipcMain.handle('get-bounds', () => win.getBounds());

ipcMain.on('current-item', (_e, link) => {
  currentLink = typeof link === 'string' ? link : '';
  refreshTray();
});

ipcMain.on('open-link', (_e, url) => openLink(url));

ipcMain.on('context-menu', () => buildMenu(currentLink).popup({ window: win }));

// ---- 起動 ----
app.whenReady().then(() => {
  config = loadConfig();
  loadNews();
  loadWeather();
  createWindow();
  createTray();
  setupWatchers();
  if (config.autoFetch) fetchLatest();
  scheduleFetch();
  // スリープから復帰したら、止まっていたあいだのニュースを取り直す
  powerMonitor.on('resume', () => { if (config.autoFetch) fetchLatest(); });

  // デバッグ用: --capture=保存先.png で数秒後の画面を保存して終了
  const cap = process.argv.find((a) => a.startsWith('--capture='));
  if (cap) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(cap.slice('--capture='.length), img.toPNG());
      app.quit();
    }, 4000);
  }

  screen.on('display-metrics-changed', () => applyWindowSize());
});

app.on('before-quit', () => {
  saveState();
  closing = true;
  if (appbar) appbar.unregister();
});
app.on('window-all-closed', () => app.quit());
