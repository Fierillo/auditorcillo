/** Public NUT checks vs the mint-swap-melt cycle: the page and the auditor share this list. */
export const PUBLIC_CHECKS = { keysetIds: 2, keysetsListed: 2, mintQuote: 4, meltQuote: 5, checkState: 7 };
export const CYCLE_CHECKS = { minted: 4, dleq: 12, swap: 3, doubleSpendRejected: 3, melted: 5, spentState: 7 };
export const CHECK_NUTS = { ...PUBLIC_CHECKS, ...CYCLE_CHECKS };
