/* Kontenery — demo PWA: zdjęcie → odczyt numeru (OCR / kod QR) → GPS → zapis lokalny → Mapy Google */
'use strict';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const $ = (s) => document.querySelector(s);

/* ---------- Wspólna baza: Supabase (wszystkie telefony widzą te same skany) ----------
   Klucz „anon" jest z założenia publiczny — dostęp do tabeli ustalają zasady w docs/supabase.sql. */
const SUPABASE_URL = 'https://gsigzoxuxwqfbctojwji.supabase.co';
const SUPABASE_KEY = 'sb_publishable_tmkM44Lfc1cCx-GVh68eBQ_Bl7sEk-7';
const BUCKET = 'zdjecia';

/* ---------- Magazyn lokalny: IndexedDB (zapas, gdy brak sieci albo bazy) ---------- */
const localDb = (() => {
  let handle;
  const open = () => handle || (handle = new Promise((res, rej) => {
    const r = indexedDB.open('kontenery', 1);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore('skany', { keyPath: 'id' });
      s.createIndex('numer', 'numer');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction('skany', mode);
      const out = fn(t.objectStore('skany'));
      t.oncomplete = () => res(out && 'result' in out ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: () => tx('readonly', (s) => s.getAll()),
    put: (v) => tx('readwrite', (s) => s.put(v)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
  };
})();

const supabaseRemote = (() => {
  const H = () => ({ apikey: SUPABASE_KEY }); // nowy klucz „publishable” wystarcza w nagłówku apikey
  const ok = async (r) => { if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`); return r; };
  const publicUrl = (name) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${name}`;
  const upload = async (name, blob) => {
    await ok(await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${name}`, {
      method: 'POST', headers: { ...H(), 'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'true' }, body: blob,
    }));
    return publicUrl(name);
  };
  return {
    enabled: () => !!(SUPABASE_URL && SUPABASE_KEY),
    async all() {
      const r = await ok(await fetch(`${SUPABASE_URL}/rest/v1/skany?select=*&order=ts.desc`, { headers: H(), cache: 'no-store' }));
      return r.json();
    },
    async put(rec) {
      const row = { ...rec };
      // zdjęcia idą do magazynu plików, w tabeli zostaje tylko ich adres
      if (rec.zdjecie instanceof Blob) row.zdjecie = await upload(`${rec.id}-foto.jpg`, rec.zdjecie);
      if (rec.miniatura instanceof Blob) row.miniatura = await upload(`${rec.id}-mini.jpg`, rec.miniatura);
      await ok(await fetch(`${SUPABASE_URL}/rest/v1/skany`, {
        method: 'POST',
        headers: { ...H(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      }));
    },
    async del(id) {
      await ok(await fetch(`${SUPABASE_URL}/rest/v1/skany?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: H() }));
      await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
        method: 'DELETE', headers: { ...H(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: [`${id}-foto.jpg`, `${id}-mini.jpg`] }),
      }).catch(() => {});
    },
  };
})();


/* ---------- System firmy (API): kierowca loguje się swoim kontem, skany trafiają do systemu firmy ----------
   Bez logowania aplikacja działa jak dotąd (Supabase). Adres serwera domyślnie = serwer, z którego przyszła
   aplikacja (server.js przekazuje /api do systemu), na GitHub Pages trzeba go wpisać. */
const SYS_KEY = 'kontenery-system';
const sys = (() => {
  let st = {};
  try { st = JSON.parse(localStorage.getItem(SYS_KEY) || '{}'); } catch { /* prywatne okno */ }
  const save = () => { try { localStorage.setItem(SYS_KEY, JSON.stringify(st)); } catch { /* jw. */ } };
  return {
    get on() { return !!st.token; },
    get token() { return st.token; },
    get user() { return st.user || null; },
    get base() { return st.base || ''; },
    set(v) { st = v; save(); },
    clear() { st = { base: st.base }; save(); },
  };
})();
const defaultBase = () => (/github\.io$/.test(location.hostname) ? '' : location.origin);

async function sysFetch(path, { method = 'GET', body, base = sys.base, token = sys.token } = {}) {
  const r = await fetch(base.replace(/\/+$/, '') + path, {
    method, cache: 'no-store',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { sys.clear(); renderAccount(); toast('Sesja wygasła — zaloguj się ponownie'); }
  if (!r.ok) throw new Error(data.error || `Serwer: ${r.status}`);
  return data;
}

const blobToDataUrl = (b) => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); });

