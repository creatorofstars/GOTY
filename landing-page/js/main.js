// ---------- hero sparkles ----------
(function () {
  const hero = document.querySelector('.hero');
  if (!hero) return;
  const COUNT = 16;
  for (let i = 0; i < COUNT; i++) {
    const s = document.createElement('span');
    s.className = 'sparkle';
    s.textContent = '✦';
    s.style.left = (Math.random() * 100) + '%';
    s.style.top = (Math.random() * 92) + '%';
    s.style.fontSize = (8 + Math.random() * 13).toFixed(1) + 'px';
    s.style.animationDelay = (Math.random() * 4).toFixed(2) + 's';
    s.style.animationDuration = (2.6 + Math.random() * 2.8).toFixed(2) + 's';
    hero.appendChild(s);
  }
})();

// ---------- reveal on scroll ----------
(function () {
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    els.forEach(el => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.15 });
  els.forEach(el => io.observe(el));
})();

// ---------- scrollspy for nav ----------
(function () {
  const links = Array.from(document.querySelectorAll('.nav-links a'));
  const sections = links
    .map(a => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);
  if (!('IntersectionObserver' in window)) return;
  const spy = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        links.forEach(l =>
          l.classList.toggle('active', l.getAttribute('href') === '#' + e.target.id));
      }
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  sections.forEach(s => spy.observe(s));
})();

// ---------- feedback form ----------
(function () {
  const form = document.getElementById('feedbackForm');
  if (!form) return;
  const stars = [...form.querySelectorAll('.rate-star')];
  const text = form.querySelector('#fbText');
  const thanks = document.getElementById('fbThanks');
  let rating = 0;

  function paint(n) { stars.forEach((s, i) => s.classList.toggle('on', i < n)); }

  stars.forEach((s, i) => {
    s.addEventListener('mouseenter', () => paint(i + 1));
    s.addEventListener('mouseleave', () => paint(rating));
    s.addEventListener('click', () => { rating = i + 1; paint(rating); });
  });

  text.addEventListener('input', () => text.classList.remove('err'));

  form.addEventListener('submit', e => {
    e.preventDefault();
    const msg = text.value.trim();
    if (!msg) { text.classList.add('err'); text.focus(); return; }
    text.classList.remove('err');

    // wire up to a backend endpoint later — kept local for now
    const entry = {
      name: form.querySelector('#fbName').value.trim(),
      message: msg,
      rating,
      at: new Date().toISOString(),
    };
    try {
      const all = JSON.parse(localStorage.getItem('fb-feedback') || '[]');
      all.push(entry);
      localStorage.setItem('fb-feedback', JSON.stringify(all));
    } catch (err) { /* storage unavailable — still show thanks */ }

    form.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = true; });
    thanks.hidden = false;
  });
})();

// ---------- archer character popup (3D viewer) ----------
(function () {
  const card = document.querySelector('.fighter[data-char="archer"]');
  const modal = document.getElementById('archerModal');
  if (!card || !modal) return;

  const canvas = document.getElementById('charCanvas');
  const loading = document.getElementById('charLoading');
  const fallback = document.getElementById('charFallback');
  let raf = null;
  let api = null;

  function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
  function close() {
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    stopLoop();
  }

  async function startViewer() {
    if (api) { api.start(); return; }
    loading.hidden = false;

    try {
      const THREE = await import('three');
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');

      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
      camera.position.set(0, 1.4, 3.4);

      scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x8a7a5a, 1.5));
      scene.add(new THREE.AmbientLight(0xffffff, 0.55));
      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(2, 4, 3);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x9fd0ff, 1.4);
      rim.position.set(-3, 2, -2);
      scene.add(rim);

      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.autoRotate = true;
      controls.autoRotateSpeed = 1.6;
      controls.target.set(0, 0.9, 0);
      controls.minDistance = 1.5;
      controls.maxDistance = 6;

      new FBXLoader().load('models/archer-3d.fbx', obj => {
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const scale = 1.9 / Math.max(size.x, size.y, size.z);
        obj.scale.setScalar(scale);
        obj.position.sub(center.multiplyScalar(scale));
        scene.add(obj);
        loading.hidden = true;
      }, undefined, () => {
        loading.hidden = true;
        fallback.hidden = false; // model missing → show static art instead
      });

      function resize() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      window.addEventListener('resize', resize);

      function loop() {
        raf = requestAnimationFrame(loop);
        resize();
        controls.update();
        renderer.render(scene, camera);
      }
      api = { start() { if (!raf) loop(); } };
      api.start();
    } catch (err) {
      loading.hidden = true;
      fallback.hidden = false; // CDN/library unavailable → static art
    }
  }

  function open() {
    modal.hidden = false;
    document.body.classList.add('modal-open');
    startViewer();
  }

  card.addEventListener('click', open);
  card.setAttribute('tabindex', '0');
  card.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  modal.querySelector('.char-close').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });
})();

// ---------- mobile menu ----------
(function () {
  const btn = document.querySelector('.menu-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.querySelectorAll('.nav-links a').forEach(a =>
    a.addEventListener('click', () => {
      document.body.classList.remove('nav-open');
      btn.setAttribute('aria-expanded', 'false');
    }));
})();
