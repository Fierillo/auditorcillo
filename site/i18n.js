export const MESSAGES = {
  en: {
    title: 'Auditorcillo · Cashu mint ranking',
    heading: 'Auditorcillo',
    intro: 'Ranking of Cashu mints by observed behaviour, not by what they announce.',
    language: 'Language',
    colScore: 'Score',
    colAvailability: 'Availability',
    colNuts: 'NUTs',
    colKeysets: 'Keysets',
    colInfo: 'Info',
    loading: 'Loading…',
    updated: 'Updated: {time} (Buenos Aires time).',
    weights:
      'Score: availability {availability} %, announced NUT compliance {nuts} %, keyset consistency {keysets} %, info and contact {info} %. A mint that accepts spent tokens or publishes invalid keysets scores 0.',
    fraud: '⚠ Possible fraud: {alerts}',
    offline: 'Does not respond',
    checks: 'Checks',
    checksPassed: '{passed} of {total} checks',
    uptimeLabel: 'Uptime',
    latencyLabel: 'Latency',
    latencyMs: '{latency} ms',
    runsCount: '{runs} runs',
    unknownVersion: 'unknown version',
    loadError: 'Could not load ranking.json',
    check_keysetIds: 'Keyset IDs derive from their keys (NUT-02)',
    check_keysetsListed: 'Active keysets publish keys (NUT-02)',
    check_mintQuote: 'Creates a mint quote (NUT-04)',
    check_meltQuote: 'Creates a melt quote (NUT-05)',
    check_checkState: 'Reports token state (NUT-07)',
    check_minted: 'Issues tokens (NUT-04)',
    check_dleq: 'Signatures carry a valid DLEQ proof (NUT-12)',
    check_swap: 'Swaps tokens (NUT-03)',
    check_doubleSpendRejected: 'Rejects an already spent token (NUT-03)',
    check_melted: 'Pays a Lightning invoice (NUT-05)',
    check_spentState: 'Marks used tokens as spent (NUT-07)',
  },
  es: {
    title: 'Auditorcillo · ranking de mints Cashu',
    heading: 'Auditorcillo',
    intro: 'Ranking de mints Cashu según lo que se observa al probarlos, no según lo que anuncian.',
    language: 'Idioma',
    colScore: 'Puntaje',
    colAvailability: 'Disponibilidad',
    colNuts: 'NUTs',
    colKeysets: 'Keysets',
    colInfo: 'Info',
    loading: 'Cargando…',
    updated: 'Actualizado: {time} (hora de Buenos Aires).',
    weights:
      'Puntaje: disponibilidad {availability} %, cumplimiento de NUTs anunciados {nuts} %, consistencia de keysets {keysets} %, info y contacto {info} %. Un mint que acepta tokens gastados o publica keysets inválidos queda en 0.',
    fraud: '⚠ Posible fraude: {alerts}',
    offline: 'No responde',
    checks: 'Chequeos',
    checksPassed: '{passed} de {total} chequeos',
    uptimeLabel: 'Tiempo en línea',
    latencyLabel: 'Latencia',
    latencyMs: '{latency} ms',
    runsCount: '{runs} corridas',
    unknownVersion: 'versión desconocida',
    loadError: 'No se pudo cargar ranking.json',
    check_keysetIds: 'IDs de keyset derivan de sus claves (NUT-02)',
    check_keysetsListed: 'Keysets activos publican claves (NUT-02)',
    check_mintQuote: 'Crea cotización de mint (NUT-04)',
    check_meltQuote: 'Crea cotización de melt (NUT-05)',
    check_checkState: 'Informa estado de tokens (NUT-07)',
    check_minted: 'Emite tokens (NUT-04)',
    check_dleq: 'Firmas con prueba DLEQ válida (NUT-12)',
    check_swap: 'Intercambia tokens (NUT-03)',
    check_doubleSpendRejected: 'Rechaza un token ya gastado (NUT-03)',
    check_melted: 'Paga una factura Lightning (NUT-05)',
    check_spentState: 'Marca como gastados los tokens usados (NUT-07)',
  },
};

export function pickLanguage(stored, browserLanguage) {
  if (stored === 'en' || stored === 'es') return stored;
  return typeof browserLanguage === 'string' && browserLanguage.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function translate(messages, lang, key, vars) {
  const text = messages[lang]?.[key] ?? messages.en?.[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? `{${name}}`) : text;
}
