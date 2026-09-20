/* 音效模块：Web Audio 合成音效 + 音频文件BGM（无外部音频文件的音效部分） */
const SFX = (() => {
  let ctx = null, bgmOn = false, bgmStyle = 'lobby'; // 默认关闭，由开场的音乐询问决定
  let muted = false; // 总静音：关闭后所有BGM与音效均不发声，仅由界面按钮重新开启

  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // 单音：freq频率 dur时长 type波形 vol音量 when延迟 slide滑音
  function tone(freq, dur, type = 'square', vol = 0.12, when = 0, slide = 0) {
    if (muted) return;
    const c = ac();
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, c.currentTime + when);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), c.currentTime + when + dur);
    g.gain.setValueAtTime(vol, c.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + when + dur);
    o.connect(g); g.connect(c.destination);
    o.start(c.currentTime + when);
    o.stop(c.currentTime + when + dur + 0.02);
  }

  // 噪声：爆炸/打击
  function noise(dur, vol = 0.3, when = 0) {
    if (muted) return;
    const c = ac();
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, c.currentTime + when);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + when + dur);
    src.connect(g); g.connect(c.destination);
    src.start(c.currentTime + when);
  }

  // 播放一次性音频文件
  function sample(src, vol = 0.55) {
    if (muted) return;
    try {
      const a = new Audio(src);
      a.volume = vol;
      a.play().catch(() => {});
    } catch (e) { /* ignore */ }
  }

  const fx = {
    click()   { tone(880, .06, 'square', .07); },
    charge()  { tone(220, .12, 'square', .07); },
    tick()    { tone(1200, .05, 'square', .08); },
    turn()    { tone(660, .09, 'square', .1); tone(880, .13, 'square', .1, .1); },
    attack()  { tone(120, .2, 'sawtooth', .16, 0, -60); noise(.12, .12); },
    kill()    { tone(523, .08, 'square', .12); tone(659, .08, 'square', .12, .08); tone(784, .16, 'square', .12, .16); },
    join()    { tone(587, .08, 'square', .08); tone(880, .1, 'square', .08, .08); },
    // 角色专属命中音效
    hit0() { noise(.6, .35); tone(75, .5, 'triangle', .24, 0, -45); noise(.25, .15, .08); tone(50, .4, 'sine', .15, .1, -20); },  // 轰侠：主爆+二次余爆+低频震动
    hit1() { noise(.08, .15); tone(320, .1, 'square', .13, 0, -170); tone(140, .14, 'square', .1, .04, -70); noise(.2, .05, .1); }, // 影袭：命中+箭杆震颤尾音
    hit2() { tone(1400, .2, 'sine', .1, 0, -900); tone(950, .26, 'sine', .08, .05, -520); tone(1800, .15, 'sine', .05, .02, -1100); noise(.24, .07); }, // 鹰眼：迸裂碎屑三层下滑
    hit3() { noise(.06, .13); tone(520, .08, 'square', .1, 0, -300); tone(150, .12, 'square', .1, .04, -60); noise(.12, .06, .08); }, // 疾风：钉击+镖身余震
    upgHover() { tone(1750, .04, 'triangle', .07); tone(2350, .03, 'sine', .04, .012); noise(.015, .03); },   // 悬停：清脆咔哒
    upgClick() { tone(1244, .16, 'square', .055); tone(1867, .12, 'square', .045, .005); tone(2489, .22, 'sine', .06); noise(.035, .045); }, // 点击：金铁交鸣
    shoot0()  { tone(150, .3, 'sawtooth', .18, 0, -120); noise(.2, .12); tone(90, .2, 'triangle', .14, .02, -40); tone(500, .07, 'square', .05); }, // 轰侠：炮膛闷响+气浪+机械上膛
    shoot1()  { tone(520, .1, 'triangle', .14, 0, -380); noise(.05, .07); tone(1500, .06, 'sine', .05, .04, -900); }, // 影袭：弓弦回弹+箭矢破空
    shoot2()  { tone(1100, .18, 'sine', .1, 0, 520); tone(1650, .14, 'sine', .07, .04, -430); tone(2200, .1, 'sine', .04, .08, -300); }, // 鹰眼：三段上行魔法泛音
    shoot3()  { noise(.2, .12); tone(820, .14, 'sine', .06, 0, -660); tone(300, .05, 'square', .05); tone(1200, .06, 'sine', .04, .06, -800); }, // 疾风：破风+甩腕
    win()     { sample('/sound/victory.mp3'); },   // 战胜音效（音频文件）
    lose()    { sample('/sound/defeat.m4a'); },    // 战败音效（音频文件）
  };

  // BGM：使用音频文件循环播放（lobby/battle两套）
  const bgmFiles = {
    lobby:  '/sound/bgm_lobby.mp3',
    battle: '/sound/bgm_battle.mp3',
  };
  const bgmEls = {};
  function bgmEl(style) {
    if (!bgmEls[style]) {
      const a = new Audio(bgmFiles[style]);
      a.loop = true;
      a.volume = 0.35;
      bgmEls[style] = a;
    }
    return bgmEls[style];
  }
  function playBgm() {
    if (!bgmOn || muted) return;
    Object.entries(bgmEls).forEach(([k, a]) => { if (k !== bgmStyle) { try { a.pause(); } catch (e) {} } });
    const a = bgmEl(bgmStyle);
    if (a.paused) a.play().catch(() => {}); // 幂等：已在播放则不重播
  }
  function stopBgmAudio() {
    Object.values(bgmEls).forEach(a => { try { a.pause(); } catch (e) {} });
  }

  // 蓄力音：持续振荡器，音调随蓄力进度上升
  let chargeOsc = null, chargeGain = null;
  function startChargeSound() {
    if (muted) return;
    const c = ac();
    stopChargeSound();
    chargeOsc = c.createOscillator(); chargeGain = c.createGain();
    chargeOsc.type = 'sawtooth';
    chargeOsc.frequency.setValueAtTime(180, c.currentTime);
    chargeGain.gain.setValueAtTime(0.0001, c.currentTime);
    chargeGain.gain.linearRampToValueAtTime(0.05, c.currentTime + 0.05);
    chargeOsc.connect(chargeGain); chargeGain.connect(c.destination);
    chargeOsc.start();
  }
  function updateChargeSound(progress) { // progress: 0~1
    if (!chargeOsc || !ctx) return;
    const f = 180 + Math.max(0, Math.min(1, progress)) * 620; // 180 → 800Hz
    try {
      chargeOsc.frequency.linearRampToValueAtTime(f, ctx.currentTime + 0.03);
      chargeGain.gain.setValueAtTime(0.05 + progress * 0.03, ctx.currentTime);
    } catch (e) { /* ignore */ }
  }
  function stopChargeSound() {
    if (chargeOsc) {
      try {
        chargeGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
        chargeOsc.stop(ctx.currentTime + 0.1);
      } catch (e) { /* ignore */ }
      chargeOsc = null; chargeGain = null;
    }
  }

  return {
    init() {
      ac();
      playBgm(); // 首次用户交互后启动BGM（浏览器自动播放策略允许此后播放）
    },
    startChargeSound, updateChargeSound, stopChargeSound,
    /** 切换BGM风格：'lobby'大厅曲 / 'battle'战斗曲 */
    setBgm(style) {
      if (bgmStyle === style) { playBgm(); return; }
      bgmStyle = style;
      playBgm();
    },
    play(n) { try { fx[n] && fx[n](); } catch (e) { /* ignore */ } },
    toggleBgm() { bgmOn = !bgmOn; muted = !bgmOn; if (bgmOn) playBgm(); else stopBgmAudio(); return bgmOn; },
    /** 直接设置音乐开关（不翻转）：关闭时同时总静音全部音效 */
    setBgmOn(v) { bgmOn = v; muted = !v; if (v) playBgm(); else stopBgmAudio(); },
  };
})();