const systemRemote = {
  async all() {
    const abs = (u) => (u ? sys.base.replace(/\/+$/, '') + u : null);
    return (await sysFetch('/api/mobile/scans')).map((x) => ({ ...x, zdjecie: abs(x.zdjecie), miniatura: abs(x.miniatura) }));
  },
  async put(rec) {
    const body = { ...rec };
    if (rec.zdjecie instanceof Blob) body.zdjecie = await blobToDataUrl(rec.zdjecie);
    if (rec.miniatura instanceof Blob) body.miniatura = await blobToDataUrl(rec.miniatura);
    if (typeof body.zdjecie === 'string' && !body.zdjecie.startsWith('data:')) delete body.zdjecie; // adres z innej bazy — nie przenosimy
    if (typeof body.miniatura === 'string' && !body.miniatura.startsWith('data:')) delete body.miniatura;
    await sysFetch('/api/mobile/scans', { method: 'POST', body });
  },
  async del(id) { await sysFetch(`/api/mobile/scans/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
};

/** Wspólna baza: system firmy, gdy kierowca jest zalogowany — inaczej Supabase (demo). */
const remote = {
  enabled: () => sys.on || supabaseRemote.enabled(),
  all: () => (sys.on ? systemRemote : supabaseRemote).all(),
  put: (rec) => (sys.on ? systemRemote : supabaseRemote).put(rec),
  del: (id) => (sys.on ? systemRemote : supabaseRemote).del(id),
};

/** Okno logowania do systemu firmy (hasło → ewentualnie kod MFA). */
function openLogin() {
  const d = document.createElement('dialog');
  d.className = 'sys-dialog';
  if (sys.on) {
    const u = sys.user;
    d.innerHTML = `<form method="dialog"><h2>${ic('user')} ${esc(u.first_name)} ${esc(u.last_name)}</h2>
      <p>Zalogowany do systemu firmy <b>${esc(u.tenant_name || '')}</b>.<br>Skany zapisują się na Twoim koncie.</p>
      <p class="muted">${esc(sys.base)}</p>
      <div class="sys-actions"><button value="cancel" class="btn">Zamknij</button><button value="logout" class="btn danger">Wyloguj</button></div></form>`;
    d.addEventListener('close', () => {
      if (d.returnValue === 'logout') { sys.clear(); renderAccount(); toast('Wylogowano — skany idą do bazy demo'); route(); }
      d.remove();
    });
  } else {
    d.innerHTML = `<form><h2>Logowanie do systemu firmy</h2>
      <label>Adres serwera<input name="base" type="url" required placeholder="https://kontenery.twojafirma.pl" value="${esc(sys.base || defaultBase())}"></label>
      <label>E-mail<input name="email" type="email" autocomplete="username" required></label>
      <label>Hasło<input name="password" type="password" autocomplete="current-password" required></label>
      <label class="mfa" hidden>Kod z aplikacji uwierzytelniającej<input name="code" inputmode="numeric" autocomplete="one-time-code"></label>
      <p class="err" hidden></p>
      <div class="sys-actions"><button type="button" class="btn" data-x>Anuluj</button><button class="btn primary">Zaloguj</button></div></form>`;
    const f = d.querySelector('form');
    let mfaToken = null;
    d.querySelector('[data-x]').onclick = () => d.close();
    d.addEventListener('close', () => d.remove());
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = f.querySelector('.err');
      err.hidden = true;
      const base = f.base.value.trim().replace(/\/+$/, '');
      try {
        let r = mfaToken
          ? await sysFetch('/api/auth/mfa/verify', { method: 'POST', base, token: null, body: { mfaToken, code: f.code.value.trim() } })
          : await sysFetch('/api/auth/login', { method: 'POST', base, token: null, body: { email: f.email.value.trim(), password: f.password.value, mobile: true } });
        if (r.mfa === 'verify') { mfaToken = r.mfaToken; f.querySelector('.mfa').hidden = false; f.code.focus(); return; }
        if (r.mfa === 'setup') throw new Error('Firma wymaga MFA — najpierw skonfiguruj je w panelu na komputerze (Mój profil).');
        sys.set({ base, token: r.token, user: r.user });
        d.close();
        renderAccount();
        toast(`Zalogowano: ${r.user.first_name}`);
        route();
      } catch (x) { err.textContent = x.message === 'Failed to fetch' ? 'Brak połączenia z serwerem — sprawdź adres' : x.message; err.hidden = false; }
    };
  }
  document.body.appendChild(d);
  d.showModal();
}

/** Nagłówek: zalogowany kierowca zamiast wyboru imienia z listy. */
function renderAccount() {
  const btn = $('#btn-login');
  const pick = document.querySelector('.user-pick');
  if (sys.on) {
    btn.innerHTML = `${ic('user')} ${esc(sys.user.first_name)}`;
    btn.classList.add('on');
    if (pick) pick.hidden = true;
  } else {
    btn.textContent = 'Zaloguj';
    btn.classList.remove('on');
    if (pick) pick.hidden = false;
  }
}

/** Skany zapisane w telefonie (sprzed bazy albo bez sieci) przenosi do wspólnej bazy. */
let pushing = null;
function pushLocal() {
  return pushing || (pushing = (async () => {
    let n = 0;
    for (const rec of await localDb.all()) { await remote.put(rec); await localDb.del(rec.id); n++; }
    return n;
  })().finally(() => { pushing = null; }));
}

/** Magazyn używany przez aplikację: wspólna baza, a bez niej — telefon. */
const db = {
  shared: false,
  async all() {
    if (remote.enabled()) {
      try {
        const sent = await pushLocal();
        if (sent) toast(`Przesłano do wspólnej bazy skany z tego telefonu: ${sent}`);
        const rows = await remote.all();
        this.shared = true;
        return rows;
      } catch (e) { console.warn(e); this.shared = false; }
    }
    return localDb.all();
  },
  async put(rec) {
    if (remote.enabled()) {
      try { return await remote.put(rec); } catch (e) { console.warn(e); toast('Brak połączenia z bazą — skan zapisany w telefonie, wyślę go później'); }
    }
    return localDb.put(rec);
  },
  async del(id) {
    await localDb.del(id).catch(() => {});
    if (remote.enabled()) await remote.del(id);
  },
};

/* ---------- Pomocnicze ---------- */
const fmtDate = (ts) => new Date(ts).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
const fmtCoord = (n) => n.toFixed(6);
/** Dokładność GPS słownie: „+/- 20 metrów" (z polską odmianą). */
const fmtAcc = (m) => {
  const n = Math.round(m), d = n % 10, dd = n % 100;
  const w = n === 1 ? "metr" : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? "metry" : "metrów";
  return `+/- ${n} ${w}`;
};
const mapsUrl = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
const navUrl = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
const embedUrl = (lat, lng) => `https://maps.google.com/maps?q=${lat},${lng}&z=17&output=embed`;
/** Kolor karty wg typu kontenera (prefiks numeru). */
const accent = (n) => (/^KP5/.test(n) ? 'c-blue' : /^KP7/.test(n) ? 'c-green' : /^KP10/.test(n) ? 'c-orange' : /^\d/.test(n) ? 'c-purple' : 'c-teal');
/** Plakietka z imieniem — każdy użytkownik ma swój kolor. */
const USER_COLORS = { Janek: 'blue', Tomek: 'orange', Karol: 'purple' };
const userTag = (name) => `<span class="user-tag u-${USER_COLORS[String(name).split(' ')[0]] || 'teal'}">${ic('user')}${esc(name)}</span>`;
/** Ikonka z zestawu w index.html. */
const ic = (n) => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const normNumber = (s) => s.toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9\-\/]/g, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2800);
}

