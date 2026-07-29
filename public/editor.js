import { icon } from './icons.js';

/* ===========================================================================
   editor — the thing that opens when you click 编辑 in 文件管理.
   ---------------------------------------------------------------------------
   It is still one `<textarea>`. That is deliberate: a contenteditable code
   editor has to re-implement the caret, IME composition, selection, undo and
   mobile keyboards, and every one of those is a place where a panel that only
   needs to fix an nginx.conf would end up worse than the box it replaced.

   So the textarea keeps doing the typing, and everything an editor is expected
   to have is layered around it:

     · a gutter that mirrors the wrapped line boxes, so the numbers stay right
       even with 自动换行 on (each row carries an invisible copy of its own
       line — the browser does the measuring, no JS layout maths);
     · a `<pre>` painted underneath with the same metrics, holding the syntax
       colours, while the textarea's own text is made transparent;
     · key handling for the edits people expect to be able to do without a
       mouse — indent, comment, duplicate, move, auto-pairs, smart Home;
     · find / replace, go-to-line, and a status bar that says where you are.

   Two rules keep the whole thing honest:

     1. every programmatic edit goes through `edit()`, which uses
        execCommand('insertText'). It is deprecated and it is the only way to
        write into a textarea without throwing away the browser's native undo
        stack — Ctrl+Z has to keep working, and no home-grown undo stack is
        going to beat the real one on a phone keyboard.
     2. while an IME is composing, the paint layer gets out of the way and the
        real text becomes visible again. A transparent textarea would otherwise
        swallow the candidate text — which, in a Chinese panel, is most typing.
   =========================================================================== */

/* ------------------------------------------------------------- languages --- */

/** Filenames that carry their type in the name rather than in an extension. */
const BY_NAME = {
  dockerfile: 'sh',
  containerfile: 'sh',
  makefile: 'sh',
  jenkinsfile: 'js',
  gemfile: 'py',
  rakefile: 'py',
  procfile: 'sh',
  '.env': 'sh',
  '.bashrc': 'sh',
  '.bash_profile': 'sh',
  '.profile': 'sh',
  '.zshrc': 'sh',
  '.gitignore': 'sh',
  '.dockerignore': 'sh',
  '.npmrc': 'sh',
  '.editorconfig': 'sh',
};

const BY_EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', json: 'js', jsonc: 'js',
  java: 'js', c: 'js', h: 'js', cpp: 'js', hpp: 'js', cc: 'js', cs: 'js', go: 'js', rs: 'js',
  php: 'js', swift: 'js', kt: 'js', scala: 'js', dart: 'js', groovy: 'js',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'xml', htm: 'xml', xhtml: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', plist: 'xml',
  sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', env: 'sh', conf: 'sh', cfg: 'sh', ini: 'sh',
  toml: 'sh', properties: 'sh', yml: 'sh', yaml: 'sh', service: 'sh', gitconfig: 'sh',
  py: 'py', rb: 'py', pl: 'py', lua: 'py', r: 'py', tcl: 'py',
  sql: 'sql',
  md: 'md', markdown: 'md',
};

/** Human label for the status bar — the family is an implementation detail. */
const LANG_NAME = {
  js: 'JavaScript', json: 'JSON', ts: 'TypeScript', tsx: 'TypeScript', jsx: 'JavaScript',
  css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML', htm: 'HTML', xml: 'XML', svg: 'SVG',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', conf: 'Conf', ini: 'INI', toml: 'TOML',
  yml: 'YAML', yaml: 'YAML', env: 'Env', py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust',
  php: 'PHP', lua: 'Lua', sql: 'SQL', md: 'Markdown', markdown: 'Markdown', java: 'Java',
  c: 'C', h: 'C', cpp: 'C++', cs: 'C#', txt: '纯文本', log: '日志',
};

function detect(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : '';
  const family = BY_NAME[lower] ?? (ext ? BY_EXT[ext] : null) ?? null;
  const label = LANG_NAME[ext] || (BY_NAME[lower] ? name : '') || (ext ? ext.toUpperCase() : '纯文本');
  return { family, label };
}

/* ------------------------------------------------------------ highlight --- */

/* One combined regex per family. Every sub-pattern is written with
   non-capturing groups only, so capture group `n + 1` is rule `n` — that is how
   the painter knows which class a match belongs to without running the rules
   one at a time. Order inside the list is priority: comments and strings first,
   or a `#` inside a quoted string turns the rest of the line into a comment. */
