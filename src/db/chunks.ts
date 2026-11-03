// D1 accepts at most 100 bound values in one statement. The IN lists that grow with the bots, destinations or
// connections of a workspace are read in chunks of this many values, which leaves room for the other values of the
// statement.
export const IN_CHUNK_SIZE = 90;

// items split into arrays of at most size items, in order. Empty for no items.
export function chunks<T>(items: readonly T[], size = IN_CHUNK_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`invalid chunk size: ${size}`);
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}
