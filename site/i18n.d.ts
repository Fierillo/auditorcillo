export const MESSAGES: { en: Record<string, string>; es: Record<string, string> };
export function pickLanguage(stored: string | null | undefined, browserLanguage: string | undefined): 'en' | 'es';
export function translate(
  messages: Record<string, Record<string, string> | undefined>,
  lang: string,
  key: string,
  vars?: Record<string, string | number>,
): string;
