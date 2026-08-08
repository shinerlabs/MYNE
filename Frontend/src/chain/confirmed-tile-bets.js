export const mergeConfirmedTileBets = (onChainBets, localBets, tileCount = 25) => (
  Array.from({ length: tileCount }, (_, index) => {
    const chainAmount = BigInt(onChainBets?.[index] ?? 0n);
    const confirmedAmount = BigInt(localBets?.[index] ?? 0n);
    return chainAmount >= confirmedAmount ? chainAmount : confirmedAmount;
  })
);
