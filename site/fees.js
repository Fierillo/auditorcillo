/** A valid NUT-02 `input_fee_ppk`: a whole number of thousandths of a sat per token, 0 or more. The auditor and the page share this rule. */
export const isFeePpk = (value) => Number.isSafeInteger(value) && value >= 0;
