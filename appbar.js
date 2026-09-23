'use strict';
// Windows の「アプリケーション デスクトップ ツールバー（AppBar）」の登録。
// タスクバーと同じしくみで画面の上端/下端を予約するので、
// 他のウィンドウを最大化したときにティッカーの場所を避けてくれる。
const { screen } = require('electron');

let api = null;
function load() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const shell32 = koffi.load('shell32.dll');
    const RECT = koffi.struct('ABRECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const APPBARDATA = koffi.struct('APPBARDATA', {
      cbSize: 'uint32',
      hWnd: 'intptr',
      uCallbackMessage: 'uint32',
      uEdge: 'uint32',
      rc: RECT,
      lParam: 'intptr',
    });
    const SHAppBarMessage = shell32.func('uintptr __stdcall SHAppBarMessage(uint32, _Inout_ APPBARDATA *)');
    api = { SHAppBarMessage, size: koffi.sizeof(APPBARDATA) };
  } catch (e) {
    console.error('AppBar を使えません:', e.message);
  }
  return api;
}

const ABM_NEW = 0;
const ABM_REMOVE = 1;
const ABM_QUERYPOS = 2;
const ABM_SETPOS = 3;
const ABM_ACTIVATE = 6;
const ABN_POSCHANGED = 1;
const ABN_FULLSCREENAPP = 2;
const ABE_TOP = 1;
const ABE_BOTTOM = 3;
const CALLBACK_MSG = 0x0400 + 0x2a1; // WM_USER + 適当な番号

class AppBar {
  // onPosChanged: 他の AppBar やタスクバーが動いたので置き直してほしいとき
  // onFullscreen(bool): 全画面アプリが出た/消えたとき
  constructor(win, { onPosChanged, onFullscreen }) {
    this.win = win;
    // HWND は Windows のときだけ 8 バイト。Linux などでは使わないので読まない
    this.hwnd = process.platform === 'win32' ? Number(win.getNativeWindowHandle().readBigUInt64LE(0)) : 0;
    this.registered = false;
    this.lastKey = null;
    this.lastRect = null;
    this.onPosChanged = onPosChanged;
    this.onFullscreen = onFullscreen;
  }

  static available() {
    return !!load();
  }

  data(extra = {}) {
    return {
      cbSize: api.size,
      hWnd: this.hwnd,
      uCallbackMessage: CALLBACK_MSG,
      uEdge: 0,
      rc: { left: 0, top: 0, right: 0, bottom: 0 },
      lParam: 0,
      ...extra,
    };
  }

  register() {
    if (this.registered || !load()) return this.registered;
    this.registered = !!api.SHAppBarMessage(ABM_NEW, this.data());
    if (this.registered) {
      this.win.hookWindowMessage(CALLBACK_MSG, (wParam, lParam) => {
        const code = Number(wParam.readBigUInt64LE(0));
        if (code === ABN_POSCHANGED) this.onPosChanged();
        if (code === ABN_FULLSCREENAPP) this.onFullscreen(Number(lParam.readBigUInt64LE(0)) !== 0);
      });
    }
    return this.registered;
  }

  unregister() {
    if (!this.registered) return;
    try { this.win.unhookWindowMessage(CALLBACK_MSG); } catch {}
    api.SHAppBarMessage(ABM_REMOVE, this.data());
    this.registered = false;
    this.lastKey = null;
    this.lastRect = null;
  }

  // display の上端 (edge='top') か下端 (edge='bottom') に高さ heightDip の帯を予約し、
  // 実際に確保できた範囲を DIP で返す
  dock(display, edge, heightDip) {
    if (!this.register()) return null;
    const mon = screen.dipToScreenRect(null, display.bounds); // 物理ピクセル
    const h = Math.round(heightDip * display.scaleFactor);
    const uEdge = edge === 'top' ? ABE_TOP : ABE_BOTTOM;
    const d = this.data({
      uEdge,
      rc: {
        left: mon.x,
        right: mon.x + mon.width,
        top: edge === 'top' ? mon.y : mon.y + mon.height - h,
        bottom: edge === 'top' ? mon.y + h : mon.y + mon.height,
      },
    });
    // タスクバーなど他の AppBar と重ならない位置を聞いてから、高さを合わせて確定する
    api.SHAppBarMessage(ABM_QUERYPOS, d);
    if (edge === 'top') d.rc.bottom = d.rc.top + h;
    else d.rc.top = d.rc.bottom - h;
    // 同じ位置なら SETPOS し直さない（作業領域の変更通知がループしないように）
    const key = JSON.stringify(d.rc);
    if (key !== this.lastKey) {
      api.SHAppBarMessage(ABM_SETPOS, d);
      this.lastKey = key;
      this.lastRect = { ...d.rc };
    }
    api.SHAppBarMessage(ABM_ACTIVATE, this.data());
    const rc = this.lastRect;
    return screen.screenToDipRect(null, { x: rc.left, y: rc.top, width: rc.right - rc.left, height: rc.bottom - rc.top });
  }
}

module.exports = { AppBar };
