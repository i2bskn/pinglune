// Indirection so tests can control the current time.
export const clock = {
  now: (): number => Date.now(),
};
