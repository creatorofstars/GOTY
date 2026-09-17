/* 音效模块：Web Audio 合成 MIDI 风格音效与循环BGM（无外部音频文件） */
const SFX = (() => {
  let ctx = null, bgmOn = true, bgmTimer = null, step = 0;

  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // 单音：freq频率 dur时长 type波形 vol音量 when延迟 slide滑音
  function tone(freq, dur, type = 'square', vol = 0.12, when = 0, slide = 0) {
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

  const fx = {
    click()   { tone(880, .06, 'square', .07); },
    shoot()   { tone(320, .3, 'sawtooth', .13, 0, -270); },
    explode() { noise(.55, .35); tone(90, .45, 'triangle', .22, 0, -55); },
    charge()  { tone(220, .12, 'square', .07); },
    tick()    { tone(1200, .05, 'square', .08); },
    turn()    { tone(660, .09, 'square', .1); tone(880, .13, 'square', .1, .1); },
    hit()     { tone(150, .16, 'square', .18, 0, -85); },
    attack()  { tone(120, .2, 'sawtooth', .16, 0, -60); noise(.12, .12); },
    kill()    { tone(523, .08, 'square', .12); tone(659, .08, 'square', .12, .08); tone(784, .16, 'square', .12, .16); },
    join()    { tone(587, .08, 'square', .08); tone(880, .1, 'square', .08, .08); },
    win()     { [523, 659, 784, 1046].forEach((f, i) => tone(f, .18, 'square', .14, i * .15)); },
    lose()    { [420, 360, 300, 180].forEach((f, i) => tone(f, .26, 'sawtooth', .12, i * .2)); },
  };

  // 钢琴音色：多层正弦泛音 + 指数衰减
  function piano(freq, dur, vol = 0.09, when = 0) {
    const c = ac();
    [[1, 1], [2, 0.4], [3, 0.14], [4.01, 0.06]].forEach(([mult, amp]) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq * mult, c.currentTime + when);
      g.gain.setValueAtTime(vol * amp, c.currentTime + when);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + when + dur);
      o.connect(g); g.connect(c.destination);
      o.start(c.currentTime + when);
      o.stop(c.currentTime + when + dur + 0.05);
    });
  }

  // BGM：钢琴曲 —— 卡农式和弦分解（C-G-Am-Em-F-C-F-G），低音铺底
  const CHORDS = [
    [261.63, 329.63, 392.00, 523.25], // C
    [392.00, 493.88, 587.33, 783.99], // G
    [440.00, 523.25, 659.25, 880.00], // Am
    [329.63, 392.00, 493.88, 659.25], // Em
    [349.23, 440.00, 523.25, 698.46], // F
    [261.63, 329.63, 392.00, 523.25], // C
    [349.23, 440.00, 523.25, 698.46], // F
    [392.00, 493.88, 587.33, 783.99], // G
  ];
  const ARP = [0, 1, 2, 3, 2, 1, 2, 3]; // 分解和弦指法

  function bgmStep() {
    if (!bgmOn || !ctx) return;
    try {
      const bar = Math.floor(step / ARP.length) % CHORDS.length;
      const chord = CHORDS[bar];
      const note = chord[ARP[step % ARP.length]];
      piano(note, 1.4, 0.07);                    // 旋律分解音
      if (step % ARP.length === 0) {
        piano(chord[0] / 2, 2.2, 0.05);          // 低音根音
        noise(.03, .02);                          // 轻节拍
      }
      step++;
    } catch (e) { /* ignore */ }
  }

  return {
    init() {
      ac();
      if (!bgmTimer) bgmTimer = setInterval(bgmStep, 300);
    },
    play(n) { try { fx[n] && fx[n](); } catch (e) { /* ignore */ } },
    toggleBgm() { bgmOn = !bgmOn; return bgmOn; },
  };
})();
