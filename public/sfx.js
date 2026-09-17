/* 音效模块：Web Audio 合成 MIDI 风格音效与循环BGM（无外部音频文件） */
const SFX = (() => {
  let ctx = null, bgmOn = true, bgmTimer = null, step = 0, bgmStyle = 'lobby';

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
    // 角色专属命中音效
    hit0() { noise(.6, .35); tone(75, .5, 'triangle', .24, 0, -45); noise(.25, .15, .08); tone(50, .4, 'sine', .15, .1, -20); },  // 轰侠：主爆+二次余爆+低频震动
    hit1() { noise(.08, .15); tone(320, .1, 'square', .13, 0, -170); tone(140, .14, 'square', .1, .04, -70); noise(.2, .05, .1); }, // 影袭：命中+箭杆震颤尾音
    hit2() { tone(1400, .2, 'sine', .1, 0, -900); tone(950, .26, 'sine', .08, .05, -520); tone(1800, .15, 'sine', .05, .02, -1100); noise(.24, .07); }, // 鹰眼：迸裂碎屑三层下滑
    hit3() { noise(.06, .13); tone(520, .08, 'square', .1, 0, -300); tone(150, .12, 'square', .1, .04, -60); noise(.12, .06, .08); }, // 疾风：钉击+镖身余震
    shoot0()  { tone(150, .3, 'sawtooth', .18, 0, -120); noise(.2, .12); tone(90, .2, 'triangle', .14, .02, -40); tone(500, .07, 'square', .05); }, // 轰侠：炮膛闷响+气浪+机械上膛
    shoot1()  { tone(520, .1, 'triangle', .14, 0, -380); noise(.05, .07); tone(1500, .06, 'sine', .05, .04, -900); }, // 影袭：弓弦回弹+箭矢破空
    shoot2()  { tone(1100, .18, 'sine', .1, 0, 520); tone(1650, .14, 'sine', .07, .04, -430); tone(2200, .1, 'sine', .04, .08, -300); }, // 鹰眼：三段上行魔法泛音
    shoot3()  { noise(.2, .12); tone(820, .14, 'sine', .06, 0, -660); tone(300, .05, 'square', .05); tone(1200, .06, 'sine', .04, .06, -800); }, // 疾风：破风+甩腕
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

  // 大厅BGM：钢琴卡农（舒缓）
  function bgmStepLobby() {
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

  // 小提琴声部：三把轻微失谐的锯齿波叠成弦乐合奏，慢起音+弓感衰减
  function violin(freq, dur, vol = 0.055, when = 0) {
    const c = ac();
    [1, 1.006, 0.994].forEach((det, i) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(freq * det, c.currentTime + when);
      g.gain.setValueAtTime(0.0001, c.currentTime + when);
      g.gain.linearRampToValueAtTime(vol * (i === 0 ? 1 : 0.55), c.currentTime + when + 0.03); // 起弓
      g.gain.setValueAtTime(vol * (i === 0 ? 1 : 0.55), c.currentTime + when + dur * 0.65);    // 运弓保持
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + when + dur);                  // 收弓
      o.connect(g); g.connect(c.destination);
      o.start(c.currentTime + when);
      o.stop(c.currentTime + when + dur + 0.05);
    });
  }
  const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // PVE战斗BGM：昂扬的小提琴主旋律 + 弦乐固定音型伴奏 + 打击乐
  const LEAD = [
    69, 0, 72, 0,  76, 0, 77, 76,   74, 0, 72, 0,  74, 76, 74, 72,
    77, 0, 76, 0,  81, 0, 79, 77,   76, 0, 74, 0,  72, 0, 69, 0,
  ];
  const OST = [
    45, 57, 45, 57,  52, 64, 52, 64,  41, 53, 41, 53,  43, 55, 43, 55,
  ];
  function bgmStepBattle() {
    if (!bgmOn || !ctx) return;
    try {
      const c32 = step % 32, c16 = step % 16;
      const lead = LEAD[c32];
      if (lead && LEAD[(c32 + 1) % 32] === 0) violin(midi(lead), 0.34, 0.06);       // 长音拉弓
      else if (lead) violin(midi(lead), 0.16, 0.05);                                 // 短促断奏
      violin(midi(OST[c16]) / 2, 0.13, 0.028);                                       // 弦乐伴奏固定音型
      if (c16 % 8 === 0) { tone(90, .1, 'triangle', .2, 0, -50); noise(.06, .1); }   // 底鼓
      else if (c16 % 8 === 4) { noise(.08, .12); tone(200, .04, 'square', .04); }    // 军鼓
      noise(.02, .03);                                                               // 闭镲
      step++;
    } catch (e) { /* ignore */ }
  }

  function startBgmTimer() {
    if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
    const battle = bgmStyle === 'battle';
    bgmTimer = setInterval(battle ? bgmStepBattle : bgmStepLobby, battle ? 150 : 300);
  }

  return {
    init() {
      ac();
      if (!bgmTimer) startBgmTimer();
    },
    /** 切换BGM风格：'lobby'钢琴曲 / 'battle'急促弦乐+打击乐 */
    setBgm(style) {
      if (bgmStyle === style) return;
      bgmStyle = style;
      if (bgmTimer) startBgmTimer();
    },
    play(n) { try { fx[n] && fx[n](); } catch (e) { /* ignore */ } },
    toggleBgm() { bgmOn = !bgmOn; return bgmOn; },
  };
})();
