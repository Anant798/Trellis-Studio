let tail: Promise<void> = Promise.resolve();

/** Keep separate local model workers from overlapping on one physical GPU. */
export async function withGpuLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await run(); }
  finally { release(); }
}