const urls = new Set();
function blobUrl(blob) { if (typeof blob === 'string') return blob; const u = URL.createObjectURL(blob); urls.add(u); return u; }
function releaseUrls() { urls.forEach((u) => URL.revokeObjectURL(u)); urls.clear(); }

/* ---------- Obraz: wczytanie, zmniejszenie, przygotowanie pod OCR ---------- */
async function loadBitmap(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fallback niżej */ }
  }
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

function toCanvas(src, maxSide) {
  const w = src.width, h = src.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Skala szarości + rozciągnięcie kontrastu; invert=true dla jasnego napisu na ciemnym tle. */
function prepareForOcr(src, invert, center) {
  let c = toCanvas(src, 1600);
  if (center) { // środek kadru (70% × 50%) — mniej tła, które myli wykrywanie układu tekstu
    const cc = document.createElement('canvas');
    cc.width = Math.round(c.width * 0.7); cc.height = Math.round(c.height * 0.5);
    cc.getContext('2d').drawImage(c, c.width * 0.15, c.height * 0.25, cc.width, cc.height, 0, 0, cc.width, cc.height);
    c = cc;
  }
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = g;
    if (g < min) min = g; if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    let v = ((d[i] - min) * 255) / range;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const canvasToBlob = (c, q = 0.72) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));

/* ---------- Rozpoznawanie numeru ---------- */
let tesseractReady;
function loadTesseract() {
  return tesseractReady || (tesseractReady = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = () => res(window.Tesseract);
    s.onerror = () => { tesseractReady = null; rej(new Error('Nie udało się pobrać modułu OCR (brak internetu?)')); };
    document.head.appendChild(s);
  }));
}

let workerPromise;
async function getWorker(onProgress) {
  const T = await loadTesseract();
  if (!workerPromise) {
    workerPromise = (async () => {
      const w = await T.createWorker('eng', 1, {
        logger: (m) => window.__ocrLogger && window.__ocrLogger(m),
      });
      await w.setParameters({
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/',
        tessedit_pageseg_mode: '11', // tekst rozproszony — napisy w różnych miejscach zdjęcia
      });
      return w;
    })().catch((e) => { workerPromise = null; throw e; });
  }
  window.__ocrLogger = onProgress;
  return workerPromise;
}

/**
 * Wyciąga kandydatów na numer: ciągi z co najmniej 2 cyframi, ocenione po pewności i długości.
 * Zwraca [{ text, box }] — box to położenie napisu na zdjęciu (do wycinka nad polem numeru).
 * toPhoto przelicza współrzędne z obrazu podanego do OCR na współrzędne oryginalnego zdjęcia.
 */
function extractCandidates(data, toPhoto = (b) => b) {
  const found = new Map();
  const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
  const add = (raw, conf, bbox) => {
    const t = normNumber(raw).replace(/^[-\/]+|[-\/]+$/g, '');
    const digits = (t.match(/\d/g) || []).length;
    if (t.length < 2 || t.length > 14 || digits < 2) return;
    const score = conf + digits * 6 + Math.min(t.length, 8) * 2;
    if (!found.has(t) || found.get(t).score < score) found.set(t, { score, box: bbox ? toPhoto(bbox) : null });
  };
  const lines = (data.lines || []);
  for (const line of lines) {
    const words = line.words || [];
    // wiersz z numerem telefonu (9+ cyfr, np. „Wynajmij kontener: 666 200 990”) to nie numer kontenera
    if (((line.text || '').match(/\d/g) || []).length >= 9) continue;
    words.forEach((w) => add(w.text, w.confidence, w.bbox));
    // sąsiednie słowa sklejone (np. "KP 1234" → "KP1234")
    for (let i = 0; i < words.length - 1; i++) {
      add(words[i].text + words[i + 1].text, (words[i].confidence + words[i + 1].confidence) / 2 - 4,
        words[i].bbox && words[i + 1].bbox ? union(words[i].bbox, words[i + 1].bbox) : null);
    }
  }
  if (!lines.length && data.text) data.text.split(/\s+/).forEach((t) => add(t, 50, null));
  return [...found.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 5).map(([text, v]) => ({ text, box: v.box }));
}

/**
 * Wycinek zdjęcia z numerem — widoczny nad polem numeru także wtedy, gdy klawiatura zasłoni resztę ekranu.
 * Bez położenia napisu pokazuje środkowy pas zdjęcia (tam zwykle jest numer).
 */
function renderCrop(box) {
  const img = $('#number-crop');
  const src = draft && draft.bitmap;
  if (!src) { img.hidden = true; return; }
  const W = src.width, H = src.height;
  let x0, y0, x1, y1;
  if (box) {
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    x0 = box.x0 - bw * 0.35; x1 = box.x1 + bw * 0.35;
    y0 = box.y0 - bh * 0.9; y1 = box.y1 + bh * 0.9;
  } else {
    x0 = W * 0.05; x1 = W * 0.95; y0 = H * 0.3; y1 = H * 0.7;
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
  const cw = x1 - x0, ch = y1 - y0;
  if (cw < 4 || ch < 4) { img.hidden = true; return; }
  const k = Math.min(1, 900 / cw);
  const c = document.createElement('canvas');
  c.width = Math.round(cw * k); c.height = Math.round(ch * k);
  c.getContext('2d').drawImage(src, x0, y0, cw, ch, 0, 0, c.width, c.height);
  img.src = c.toDataURL('image/jpeg', 0.85);
  img.hidden = false;
}

async function tryQr(bitmap) {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const det = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'data_matrix'] });
    const codes = await det.detect(bitmap);
    if (!codes.length) return null;
    const r = codes[0].boundingBox;
    return { text: normNumber(codes[0].rawValue), box: r ? { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height } : null };
  } catch { return null; }
}

