/** Let pending promise callbacks and zero-delay timers run. */
export const flush = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

/** Wait for an asynchronous condition, counting rounds rather than time. */
export async function until(
  condition: () => boolean,
  rounds = 400
): Promise<void> {
  for (let round = 0; !condition(); round++) {
    if (round >= rounds) {
      throw new Error('Timed out waiting for a condition.');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
