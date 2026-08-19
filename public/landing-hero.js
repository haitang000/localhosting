/* ============================================================================
   landing-hero.js — landing 首屏动效：粒子 logo 与文字入场
   ----------------------------------------------------------------------------
   依赖全局 gsap（/vendor/gsap.min.js，在本文件之前引入）。品牌色写在画布的
   data-ink 上，与管理后台设置的主题色同源（src/landing.js 渲染时注入）。

   结构自底向上分四层：
   1. 粒子几何 —— 「家」按 dotMark() 同一套几何撒在圆角方环带上（viewBox
      0..32），远看仍是那枚标记；起点散布全画布，像噪声里凝出图像。
   2. 入场编排 —— 不逐粒子建 tween：粒子按 (x+y)+抖动 分进 26 个批次，
      gsap 一次 stagger tween 把各批次的 k 从 0 推到 1，物理弹簧追着批次
      目标走。一次 tween 驱动三千粒子，进场即斜扫。
   3. 指针交互 —— 坐标经 gsap.quickTo 平滑（斥力场有拖尾惯性）；按下/松开
      用弹性 tween 过渡半径与力度（松手回弹）；整枚标记再被指针轻微牵引，
      引力随距离平滑衰减 —— 离指针越远影响越小。
   4. 光带 —— 一条更亮的高光带周期性沿对角线扫过粒子环，是点阵标记波纹
      动画的粒子版（第二条绘制 pass，只画带内粒子）。

   渲染循环挂在 gsap.ticker 上，hero 滚出视口即停。访客要求减少动效或
   gsap 没加载成功时，只画一层静态粒子，不监听指针。 */
