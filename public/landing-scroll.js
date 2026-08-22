/* ============================================================================
   landing-scroll.js — landing 页 hero 以下各节的滚动入场与微交互
   ----------------------------------------------------------------------------
   依赖 /vendor/gsap.min.js 与 /vendor/ScrollTrigger.min.js（先于本文件加载）。
   全部走渐进增强：初始隐藏态由 gsap.set/from 设置 —— 不跑 JS、gsap 没加载
   成功、或访客要求减少动效时，内容原样立即可见（FAQ 也退回原生展开）。
   trigger 按文档顺序自上而下创建（ScrollTrigger.refresh 按创建顺序跑），
   入场大多 once: true —— 回滚不倒放，内容不许凭空消失。

   各节的性格刻意错开，不共用一套「淡入上移」：
   - 分节标题：标题逐字浮起（中文按字切 span）+ 色条从中间划开
   - 左右分栏：视觉从外侧滑入，文案错峰上浮（h2 已由分节标题接手，不重复）
   - 模板 logo：三行履带用 wrap 折回 x，悬停降速，离屏暂停
   - 特性卡片：batch 批次入场；落定后 clearProps，悬停提升交给 CSS，
     指针追光（--mx/--my）与图标弹跳在这里接线
   - 模板节：标题里的模板总数滚动计数；chips 随机次序 back.out 弹出，
     每个 chip 里的分类数也数一遍
   - 示意面板：休眠状态轮换、终端行错峰浮起、用量条从 0 长出
   - 流程四步：整列错峰上移，序号 back.out(2.2) 逐个弹，
     卡片间的连接线 scaleX 划出
   - FAQ：逐条浮起；点击展开/收起走 GSAP 高度动画（原生 details 兜底）
   - 收尾 CTA 横幅：深色底上的三行内容错峰浮起
   - 页脚：一行内容淡淡浮起 */
