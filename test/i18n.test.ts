import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MESSAGES, pickLanguage, translate } from '../site/i18n.js';

describe('pickLanguage', () => {
  it('prefers a stored en or es over the browser language', () => {
    expect(pickLanguage('es', 'en-US')).toBe('es');
    expect(pickLanguage('en', 'es-AR')).toBe('en');
  });

  it('uses Spanish when nothing valid is stored and the browser language is es*', () => {
    expect(pickLanguage(null, 'es')).toBe('es');
    expect(pickLanguage(undefined, 'es-AR')).toBe('es');
    expect(pickLanguage('', 'ES-MX')).toBe('es');
    expect(pickLanguage('fr', 'es-AR')).toBe('es');
  });

  it('falls back to English otherwise', () => {
    expect(pickLanguage(null, 'en-US')).toBe('en');
    expect(pickLanguage(null, 'pt-BR')).toBe('en');
    expect(pickLanguage(null, undefined)).toBe('en');
    expect(pickLanguage('fr', 'de')).toBe('en');
  });
});

describe('translate', () => {
  const messages = {
    en: { hello: 'Hello {name}', onlyEn: 'English only' },
    es: { hello: 'Hola {name}' },
  };

  it('returns the string for the requested language and fills placeholders', () => {
    expect(translate(messages, 'es', 'hello', { name: 'Fierillo' })).toBe('Hola Fierillo');
    expect(translate(messages, 'en', 'hello', { name: 'Fierillo' })).toBe('Hello Fierillo');
  });

  it('falls back to English when the key is missing in the requested language', () => {
    expect(translate(messages, 'es', 'onlyEn')).toBe('English only');
  });

  it('drops a placeholder it has no value for instead of showing it', () => {
    expect(translate(messages, 'en', 'hello', {})).toBe('Hello ');
    expect(translate(messages, 'en', 'hello')).toBe('Hello ');
  });

  it('returns the key itself when it is missing in every language', () => {
    expect(translate(messages, 'pt', 'missing')).toBe('missing');
  });
});

describe('MESSAGES', () => {
  it('has the same keys in English and Spanish, all non-empty', () => {
    expect(Object.keys(MESSAGES.en).sort()).toEqual(Object.keys(MESSAGES.es).sort());
    for (const key of Object.keys(MESSAGES.en)) {
      expect(MESSAGES.en[key].length, key).toBeGreaterThan(0);
      expect(MESSAGES.es[key].length, key).toBeGreaterThan(0);
    }
  });

  it('labels the fees part, says it is not measured yet and that it will be measured with a real withdrawal', () => {
    expect(MESSAGES.en.colFees).toContain('Fees');
    expect(MESSAGES.es.colFees).toContain('Comisiones');
    expect(MESSAGES.en.partNotMeasured).toBe('Not measured');
    expect(MESSAGES.es.partNotMeasured).toBe('Sin medir');
    expect(MESSAGES.en.faqScoreA).toContain('Fees: shown but not counted yet; they will be measured with a real withdrawal.');
    expect(MESSAGES.es.faqScoreA).toContain('Comisiones: se muestran pero todavía no suman; se van a medir con un retiro real.');
  });

  it('never renders a placeholder left unfilled, in any message or language', () => {
    for (const lang of ['en', 'es'] as const) {
      for (const key of Object.keys(MESSAGES.en)) expect(translate(MESSAGES, lang, key, {}), `${lang}.${key}`).not.toMatch(/\{\w+\}/);
    }
  });

  it('fills the score FAQ from an older ranking.json that has no fees weight', () => {
    const old = { availability: 40, nuts: 30, keysets: 20, info: 10 };
    for (const lang of ['en', 'es'] as const) {
      const text = translate(MESSAGES, lang, 'faqScoreA', old);
      expect(text).not.toMatch(/[{}]/);
      for (const n of Object.values(old)) expect(text).toContain(`${n} %`);
    }
  });

  it('labels a timed-out mint in both languages', () => {
    expect(MESSAGES.en.timedOut).toBe('Timed out');
    expect(MESSAGES.es.timedOut).toBe('No respondió a tiempo');
  });

  it('labels a mint that had no time left to pay in both languages', () => {
    expect(MESSAGES.en.noTime).toBe('No time to pay this run');
    expect(MESSAGES.es.noTime).toBe('Sin tiempo para pagar en esta corrida');
  });

  it('labels the paid cycle timestamp and documents daily payment vs 3h checks in FAQ and index.html', () => {
    expect(MESSAGES.en.paidCheckedAt).toContain('{time}');
    expect(MESSAGES.es.paidCheckedAt).toContain('{time}');
    expect(MESSAGES.en.faqUpdateA).toMatch(/3 hours/i);
    expect(MESSAGES.en.faqUpdateA).toMatch(/once a day/i);
    expect(MESSAGES.es.faqUpdateA).toMatch(/3 horas/i);
    expect(MESSAGES.es.faqUpdateA).toMatch(/una vez por d[ií]a/i);
    expect(MESSAGES.en.faqChecksA).toMatch(/once a day/i);
    expect(MESSAGES.es.faqChecksA).toMatch(/una vez por d[ií]a/i);
    const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
    expect(html).toContain(MESSAGES.en.faqChecksA);
    expect(html).toContain(MESSAGES.en.faqUpdateA);
  });
});

describe('fee texts', () => {
  it('shows the declared and measured fee with their values and links the fees FAQ', () => {
    for (const lang of ['en', 'es'] as const) {
      expect(translate(MESSAGES, lang, 'feeDeclared', { sats: '0,1' })).toContain('0,1');
      expect(translate(MESSAGES, lang, 'feeMeasured', { pct: '2' })).toContain('2 %');
      expect(MESSAGES[lang].colFees).toMatch(/^\[faq-fees\].+\[\/faq-fees\]$/);
      expect(MESSAGES[lang].feesLegend).toMatch(/\[faq-fees\].+\[\/faq-fees\]/);
      expect(MESSAGES[lang]).not.toHaveProperty('feeDeclaredNote');
    }
    expect(MESSAGES.es.feeDeclared).toContain('declarada');
    expect(MESSAGES.en.feeDeclared).toContain('declared');
    expect(MESSAGES.es.feeMeasured).toContain('medida');
    expect(MESSAGES.en.feeMeasured).toContain('measured');
  });

  it('has a fees FAQ in index.html that says how fees are measured with real sats', () => {
    const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
    expect(html).toContain('<details id="faq-fees">');
    expect(html).toContain(MESSAGES.en.faqFeesQ);
    expect(html).toContain(MESSAGES.en.faqFeesA);
    expect(MESSAGES.en.faqFeesA).toContain('100 sats');
    expect(MESSAGES.es.faqFeesA).toContain('100 sats');
    expect(MESSAGES.es.faqFeesA).toContain('contamos con cuántos se quedó');
    expect(MESSAGES.en.faqFeesA).toContain('counts it as 0');
    expect(MESSAGES.es.faqFeesA).toContain('la cuenta como 0');
    expect(MESSAGES.en.faqFeesA).not.toContain('declares nothing');
    expect(MESSAGES.es.faqFeesA).not.toContain('no declara nada');
  });
});
