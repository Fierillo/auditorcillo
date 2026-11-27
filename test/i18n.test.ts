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