/* ---------- Lokalizacja ---------- */
const gps = {
  watchId: null,
  best: null,
  start() {
    this.stop();
    this.best = null;
    renderGps('Pobieram współrzędne…');
    if (!('geolocation' in navigator)) return renderGps('Ta przeglądarka nie udostępnia lokalizacji.');
    if (!window.isSecureContext) return renderGps('Lokalizacja wymaga połączenia HTTPS.');
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        const c = p.coords;
        if (!this.best || c.accuracy <= this.best.accuracy) {
          this.best = { lat: c.latitude, lng: c.longitude, accuracy: Math.round(c.accuracy), ts: p.timestamp };
          renderGps();
        }
        if (c.accuracy <= 10) this.stop(); // wystarczająco dokładnie — oszczędzamy baterię
      },
      (e) => renderGps(e.code === 1 ? 'Brak zgody na lokalizację — zezwól w ustawieniach przeglądarki.' : 'Nie udało się ustalić pozycji: ' + e.message),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  },
  stop() { if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId); this.watchId = null; },
};

function renderGps(msg) {
  const b = gps.best;
  if (b) {
    $('#gps-status').textContent = `Dokładność ${fmtAcc(b.accuracy)}` + (gps.watchId != null ? ' · doprecyzowuję…' : '');
    $('#gps-coords').innerHTML = `${fmtCoord(b.lat)}, ${fmtCoord(b.lng)} · <a href="${mapsUrl(b.lat, b.lng)}" target="_blank" rel="noopener">Mapy Google</a>`;
    showGpsMap(b);
  } else {
    $('#gps-status').textContent = msg || '';
    $('#gps-coords').textContent = '';
    $('#gps-map').hidden = true;
  }
  updateSaveButton();
}