(function () {
  'use strict';

  var hero = document.querySelector('.ld-hero');
  var canvas = document.querySelector('.ld-logo');
  if (!hero || !canvas) return;
  var ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;

  var gsap = window.gsap;
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var TAU = Math.PI * 2;

  /* 与 dotMark() 相同的几何：圆角方环中心线（中心 16、半边 11、圆角半径 5）
     加上带宽 —— |d| ≤ BAND 的点都在环带上 */
  var CENTER = 16, RADIUS = 5, FLAT = 11 - RADIUS, BAND = (22 / 15) * 1.02;
  var INK = canvas.dataset.ink || '#006FEE';

  /* 品牌色 → 调亮：渐变收尾向白靠拢，同原点阵标记的对角线渐变 */
  function mixWhite(hex, t) {
    var m = /^#([0-9a-f]{6})$/i.exec(String(hex));
    if (!m) return hex;
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 'rgb(' + Math.round(r + (255 - r) * t) + ',' +
      Math.round(g + (255 - g) * t) + ',' + Math.round(b + (255 - b) * t) + ')';
  }

  /* ── 状态 ── */
  var pts = [];
  var cohorts = [];        /* 入场批次：{ k: 0→1 }，由 gsap tween 推动 */
  var COHORT_N = 26;
  var entranceDone = false;
  var entranceTween = null;
  var unit = 0;
  var inkGrad = null, litGrad = null;

  /* 指针：原始坐标 + quickTo 平滑出的拖尾坐标（斥力场跟的是拖尾值） */
  var pointer = { x: -1e3, y: -1e3, sx: -1e3, sy: -1e3 };
  var press = { radius: 7, power: 0.16 };
  /* 全局引力：PULL 是近处力度上限，FALLOFF 是衰减尺度 */
  var PULL = 0.07, FALLOFF = 12;
  var SPRING = 0.025, DAMP = 0.86;

  /* 光带：波前在对角线 (x+y)/√2 上的位置 */
  var wave = { p: -8 };

  function inBand(x, y) {
    var qx = Math.abs(x - CENTER) - FLAT;
    var qy = Math.abs(y - CENTER) - FLAT;
    var d = Math.abs(
      Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RADIUS
    );
    return d <= BAND;
  }

  function seed() {
    pts = [];
    cohorts = [];
    var settled = entranceDone || reduced || !gsap;
    for (var c = 0; c < COHORT_N; c++) cohorts.push({ k: settled ? 1 : 0 });
    /* 密度跟着画布尺寸走：~30px² 一粒，300px 的标记约 3000+ 粒 */
    var n = Math.min(4000, Math.round((unit * unit) / 30));
    var guard = n * 60; /* 拒绝采样的保底循环数 */
    while (pts.length < n && guard-- > 0) {
      var x = 3.2 + Math.random() * 25.6;
      var y = 3.2 + Math.random() * 25.6;
      if (!inBand(x, y)) continue;
      /* 批次 = 对角线次序 ± 抖动：整体像一道斜扫，细看有噪声 */
      var ci = Math.round(((x + y - 6.4) / 51.2) * (COHORT_N - 1) + (Math.random() * 4 - 2));
      pts.push({
        ox: x, oy: y,
        sx: 1.5 + Math.random() * 29, /* 起点：全画布噪声位 */
        sy: 1.5 + Math.random() * 29,
        x: 0, y: 0, vx: 0, vy: 0,
        r: 0.05 + Math.random() * 0.035,
        ph: Math.random() * TAU,
        ws: 0.5 + Math.random(),
        c: Math.max(0, Math.min(COHORT_N - 1, ci))
      });
    }
    for (var i = 0; i < pts.length; i++) {
      pts[i].x = pts[i].sx;
      pts[i].y = pts[i].sy;
    }
  }

  function buildGradients() {
    inkGrad = ctx.createLinearGradient(0, 0, 32, 32);
    inkGrad.addColorStop(0, INK);
    inkGrad.addColorStop(1, mixWhite(INK, 0.45));
    litGrad = ctx.createLinearGradient(0, 0, 32, 32);
    litGrad.addColorStop(0, mixWhite(INK, 0.55));
    litGrad.addColorStop(1, mixWhite(INK, 0.8));
  }

  var lastUnit = 0;
  function size() {
    var rect = canvas.getBoundingClientRect();
    unit = Math.max(1, Math.min(rect.width, rect.height));
    /* ResizeObserver.observe() 后总会立刻回调一次 —— 尺寸没变就别动，
       否则刚起步的入场 tween 会被误杀。真变了尺寸才重撒粒子。 */
    if (Math.abs(unit - lastUnit) < 1) return;
    lastUnit = unit;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(unit * dpr);
    canvas.height = Math.round(unit * dpr);
    var k = (unit * dpr) / 32; /* 之后全部按 viewBox 坐标作画 */
    ctx.setTransform(k, 0, 0, k, 0, 0);
    buildGradients();
    /* 尺寸变了粒子得重撒；入场只播一次 —— 中途被 resize 打断就直接落定 */
    if (entranceTween && !entranceDone) {
      entranceTween.kill();
      entranceDone = true;
    }
    seed();
    if (reduced || !gsap) drawSettled();
  }

  /* 静态一帧：粒子全在「家」上，无物理（reduced / 无 gsap 的降级路径） */
  function drawSettled() {
    ctx.clearRect(0, 0, 32, 32);
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = inkGrad || INK;
    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      ctx.moveTo(p.ox + p.r, p.oy);
      ctx.arc(p.ox, p.oy, p.r, 0, TAU);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* 每帧：物理推进 + 两条绘制 pass（本体 / 光带高亮） */
  function render(time) {
    var t = time; /* gsap.ticker 给的是秒 */
    var R = press.radius, R2 = R * R, power = press.power;
    ctx.clearRect(0, 0, 32, 32);
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = inkGrad || INK;
    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var k = cohorts[p.c].k;
      /* 目标 = 起点 → (家 + 呼吸浮动) 的插值：入场时飞向环带，落定后只剩浮动 */
      var hx = p.ox + Math.sin(t * p.ws + p.ph) * 0.15;
      var hy = p.oy + Math.cos(t * p.ws * 0.9 + p.ph) * 0.15;
      var tx = p.sx + (hx - p.sx) * k;
      var ty = p.sy + (hy - p.sy) * k;
      var dx = p.x - pointer.sx, dy = p.y - pointer.sy;
      var d2 = dx * dx + dy * dy;
      if (d2 < R2) {
        /* 近处：斥力把粒子推开（力度二次衰减） */
        var d = Math.sqrt(d2) || 1e-4;
        var f = 1 - d / R;
        f = f * f * power;
        p.vx += (dx / d) * f;
        p.vy += (dy / d) * f;
      }
      /* 全局引力：整枚标记朝指针弯，随距离平滑衰减 */
      var ad = Math.sqrt(d2) || 1e-4;
      var g = PULL * FALLOFF / (ad + FALLOFF);
      p.vx -= (dx / ad) * g;
      p.vy -= (dy / ad) * g;
      /* 弹簧回家 + 阻尼 */
      p.vx += (tx - p.x) * SPRING;
      p.vy += (ty - p.y) * SPRING;
      p.vx *= DAMP;
      p.vy *= DAMP;
      p.x += p.vx;
      p.y += p.vy;
      var r = p.r * (0.25 + 0.75 * k); /* 飞行中偏小，落定恢复 */
      ctx.moveTo(p.x + r, p.y);
      ctx.arc(p.x, p.y, r, 0, TAU);
    }
    ctx.fill();

    /* 光带 pass：只画波前高斯带内的粒子，更亮、稍大 —— 光从标记上扫过 */
    if (entranceDone) {
      ctx.beginPath();
      var any = false;
      for (var j = 0; j < pts.length; j++) {
        var q = pts[j];
        var dd = (q.x + q.y) * 0.7071 - wave.p;
        if (dd < -2.4 || dd > 2.4) continue;
        var glow = Math.exp(-(dd * dd) / 2.2);
        if (glow < 0.12) continue;
        any = true;
        var rr = q.r * (1 + glow * 0.9);
        ctx.moveTo(q.x + rr, q.y);
        ctx.arc(q.x, q.y, rr, 0, TAU);
      }
      if (any) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = litGrad || INK;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ── GSAP 编排 ── */
  function play() {
    /* 画布与文案的入场：先logo聚形，文字错峰浮起 */
    gsap.from(canvas, {
      scale: 0.88, autoAlpha: 0, duration: 1.4, ease: 'power2.out', transformOrigin: '50% 50%'
    });
    var lines = hero.querySelectorAll('.ld-hero-text > *');
    if (lines.length) {
      gsap.from(lines, {
        y: 26, autoAlpha: 0, duration: 0.9, ease: 'power3.out', stagger: 0.08, delay: 0.2
      });
    }
    /* 粒子按批次凝聚：一次 stagger tween 驱动全部 */
    entranceTween = gsap.to(cohorts, {
      k: 1, duration: 1.05, ease: 'power3.out', stagger: 0.05,
      onComplete: function () { entranceDone = true; }
    });
    /* 光带：入场落定后开始，沿对角线周期性扫过 */
    gsap.fromTo(wave, { p: -8 }, {
      p: 46, duration: 6.5, ease: 'none', delay: 2.8, repeat: -1, repeatDelay: 3.4
    });
  }

  /* ── 指针接线 ── */
  var pxTo = null, pyTo = null;
  if (gsap && !reduced) {
    pxTo = gsap.quickTo(pointer, 'sx', { duration: 0.45, ease: 'power3' });
    pyTo = gsap.quickTo(pointer, 'sy', { duration: 0.45, ease: 'power3' });
  }
  function at(e) {
    var rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 32;
    pointer.y = ((e.clientY - rect.top) / rect.height) * 32;
    if (pxTo) {
      pxTo(pointer.x);
      pyTo(pointer.y);
    } else {
      pointer.sx = pointer.x;
      pointer.sy = pointer.y;
    }
  }
  function release() {
    if (!gsap || reduced) return;
    gsap.to(press, {
      radius: 7, power: 0.16, duration: 0.85, ease: 'elastic.out(1, 0.5)', overwrite: 'auto'
    });
  }
  function away() {
    pointer.x = pointer.y = -1e3;
    if (pxTo) {
      pxTo(-1e3);
      pyTo(-1e3);
    } else {
      pointer.sx = pointer.sy = -1e3;
    }
    release();
  }

  /* ── ticker 开关（hero 滚出视口就停，省电） ── */
  var ticking = false;
  function startTicker() {
    if (ticking || !gsap || reduced) return;
    ticking = true;
    gsap.ticker.add(render);
  }
  function stopTicker() {
    if (!ticking) return;
    ticking = false;
    gsap.ticker.remove(render);
  }

  /* ── 启动 ── */
  size();
  /* 尺寸观察放最前：reduced / 无 gsap 的降级路径也要能重画静态帧 */
  if ('ResizeObserver' in window) {
    new ResizeObserver(size).observe(canvas);
  } else {
    var timer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(size, 150);
    });
  }
  if (reduced || !gsap) return; /* 降级：静态一帧已画好，不接指针 */

  play();
  hero.addEventListener('pointermove', at);
  hero.addEventListener('pointerdown', function (e) {
    at(e);
    gsap.to(press, { radius: 13, power: 0.4, duration: 0.28, ease: 'power2.out', overwrite: 'auto' });
  });
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  hero.addEventListener('pointerleave', away);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) startTicker();
      else stopTicker();
    }).observe(canvas);
  } else {
    startTicker();
  }
})();