(function () {
  'use strict';

  var gsap = window.gsap;
  var ST = window.ScrollTrigger;
  if (!gsap || !ST) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  gsap.registerPlugin(ST);

  var toArray = gsap.utils.toArray;
  var finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ── 工具：把元素里的文本节点按字切成 span（中文没有词界，逐字才有节奏） ──
     元素节点（如 .ld-num）原样保留 —— 计数数字有自己的动画。 */
  function splitChars(el) {
    var chars = [];
    function walk(node) {
      toArray(node.childNodes).forEach(function (n) {
        if (n.nodeType === 3) {
          var frag = document.createDocumentFragment();
          String(n.textContent).split('').forEach(function (ch) {
            if (ch.trim() === '') {
              frag.appendChild(document.createTextNode(ch));
              return;
            }
            var s = document.createElement('span');
            s.className = 'ld-ch';
            s.textContent = ch;
            frag.appendChild(s);
            chars.push(s);
          });
          node.replaceChild(frag, n);
        } else if (n.nodeType === 1) {
          walk(n);
        }
      });
    }
    walk(el);
    return chars;
  }

  /* ── 工具：滚动计数（目标值写在 data-count 上，正整数才有意义） ── */
  function countUp(el, dur) {
    var target = parseInt(el.getAttribute('data-count'), 10);
    if (!isFinite(target) || target <= 0) return;
    var o = { v: 0 };
    gsap.to(o, {
      v: target,
      duration: dur || 1.1,
      ease: 'power2.out',
      onUpdate: function () { el.textContent = Math.round(o.v); },
    });
  }

  /* ── 分节标题：逐字浮起 + 色条从中间划开；标题里的计数顺带数上来 ── */
  toArray('.ld-section').forEach(function (sec) {
    var h2 = sec.querySelector('h2');
    if (!h2) return;
    var bar = sec.querySelector('.ld-h2-bar');
    var chars = splitChars(h2);
    var tl = gsap.timeline({
      scrollTrigger: { trigger: sec, start: 'top 78%', once: true },
    });
    if (chars.length) {
      tl.from(chars, {
        yPercent: 70, autoAlpha: 0, duration: 0.55, ease: 'power3.out',
        stagger: { each: 0.03, from: 'start' },
      });
    }
    var num = h2.querySelector('.ld-num');
    if (num) tl.add(function () { countUp(num, 1.2); }, 0.1);
    if (bar) {
      tl.from(bar, { scaleX: 0, duration: 0.6, ease: 'power2.out' }, '-=0.35');
    }
  });

  /* ── 左右分栏：视觉从外侧滑入，文案（不含已有入场的 h2 / 色条）错峰上浮 ── */
  toArray('.ld-split').forEach(function (split) {
    var vis = split.querySelector('.ld-split-visual');
    var copy = split.querySelector('.ld-split-copy');
    var flip = split.classList.contains('flip');
    var tl = gsap.timeline({
      scrollTrigger: { trigger: split, start: 'top 78%', once: true },
    });
    if (vis) {
      tl.from(vis, {
        x: flip ? 28 : -28, autoAlpha: 0, duration: 0.8, ease: 'power3.out',
      }, 0);
    }
    if (copy) {
      var bits = toArray(copy.children).filter(function (el) {
        return !el.matches('h2, .ld-h2-bar');
      });
      if (bits.length) {
        tl.from(bits, {
          y: 16, autoAlpha: 0, duration: 0.6, ease: 'power3.out', stagger: 0.07,
        }, 0.1);
      }
    }
  });

  /* ── 模板 logo 无限履带 ──
     每行克隆一份，gsap.utils.wrap 把 x 折回，看起来接得上。
     行不够宽就先把原套再铺一遍；悬停降到 0.22，离屏暂停。 */
  var stage = document.querySelector('.ld-logo-stage');
  if (stage) {
    var wrapX = gsap.utils.wrap;
    var unitize = gsap.utils.unitize;
    var rows = toArray(stage.querySelectorAll('.ld-marquee'));
    var tweens = [];

    rows.forEach(function (row) {
      var set = row.querySelector('.ld-marquee-set');
      if (set && !set.dataset.src) set.dataset.src = set.innerHTML;
    });

    function mountRow(row) {
      var track = row.querySelector('.ld-marquee-track');
      var set = row.querySelector('.ld-marquee-set');
      if (!track || !set || !set.dataset.src) return null;
      toArray(track.querySelectorAll('[data-clone]')).forEach(function (n) { n.remove(); });
      set.innerHTML = set.dataset.src;
      var guard = 0;
      while (set.offsetWidth < row.offsetWidth + 80 && guard++ < 6) {
        set.insertAdjacentHTML('beforeend', set.dataset.src);
      }
      var clone = set.cloneNode(true);
      clone.setAttribute('data-clone', '1');
      clone.setAttribute('aria-hidden', 'true');
      track.appendChild(clone);
      var dir = parseFloat(row.getAttribute('data-dir') || '1');
      var gap = parseFloat(getComputedStyle(track).gap) || 10;
      var dist = set.offsetWidth + gap;
      if (dist < 16) return null;
      var dur = Math.max(18, dist / 42);
      var vars = {
        duration: dur,
        ease: 'none',
        repeat: -1,
        modifiers: { x: unitize(wrapX(-dist, 0)) },
      };
      return dir < 0
        ? gsap.fromTo(track, { x: -dist }, Object.assign({ x: 0 }, vars))
        : gsap.fromTo(track, { x: 0 }, Object.assign({ x: -dist }, vars));
    }

    function applyScale(scale) {
      tweens.forEach(function (t) { if (t) t.timeScale(scale); });
    }

    function rebuild() {
      tweens.forEach(function (t) { if (t) t.kill(); });
      tweens = rows.map(mountRow);
    }
    rebuild();

    if (finePointer) {
      stage.addEventListener('pointerenter', function () { applyScale(0.22); });
      stage.addEventListener('pointerleave', function () { applyScale(1); });
    }

    var resizeTimer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(rebuild, 180);
    });

    ST.create({
      trigger: stage,
      start: 'top bottom',
      end: 'bottom top',
      onToggle: function (self) {
        tweens.forEach(function (t) {
          if (!t) return;
          if (self.isActive) t.resume();
          else t.pause();
        });
      },
    });
  }

  /* ── 示意面板：休眠状态轮换、终端行错峰、用量条长出 ── */
  toArray('.ld-mock-pill[data-states]').forEach(function (pill) {
    var states = pill.getAttribute('data-states').split(',').map(function (s) {
      return s.trim();
    }).filter(Boolean);
    if (states.length < 2) return;
    var i = 0;
    var loop;
    function tick() {
      i = (i + 1) % states.length;
      gsap.to(pill, {
        autoAlpha: 0, y: -5, duration: 0.18, ease: 'power2.in',
        onComplete: function () {
          pill.textContent = states[i];
          pill.setAttribute('data-state', states[i]);
          gsap.fromTo(pill, { autoAlpha: 0, y: 5 }, {
            autoAlpha: 1, y: 0, duration: 0.22, ease: 'power2.out',
          });
        },
      });
      loop = gsap.delayedCall(2.4, tick);
    }
    ST.create({
      trigger: pill.closest('.ld-mock') || pill,
      start: 'top 85%',
      end: 'bottom top',
      onEnter: function () { if (!loop) loop = gsap.delayedCall(1.6, tick); },
      onEnterBack: function () { if (!loop) loop = gsap.delayedCall(0.4, tick); },
      onLeave: function () { if (loop) { loop.kill(); loop = null; } },
      onLeaveBack: function () { if (loop) { loop.kill(); loop = null; } },
    });
  });

  var term = document.querySelector('.ld-mock-term');
  if (term) {
    var lines = toArray(term.querySelectorAll('.ld-term-line, .ld-term-out'));
    if (lines.length) {
      gsap.from(lines, {
        autoAlpha: 0, x: 8, duration: 0.4, ease: 'power2.out', stagger: 0.16,
        scrollTrigger: { trigger: term, start: 'top 80%', once: true },
      });
    }
  }

  toArray('.ld-mock-bar > b').forEach(function (bar) {
    gsap.from(bar, {
      scaleX: 0,
      duration: 0.9,
      ease: 'power2.out',
      scrollTrigger: { trigger: bar, start: 'top 92%', once: true },
    });
  });

  /* ── 特性卡片：批次入场，同批错峰；落定 clearProps 把 transform 交还 CSS 悬停 ── */
  var cards = toArray('.ld-card');
  if (cards.length) {
    gsap.set(cards, { y: 34, autoAlpha: 0, scale: 0.97 });
    ScrollTrigger.batch(cards, {
      start: 'top 88%',
      once: true,
      onEnter: function (batch) {
        gsap.to(batch, {
          y: 0, autoAlpha: 1, scale: 1,
          duration: 0.75, ease: 'power3.out', stagger: 0.09, overwrite: true,
          onComplete: function () { gsap.set(batch, { clearProps: 'transform' }); },
        });
      },
    });
  }

  /* 卡片微交互（只接精确指针，触屏不吃这些事件）：追光 + 图标弹跳 */
  if (finePointer) {
    cards.forEach(function (card) {
      var ic = card.querySelector('.ld-ic');
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', (((e.clientX - r.left) / r.width) * 100).toFixed(1) + '%');
        card.style.setProperty('--my', (((e.clientY - r.top) / r.height) * 100).toFixed(1) + '%');
      });
      if (!ic) return;
      card.addEventListener('pointerenter', function () {
        gsap.to(ic, { y: -3, scale: 1.14, duration: 0.45, ease: 'back.out(2.5)', overwrite: 'auto' });
      });
      card.addEventListener('pointerleave', function () {
        gsap.to(ic, { y: 0, scale: 1, duration: 0.4, ease: 'power2.out', overwrite: 'auto' });
      });
    });
  }

  /* ── 模板分类 chips：随机次序弹出，chip 里的分类数跟着数上来 ── */
  var chips = toArray('.ld-chip');
  if (chips.length) {
    gsap.set(chips, { y: 16, autoAlpha: 0, scale: 0.8 });
    ScrollTrigger.batch(chips, {
      start: 'top 92%',
      once: true,
      batchMax: 8,
      onEnter: function (batch) {
        gsap.to(batch, {
          y: 0, autoAlpha: 1, scale: 1,
          duration: 0.55, ease: 'back.out(1.6)',
          stagger: { each: 0.045, from: 'random' }, overwrite: true,
          onComplete: function () { gsap.set(batch, { clearProps: 'transform' }); },
        });
        batch.forEach(function (chip) {
          var b = chip.querySelector('b');
          if (b) {
            var target = parseInt(b.textContent, 10);
            if (isFinite(target) && target > 0) {
              var o = { v: 0 };
              b.setAttribute('data-count', target);
              gsap.to(o, {
                v: target, duration: 0.7, ease: 'power2.out', delay: 0.15,
                onUpdate: function () { b.textContent = Math.round(o.v); },
              });
            }
          }
        });
      },
    });
  }

  /* 招牌名单与备注：跟在 chips 后面淡淡浮起 */
  var names = document.querySelector('.ld-names');
  if (names) {
    gsap.from(names, {
      y: 18, autoAlpha: 0, duration: 0.7, ease: 'power2.out',
      scrollTrigger: { trigger: names, start: 'top 92%', once: true },
    });
  }
  var note = document.querySelector('.ld-note');
  if (note) {
    gsap.from(note, {
      y: 14, autoAlpha: 0, duration: 0.6, ease: 'power2.out',
      scrollTrigger: { trigger: note, start: 'top 94%', once: true },
    });
  }

  /* ── 流程四步：整列错峰上移，序号逐个弹出，连接线划出 ── */
  var steps = toArray('.ld-steps li');
  if (steps.length) {
    var links = toArray('.ld-steps .ld-step-link');
    var tl = gsap.timeline({
      scrollTrigger: { trigger: '.ld-steps', start: 'top 82%', once: true },
    });
    tl.from(steps, { y: 38, autoAlpha: 0, duration: 0.7, ease: 'power3.out', stagger: 0.11 })
      .from('.ld-step-n', { scale: 0, duration: 0.5, ease: 'back.out(2.2)', stagger: 0.11 }, 0.12);
    if (links.length) {
      tl.from(links, {
        scaleX: 0, transformOrigin: 'left center',
        duration: 0.35, ease: 'power2.out', stagger: 0.11,
      }, 0.4);
    }
  }

  /* ── FAQ：逐条浮起；展开/收起用 GSAP 撑高度（原生 toggle 被 preventDefault） ── */
  var faqs = toArray('.ld-faq details');
  if (faqs.length) {
    gsap.set(faqs, { y: 24, autoAlpha: 0 });
    ScrollTrigger.batch(faqs, {
      start: 'top 90%',
      once: true,
      onEnter: function (batch) {
        gsap.to(batch, { y: 0, autoAlpha: 1, duration: 0.6, ease: 'power3.out', stagger: 0.08, overwrite: true });
      },
    });

    faqs.forEach(function (d) {
      var body = d.querySelector('.ld-faq-body');
      var summary = d.querySelector('summary');
      if (!body || !summary) return;
      var busy = false; /* 动画进行中再点不叠加，收尾才认状态 */
      summary.addEventListener('click', function (e) {
        e.preventDefault();
        if (busy) return;
        busy = true;
        if (d.open) {
          gsap.to(body, {
            height: 0, duration: 0.32, ease: 'power2.inOut',
            onComplete: function () {
              d.open = false;
              gsap.set(body, { clearProps: 'height' });
              busy = false;
            },
          });
        } else {
          d.open = true;
          gsap.fromTo(body, { height: 0 }, {
            height: 'auto', duration: 0.42, ease: 'power2.out',
            onComplete: function () {
              gsap.set(body, { clearProps: 'height' });
              busy = false;
              /* 若动画期间页面变高，后面 trigger 的起点要跟着校准 */
              if (ST) ST.refresh();
            },
          });
        }
      });
    });
  }

  /* ── 收尾 CTA 横幅：三行内容错峰浮起，按钮轻微过冲 ── */
  var band = document.querySelector('.ld-band');
  if (band) {
    var tl2 = gsap.timeline({
      scrollTrigger: { trigger: band, start: 'top 78%', once: true },
    });
    tl2.from(band.querySelectorAll('h2, p'), {
      y: 24, autoAlpha: 0, duration: 0.65, ease: 'power3.out', stagger: 0.12,
    }).from(band.querySelector('.ld-band-btn'), {
      y: 16, autoAlpha: 0, scale: 0.92, duration: 0.55, ease: 'back.out(1.8)',
    }, '-=0.4');
  }

  /* ── 页脚：一行内容淡淡浮起 ──
     start 用 top bottom 而不是更早的触发线：页脚是最后一个元素，页面没有
     更多滚动空间时（超高视口 / 短页），96% 那条线可能永远够不到。 */
  gsap.from('.ld-foot-in > *', {
    y: 14, autoAlpha: 0, duration: 0.6, ease: 'power2.out', stagger: 0.07,
    scrollTrigger: { trigger: '.ld-foot', start: 'top bottom', once: true },
  });
})();
