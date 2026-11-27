import { MESSAGES, pickLanguage, translate } from './i18n.js';
import {
  barPercent,
  checkSummary,
  checkTier,
  formatBuenosAiresTime,
  formatScore,
  headerMorph,
  isHighlightedRank,
  isScoredPart,
  isSafeIconUrl,
  matchesMint,
  mintInitials,
  normalizeQuery,
  openFaqTarget,
  parseLinkedText,
  partPercent,
  scoreTier,
  splitChecks,
  toTen,
} from './view.js';

const STORAGE_KEY = 'auditorcillo-lang';
const CREATION_BLOCK = { height: 976083, hash: '000000000000000000020655834cd975ec2b84b30a0e9c0fc95c93fd189e8161' };
const PARTS = [
  ['availability', 'colAvailability'],
  ['nuts', 'colNuts'],
  ['keysets', 'colKeysets'],
  ['fees', 'colFees'],
  ['info', 'colInfo'],
];
const FAQ_HREFS = {
  'faq-score': '#faq-score',
  'faq-cashu': '#faq-cashu',
  'faq-checks': '#faq-checks',
  'faq-update': '#faq-update',
  'faq-fraud': '#faq-fraud',
  'faq-source': '#faq-source',
};
const CREDIT_HREFS = {
  project: { href: 'https://github.com/Fierillo/auditorcillo', external: true },
  author: { href: 'https://github.com/Fierillo', external: true },
  block: { href: 'https://mempool.space/block/' + CREATION_BLOCK.hash, external: true },
};
const el = (tag, text, cls) => Object.assign(document.createElement(tag), { textContent: text ?? '', className: cls ?? '' });

function appendLinked(node, text, hrefs) {
  node.replaceChildren();
  for (const part of parseLinkedText(text)) {
    const href = part.type === 'link' ? hrefs[part.id] : null;
    const url = typeof href === 'string' ? href : href?.href;
    if (part.type === 'link' && url) {
      const a = document.createElement('a');
      a.className = hrefs === FAQ_HREFS || (typeof href === 'string' && href.startsWith('#')) ? 'faq-link' : '';
      a.href = url;
      a.textContent = part.value;
      if (href && href.external) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      node.append(a);
    } else {
      node.append(document.createTextNode(part.value));
    }
  }
  return node;
}

function revealFaqHash(hash = location.hash) {
  openFaqTarget(hash, document);
}

let lang = pickLanguage(localStorage.getItem(STORAGE_KEY), navigator.language);
let ranking = null;
let loadFailed = false;
let query = '';

const t = (key, vars) => translate(MESSAGES, lang, key, vars);
const checkLabel = (name) => {
  const key = 'check_' + name;
  const label = t(key);
  return label === key ? name : label;
};

function applyStatic() {
  document.documentElement.lang = lang;
  document.title = t('title');
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
  for (const btn of document.querySelectorAll('[data-lang]')) btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
  const intro = document.querySelector('.tagline');
  if (intro) appendLinked(intro, t('intro'), FAQ_HREFS);
  const height = CREATION_BLOCK.height.toLocaleString(lang === 'es' ? 'es-AR' : 'en-US');
  const block = document.getElementById('footer-block');
  if (block) appendLinked(block, t('footerBlock', { height }), CREDIT_HREFS);
  const credit = document.getElementById('footer-credit');
  if (credit) appendLinked(credit, t('footerCredit'), CREDIT_HREFS);
  fillScoreFaq();
}

function fillScoreFaq() {
  const node = document.getElementById('faq-score-a');
  if (node && ranking) node.textContent = t('faqScoreA', ranking.weights);
}

function displayTen(value, max, compact) {
  const n = toTen(value, max);
  if (n == null) return '—';
  const score = formatScore(n);
  return compact ? score : t('scoreOutOfTen', { score });
}

function portrait(m) {
  const fallback = el('div', mintInitials(m.name, m.url), 'avatar');
  fallback.setAttribute('aria-hidden', 'true');
  if (!isSafeIconUrl(m.iconUrl)) return fallback;
  const img = document.createElement('img');
  img.className = 'portrait';
  img.referrerPolicy = 'no-referrer';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.width = 40;
  img.height = 40;
  img.alt = m.name || m.url || '';
  img.addEventListener('error', () => img.replaceWith(fallback));
  img.src = m.iconUrl;
  return img;
}

