export declare const PUBLIC_CHECKS: {
  readonly keysetIds: 2;
  readonly keysetsListed: 2;
  readonly mintQuote: 4;
  readonly meltQuote: 5;
  readonly checkState: 7;
};
export declare const CYCLE_CHECKS: {
  readonly minted: 4;
  readonly dleq: 12;
  readonly swap: 3;
  readonly doubleSpendRejected: 3;
  readonly melted: 5;
  readonly spentState: 7;
};
export declare const CHECK_NUTS: typeof PUBLIC_CHECKS & typeof CYCLE_CHECKS;
