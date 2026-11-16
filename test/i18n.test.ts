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
});