/** With `percent` null the meter has no bar: the value is not a measurement. */
function meter(label, valueText, percent, tier) {
  const wrap = el('div', '', 'meter');
  const lab = el('div', '', 'meter-label');
  const name = label instanceof Node ? label : el('span', label);
  lab.append(name, el('span', valueText, 'value'));
  wrap.append(lab);
  if (percent == null) return wrap;
  const track = el('div', '', 'track');
  const fill = el('div', '', tier ? `fill ${tier}` : 'fill');
  fill.style.width = `${percent}%`;
  track.append(fill);
  wrap.append(track);
  return wrap;
}

function metaItem(label, value) {
  const item = el('span');
  item.append(el('span', label), document.createTextNode(' '), el('span', value, 'value'));
  return item;
}

function renderMint(m, i, weights, maxScore) {
  const card = el('li', '', 'card');
  if (isHighlightedRank(i, m.score.total)) card.classList.add('is-top', `place-${i + 1}`);
  if (m.score.alerts.length) card.classList.add('has-fraud');

  if (m.score.alerts.length) {
    const banner = el('div', '', 'banner');
    appendLinked(banner, t('fraud', { alerts: m.score.alerts.map(checkLabel).join(', ') }), FAQ_HREFS);
    card.append(banner);
  }

  const nameText = m.name || m.url;
  const who = el('div', '', 'who');
  const mint = el('div', '', 'mint');
  const portraitNode = portrait(m);
  const name = el('div', nameText, 'name');
  if (isSafeIconUrl(m.websiteUrl)) {
    const site = document.createElement('a');
    site.className = 'mint-site';
    site.href = m.websiteUrl;
    site.target = '_blank';
    site.rel = 'noopener noreferrer';
    site.setAttribute('aria-label', t('openMintSite', { name: nameText }));
    const hint = el('span', '↗', 'ext');
    hint.setAttribute('aria-hidden', 'true');
    name.append(hint);
    site.append(portraitNode, name);
    mint.append(site);
  } else {
    const plain = el('div', '', 'mint-plain');
    plain.append(portraitNode, name);
    mint.append(plain);
  }
  mint.append(el('div', m.url, 'url'));
  who.append(el('div', String(i + 1), 'rank'), mint);

  const total = displayTen(m.score.total, maxScore, true);
  const ring = el('div', '', `score ${scoreTier(m.score.total)}`);
  ring.style.setProperty('--pct', String(barPercent(m.score.total)));
  ring.setAttribute('aria-label', `${t('colScore')}: ${displayTen(m.score.total, maxScore)}`);
  ring.append(el('span', total));

  const head = el('div', '', 'card-head');
  head.append(who, ring);
  card.append(head);

  const uptimeValue = m.uptime == null ? '—' : `${formatScore(m.uptime)}%`;
  const uptimeTier = typeof m.uptime === 'number' ? scoreTier(m.uptime) : '';
  card.append(meter(appendLinked(el('span'), t('uptimeLabel'), FAQ_HREFS), uptimeValue, barPercent(m.uptime), uptimeTier));

  const parts = el('div', '', 'parts');
  for (const [part, labelKey] of PARTS) {
    const label = appendLinked(el('span'), t(labelKey), FAQ_HREFS);
    if (!isScoredPart(weights[part])) {
      parts.append(meter(label, t('partNotMeasured'), null));
      continue;
    }
    const value = m.score.parts[part];
    const percent = partPercent(value, weights[part]);
    parts.append(meter(label, displayTen(value, weights[part]), percent, scoreTier(percent)));
  }
  card.append(parts);

  const chips = el('div', '', 'chips');
  if (m.scam) chips.append(el('span', t('scam'), 'chip fail'));
  else if (m.pending) chips.append(el('span', t('pending'), 'chip mid'));
  if (m.timedOut) chips.append(el('span', t('timedOut'), 'chip mid'));
  else if (!m.online) chips.append(el('span', t('offline'), 'chip fail'));
  if (m.noTime) chips.append(el('span', t('noTime'), 'chip mid'));
  else if (m.notMeasured) chips.append(el('span', t('notMeasured', { check: checkLabel(m.notMeasured) }), 'chip mid'));
  const summary = checkSummary(m.checks, m.unrun);
  const tier = checkTier(summary.passed, summary.total);
  if (tier) {
    const chip = el('span', '', `chip ${tier}`);
    appendLinked(chip, t('checksPassed', summary), FAQ_HREFS);
    chips.append(chip);
  }
  if (chips.childElementCount) card.append(chips);

  const meta = el('div', '', 'meta');
  meta.append(
    metaItem(t('latencyLabel'), m.latencyMs == null ? '—' : t('latencyMs', { latency: m.latencyMs })),
    el('span', t('runsCount', { runs: m.history?.length ?? 0 })),
    el('span', m.version || t('unknownVersion'), 'value'),
  );
  card.append(meta);

  const names = Object.entries(m.checks ?? {});
  if (names.length) {
    const det = el('details', '', 'checks');
    det.append(el('summary', t('checks')));
    const appendList = (entries) => {
      const ul = el('ul');
      for (const [name, c] of entries) {
        ul.append(el('li', `${c.ok ? '✓' : '✗'} ${checkLabel(name)}${c.error ? ` (${c.error})` : ''}`, c.ok ? 'ok' : 'fail'));
      }
      det.append(ul);
    };
    const paidTime = formatBuenosAiresTime(m.paidCheckedAt, lang);
    const { publicChecks, cycleChecks } = splitChecks(m.checks);
    if (paidTime && cycleChecks.length) {
      if (publicChecks.length) appendList(publicChecks);
      det.append(el('p', t('paidCheckedAt', { time: paidTime }), 'checks-paid'));
      appendList(cycleChecks);
    } else {
      appendList(names);
      if (paidTime) det.append(el('p', t('paidCheckedAt', { time: paidTime }), 'checks-paid'));
    }
    card.append(det);
  }
  return card;
}

