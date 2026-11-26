export async function dispatch<T>(
  context: { queue: Promise<unknown>; exports?: Set<Promise<unknown>> },
  lane: "serial" | "parallel",
  invoke: () => Promise<T>,
) {
  if (lane === "serial") {
    const job = context.queue.then(invoke);
    context.queue = job.catch(() => undefined);
    return job;
  }
  const job = invoke();
  context.exports?.add(job);
  try {
    return await job;
  } finally {
    context.exports?.delete(job);
  }
}
