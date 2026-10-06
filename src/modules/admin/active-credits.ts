export interface ActiveCreditRow {
  creditId: string;
  productName: string;
  totalCredits: number;
  usedCredits: number;
  expiresAt: Date | null;
}

export interface ActiveCreditDto extends ActiveCreditRow {
  remaining: number;
}

// The campus admin computes what is left as totalCredits - usedCredits, so both must be in the response.
export function toActiveCreditDto(row: ActiveCreditRow): ActiveCreditDto {
  return {
    creditId: row.creditId,
    productName: row.productName,
    totalCredits: row.totalCredits,
    usedCredits: row.usedCredits,
    remaining: Math.max(row.totalCredits - row.usedCredits, 0),
    expiresAt: row.expiresAt,
  };
}