/* Mapka przy skanie: pinezka w miejscu kontenera + krąg dokładności GPS (Leaflet, ładowany przy pierwszym użyciu) */
let gpsMap, gpsPin, gpsCircle;
async function showGpsMap(b) {
  let L;
  try { L = await loadLeaflet(); } catch { return; } // bez internetu — zostają same współrzędne
  const box = $('#gps-map');
  box.hidden = false;
  if (!gpsMap) {
    gpsMap = L.map(box, { zoomControl: false, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(gpsMap);
    gpsCircle = L.circle([b.lat, b.lng], { radius: b.accuracy, color: '#2f6fe4', weight: 1, fillColor: '#2f6fe4', fillOpacity: 0.12 }).addTo(gpsMap);
    gpsPin = L.circleMarker([b.lat, b.lng], { radius: 10, color: '#fff', weight: 3, fillColor: '#14a37f', fillOpacity: 1 }).addTo(gpsMap);
  }
  gpsMap.invalidateSize();
  gpsPin.setLatLng([b.lat, b.lng]);
  gpsCircle.setLatLng([b.lat, b.lng]).setRadius(b.accuracy);
  gpsMap.setView([b.lat, b.lng], b.accuracy > 60 ? 16 : 17);
}

/* ---------- Ekran dodawania ---------- */
let draft = null; // { photo: Blob, thumb: Blob }
let ocrRun = 0;

function resetAdd() {
  draft = null;
  $('#photo-preview').hidden = true;
  $('#photo-preview').removeAttribute('src');
  $('#photo-hint').hidden = false;
  $('#photo-actions').hidden = true;
  $('#photo-input').value = '';
  $('#number').value = '';
  $('#candidates').innerHTML = '';
  $('#number-crop').hidden = true;
  $('#number-crop').removeAttribute('src');
  $('#ocr-status').textContent = 'Zrób zdjęcie — numer zostanie odczytany automatycznie.';
  $('#ocr-progress').hidden = true;
  updateSaveButton();
}

function updateSaveButton() {
  $('#btn-save').disabled = !normNumber($('#number').value);
}

function setProgress(p) {
  $('#ocr-progress').hidden = p == null;
  $('#ocr-progress > div').style.width = `${Math.round((p || 0) * 100)}%`;
}

function showCandidates(list) {
  const box = $('#candidates');
  box.innerHTML = '';
  list.forEach(({ text, box: where }, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip' + (i === 0 ? ' active' : ''); b.textContent = text;
    b.onclick = () => {
      $('#number').value = text; updateSaveButton();
      box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
      renderCrop(where); // wycinek pokazuje, skąd wzięła się ta propozycja
    };
    box.appendChild(b);
  });
  renderCrop(list[0] && list[0].box);
}

async function onPhoto(file) {
  if (!file) return;
  const run = ++ocrRun;
  const bitmap = await loadBitmap(file);
  const view = toCanvas(bitmap, 1280);
  draft = { photo: await canvasToBlob(view, 0.72), thumb: await canvasToBlob(toCanvas(bitmap, 200), 0.7), bitmap };
  const prev = $('#photo-preview');
  prev.src = blobUrl(draft.photo); prev.hidden = false; $('#photo-hint').hidden = true; $('#photo-actions').hidden = false;
  if (!gps.best && gps.watchId == null) gps.start();

  $('#candidates').innerHTML = '';
  renderCrop(null); // od razu środek zdjęcia — zanim OCR skończy, można już wpisywać
  // 1) Kod QR / kreskowy — jeśli jest na kontenerze, to odczyt pewny
  const qr = await tryQr(bitmap);
  if (qr) {
    $('#number').value = qr.text; showCandidates([qr]); updateSaveButton();
    $('#ocr-status').textContent = 'Odczytano z kodu QR / kreskowego.';
    return;
  }
  // 2) OCR nadrukowanych cyfr
  $('#ocr-status').textContent = 'Rozpoznaję numer na zdjęciu…';
  setProgress(0.02);
  try {
    const w = await getWorker((m) => {
      if (run !== ocrRun) return;
      if (m.status === 'recognizing text') setProgress(m.progress);
      else if (/load|initializ/.test(m.status)) $('#ocr-status').textContent = 'Przygotowuję rozpoznawanie (pierwszy raz trwa dłużej)…';
    });
    // kolejne próby, aż któraś da wynik: całe zdjęcie, negatyw, środek kadru, środek w negatywie
    // tryb 11 = tekst rozproszony po całym zdjęciu; tryb 6 = zwarty blok (lepszy dla dużego numeru na środku)
    const passes = [
      [false, false, '11', ''],
      [true, false, '11', 'Próbuję jeszcze raz (jasny napis na ciemnym tle)…'],
      [false, true, '11', 'Szukam numeru na środku kadru…'],
      [true, true, '11', 'Szukam numeru na środku kadru…'],
      [false, true, '6', 'Jeszcze jedna próba…'],
      [true, true, '6', 'Ostatnia próba…'],
    ];
    let cands = [];
    for (const [invert, center, psm, msg] of passes) {
      if (run !== ocrRun) return;
      if (msg) $('#ocr-status').textContent = msg;
      await w.setParameters({ tessedit_pageseg_mode: psm });
      const res = await w.recognize(prepareForOcr(bitmap, invert, center));
      // przeliczenie współrzędnych: obraz do OCR był zmniejszony (k) i ewentualnie przycięty do środka
      const k = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const offX = center ? Math.round(bitmap.width * k) * 0.15 : 0;
      const offY = center ? Math.round(bitmap.height * k) * 0.25 : 0;
      const toPhoto = (b) => ({ x0: (b.x0 + offX) / k, y0: (b.y0 + offY) / k, x1: (b.x1 + offX) / k, y1: (b.y1 + offY) / k });
      cands = extractCandidates(res.data, toPhoto);
      if (cands.length) break;
    }
    if (run !== ocrRun) return;
    setProgress(null);
    if (cands.length) {
      if (!$('#number').value) $('#number').value = cands[0].text;
      showCandidates(cands);
      $('#ocr-status').textContent = 'Sprawdź odczyt. Jeśli jest błędny — wybierz inną propozycję albo popraw ręcznie.';
    } else {
      $('#ocr-status').textContent = 'Nie znaleziono numeru na zdjęciu — wpisz go ręcznie albo zrób zdjęcie bliżej.';
      $('#number').focus();
    }
  } catch (e) {
    setProgress(null);
    $('#ocr-status').textContent = (e && e.message ? e.message : 'Błąd rozpoznawania') + ' — wpisz numer ręcznie.';
  }
  updateSaveButton();
}

async function save() {
  const numer = normNumber($('#number').value);
  if (!numer) return;
  const b = gps.best;
  const rec = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
    numer,
    ts: Date.now(),
    lat: b ? b.lat : null,
    lng: b ? b.lng : null,
    accuracy: b ? b.accuracy : null,
    uzytkownik: currentUser() || null,
    zdjecie: draft ? draft.photo : null,
    miniatura: draft ? draft.thumb : null,
  };
  await db.put(rec);
  gps.stop();
  toast(b ? `Zapisano ${numer}` : `Zapisano ${numer} (bez lokalizacji)`);
  location.hash = '#/'; // po zapisie wracamy na ekran główny (lista kontenerów)
}

/* ---------- Lista i szczegóły ---------- */
async function grouped() {
  const all = await db.all();
  const map = new Map();
  for (const r of all) {
    if (!map.has(r.numer)) map.set(r.numer, []);
    map.get(r.numer).push(r);
  }
  for (const list of map.values()) list.sort((a, b) => b.ts - a.ts);
  return [...map.entries()].sort((a, b) => b[1][0].ts - a[1][0].ts);
}

async function renderList() {
  releaseUrls();
  const groups = await grouped();
  const ul = $('#list');
  ul.innerHTML = '';
  $('#list-empty').hidden = groups.length > 0;
  const scansTotal = groups.reduce((n, [, s]) => n + s.length, 0);
  const located = groups.filter(([, s]) => s[0].lat != null).length;
  $('#stats').innerHTML = `
    <div class="stat s-green"><b>${groups.length}</b><span>kontenerów</span></div>
    <div class="stat s-blue"><b>${located}</b><span>z lokalizacją</span></div>
    <div class="stat s-orange"><b>${scansTotal}</b><span>skanów</span></div>`;
  for (const [numer, scans] of groups) {
    const last = scans[0];
    const withImg = scans.find((s) => s.miniatura);
    const li = document.createElement('li');
    li.className = 'card ' + accent(numer);
    li.innerHTML = `
      ${withImg ? `<img src="${blobUrl(withImg.miniatura)}" alt="">` : `<div class="noimg">${ic('box')}</div>`}
      <div class="grow">
        <div class="num">${esc(numer)}</div>
        <div class="meta">${ic('clock')} ${fmtDate(last.ts)}${last.uzytkownik ? ` ${userTag(last.uzytkownik)}` : ''}${scans.length > 1 ? ` · skanów: ${scans.length}` : ''}</div>
        <div class="meta">${last.lat != null ? `${ic('pin')} ${fmtCoord(last.lat)}, ${fmtCoord(last.lng)}` : `${ic('alert')} brak lokalizacji`}</div>
      </div>
      <span class="go">${ic('next')}</span>`;
    li.onclick = () => (location.hash = '#/container/' + encodeURIComponent(numer));
    ul.appendChild(li);
  }
}

async function renderDetail(numer) {
  releaseUrls();
  const scans = (await grouped()).find(([n]) => n === numer)?.[1];
  const box = $('#detail');
  if (!scans) { box.innerHTML = '<p class="muted">Nie znaleziono kontenera.</p>'; return; }
  const last = scans[0];
  const photo = scans.find((s) => s.zdjecie);
  const has = last.lat != null;
  box.innerHTML = `
    <div class="view">
      <div class="hero ${accent(numer)}">
        ${photo ? `<img class="detail-photo" src="${blobUrl(photo.zdjecie)}" alt="Zdjęcie kontenera">` : ''}
        <div class="hero-num">${esc(numer)}</div>
      </div>
      <div class="panel">
        <div class="panel-title"><span class="dot d-blue">${ic('pin')}</span>Lokalizacja</div>
        <dl class="kv">
          <dt>Ostatni skan</dt><dd>${fmtDate(last.ts)}</dd>
          ${last.uzytkownik ? `<dt>Wpisał</dt><dd>${userTag(last.uzytkownik)}</dd>` : ''}
          <dt>Szerokość</dt><dd class="coords">${has ? fmtCoord(last.lat) : '—'}</dd>
          <dt>Długość</dt><dd class="coords">${has ? fmtCoord(last.lng) : '—'}</dd>
          <dt>Dokładność</dt><dd>${has ? fmtAcc(last.accuracy) : '—'}</dd>
        </dl>
      </div>
      ${has ? `
        <a class="btn btn-primary btn-big" href="${mapsUrl(last.lat, last.lng)}" target="_blank" rel="noopener">${ic('map')} Pokaż w Mapach Google</a>
        <div class="row">
          <a class="btn btn-soft-blue" href="${navUrl(last.lat, last.lng)}" target="_blank" rel="noopener">${ic('nav')} Nawiguj</a>
        </div>
        <iframe class="map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${embedUrl(last.lat, last.lng)}" title="Mapa"></iframe>
      ` : '<p class="muted">Ten skan nie ma lokalizacji.</p>'}
      <div class="panel">
        <div class="panel-title"><span class="dot d-orange">${ic('clock')}</span>Historia skanów (${scans.length})</div>
        <ul class="history">
          ${scans.map((s) => `<li><span>${fmtDate(s.ts)}${s.uzytkownik ? ` ${userTag(s.uzytkownik)}` : ''}</span><span>${s.lat != null
            ? `<a href="${mapsUrl(s.lat, s.lng)}" target="_blank" rel="noopener">${fmtCoord(s.lat)}, ${fmtCoord(s.lng)}</a>` : 'brak GPS'}</span></li>`).join('')}
        </ul>
      </div>
      <button class="btn btn-danger" id="btn-delete" type="button">${ic('trash')} Usuń kontener z ewidencji</button>
    </div>`;
  const dp = box.querySelector('.detail-photo');
  if (dp) dp.onclick = () => viewer.open([{ src: dp.src, caption: numer }]);
  $('#btn-delete').onclick = async () => {
    const btn = $('#btn-delete');
    if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Dotknij ponownie, aby potwierdzić'; return; }
    for (const s of scans) await db.del(s.id);
    toast(`Usunięto ${numer}`);
    location.hash = '#/';
  };
}

/* ---------- Mapa wszystkich kontenerów (Leaflet + OpenStreetMap, bez klucza i opłat) ---------- */
const LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
const ACCENT_HEX = { 'c-green': '#16a34a', 'c-blue': '#2f6fe4', 'c-orange': '#ea7a1a', 'c-purple': '#8b5cf6', 'c-teal': '#0f9fa8' };
let leafletReady, mapAll, mapLayer;

function loadLeaflet() {
  return leafletReady || (leafletReady = new Promise((res, rej) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = LEAFLET + 'leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = LEAFLET + 'leaflet.js';
    s.onload = () => res(window.L);
    s.onerror = () => { leafletReady = null; rej(new Error('Nie udało się pobrać mapy (brak internetu?)')); };
    document.head.appendChild(s);
  }));
}