function render() {
  const list = document.getElementById('ranking');
  const clear = document.getElementById('search-clear');
  clear.hidden = normalizeQuery(query) === '';

  if (loadFailed) {
    list.replaceChildren(el('li', t('loadError'), 'status error'));
    return;
  }
  if (!ranking) return;
  const { generatedAt, weights, mints } = ranking;
  const maxScore = Object.values(weights).reduce((a, b) => a + b, 0);
  document.getElementById('updated').textContent = t('updated', {
    time: formatBuenosAiresTime(generatedAt, lang) ?? '',
  });
  fillScoreFaq();
  const shown = mints
    .map((m, i) => [m, i])
    .filter(([m]) => matchesMint(m.name, m.url, query));
  if (!shown.length) {
    const empty = el('li', '', 'status');
    const img = document.createElement('img');
    img.className = 'mascot-empty';
    img.src = 'logo.svg';
    img.width = 80;
    img.height = 92;
    img.alt = '';
    empty.append(img, el('p', t('searchEmpty', { query: query.trim() })));
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...shown.map(([m, i]) => renderMint(m, i, weights, maxScore)));
}

function setLang(next) {
  lang = next;
  localStorage.setItem(STORAGE_KEY, lang);
  applyStatic();
  render();
}

for (const btn of document.querySelectorAll('[data-lang]')) {
  btn.addEventListener('click', () => setLang(btn.dataset.lang));
}

const search = document.getElementById('search');
search.addEventListener('input', () => { query = search.value; render(); });
document.getElementById('search-clear').addEventListener('click', () => {
  query = '';
  search.value = '';
  render();
  search.focus();
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest('a[href^="#faq-"]');
  if (link) revealFaqHash(link.hash || link.getAttribute('href'));
});
window.addEventListener('hashchange', () => revealFaqHash());

const topbar = document.querySelector('.topbar');
const heroTitle = document.querySelector('h1');
const heroMark = heroTitle.querySelector('.wordmark');
const barMark = heroMark.cloneNode(true);
topbar.querySelector('.topbar-mark').append(barMark);
let morphBase = null;
let morphFrame = 0;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function measureMorph() {
  heroMark.style.transform = '';
  const big = heroMark.getBoundingClientRect();
  const small = barMark.getBoundingClientRect();
  morphBase = {
    big: { top: big.top + window.scrollY, left: big.left, width: big.width },
    small: { top: small.top, left: small.left, width: small.width },
  };
}
function applyMorph() {
  morphFrame = 0;
  if (!morphBase) measureMorph();
  const { x, scale, docked } = headerMorph(window.scrollY, morphBase.big, morphBase.small);
  heroMark.style.transform = reducedMotion.matches ? '' : `translateX(${x}px) scale(${scale})`;
  heroTitle.classList.toggle('docked', docked);
  topbar.classList.toggle('docked', docked);
}
const scheduleMorph = () => { if (!morphFrame) morphFrame = requestAnimationFrame(applyMorph); };
window.addEventListener('scroll', scheduleMorph, { passive: true });
window.addEventListener('resize', () => { morphBase = null; scheduleMorph(); });
scheduleMorph();
applyStatic();
revealFaqHash();
fetch('ranking.json', { cache: 'no-store' })
  .then((r) => r.json())
  .then((data) => { ranking = data; render(); })
  .catch(() => { loadFailed = true; render(); });
