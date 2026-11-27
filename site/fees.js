/** A valid NUT-02 `input_fee_ppk`: a whole number of thousandths of a sat per token, 0 or more. The auditor and the page share this rule. */
export const isFeePpk = (value) => Number.isSafeInteger(value) && value >= 0;
/** A valid measured fee: the % of a real withdrawal the mint kept, any finite number, 0 or more. The score and the page share this rule. */
export const isKeptPct = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