async function renderMap() {
  const groups = await grouped();
  const located = groups.filter(([, s]) => s[0].lat != null);
  const missing = groups.length - located.length;
  $('#map-info').textContent = located.length
    ? `Na mapie: ${located.length}` + (missing ? ` · bez lokalizacji: ${missing}` : '')
    : 'Brak kontenerów z lokalizacją — zeskanuj pierwszy.';
  let L;
  try { L = await loadLeaflet(); } catch (e) { $('#map-info').textContent = e.message; return; }
  if (!mapAll) {
    mapAll = L.map('map-all', { zoomControl: true }).setView([52.07, 19.48], 6); // środek Polski
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(mapAll);
  }
  mapAll.invalidateSize();
  if (mapLayer) mapLayer.remove();
  mapLayer = L.featureGroup().addTo(mapAll);
  for (const [numer, scans] of located) {
    const s = scans[0];
    const color = ACCENT_HEX[accent(numer)];
    L.circleMarker([s.lat, s.lng], { radius: 11, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 })
      .bindTooltip(esc(numer), { permanent: located.length <= 15, direction: 'top', offset: [0, -10], className: 'map-label' })
      .bindPopup(`<div class="map-pop">
          <b style="color:${color}">${esc(numer)}</b>
          <div>${ic('clock')} ${fmtDate(s.ts)}</div>
          ${s.uzytkownik ? `<div>${userTag(s.uzytkownik)}</div>` : ''}
          <div>${ic('pin')} ${s.accuracy != null ? fmtAcc(s.accuracy) : ''}</div>
          <div class="map-pop-btns">
            <a href="#/container/${encodeURIComponent(numer)}">Szczegóły</a>
            <a href="${mapsUrl(s.lat, s.lng)}" target="_blank" rel="noopener">Mapy Google</a>
          </div></div>`)
      .addTo(mapLayer);
  }
  if (located.length) mapAll.fitBounds(mapLayer.getBounds(), { padding: [40, 40], maxZoom: 16 });
}

