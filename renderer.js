'use strict';
// LED ドットマトリクスの描き方:
//   1. 1ドット=1px の小さなキャンバス(low)に、点灯しているドットを色で塗る
//   2. それを拡大して本番キャンバスに描き、丸いドットの形だけを残して「粒」にする
//   3. 後ろに半透明の背景を敷き、ぼかした光を加算で重ねて LED のにじみを出す

const canvas = document.getElementById('led');
const ctx = canvas.getContext('2d');

let cfg = null;
let layout = null;
let items = [];
let idx = 0;
let paused = false;

// 表示の状態: hold（タイトルだけ表示）→ scroll（本文が流れる）→ gap（流れ切った後の間）→ 次へ
let phase = 'hold';
let phaseTime = 0;
let scrollX = 0; // 本文の左端のドット位置（小数）

let low = null;      // 1ドット=1px のキャンバス
let lowCtx = null;
let mask = null;     // ドットの位置だけ丸く塗ったマスク
let titleBmp = null;
let bodyBmp = null;
let dpr = window.devicePixelRatio || 1;
let dirty = true;
let lastDrawnX = null;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// 文字列を dotRows 行のドット絵にする（点灯ドット=指定色、その他=透明）
function textToDots(text, color) {
  const rows = cfg.dotRows;
  const font = `${cfg.fontWeight} ${rows}px ${cfg.fontFamily}`;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const width = Math.max(1, Math.ceil(probe.measureText(text).width));

  const c = document.createElement('canvas');
  c.width = width;
  c.height = rows;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.font = font;
  x.textBaseline = 'middle';
  x.fillStyle = '#fff';
  x.fillText(text, 0, rows / 2 + 0.5);

  const img = x.getImageData(0, 0, width, rows);
  const d = img.data;
  const [r, g, b] = hexToRgb(color);
  const th = Math.round(cfg.dotThreshold * 255);
  for (let i = 0; i < d.length; i += 4) {
    const on = d[i + 3] >= th;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = on ? 255 : 0;
  }
  x.putImageData(img, 0, 0);
  return c;
}

function build() {
  dpr = window.devicePixelRatio || 1;
  const { width, height, cols, rows, pitch } = layout;

  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  low = document.createElement('canvas');
  low.width = cols;
  low.height = rows;
  lowCtx = low.getContext('2d');
  lowCtx.imageSmoothingEnabled = false;

  // マスク: ドットの位置だけ丸く塗る（ここに重なった部分だけが残る）
  mask = document.createElement('canvas');
  mask.width = canvas.width;
  mask.height = canvas.height;
  const m = mask.getContext('2d');
  m.fillStyle = '#fff';
  const p = pitch * dpr;
  const r = Math.max(0.5, (p * cfg.dotFill) / 2);
  m.beginPath();
  for (let y = 0; y < rows; y++) {
    const cy = (y + 0.5) * p;
    for (let x = 0; x < cols; x++) {
      const cx = (x + 0.5) * p;
      m.moveTo(cx + r, cy);
      m.arc(cx, cy, r, 0, Math.PI * 2);
    }
  }
  m.fill();

  prepareItem();
}

function currentItem() {
  if (items.length) return items[idx % items.length];
  return { title: 'ニュースがありません', body: 'news_ticker フォルダに md ファイルを置いてください', link: '' };
}

function prepareItem() {
  const it = currentItem();
  titleBmp = textToDots(it.title, cfg.colors.title);
  bodyBmp = textToDots(it.body || '', cfg.colors.body);
  if (window.ticker) window.ticker.currentItem(it.link || '');
  dirty = true;
}

function startItem(i) {
  idx = items.length ? ((i % items.length) + items.length) % items.length : 0;
  phase = 'hold';
  phaseTime = 0;
  scrollX = layout.cols;
  prepareItem();
}

