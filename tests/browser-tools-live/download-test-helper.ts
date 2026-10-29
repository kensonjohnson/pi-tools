import { chromium, type Browser, type BrowserServer } from "playwright";

/** Dedicated browser server lets a timed-out fixture kill only its own child. */
export async function within<T>(
  work: Promise<T>,
  timeoutMs = 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Fixture operation timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function launchFixtureBrowser(headless: boolean) {
  const server: BrowserServer = await chromium.launchServer({
    headless,
    channel: "chromium",
    timeout: 10000,
  });
  let browser: Browser;
  try {
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 5000 });
  } catch (error) {
    server.process().kill("SIGKILL");
    throw error;
  }
  return {
    browser,
    close: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const closed = await Promise.race([
          server.close().then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 3000);
          }),
        ]);
        const child = server.process();
        if (!closed && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) =>
            child.once("exit", () => resolve()),
          );
          if (!child.kill("SIGKILL"))
            throw new Error("Fixture browser kill was not dispatched.");
          await within(exited, 2000);
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
