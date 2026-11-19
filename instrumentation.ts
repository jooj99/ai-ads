// Starts the Workflow World when the server boots. In dev (the local world)
// this is what re-enqueues runs that were in flight when the process died;
// without it an interrupted run stays "running" forever after a restart. On
// Vercel the Vercel World recovers runs itself and start() is harmless.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "edge") {
    const { getWorld } = await import("workflow/runtime");
    const world = await getWorld();
    await world.start?.();
  }
}
