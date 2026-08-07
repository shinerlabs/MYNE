const toBig = (value) => BigInt(value?.toString?.() ?? value ?? 0);

/** Standard (withdrawable) and burn (permanent) principal are both staked MYNE. */
export const totalStakedBaseUnits = (standard, burn) => toBig(standard) + toBig(burn);

export const totalStakedMyne = (standard, burn) => Number(totalStakedBaseUnits(standard, burn)) / 1e9;