/* ---------- Przykładowe zdjęcia: pokaz na jednym urządzeniu, skan drugim ---------- */
const SAMPLES = [
  ['01-KP7-0123-zielony.jpg', 'KP7-0123', 'czysty napis'],
  ['02-KP10-0457-zolty.jpg', 'KP10-0457', 'ciemny napis na jasnym tle'],
  ['03-KP5-0311-niebieski-brudny.jpg', 'KP5-0311', 'zabrudzony — do poprawki ręcznej'],
  ['04-KP7-0215-z-kodem-QR.jpg', 'KP7-0215', 'z naklejką QR'],
  ['05-1100-0089-pojemnik-szary.jpg', '1100-0089', 'pojemnik 1100 l'],
];

function renderSamples() {
  $('#samples').innerHTML = SAMPLES.map(([f, n, opis], i) => `
    <button class="sample ${accent(n)}" type="button" data-i="${i}">
      <img src="samples/${f}" alt="Kontener ${n}" loading="lazy">
      <span class="sample-cap"><b>${n}</b><small>${opis}</small></span>
    </button>`).join('');
  $('#samples').querySelectorAll('.sample').forEach((b) => (b.onclick = () => viewer.open(SAMPLES.map(([f, n]) => ({ src: 'samples/' + f, caption: n })), Number(b.dataset.i))));
}

/**
 * Pokaz zdjęć na pełnym ekranie z powiększaniem:
 * dwa palce — przybliżanie, jeden palec — przesuwanie (gdy przybliżone) albo zmiana zdjęcia (gdy nie),
 * podwójne dotknięcie — przybliż / oddal w miejscu dotknięcia. Myszą: kółko i podwójne kliknięcie.
 */
const viewer = {
  items: [],
  i: 0,
  lock: null,
  s: 1, x: 0, y: 0,
  async open(items, i = 0) {
    this.items = items; this.i = i; this.render();
    const many = items.length > 1;
    $('#viewer-prev').hidden = !many; $('#viewer-next').hidden = !many;
    $('#viewer').hidden = false;
    try { await $('#viewer').requestFullscreen?.(); } catch { /* nie każdy telefon pozwala */ }
    try { this.lock = await navigator.wakeLock?.request('screen'); } catch { /* ekran może się wygasić */ }
  },
  close() {
    if ($('#viewer').hidden) return;
    $('#viewer').hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.lock?.release().catch(() => {}); this.lock = null;
  },
  step(d) {
    if (this.items.length < 2) return;
    this.i = (this.i + d + this.items.length) % this.items.length; this.render();
  },
  render() {
    const it = this.items[this.i];
    $('#viewer-img').src = it.src;
    $('#viewer-caption').textContent = (this.items.length > 1 ? `${this.i + 1} / ${this.items.length} · ` : '') + (it.caption || '');
    this.zoom(1, 0, 0, false);
  },
  zoom(s, x, y, animate = true) {
    this.s = s; this.x = x; this.y = y;
    const img = $('#viewer-img');
    img.style.transition = animate ? 'transform .2s ease' : 'none';
    img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    $('#viewer-hint').hidden = s > 1;
  },
  /** Powiększenie o współczynnik wokół punktu ekranu (px, py) — ten punkt zostaje w miejscu. */
  zoomAt(newS, px, py, animate) {
    newS = Math.min(6, Math.max(1, newS));
    if (newS === 1) return this.zoom(1, 0, 0, animate);
    const r = $('#viewer').getBoundingClientRect();
    const cx = r.width / 2, cy = r.height / 2;
    const qx = (px - cx - this.x) / this.s, qy = (py - cy - this.y) / this.s; // punkt zdjęcia pod palcem
    this.zoom(newS, px - cx - newS * qx, py - cy - newS * qy, animate);
  },
};

(() => {
  const el = $('#viewer');
  const pts = new Map();
  let start = null, lastTap = { t: 0, x: 0, y: 0 }, moved = false;
  const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.viewer-btn')) return;
    el.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    start = pts.size === 2
      ? { ...mid(), s: viewer.s, tx: viewer.x, ty: viewer.y }
      : { x: e.clientX, y: e.clientY, s: viewer.s, tx: viewer.x, ty: viewer.y, t: Date.now() };
  });
  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && start.d) { // przybliżanie dwoma palcami
      moved = true;
      const m = mid();
      const s = Math.min(6, Math.max(1, start.s * m.d / start.d));
      const r = el.getBoundingClientRect();
      const qx = (start.x - r.width / 2 - start.tx) / start.s, qy = (start.y - r.height / 2 - start.ty) / start.s;
      viewer.zoom(s, m.x - r.width / 2 - s * qx, m.y - r.height / 2 - s * qy, false);
    } else if (pts.size === 1) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 8) moved = true;
      if (viewer.s > 1) viewer.zoom(viewer.s, start.tx + dx, start.ty + dy, false); // przesuwanie
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (pts.size === 1) { // zostaje jeden palec — dalej przesuwa od bieżącego miejsca
      const [q] = [...pts.values()];
      start = { x: q.x, y: q.y, s: viewer.s, tx: viewer.x, ty: viewer.y, t: Date.now() };
      return;
    }
    if (viewer.s < 1.05) viewer.zoom(1, 0, 0);
    if (!start || start.d) { start = null; return; }
    const dx = p.x - start.x;
    if (viewer.s === 1 && moved && Math.abs(dx) > 60 && Date.now() - start.t < 600) viewer.step(dx < 0 ? 1 : -1); // przesunięcie = zmiana zdjęcia
    if (!moved) { // podwójne dotknięcie: przybliż / oddal
      const now = Date.now();
      if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) {
        if (viewer.s > 1) viewer.zoom(1, 0, 0); else viewer.zoomAt(2.5, p.x, p.y, true);
        lastTap.t = 0;
      } else lastTap = { t: now, x: p.x, y: p.y };
    }
    start = null;
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', (e) => { e.preventDefault(); viewer.zoomAt(viewer.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY, false); }, { passive: false });
})();

