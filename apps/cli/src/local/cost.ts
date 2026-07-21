/** Round to cents — API-equivalent costs are estimates; sub-cent float noise is not signal. */
function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export { roundUsd };
