// The clip shelf: covers standing in a row in 3D, the chosen one facing you, with reflections on the floor.
// Flick through with drag / swipe, the arrow keys, a sideways scroll, the slider, or by clicking a cover.
// The chosen clip plays silently in place (devices with a mouse only). Buttons in the bar carry the same
// data attributes as the grid cards (data-copy, data-clipmenu), so library.js handles them the same way.
import { esc, icon, fmtBytes, fmtDuration, ago, calm } from './common.js';

const SIDE = 7;   // covers shown on each side of the chosen one

export function createShelf(root, { showOwner = false } = {}) {
  root.innerHTML = `
    <div class="shelf-stage" tabindex="0" role="listbox" aria-label="Clips" aria-orientation="horizontal"></div>
    <div class="shelf-cap"><div class="shelf-title"></div><div class="shelf-meta num"></div></div>
    <div class="shelf-bar">
      <button class="icon" type="button" data-step="-1" aria-label="Previous clip">${icon('prev')}</button>
      <input type="range" class="shelf-scroll" min="0" max="0" step="1" value="0" aria-label="Scroll through clips">
      <button class="icon" type="button" data-step="1" aria-label="Next clip">${icon('next')}</button>
      <span class="shelf-acts"></span>
    </div>`;
  const stage = root.querySelector('.shelf-stage'), slider = root.querySelector('.shelf-scroll');
  const title = root.querySelector('.shelf-title'), metaEl = root.querySelector('.shelf-meta'), acts = root.querySelector('.shelf-acts');
  let clips = [], sel = 0, sig = '', els = new Map(), video = null, previewTimer = 0;
  const canHover = matchMedia('(hover: hover)').matches;

  const face = (c) => {
    const src = `/api/clips/${c.id}.jpg`;
    return c.hasThumb
      ? `<span class="cf-face"><img src="${src}" alt="" draggable="false" decoding="async"><span class="dur num">${fmtDuration(c.duration)}</span></span><img class="cf-refl" src="${src}" alt="" draggable="false" decoding="async" aria-hidden="true">`
      : `<span class="cf-face"><span class="ph">${icon('play')}</span><span class="dur num">${fmtDuration(c.duration)}</span></span><span class="cf-refl ph" aria-hidden="true"></span>`;
  };

  function stopPreview() {
    clearTimeout(previewTimer);
    if (video) { video.removeAttribute('src'); video.load(); video.remove(); video = null; }
  }
  function startPreview() {
    stopPreview();
    const c = clips[sel];
    if (!c || !canHover || document.hidden) return;
    previewTimer = setTimeout(() => {
      const host = els.get(c.id)?.querySelector('.cf-face');
      if (!host || clips[sel] !== c) return;
      video = Object.assign(document.createElement('video'), { muted: true, loop: true, playsInline: true, preload: 'auto', src: `/${c.id}.mp4` });
      video.addEventListener('playing', () => video?.classList.add('on'), { once: true });
      host.append(video);
      video.play().catch(() => {});
    }, 700);
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? stopPreview() : startPreview()));

  // where each cover stands, given how far it is from the chosen one
  function place() {
    const w = stage.querySelector('.cf')?.offsetWidth || 0;
    clips.forEach((c, i) => {
      const el = els.get(c.id); if (!el) return;
      const d = i - sel, a = Math.abs(d), s = Math.sign(d);
      el.classList.toggle('sel', d === 0);
      el.classList.toggle('far', a > SIDE);
      el.setAttribute('aria-selected', String(d === 0));
      el.style.zIndex = String(100 - a);
      el.style.transform = d === 0 ? 'translate3d(0,0,0)'
        : `translate3d(${s * (w * 0.78 + (a - 1) * w * 0.24)}px,0,${-w * 0.8}px) rotateY(${-s * 64}deg)`;
    });
  }

  function caption() {
    const c = clips[sel]; if (!c) return;
    title.textContent = c.title; title.title = c.title;
    metaEl.textContent = [`${c.height}p${c.fps || ''}`, fmtBytes(c.size), ago(c.created), showOwner && c.ownerName ? `by ${c.ownerName}` : ''].filter(Boolean).join(' · ');
    acts.innerHTML = `<button class="primary" data-copy="${esc(c.url)}" type="button">${icon('link')}Copy link</button>
      <a class="btn" href="${esc(c.url)}" target="_blank" rel="noopener">${icon('open')}Open</a>
      ${c.sourceGone ? '' : `<a class="btn" href="/edit/${esc(c.sourceId)}?clip=${esc(c.id)}">${icon('edit')}Edit</a>`}
      <button class="icon" data-clipmenu="${esc(c.id)}" type="button" aria-label="More actions" aria-haspopup="menu">${icon('more')}</button>`;
    slider.value = String(sel);
  }

  function select(i, { quiet = false } = {}) {
    i = Math.max(0, Math.min(clips.length - 1, i));
    if (i === sel && !quiet) return;
    sel = i; place(); caption(); startPreview();
  }

  // ---- input ----
  root.addEventListener('click', (e) => { const b = e.target.closest('[data-step]'); if (b) select(sel + Number(b.dataset.step)); });
  slider.addEventListener('input', () => select(Number(slider.value)));
  stage.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft') select(sel - 1); else if (k === 'ArrowRight') select(sel + 1);
    else if (k === 'Home') select(0); else if (k === 'End') select(clips.length - 1);
    else if (k === 'Enter' && clips[sel]) window.open(clips[sel].url, '_blank', 'noopener');
    else return;
    e.preventDefault();
  });
  let wheelAcc = 0;
  stage.addEventListener('wheel', (e) => {   // only a sideways scroll moves the shelf; up/down still scrolls the page
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    if (Math.abs(dx) <= Math.abs(e.shiftKey ? 0 : e.deltaY)) return;
    e.preventDefault();
    wheelAcc += dx;
    if (Math.abs(wheelAcc) > 60) { select(sel + Math.sign(wheelAcc)); wheelAcc = 0; }
  }, { passive: false });
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    drag = { x: e.clientX, from: sel, moved: false, target: e.target.closest('.cf') };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, w = stage.querySelector('.cf')?.offsetWidth || 300;
    if (Math.abs(dx) > 6) drag.moved = true;
    if (drag.moved) select(drag.from - Math.round(dx / (w * 0.3)));
  });
  const up = () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.moved || !d.target) return;
    const i = clips.findIndex((c) => c.id === d.target.dataset.id);
    if (i === sel && clips[i]) window.open(clips[i].url, '_blank', 'noopener');   // the chosen cover opens its page
    else if (i >= 0) select(i);
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', () => { drag = null; });
  new ResizeObserver(place).observe(stage);

  return {
    // Give it the current list. Rebuilds only when something visible changed; keeps the chosen clip chosen, and
    // flies to a clip that is new since last time.
    set(list) {
      const next = list.map((c) => `${c.id}|${c.title}|${c.hasThumb}|${c.size}|${c.sourceGone}`).join('\n');
      if (next === sig) { caption(); return; }
      const first = sig === '', keep = clips[sel]?.id, had = new Set(clips.map((c) => c.id));
      sig = next; clips = list;
      stopPreview();
      stage.innerHTML = clips.map((c) => `<div class="cf" role="option" data-id="${esc(c.id)}" aria-label="${esc(c.title)}">${face(c)}</div>`).join('');
      els = new Map([...stage.children].map((el) => [el.dataset.id, el]));
      slider.max = String(Math.max(0, clips.length - 1));
      const fresh = first ? -1 : clips.findIndex((c) => !had.has(c.id));
      const kept = clips.findIndex((c) => c.id === keep);
      const target = fresh >= 0 ? fresh : kept >= 0 ? kept : Math.min(sel, clips.length - 1);
      if (fresh >= 0 && !calm()) { sel = Math.max(0, kept); place(); void stage.offsetWidth; }   // start where we were, then fly
      select(Math.max(0, target), { quiet: true });
    },
    stop: stopPreview,
    resume: startPreview,
  };
}