const RULES = {
  js: {
    rules: [
      ['com', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/],
      ['str', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/],
      ['kw', /\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|defer|delete|do|else|enum|export|extends|false|final|finally|fn|for|from|func|function|get|go|if|impl|implements|import|in|instanceof|interface|let|match|mut|namespace|new|nil|null|of|override|package|private|protected|public|pub|readonly|require|return|self|set|static|struct|super|switch|this|throw|throws|trait|true|try|type|typeof|undefined|use|var|void|where|while|with|yield)\b/],
      ['num', /\b(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)\b/],
      ['fn', /\b[A-Za-z_$][\w$]*(?=\s*\()/],
    ],
  },
  css: {
    rules: [
      ['com', /\/\*[\s\S]*?(?:\*\/|$)/],
      ['str', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/],
      ['var', /--[\w-]+/],
      ['kw', /@[\w-]+|![\w-]+/],
      ['atr', /[-\w]+(?=\s*:)/],
      ['num', /#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|r?em|%|v[hw]|m?s|deg|fr|ch|pt|vmin|vmax)?\b/],
    ],
  },
  xml: {
    rules: [
      ['com', /<!--[\s\S]*?(?:-->|$)/],
      ['kw', /<!\w[^>]*>|<\?[\s\S]*?\?>/],
      ['tag', /<\/?[A-Za-z][\w:.-]*|\/?>/],
      ['atr', /[A-Za-z_:][\w:.-]*(?=\s*=)/],
      ['str', /"[^"]*"|'[^']*'/],
      ['var', /&[\w#]+;/],
    ],
  },
  sh: {
    rules: [
      ['com', /#[^\n]*/],
      ['str', /"(?:[^"\\]|\\.)*"|'[^']*'/],
      ['var', /\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[@*#?$!0-9-])/],
      // `key: value` and `key=value` cover yaml/ini/toml/env; the second
      // alternative is the nginx-shaped `directive value;` / `block {`, which is
      // most of what a .conf in a container actually looks like.
      ['atr', /^[ \t]*(?:- )?[\w.\-/]+(?=[ \t]*[:=])|^[ \t]*[A-Za-z_][\w.-]*(?=[ \t][^\n]*[;{][ \t]*$)/],
      ['kw', /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|select|return|export|local|readonly|source|alias|set|unset|shift|trap|exit|echo|true|false|null|yes|no|on|off|FROM|RUN|CMD|ENV|COPY|ADD|WORKDIR|EXPOSE|ENTRYPOINT|VOLUME|USER|ARG|LABEL|HEALTHCHECK|ONBUILD|STOPSIGNAL|SHELL)\b/],
      ['num', /\b\d+(?:\.\d+)?\b/],
    ],
  },
  py: {
    rules: [
      ['com', /#[^\n]*/],
      ['str', /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/],
      ['var', /@[A-Za-z_][\w.]*/],
      ['kw', /\b(?:and|as|assert|async|await|begin|break|class|continue|def|del|do|elif|else|elsif|end|ensure|except|False|finally|for|from|global|if|import|in|is|lambda|module|nil|None|nonlocal|not|or|pass|raise|require|rescue|return|self|then|True|try|unless|until|while|with|yield)\b/],
      ['num', /\b\d+(?:\.\d+)?\b/],
      ['fn', /\b[A-Za-z_]\w*(?=\s*\()/],
    ],
  },
  sql: {
    flags: 'i',
    rules: [
      ['com', /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/],
      ['str', /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`/],
      ['kw', /\b(?:add|all|alter|and|as|asc|autoincrement|begin|between|by|cascade|case|check|column|commit|constraint|create|cross|default|delete|desc|distinct|drop|else|end|exists|foreign|from|full|group|having|if|in|index|inner|insert|into|is|join|key|left|like|limit|not|null|offset|on|or|order|outer|primary|references|rename|replace|returning|right|rollback|select|set|table|then|transaction|union|unique|update|using|values|view|when|where|with)\b/],
      ['num', /\b\d+(?:\.\d+)?\b/],
    ],
  },
  md: {
    rules: [
      ['str', /```[\s\S]*?(?:```|$)|`[^`\n]*`/],
      ['kw', /^#{1,6}[ \t][^\n]*/],
      ['com', /^[ \t]*>[^\n]*/],
      ['var', /!?\[[^\]\n]*\]\([^)\n]*\)/],
      ['atr', /\*\*(?:[^*\n]|\*(?!\*))+\*\*|__(?:[^_\n]|_(?!_))+__/],
      ['num', /^[ \t]*(?:[-*+]|\d+\.)(?=[ \t])|^[ \t]*(?:---+|===+)[ \t]*$/],
    ],
  },
};

const COMPILED = new Map();
function compiled(family) {
  if (!family || !RULES[family]) return null;
  if (!COMPILED.has(family)) {
    const { rules, flags = '' } = RULES[family];
    COMPILED.set(family, {
      names: rules.map(([n]) => n),
      re: new RegExp(rules.map(([, r]) => `(${r.source})`).join('|'), `gm${flags}`),
    });
  }
  return COMPILED.get(family);
}

const escHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function paint(text, family) {
  const c = compiled(family);
  if (!c) return escHtml(text);
  let out = '';
  let last = 0;
  let m;
  c.re.lastIndex = 0;
  while ((m = c.re.exec(text))) {
    if (!m[0]) {
      c.re.lastIndex++;
      continue;
    }
    let k = 0;
    while (k < c.names.length && m[k + 1] === undefined) k++;
    if (m.index > last) out += escHtml(text.slice(last, m.index));
    out += `<span class="t-${c.names[k]}">${escHtml(m[0])}</span>`;
    last = c.re.lastIndex = m.index + m[0].length;
  }
  return out + escHtml(text.slice(last));
}

/** Line-comment token, or a block pair for the languages that have no line one. */
const LINE_COMMENT = { js: '//', sh: '#', py: '#', sql: '--' };
const BLOCK_COMMENT = { css: ['/*', '*/'], xml: ['<!--', '-->'], md: ['<!--', '-->'] };

/* ------------------------------------------------------------ preferences --- */

const PREFS_KEY = 'lh.editor';
const FONTS = [12, 13, 14, 16, 18];
/** Indent presets, cycled by one button: label, unit, and the tab-stop width. */
const INDENTS = [
  { label: '空格 2', unit: '  ', width: 2 },
  { label: '空格 4', unit: '    ', width: 4 },
  { label: 'Tab 4', unit: '\t', width: 4 },
  { label: 'Tab 8', unit: '\t', width: 8 },
];

function loadPrefs() {
  const base = { wrap: false, indent: 1, font: 13 };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return {
      wrap: !!saved.wrap,
      indent: INDENTS[saved.indent] ? saved.indent : base.indent,
      font: FONTS.includes(saved.font) ? saved.font : base.font,
    };
  } catch {
    return base;
  }
}

/* ------------------------------------------------------------------ pairs --- */

const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const CLOSERS = new Set([')', ']', '}', '"', "'", '`']);

/* Above this many characters the paint layer and the wrapped-line gutter cost
   more than they are worth on a keystroke, so both stand down and the textarea
   goes back to being a plain — and still perfectly usable — textarea. */
const LIGHT_ABOVE = 150 * 1024;

/* ------------------------------------------------------------------- open --- */

/**
 * @param {object} o
 * @param {string} o.path        absolute path inside the container
 * @param {string} o.text        file contents as fetched
 * @param {number} o.size        byte length on disk
 * @param {boolean} o.truncated  only the head was read → read-only
 * @param {(text: string) => Promise<{size: number}>} o.save
 * @param {(opts: object) => Promise<string|null>} o.ask   the panel's dialog
 * @param {(msg: string, kind?: string) => void} o.toast
 * @param {(n: number) => string} o.bytes
 * @param {() => void} [o.onSaved]  the listing is stale after a write
 */
export function openTextEditor({ path, text, size, truncated, save, ask, toast, bytes, onSaved }) {
  const prefs = loadPrefs();
  const lang = detect(path);
  /* A textarea's value is newline-normalised by the platform, so CRLF has to be
     noticed here, on the way in, and put back on the way out — otherwise every
     save silently rewrites a Windows-authored file to LF. */
  const eol = /\r\n/.test(text) ? 'CRLF' : 'LF';
  const body = eol === 'CRLF' ? text.replace(/\r\n/g, '\n') : text;
  const readonly = !!truncated;
  let light = body.length > LIGHT_ABOVE;

  document.getElementById('fm-editor')?.remove();
  const dlg = document.createElement('dialog');
  dlg.id = 'fm-editor';
  dlg.className = 'fm-edit';
  dlg.innerHTML = `
    <div class="ed-head">
      <span class="ed-file">${icon(
        'file-pen'
      )}<span class="ed-path"><span class="ed-dir"></span><b class="ed-base"></b></span></span>
      <span class="ed-dirty" title="有未保存的修改" hidden>●</span>
      <span class="ed-grow"></span>
      <button class="small ghost ed-icon" data-act="max" title="最大化" aria-label="最大化">${icon('maximize')}</button>
      <button class="primary small" data-act="save" ${readonly ? 'disabled' : ''}>${icon('save')}<span>保存</span></button>
      <button class="small ghost ed-icon" data-act="close" title="关闭 (Esc)" aria-label="关闭">${icon('x')}</button>
    </div>

    <div class="ed-tools">
      <button class="small ghost ed-icon" data-act="undo" title="撤销 (Ctrl+Z)" aria-label="撤销">${icon('undo-2')}</button>
      <button class="small ghost ed-icon" data-act="redo" title="重做 (Ctrl+Y)" aria-label="重做">${icon('redo-2')}</button>
      <i class="ed-sep"></i>
      <button class="small ghost ed-icon" data-act="find" title="查找替换 (Ctrl+F)" aria-label="查找替换" aria-pressed="false">${icon('search')}</button>
      <button class="small ghost ed-icon" data-act="goto" title="跳转到行 (Ctrl+G)" aria-label="跳转到行">${icon('hash')}</button>
      <i class="ed-sep"></i>
      <button class="small ghost ed-icon" data-act="wrap" title="自动换行" aria-label="自动换行" aria-pressed="false">${icon('wrap-text')}</button>
      <button class="small ghost" data-act="indent" title="缩进方式"><span class="ed-ind-label"></span>${icon('indent-increase')}</button>
      <button class="small ghost ed-icon" data-act="font" title="字号" aria-label="字号">${icon('a-large-small')}</button>
    </div>

    <!-- A two-column grid rather than two rows: the second column is as wide as
         its widest control group, so both fields end at the same edge. -->
    <div class="ed-find" hidden>
      <label class="ed-input">${icon('search')}<input class="ed-q" type="text" placeholder="查找" spellcheck="false" aria-label="查找" /></label>
      <div class="ed-find-side">
        <button class="ed-flag" data-flag="cs" title="区分大小写" aria-pressed="false">Aa</button>
        <button class="ed-flag" data-flag="word" title="全字匹配" aria-pressed="false">|ab|</button>
        <button class="ed-flag mono" data-flag="re" title="正则表达式" aria-pressed="false">.*</button>
        <span class="ed-count sub">—</span>
        <button class="small ghost ed-icon" data-act="prev" title="上一个 (Shift+Enter)" aria-label="上一个">${icon('arrow-up')}</button>
        <button class="small ghost ed-icon" data-act="next" title="下一个 (Enter)" aria-label="下一个">${icon('arrow-down')}</button>
        <button class="small ghost ed-icon" data-act="find-close" title="关闭查找 (Esc)" aria-label="关闭查找">${icon('x')}</button>
      </div>
      <label class="ed-input">${icon('corner-down-left')}<input class="ed-r" type="text" placeholder="替换为" spellcheck="false" aria-label="替换为" /></label>
      <div class="ed-find-side">
        <button class="small ghost" data-act="rep" ${readonly ? 'disabled' : ''}>替换</button>
        <button class="small ghost" data-act="repall" ${readonly ? 'disabled' : ''}>全部替换</button>
      </div>
    </div>

    ${
      readonly
        ? `<div class="ed-note err">${icon(
            'triangle-alert'
          )}文件太大，只读取了开头一段；保存会把后面的内容截掉，所以这里只能看不能存。</div>`
        : ''
    }

    <div class="ed-main">
      <div class="ed-gutter" aria-hidden="true"><div class="ed-nums"></div></div>
      <div class="ed-pane">
        <div class="ed-cur" aria-hidden="true" hidden></div>
        <pre class="ed-hl" aria-hidden="true"><span class="ed-shift"><code></code><span class="ed-hits"></span></span></pre>
        <textarea class="ed-ta mono" spellcheck="false" autocapitalize="off" autocorrect="off"
          aria-label="文件内容" ${readonly ? 'readonly' : ''}></textarea>
      </div>
    </div>

    <div class="ed-status">
      <span class="ed-pos">行 1，列 1</span>
      <span class="ed-sel" hidden></span>
      <span class="ed-grow"></span>
      <span class="ed-mode" hidden>轻量模式</span>
      <span class="ed-size"></span>
      <span class="ed-count-lines"></span>
      <span class="ed-eol">${eol}</span>
      <span class="ed-ind"></span>
      <span>UTF-8</span>
      <span class="ed-lang"></span>
    </div>`;
  document.body.append(dlg);

  const $ = (sel) => dlg.querySelector(sel);
  const act = (name) => dlg.querySelector(`[data-act="${name}"]`);
  const ta = $('.ed-ta');
  const shift = $('.ed-shift');
  const code = $('.ed-hl code');
  const hits = $('.ed-hits');
  const nums = $('.ed-nums');
  const cur = $('.ed-cur');
  const findBar = $('.ed-find');
  const qIn = $('.ed-q');
  const rIn = $('.ed-r');

  // Directory and file name are split so the ellipsis can only ever eat the
  // directory — the name is the part that says which file you are looking at.
  const cut = path.lastIndexOf('/') + 1;
  $('.ed-dir').textContent = path.slice(0, cut);
  $('.ed-base').textContent = path.slice(cut);
  $('.ed-file').title = path;
  $('.ed-lang').textContent = lang.label;
  $('.ed-eol').title = eol === 'CRLF' ? '换行符 CRLF（Windows），保存时保持不变' : '换行符 LF';
  ta.value = body;

  let saved = body;
  let composing = false;
  let dirty = false;
  let curTop = 0;
  let curHeight = 0;
  let lastLineCount = -1;
  let charWidth = 8;
  let version = 0;

  const indent = () => INDENTS[prefs.indent];
  const canPaint = () => !light && !!compiled(lang.family);

  const storePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* private mode: the editor still works, it just forgets */
    }
  };

  /* ------------------------------------------------------------- layout --- */

  const countLines = (v) => {
    let n = 1;
    for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) === 10) n++;
    return n;
  };

  const lineAt = (pos) => {
    const v = ta.value;
    let n = 0;
    for (let i = 0; i < pos && i < v.length; i++) if (v.charCodeAt(i) === 10) n++;
    return n;
  };

  const plainNums = (n) => {
    let out = '';
    for (let i = 1; i <= n; i++) out += `<div class="ln">${i}</div>`;
    return out;
  };

  /** The gutter in 自动换行 mode carries a hidden copy of each line, so the
      browser gives every row exactly the height its wrapped text occupies. */
  const mirrorNums = (v) => {
    const arr = v.split('\n');
    let out = '';
    for (let i = 0; i < arr.length; i++) {
      // A blank line still needs a line box, hence the zero-width space.
      out += `<div class="ln"><i>${i + 1}</i><s>${escHtml(arr[i]) || '\u200b'}</s></div>`;
    }
    return out;
  };

  const measure = () => {
    const cs = getComputedStyle(ta);
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;top:0;left:0';
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.textContent = 'x'.repeat(50);
    dlg.append(probe);
    charWidth = probe.getBoundingClientRect().width / 50 || 8;
    probe.remove();
    // Gutter first — it takes its width from the widest line number, and what is
    // left over is what the text has to wrap inside.
    const digits = String(Math.max(lastLineCount, 1)).length;
    // + the row's 12px indent, the gutter's 8px padding and its 1px rule
    dlg.style.setProperty('--ed-gw', `${Math.ceil(digits * charWidth) + 24}px`);
    // The paint layer has no scrollbar of its own, so it is told the textarea's
    // real content width rather than left to work it out — a few pixels either
    // way and every wrapped line breaks in a different place than the text does.
    const inner = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    dlg.style.setProperty('--ed-w', `${Math.max(0, inner)}px`);
  };

  const syncScroll = () => {
    const top = ta.scrollTop;
    nums.style.transform = `translateY(${-top}px)`;
    // One transform for the whole paint layer, match boxes included — they were
    // measured against the same origin, so they ride along for free.
    shift.style.transform = `translate(${-ta.scrollLeft}px, ${-top}px)`;
    if (!cur.hidden) cur.style.transform = `translateY(${curTop - top}px)`;
  };

  /* offsetTop, not getBoundingClientRect: the dialog opens with a scale
     animation, and a rect measured mid-flight is a scaled number that then gets
     written back as an unscaled length — which is how the current-line band
     ends up a dozen pixels above the line it is meant to be marking. Offsets are
     layout values and ignore transforms entirely. */
  const rowBox = (row) => ({ top: row.offsetTop, height: row.offsetHeight });

  const markCurrentLine = () => {
    const row = nums.children[lineAt(ta.selectionStart)];
    nums.querySelector('.ln.on')?.classList.remove('on');
    if (!row) {
      cur.hidden = true;
      return;
    }
    row.classList.add('on');
    const box = rowBox(row);
    curTop = box.top;
    curHeight = box.height;
    cur.hidden = false;
    cur.style.height = `${curHeight}px`;
    syncScroll();
  };

  function render() {
    const v = ta.value;
    const n = countLines(v);
    const grew = String(n).length !== String(Math.max(lastLineCount, 1)).length;
    const countChanged = n !== lastLineCount;
    lastLineCount = n;
    // Crossing 99 → 100 widens the gutter, which narrows the text column, which
    // changes where every wrapped line breaks. Re-measure before drawing.
    if (grew) measure();
    hits.replaceChildren();
    if (prefs.wrap && !light) nums.innerHTML = mirrorNums(v);
    else if (countChanged) nums.innerHTML = plainNums(n);
    // In 轻量模式 the gutter cannot follow wrapped lines, and a column of numbers
    // that points at the wrong rows is worse than no column at all.
    dlg.classList.toggle('nogutter', light && prefs.wrap);
    // Even with nothing to colour the layer is still filled and still laid out,
    // only made invisible: it is what the find bar measures a match against.
    // Above 轻量模式's threshold it is dropped entirely, cost being the point.
    code.innerHTML = light ? '' : `${canPaint() ? paint(v, lang.family) : escHtml(v)}\n`;
    $('.ed-count-lines').textContent = `${n} 行`;
    markCurrentLine();
  }

  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };

  /* ------------------------------------------------------------- status --- */

  const setDirty = (on) => {
    if (dirty === on) return;
    dirty = on;
    $('.ed-dirty').hidden = !on;
    dlg.classList.toggle('is-dirty', on);
  };

  function updateStatus() {
    const v = ta.value;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    let line = 1;
    let start = 0;
    for (let i = 0; i < s; i++) {
      if (v.charCodeAt(i) === 10) {
        line++;
        start = i + 1;
      }
    }
    $('.ed-pos').textContent = `行 ${line}，列 ${s - start + 1}`;
    const sel = $('.ed-sel');
    if (e > s) {
      const lines = countLines(v.slice(s, e));
      sel.hidden = false;
      sel.textContent = lines > 1 ? `已选 ${e - s} 字符 / ${lines} 行` : `已选 ${e - s} 字符`;
    } else {
      sel.hidden = true;
    }
  }

  /** The size on disk, so it only moves when a save has actually moved it. */
  const refreshSize = (n) => {
    $('.ed-size').textContent = bytes(n);
  };
  refreshSize(size);

  /* --------------------------------------------------------------- edits --- */

  /**
   * The one door every programmatic change goes through. execCommand is the
   * only write that the browser records on its own undo stack; setRangeText is
   * the fallback for anything that has finally removed it, at the price of that
   * one edit not being undoable.
   */
  function edit(from, to, text, selFrom, selTo) {
    if (readonly) return;
    if (from === to && text === '') return;
    ta.focus();
    ta.setSelectionRange(from, to);
    let ok = false;
    try {
      ok = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }
    if (!ok) {
      ta.setRangeText(text, from, to, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (selFrom != null) ta.setSelectionRange(selFrom, selTo ?? selFrom);
    onChanged();
  }

  const lineStart = (pos) => ta.value.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = (pos) => {
    const i = ta.value.indexOf('\n', pos);
    return i === -1 ? ta.value.length : i;
  };

  /** The whole-line span covering the selection — what indent/comment/move act on. */
  const lineBlock = () => {
    const a = lineStart(ta.selectionStart);
    // A selection that ends exactly at a line start has not really reached that
    // line; without this, indenting three selected lines indents four.
    const endPos = ta.selectionEnd > ta.selectionStart && ta.value[ta.selectionEnd - 1] === '\n'
      ? ta.selectionEnd - 1
      : ta.selectionEnd;
    return [a, lineEnd(endPos)];
  };

  function indentLines(out) {
    const [a, b] = lineBlock();
    const { unit, width } = indent();
    const before = ta.value.slice(a, b);
    const next = before
      .split('\n')
      .map((l) => {
        if (!out) return l.trim() === '' ? l : unit + l;
        if (l.startsWith('\t')) return l.slice(1);
        const lead = /^ +/.exec(l);
        return lead ? l.slice(Math.min(lead[0].length, width)) : l;
      })
      .join('\n');
    if (next === before) return;
    edit(a, b, next, a, a + next.length);
  }

  function toggleComment() {
    const token = LINE_COMMENT[lang.family];
    const [a, b] = lineBlock();
    const before = ta.value.slice(a, b);
    if (!token) {
      const pair = BLOCK_COMMENT[lang.family];
      if (!pair) return;
      const trimmed = before.trim();
      const next = trimmed.startsWith(pair[0]) && trimmed.endsWith(pair[1])
        ? before.replace(pair[0], '').replace(new RegExp(`${pair[1].replace(/[*/]/g, '\\$&')}\\s*$`), '')
        : `${pair[0]} ${before} ${pair[1]}`;
      return edit(a, b, next, a, a + next.length);
    }
    const lines = before.split('\n');
    const real = lines.filter((l) => l.trim() !== '');
    const allOn = real.length > 0 && real.every((l) => l.trimStart().startsWith(token));
    const pad = allOn ? null : Math.min(...real.map((l) => l.length - l.trimStart().length));
    const next = lines
      .map((l) => {
        if (l.trim() === '') return l;
        if (allOn) return l.replace(new RegExp(`^(\\s*)${token.replace(/[/*-]/g, '\\$&')} ?`), '$1');
        return l.slice(0, pad) + token + ' ' + l.slice(pad);
      })
      .join('\n');
    edit(a, b, next, a, a + next.length);
  }

  function duplicate() {
    const { selectionStart: s, selectionEnd: e } = ta;
    if (s !== e) {
      const text = ta.value.slice(s, e);
      return edit(e, e, text, e, e + text.length);
    }
    const a = lineStart(s);
    const b = lineEnd(s);
    const text = ta.value.slice(a, b);
    edit(b, b, `\n${text}`, s + text.length + 1);
  }

  function deleteLines() {
    const [a, b] = lineBlock();
    const end = b < ta.value.length ? b + 1 : b;
    const from = end === b && a > 0 ? a - 1 : a;
    edit(from, end, '', Math.min(from, ta.value.length));
  }

  function moveLines(dir) {
    const [a, b] = lineBlock();
    const v = ta.value;
    const block = v.slice(a, b);
    const keepStart = ta.selectionStart - a;
    const keepEnd = ta.selectionEnd - a;
    if (dir < 0) {
      if (a === 0) return;
      const prevA = lineStart(a - 1);
      const prev = v.slice(prevA, a - 1);
      const next = `${block}\n${prev}`;
      edit(prevA, b, next, prevA + keepStart, prevA + keepEnd);
    } else {
      if (b >= v.length) return;
      const nextB = lineEnd(b + 1);
      const after = v.slice(b + 1, nextB);
      const next = `${after}\n${block}`;
      const base = a + after.length + 1;
      edit(a, nextB, next, base + keepStart, base + keepEnd);
    }
  }

  /** Enter keeps the current indent, and opens a block out one level further. */
  function newline() {
    const { selectionStart: s, selectionEnd: e } = ta;
    const v = ta.value;
    const head = v.slice(lineStart(s), s);
    const lead = (/^[ \t]*/.exec(head) || [''])[0];
    const prev = head.trimEnd().slice(-1);
    const next = v[e];
    const unit = indent().unit;
    const opens = '([{'.includes(prev) || (prev === ':' && (lang.family === 'py' || lang.family === 'sh'));
    if (opens && next && PAIRS[prev] === next) {
      const text = `\n${lead}${unit}\n${lead}`;
      return edit(s, e, text, s + 1 + lead.length + unit.length);
    }
    edit(s, e, `\n${lead}${opens ? unit : ''}`);
  }

  /** Home lands on the first real character, and only then on column 0. */
  function smartHome(extend) {
    const s = ta.selectionStart;
    const a = lineStart(s);
    const l = ta.value.slice(a, lineEnd(s));
    const firstReal = a + (l.length - l.trimStart().length);
    const target = s === firstReal ? a : firstReal;
    if (extend) ta.setSelectionRange(Math.min(target, ta.selectionEnd), Math.max(target, ta.selectionEnd));
    else ta.setSelectionRange(target, target);
    onCaret();
  }

  /* ------------------------------------------------------------- reveal --- */

  const lineHeight = () => parseFloat(getComputedStyle(ta).lineHeight) || 18;

  function reveal(pos = ta.selectionStart) {
    const row = nums.children[lineAt(pos)];
    const box = row ? rowBox(row) : null;
    const top = box ? box.top : lineAt(pos) * lineHeight();
    const h = box ? box.height : lineHeight();
    const view = ta.clientHeight;
    if (top < ta.scrollTop) ta.scrollTop = Math.max(0, top - view / 3);
    else if (top + h > ta.scrollTop + view) ta.scrollTop = top + h - view + view / 3;
    if (!prefs.wrap) {
      const col = pos - lineStart(pos);
      const x = col * charWidth;
      if (x < ta.scrollLeft || x > ta.scrollLeft + ta.clientWidth - 60) {
        ta.scrollLeft = Math.max(0, x - ta.clientWidth / 2);
      }
    }
    syncScroll();
  }

  /* --------------------------------------------------------------- find --- */

  /**
   * A textarea's selection is only painted while the textarea has focus, and
   * the find box wants to keep it — so the current match is drawn instead.
   *
   * The paint layer holds exactly the same characters in exactly the same box,
   * so a DOM Range over it gives the browser's own rectangles for the match:
   * correct across wrapped lines, tabs and double-width CJK, with no arithmetic
   * of ours anywhere near it. `getClientRects()` returns one box per line the
   * match spans, which is why this loops.
   */
  function rangeIn(from, to) {
    const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let seen = 0;
    let started = false;
    let node;
    while ((node = walk.nextNode())) {
      const len = node.nodeValue.length;
      if (!started && seen + len >= from) {
        range.setStart(node, from - seen);
        started = true;
      }
      if (started && seen + len >= to) {
        range.setEnd(node, to - seen);
        return range;
      }
      seen += len;
    }
    return null;
  }

  function showHit(from, to) {
    hits.replaceChildren();
    if (light || from == null) return;
    const range = rangeIn(from, to);
    if (!range) return;
    const base = code.getBoundingClientRect();
    // Rects come back through whatever transform the dialog is under (it opens
    // with a scale animation); the boxes go back in as plain lengths inside that
    // same transform, so the measurement has to be divided back out first.
    const k = base.width / code.offsetWidth || 1;
    for (const r of range.getClientRects()) {
      const box = document.createElement('span');
      box.className = 'ed-hit';
      box.style.cssText = `left:${(r.left - base.left) / k}px;top:${(r.top - base.top) / k}px;width:${
        r.width / k
      }px;height:${r.height / k}px`;
      hits.append(box);
    }
  }

  const flags = { cs: false, word: false, re: false };
  let matches = [];
  let matchesFor = null;
  let active = -1;

  const searchRe = (global) => {
    const q = qIn.value;
    if (!q) return null;
    let src = flags.re ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (flags.word) src = `\\b(?:${src})\\b`;
    return new RegExp(src, `${global ? 'g' : ''}${flags.cs ? '' : 'i'}`);
  };

  function collect() {
    // Keyed on a document counter, not on the text: re-hashing half a megabyte
    // on every keystroke is exactly the cost this cache exists to avoid.
    const key = `${version}|${flags.cs}${flags.word}${flags.re}|${qIn.value}`;
    if (matchesFor === key) return;
    matchesFor = key;
    matches = [];
    qIn.classList.remove('bad');
    let re;
    try {
      re = searchRe(true);
    } catch {
      qIn.classList.add('bad');
      return;
    }
    if (!re) return;
    const v = ta.value;
    let m;
    while ((m = re.exec(v))) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      matches.push([m.index, m.index + m[0].length]);
      if (matches.length >= 20000) break;
    }
  }

  function paintCount() {
    const el = $('.ed-count');
    if (!qIn.value) el.textContent = '—';
    else if (qIn.classList.contains('bad')) el.textContent = '表达式无效';
    else if (!matches.length) el.textContent = '无结果';
    else el.textContent = `${active >= 0 ? active + 1 : '·'}/${matches.length}`;
  }

  function jump(dir) {
    collect();
    if (!matches.length) return paintCount();
    // Focus has to visit the textarea for the hit to be selected and painted,
    // but it goes straight back to the box it came from — otherwise the Enter
    // that found this match would insert a newline the next time it is pressed.
    const from = dir > 0 ? ta.selectionEnd : ta.selectionStart;
    const inBox = document.activeElement === qIn || document.activeElement === rIn;
    // In 轻量模式 there is no paint layer to draw the match on, so the textarea
    // keeps focus and the real selection does the job instead.
    const back = inBox && !light ? document.activeElement : null;
    let i = dir > 0
      ? matches.findIndex(([a]) => a >= from)
      : (() => {
          for (let k = matches.length - 1; k >= 0; k--) if (matches[k][1] <= from) return k;
          return -1;
        })();
    if (i === -1) i = dir > 0 ? 0 : matches.length - 1;
    active = i;
    ta.focus();
    ta.setSelectionRange(matches[i][0], matches[i][1]);
    reveal(matches[i][0]);
    onCaret();
    paintCount();
    showHit(matches[i][0], matches[i][1]);
    back?.focus();
  }

  function replaceCurrent() {
    collect();
    if (!matches.length) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    const hit = matches.findIndex(([a, b]) => a === s && b === e);
    if (hit === -1) return jump(1);
    let out = rIn.value;
    if (flags.re) {
      try {
        out = ta.value.slice(s, e).replace(searchRe(false), rIn.value);
      } catch {
        /* fall back to the literal replacement */
      }
    }
    edit(s, e, out, s + out.length);
    jump(1);
  }

  function replaceAll() {
    collect();
    if (!matches.length) return toast('没有可替换的内容', '');
    let re;
    try {
      re = searchRe(true);
    } catch {
      return;
    }
    const count = matches.length;
    const next = ta.value.replace(re, flags.re ? rIn.value : () => rIn.value);
    edit(0, ta.value.length, next, 0);
    active = -1;
    collect();
    paintCount();
    toast(`替换了 ${count} 处`, 'ok');
  }

  function toggleFind(on) {
    const show = on ?? findBar.hidden;
    findBar.hidden = !show;
    act('find').setAttribute('aria-pressed', String(show));
    if (show) {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel && !sel.includes('\n')) qIn.value = sel;
      qIn.focus();
      qIn.select();
      collect();
      paintCount();
    } else {
      hits.replaceChildren();
      ta.focus();
    }
  }

  /* ---------------------------------------------------------------- save --- */

  async function doSave() {
    if (readonly) return toast('这个文件被截断了，不能保存', 'err');
    const btn = act('save');
    if (btn.disabled) return;
    btn.disabled = true;
    const text = eol === 'CRLF' ? ta.value.replace(/\n/g, '\r\n') : ta.value;
    try {
      const res = await save(text);
      saved = ta.value;
      setDirty(false);
      refreshSize(res?.size ?? new TextEncoder().encode(text).length);
      toast('已保存', 'ok');
      onSaved?.();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function tryClose() {
    if (!dirty) return dlg.close();
    const yes = await ask({
      title: '放弃未保存的修改？',
      ok: '放弃',
      kind: 'danger',
      hint: `<div class="mono" style="margin:6px 0;overflow-wrap:anywhere">${escHtml(path)}</div>还没保存，关掉就没了。`,
    });
    if (yes) dlg.close();
  }

  /* ------------------------------------------------------------- wiring --- */

  const onChanged = () => {
    version++;
    setDirty(ta.value !== saved);
    schedule();
    updateStatus();
  };

  const onCaret = () => {
    updateStatus();
    markCurrentLine();
  };

  ta.addEventListener('input', onChanged);
  ta.addEventListener('scroll', syncScroll, { passive: true });
  ta.addEventListener('click', onCaret);
  ta.addEventListener('keyup', onCaret);
  ta.addEventListener('select', onCaret);
  document.addEventListener('selectionchange', selectionWatch);
  function selectionWatch() {
    if (document.activeElement === ta) onCaret();
  }

  ta.addEventListener('compositionstart', () => {
    composing = true;
    dlg.classList.add('composing');
  });
  ta.addEventListener('compositionend', () => {
    composing = false;
    dlg.classList.remove('composing');
    schedule();
  });

  ta.addEventListener('keydown', (ev) => {
    if (composing || ev.isComposing) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const k = ev.key;

    if (mod && !ev.altKey) {
      const lower = k.toLowerCase();
      if (lower === 's') {
        ev.preventDefault();
        return void doSave();
      }
      if (lower === 'f' || (lower === 'h' && !ev.shiftKey)) {
        ev.preventDefault();
        return toggleFind(true);
      }
      if (lower === 'g') {
        ev.preventDefault();
        return void gotoLine();
      }
      if (lower === 'd' && !ev.shiftKey) {
        ev.preventDefault();
        return duplicate();
      }
      if (lower === 'k' && ev.shiftKey) {
        ev.preventDefault();
        return deleteLines();
      }
      if (k === '/') {
        ev.preventDefault();
        return toggleComment();
      }
      if (lower === 'y' || (lower === 'z' && ev.shiftKey)) {
        ev.preventDefault();
        document.execCommand('redo');
        return onChanged();
      }
      if (k === 'Home' || k === 'End') return; // let the browser jump to the ends
    }

    if (ev.altKey && !mod && (k === 'ArrowUp' || k === 'ArrowDown')) {
      ev.preventDefault();
      return moveLines(k === 'ArrowUp' ? -1 : 1);
    }

    if (k === 'Tab') {
      const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
      if (ev.shiftKey) {
        // Shift+Tab on a line with nothing to outdent is left to the browser, so
        // a keyboard user is never sealed inside the textarea.
        const head = ta.value.slice(lineStart(ta.selectionStart), ta.selectionStart);
        if (!multi && !/^[ \t]+$/.test(head) && head !== '') return;
        ev.preventDefault();
        return indentLines(true);
      }
      ev.preventDefault();
      if (multi) return indentLines(false);
      const { unit, width } = indent();
      const col = ta.selectionStart - lineStart(ta.selectionStart);
      // Spaces go to the next tab stop rather than always inserting a full unit,
      // so a Tab pressed mid-line still lands on the grid the file is written on.
      const fill = unit === '\t' ? '\t' : ' '.repeat(width - (col % width));
      return edit(ta.selectionStart, ta.selectionEnd, fill);
    }

    if (k === 'Enter' && !mod && !ev.shiftKey && !readonly) {
      ev.preventDefault();
      return newline();
    }

    if (k === 'Home' && !mod) {
      ev.preventDefault();
      return smartHome(ev.shiftKey);
    }

    // Everything below is about a character being typed. A chord is not that —
    // and on a keyboard where `{` needs AltGr, ctrl+alt arrives with it, so the
    // pair logic has to stay out of the way rather than guess.
    if (readonly || mod || ev.altKey) return;

    const { selectionStart: s, selectionEnd: e } = ta;
    if (PAIRS[k]) {
      if (s !== e) {
        // Wrapping a selection is the one auto-pair behaviour nobody argues
        // with: it never eats a keystroke, it only ever adds two.
        ev.preventDefault();
        const inner = ta.value.slice(s, e);
        return edit(s, e, `${k}${inner}${PAIRS[k]}`, s + 1, e + 1);
      }
      const after = ta.value[s] ?? '';
      const before = ta.value[s - 1] ?? '';
      const quote = k === '"' || k === "'" || k === '`';
      // Don't auto-close a quote against a word — `don't` and `it's` are text,
      // not the start of a string.
      if (quote && (/[\w"'`]/.test(after) || /[\w\\]/.test(before))) return;
      if (!quote && /[\w([{]/.test(after)) return;
      ev.preventDefault();
      return edit(s, e, k + PAIRS[k], s + 1);
    }
    if (CLOSERS.has(k) && s === e && ta.value[s] === k) {
      ev.preventDefault();
      ta.setSelectionRange(s + 1, s + 1);
      return onCaret();
    }
    if (k === 'Backspace' && s === e && s > 0) {
      const before = ta.value[s - 1];
      if (PAIRS[before] && ta.value[s] === PAIRS[before]) {
        ev.preventDefault();
        return edit(s - 1, s + 1, '');
      }
    }
  });

  /* Paste of a big blob can flip the editor into 轻量模式 mid-session; check
     after the value has actually changed rather than guessing from the event. */
  ta.addEventListener('paste', () => {
    setTimeout(() => {
      const heavy = ta.value.length > LIGHT_ABOVE;
      if (heavy !== light) applyLight(heavy);
    }, 0);
  });

  function applyLight(on) {
    light = on;
    dlg.classList.toggle('light', on);
    dlg.classList.toggle('plain', !canPaint());
    $('.ed-mode').hidden = !on;
    lastLineCount = -1;
    render();
  }

  async function gotoLine() {
    const total = countLines(ta.value);
    const answer = await ask({
      title: '跳转到行',
      label: `行号（1 – ${total}）`,
      value: String(lineAt(ta.selectionStart) + 1),
      ok: '跳转',
    });
    if (answer === null) return;
    const n = Math.min(Math.max(parseInt(answer, 10) || 1, 1), total);
    let pos = 0;
    for (let i = 1; i < n; i++) pos = ta.value.indexOf('\n', pos) + 1;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    reveal(pos);
    onCaret();
  }

  const applyWrap = () => {
    dlg.classList.toggle('wrap', prefs.wrap);
    act('wrap').setAttribute('aria-pressed', String(prefs.wrap));
    ta.scrollLeft = 0;
    lastLineCount = -1;
    measure();
    render();
  };

  const applyIndent = () => {
    const it = indent();
    dlg.style.setProperty('--ed-tab', it.width);
    $('.ed-ind-label').textContent = it.label;
    $('.ed-ind').textContent = it.label;
    measure();
  };

  const applyFont = () => {
    // The *preference*; a touch device clamps it up to 16px in CSS, because
    // anything smaller makes iOS zoom the panel in on focus and never back out.
    dlg.style.setProperty('--ed-fs-pref', `${prefs.font}px`);
    measure();
    lastLineCount = -1;
    render();
  };

  dlg.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act], [data-flag]');
    if (!btn || !dlg.contains(btn)) return;
    const flag = btn.dataset.flag;
    if (flag) {
      flags[flag] = !flags[flag];
      btn.setAttribute('aria-pressed', String(flags[flag]));
      matchesFor = null;
      active = -1;
      collect();
      return paintCount();
    }
    switch (btn.dataset.act) {
      case 'save':
        return void doSave();
      case 'close':
        return void tryClose();
      case 'max': {
        const on = dlg.classList.toggle('max');
        btn.innerHTML = icon(on ? 'minimize' : 'maximize');
        btn.title = on ? '还原' : '最大化';
        btn.setAttribute('aria-label', btn.title);
        requestAnimationFrame(() => {
          measure();
          lastLineCount = -1;
          render();
        });
        return;
      }
      case 'undo':
        ta.focus();
        document.execCommand('undo');
        return onChanged();
      case 'redo':
        ta.focus();
        document.execCommand('redo');
        return onChanged();
      case 'find':
        return toggleFind();
      case 'find-close':
        return toggleFind(false);
      case 'goto':
        return void gotoLine();
      case 'wrap':
        prefs.wrap = !prefs.wrap;
        storePrefs();
        return applyWrap();
      case 'indent':
        prefs.indent = (prefs.indent + 1) % INDENTS.length;
        storePrefs();
        return applyIndent();
      case 'font':
        prefs.font = FONTS[(FONTS.indexOf(prefs.font) + 1) % FONTS.length];
        storePrefs();
        return applyFont();
      case 'prev':
        return jump(-1);
      case 'next':
        return jump(1);
      case 'rep':
        return replaceCurrent();
      case 'repall':
        return replaceAll();
      default:
    }
  });

  qIn.addEventListener('input', () => {
    matchesFor = null;
    active = -1;
    hits.replaceChildren();
    collect();
    paintCount();
  });
  for (const input of [qIn, rIn]) {
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (input === rIn) return replaceCurrent();
        return jump(ev.shiftKey ? -1 : 1);
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        toggleFind(false);
      }
    });
  }

  // Esc closes the find bar first — the second press is the one that means
  // "close the file", which is what `cancel` handles.
  dlg.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !findBar.hidden) {
      ev.preventDefault();
      toggleFind(false);
    }
  });

  dlg.addEventListener('cancel', (ev) => {
    if (!dirty) return;
    ev.preventDefault();
    void tryClose();
  });

  const ro = new ResizeObserver(() => {
    measure();
    if (prefs.wrap) schedule();
    else markCurrentLine();
  });
  ro.observe(ta);

  dlg.addEventListener('close', () => {
    ro.disconnect();
    document.removeEventListener('selectionchange', selectionWatch);
    if (frame) cancelAnimationFrame(frame);
    dlg.remove();
  });

  applyIndent();
  applyFont();
  dlg.classList.toggle('wrap', prefs.wrap);
  act('wrap').setAttribute('aria-pressed', String(prefs.wrap));
  dlg.classList.toggle('light', light);
  dlg.classList.toggle('plain', !canPaint());
  $('.ed-mode').hidden = !light;

  dlg.showModal();
  measure();
  render();
  ta.focus();
  // Open at the top of the file: focusing a textarea otherwise drops the caret
  // at the end, which for a config file means opening on its last line.
  ta.setSelectionRange(0, 0);
  ta.scrollTop = 0;
  ta.scrollLeft = 0;
  onCaret();
  syncScroll();
  return dlg;
}