$('#viewer-close').onclick = () => viewer.close();
$('#viewer-prev').onclick = (e) => { e.stopPropagation(); viewer.step(-1); };
$('#viewer-next').onclick = (e) => { e.stopPropagation(); viewer.step(1); };
document.addEventListener('keydown', (e) => {
  if ($('#viewer').hidden) return;
  if (e.key === 'ArrowRight') viewer.step(1);
  else if (e.key === 'ArrowLeft') viewer.step(-1);
  else if (e.key === 'Escape') viewer.close();
});
// Wyjście z pełnego ekranu (np. gest „wstecz”) zamyka pokaz — ale tylko gdy pełny ekran faktycznie był włączony.
let wasFullscreen = false;
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) { wasFullscreen = true; return; }
  if (wasFullscreen) { wasFullscreen = false; viewer.close(); }
});

/* ---------- Nawigacja (adresy po angielsku) ---------- */
function show(id, title, back) {
  viewer.close();
  ['#view-list', '#view-add', '#view-detail', '#view-map', '#view-samples'].forEach((v) => ($(v).hidden = v !== id));
  $('#title').textContent = title;
  $('#btn-back').hidden = !back;
  window.scrollTo(0, 0);
}

function route() {
  const h = location.hash || '#/';
  if (h === '#/scan') {
    show('#view-add', 'Nowy skan', true);
    resetAdd();
    if (gps.watchId == null) gps.start(); else renderGps('Pobieram współrzędne…');
    if (pendingPhoto) { const f = pendingPhoto; pendingPhoto = null; onPhoto(f); }
    return;
  }
  gps.stop();
  if (h === '#/samples') {
    show('#view-samples', 'Przykładowe zdjęcia', true);
    renderSamples();
    return;
  }
  if (h === '#/map') {
    show('#view-map', 'Mapa kontenerów', true);
    renderMap();
    return;
  }
  const m = h.match(/^#\/container\/(.+)$/);
  if (m) {
    const numer = decodeURIComponent(m[1]);
    show('#view-detail', numer, true);
    renderDetail(numer);
    return;
  }
  show('#view-list', 'Kontenery', false);
  renderList();
}

/* ---------- Start ---------- */
// „Zdjęcie kontenera”: od razu aparat (bez pustego formularza). GPS rusza w tym samym momencie,
// więc po zrobieniu zdjęcia formularz ma już zdjęcie i zwykle także lokalizację.
let pendingPhoto = null;
$('#btn-add').onclick = () => {
  if (gps.watchId == null) gps.start();
  $('#photo-input').value = '';
  $('#photo-input').click();
};
$('#photo-input').addEventListener('cancel', () => { if (location.hash !== '#/scan') gps.stop(); });
$('#btn-back').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/'));
$('#photo-input').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (location.hash === '#/scan') return onPhoto(file);
  pendingPhoto = file; // zdjęcie zrobione z ekranu głównego — formularz otworzy się już z nim
  location.hash = '#/scan';
};
// Po wysunięciu klawiatury przewijamy panel numeru pod górny pasek — wycinek zdjęcia i pole są wtedy razem widoczne.
function keepNumberVisible() {
  if (document.activeElement !== $('#number')) return;
  $('#number-panel').scrollIntoView({ block: 'start' });
}
// Zapas miejsca pod treścią na czas wpisywania — bez niego krótka strona nie da się przewinąć.
$('#number').addEventListener('focus', () => { document.body.classList.add('typing'); setTimeout(keepNumberVisible, 350); });
$('#number').addEventListener('blur', () => document.body.classList.remove('typing'));
if (window.visualViewport) window.visualViewport.addEventListener('resize', keepNumberVisible);
$('#number').oninput = () => { updateSaveButton(); $('#candidates').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.textContent === normNumber($('#number').value))); };
$('#btn-gps').onclick = () => gps.start();
// Powiększanie: dotknięcie zdjęcia otwiera je na pełnym ekranie (zamiast ponownie uruchamiać aparat)
$('#photo-preview').addEventListener('click', (e) => { e.preventDefault(); viewer.open([{ src: $('#photo-preview').src, caption: 'Zdjęcie kontenera' }]); });
$('#btn-retake').onclick = () => $('#photo-input').click();
$('#number-crop').onclick = () => viewer.open([{ src: $('#number-crop').src, caption: 'Fragment z numerem' }]);
$('#btn-save').onclick = save;
window.addEventListener('hashchange', route);

// Lista odświeża się sama: skan zrobiony na innym telefonie pojawia się po kilku sekundach
let listSig = '';
setInterval(async () => {
  if (document.hidden || !remote.enabled() || (location.hash || '#/') !== '#/') return;
  try {
    const rows = await remote.all();
    const sig = rows.map((r) => r.id).join(',');
    if (listSig && sig !== listSig) renderList();
    listSig = sig;
  } catch { /* chwilowy brak sieci */ }
}, 5000);

const onlineState = () => ($('#online').textContent = navigator.onLine ? '' : '● offline');
window.addEventListener('online', onlineState);
window.addEventListener('offline', onlineState);
onlineState();


// Numer wersji — po dotknięciu plakietki „demo” (lokalnie z API, na GitHub Pages z version.json)
$('#btn-version').onclick = async () => {
  const get = (u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject()));
  try { const c = await get('api/config').catch(() => get('version.json')); toast('Wersja ' + c.wersja); }
  catch { toast('Wersja nieznana (brak połączenia)'); }
};

// Użytkownik wykonujący wpisy — wybór zapamiętany na tym urządzeniu
const USER_KEY = 'kontenery-uzytkownik';
function currentUser() { return sys.on ? `${sys.user.first_name} ${sys.user.last_name}`.trim() : $('#user').value; }
try { $('#user').value = localStorage.getItem(USER_KEY) || ''; } catch { /* prywatne okno — bez zapamiętywania */ }
$('#user').onchange = () => {
  try { localStorage.setItem(USER_KEY, currentUser()); } catch { /* jw. */ }
  toast(currentUser() ? `Wpisy będą podpisane: ${currentUser()}` : 'Wpisy bez podpisu');
};

$('#btn-login').onclick = openLogin;
renderAccount();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