function update(dt) {
  if (paused) return;
  phaseTime += dt;
  if (phase === 'hold') {
    if (phaseTime >= cfg.titleHoldSeconds) { phase = 'scroll'; phaseTime = 0; }
  } else if (phase === 'scroll') {
    scrollX -= cfg.scrollSpeed * dt;
    if (scrollX + bodyBmp.width < 0) { phase = 'gap'; phaseTime = 0; }
  } else if (phase === 'gap') {
    if (phaseTime >= cfg.itemIntervalSeconds) startItem(idx + 1);
  }
}

function draw() {
  // LED は1ドット単位で動くので、位置が変わったときだけ描き直す
  const x = Math.round(scrollX);
  if (!dirty && x === lastDrawnX) return;
  dirty = false;
  lastDrawnX = x;

  const { cols, rows, pitch } = layout;
  const pad = cfg.paddingDots;
  const line2 = pad + cfg.dotRows + cfg.lineGapDots;

  lowCtx.clearRect(0, 0, cols, rows);
  if (cfg.showUnlitDots) {
    // 消灯ドットも背景と同じ濃さで透ける
    lowCtx.globalAlpha = cfg.backgroundOpacity;
    lowCtx.fillStyle = cfg.colors.unlit;
    lowCtx.fillRect(0, 0, cols, rows);
    lowCtx.globalAlpha = 1;
  }
  lowCtx.drawImage(titleBmp, pad, pad);
  if (phase !== 'hold') lowCtx.drawImage(bodyBmp, x, line2);

  const W = canvas.width;
  const H = canvas.height;
  const sw = cols * pitch * dpr;
  const sh = rows * pitch * dpr;

  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(low, 0, 0, sw, sh);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.globalAlpha = cfg.backgroundOpacity;
  ctx.fillStyle = cfg.colors.background;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  if (cfg.glow > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, cfg.glow);
    ctx.filter = `blur(${Math.max(1, pitch * dpr * 0.9)}px)`;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(low, 0, 0, sw, sh);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (cfg) {
    if ((window.devicePixelRatio || 1) !== dpr) build();
    update(dt);
    draw();
  }
  requestAnimationFrame(frame);
}

// ---- マウス: ドラッグで移動 / ダブルクリックで記事 / 右クリックでメニュー ----
let drag = null;
canvas.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return;
  const b = await window.ticker.getBounds();
  drag = { sy: e.screenY, by: b.y, moved: false };
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  // 横幅は画面いっぱいで固定なので、動かせるのは縦だけ
  const dy = e.screenY - drag.sy;
  if (Math.abs(dy) > 2) drag.moved = true;
  if (drag.moved) window.ticker.move(drag.by + dy);
});
window.addEventListener('mouseup', () => {
  if (drag && drag.moved) window.ticker.moveEnd();
  drag = null;
});
canvas.addEventListener('dblclick', () => {
  const it = currentItem();
  if (it.link) window.ticker.openLink(it.link);
});
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.ticker.showMenu();
});

// ---- メインプロセスからの通知 ----
function applyNews(n) {
  const prevTitle = items.length ? currentItem().title : null;
  items = n.items || [];
  // 同じニュースが残っていればその位置から続ける
  const keep = items.findIndex((it) => it.title === prevTitle);
  if (keep >= 0) {
    idx = keep;
    prepareItem();
  } else {
    startItem(0);
  }
}

window.ticker.onConfig((d) => {
  cfg = d.config;
  layout = d.layout;
  build();
  startItem(idx);
});
// 別の画面に移って横幅が変わったときは、流れている位置はそのままで描き直す
window.ticker.onLayout((l) => {
  if (!cfg) return;
  layout = l;
  build();
});
window.ticker.onNews((n) => applyNews(n));
window.ticker.onCommand((c) => {
  if (c.type === 'next') startItem(idx + 1);
  if (c.type === 'pause') paused = !!c.value;
});

window.ticker.init().then((d) => {
  cfg = d.config;
  layout = d.layout;
  items = d.news.items || [];
  paused = !!d.paused;
  build();
  startItem(0);
  requestAnimationFrame(frame);
});
