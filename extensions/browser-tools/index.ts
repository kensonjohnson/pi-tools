import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import puppeteer from "puppeteer-core";
import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@mariozechner/pi-tui";

// ------------------------------------------------------------------------------
// Shared State
// ------------------------------------------------------------------------------

const BRAVE_PATH = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const CDP_URL = "http://localhost:9222";
const SCRAPING_DIR = `${process.env.HOME}/.cache/browser-tools`;

let braveProcess: ReturnType<typeof spawn> | null = null;

// ------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

async function isBraveRunning(): Promise<boolean> {
	try {
		const browser = await puppeteer.connect({
			browserURL: CDP_URL,
			defaultViewport: null,
		});
		await browser.disconnect();
		return true;
	} catch {
		return false;
	}
}

async function connectToBrave(): Promise<
	Awaited<ReturnType<typeof puppeteer.connect>>
> {
	try {
		const browser = await Promise.race([
			puppeteer.connect({
				browserURL: CDP_URL,
				defaultViewport: null,
			}),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Connection timed out")), 8000),
			),
		]);
		return browser;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("timed out") || message.includes("connect")) {
			throw new Error(
				"Brave not running on localhost:9222. Run browser_start first.",
			);
		}
		throw err;
	}
}

async function getActivePage(
	browser: Awaited<ReturnType<typeof puppeteer.connect>>,
) {
	const pages = await browser.pages();
	const page = pages.at(-1);
	if (!page) throw new Error("No active tab found");
	return page;
}

// ------------------------------------------------------------------------------
// Extension
// ------------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// No persistent connection to clean up — each tool connects/disconnects.
	// Brave process is left running on session_shutdown (user might want it).

	// ---------------------------------------------------------------------------
	// browser_start
	// ---------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_start",
		label: "Browser Start",
		description:
			"Launch Brave Browser with remote debugging on :9222. If Brave is already running on :9222, reports that instead of spawning a new instance.",
		parameters: Type.Object({
			profile: Type.Optional(
				Type.Boolean({
					description: "Copy your default Brave profile (cookies, logins, extensions) into the isolated scraping profile. Defaults to false.",
				}),
			),
		}),
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("browser_start"));
			if (args.profile) text += theme.fg("dim", " [with profile]");
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.details?.alreadyRunning
				? theme.fg("dim", "Brave already running")
				: theme.fg("success", "Brave started");
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params) {
			if (await isBraveRunning()) {
				return {
					content: [
						{
							type: "text",
							text: "Brave is already running on :9222",
						},
					],
					details: { alreadyRunning: true },
				};
			}

			// Ensure profile dir exists
			try {
				execSync(`mkdir -p "${SCRAPING_DIR}"`, { stdio: "ignore" });
			} catch {
				// ignore
			}

			// Remove Singleton locks to allow a new instance
			try {
				execSync(
					`rm -f "${SCRAPING_DIR}/SingletonLock" "${SCRAPING_DIR}/SingletonSocket" "${SCRAPING_DIR}/SingletonCookie"`,
					{ stdio: "ignore" },
				);
			} catch {
				// ignore
			}

			if (params.profile) {
				try {
					execSync(
						`rsync -a --delete \
							--exclude='SingletonLock' \
							--exclude='SingletonSocket' \
							--exclude='SingletonCookie' \
							--exclude='*/Sessions/*' \
							--exclude='*/Current Session' \
							--exclude='*/Current Tabs' \
							--exclude='*/Last Session' \
							--exclude='*/Last Tabs' \
							"${process.env.HOME}/Library/Application Support/BraveSoftware/Brave-Browser/" "${SCRAPING_DIR}/"`,
						{ stdio: "pipe" },
					);
				} catch {
					throw new Error("Failed to sync Brave profile. Ensure Brave has been launched at least once.");
				}
			}

			// Spawn Brave
			braveProcess = spawn(
				BRAVE_PATH,
				[
					"--remote-debugging-port=9222",
					`--user-data-dir=${SCRAPING_DIR}`,
					"--no-first-run",
					"--no-default-browser-check",
				],
				{ detached: true, stdio: "ignore" },
			);
			braveProcess.unref();

			if (!braveProcess.pid) {
				throw new Error("Failed to spawn Brave process");
			}

			// Wait for it to be ready
			let connected = false;
			for (let i = 0; i < 30; i++) {
				try {
					const browser = await puppeteer.connect({
						browserURL: CDP_URL,
						defaultViewport: null,
					});
					await browser.disconnect();
					connected = true;
					break;
				} catch {
					await sleep(500);
				}
			}

			if (!connected) {
				throw new Error(
					"Failed to connect to Brave after spawning. Check that the browser path is correct.",
				);
			}

			return {
				content: [
					{
						type: "text",
						text: "Brave started on :9222",
					},
				],
				details: { started: true },
			};
		},
	});

	// ---------------------------------------------------------------------------
	// browser_stop
	// ---------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_stop",
		label: "Browser Stop",
		description:
			"Kill the Brave process that was spawned by browser_start. If you didn't start Brave with browser_start, this tool will not kill it.",
		parameters: Type.Object({}),
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("browser_stop")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.details?.stopped
				? theme.fg("success", "Brave stopped")
				: theme.fg("dim", "No tracked process");
			return new Text(text, 0, 0);
		},
		async execute() {
			if (!braveProcess || braveProcess.exitCode !== null) {
				return {
					content: [
						{
							type: "text",
							text: "No Brave process tracked by this extension. If Brave is still running, close it manually.",
						},
					],
					details: { stopped: false },
				};
			}

			const pid = braveProcess.pid;
			if (!pid) {
				return {
					content: [
						{
							type: "text",
							text: "No valid Brave process to stop.",
						},
					],
					details: { stopped: false },
				};
			}

			// Kill the process group since we spawned detached
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// ignore
				}
			}

			// Give it a moment
			await sleep(500);

			braveProcess = null;

			return {
				content: [
					{
						type: "text",
						text: "Brave process stopped",
					},
				],
				details: { stopped: true },
			};
		},
	});

	// ---------------------------------------------------------------------------
	// browser_navigate
	// ---------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_navigate",
		label: "Browser Navigate",
		description:
			"Navigate the Brave browser to a URL. Reuses the current tab by default; use newTab to open a fresh tab.",
		parameters: Type.Object({
			url: Type.String({
				description: "URL to navigate to",
			}),
			newTab: Type.Optional(
				Type.Boolean({
					description: "Open in a new tab instead of reusing the current tab",
				}),
			),
			reload: Type.Optional(
				Type.Boolean({
					description:
						"Force a reload after navigating (useful for cache-busting)",
				}),
			),
		}),
		renderCall(args, theme) {
			const url = args.url.length > 60 ? `${args.url.slice(0, 57)}...` : args.url;
			let text = theme.fg("toolTitle", theme.bold("browser_navigate "));
			text += theme.fg("accent", url);
			if (args.newTab) text += theme.fg("dim", " [new tab]");
			if (args.reload) text += theme.fg("dim", " [reload]");
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const url = result.details?.url ?? "";
			const short = url.length > 60 ? `${url.slice(0, 57)}...` : url;
			const text = theme.fg("success", `Navigated to ${short}`);
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params) {
			const browser = await connectToBrave();
			try {
				if (params.newTab) {
					const page = await browser.newPage();
					await page.goto(params.url, { waitUntil: "domcontentloaded" });
				} else {
					const page = await getActivePage(browser);
					await page.goto(params.url, { waitUntil: "domcontentloaded" });
					if (params.reload) {
						await page.reload({ waitUntil: "domcontentloaded" });
					}
				}
				return {
					content: [
						{
							type: "text",
							text: `Navigated to ${params.url}`,
						},
					],
					details: { url: params.url, newTab: params.newTab ?? false },
				};
			} finally {
				await browser.disconnect();
			}
		},
	});

	// ---------------------------------------------------------------------------
	// browser_eval
	// ---------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_eval",
		label: "Browser Eval",
		description:
			"Execute JavaScript in the active tab and return the result. Supports async code. Returns objects/arrays as pretty-printed JSON, primitives as-is.",
		parameters: Type.Object({
			code: Type.String({
				description: "JavaScript code to execute. Access the page DOM and globals.",
			}),
		}),
		renderCall(args, theme) {
			const code = args.code.length > 50 ? `${args.code.slice(0, 47)}...` : args.code;
			let text = theme.fg("toolTitle", theme.bold("browser_eval "));
			text += theme.fg("accent", code);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const content = result.content[0];
			if (!content || content.type !== "text") {
				return new Text(theme.fg("dim", "No result"), 0, 0);
			}
			const txt = content.text;
			const preview = txt.length > 120 && !expanded ? `${txt.slice(0, 117)}...` : txt;
			return new Text(theme.fg("dim", preview), 0, 0);
		},
		async execute(_toolCallId, params) {
			const browser = await connectToBrave();
			try {
				const page = await getActivePage(browser);
				const result = await page.evaluate((c: string) => {
					const AsyncFunction = (async () => {}).constructor;
					return new AsyncFunction(`return (${c})`)();
				}, params.code);

				let text: string;
				if (result === null || result === undefined) {
					text = String(result);
				} else if (typeof result === "object") {
					text = JSON.stringify(result, null, 2);
				} else {
					text = String(result);
				}

				return {
					content: [{ type: "text", text }],
					details: { result },
				};
			} finally {
				await browser.disconnect();
			}
		},
	});

	// ---------------------------------------------------------------------------
	// browser_screenshot
	// ---------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description:
			"Capture a screenshot of the current viewport and save it to a temporary file. Returns the file path.",
		parameters: Type.Object({
			fullPage: Type.Optional(
				Type.Boolean({
					description: "Capture the full page instead of just the viewport",
				}),
			),
		}),
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("browser_screenshot"));
			if (args.fullPage) text += theme.fg("dim", " [full page]");
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const path = result.details?.path ?? "";
			const text = path
				? theme.fg("success", `Saved to ${path}`)
				: theme.fg("dim", "Screenshot taken");
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params) {
			const browser = await connectToBrave();
			try {
				const page = await getActivePage(browser);
				const timestamp = new Date()
					.toISOString()
					.replace(/[:.]/g, "-");
				const filename = `screenshot-${timestamp}.png`;
				const filepath = join(tmpdir(), filename);

				await page.screenshot({
					path: filepath,
					fullPage: params.fullPage ?? false,
				});

				return {
					content: [
						{
							type: "text",
							text: filepath,
						},
					],
					details: { path: filepath },
				};
			} finally {
				await browser.disconnect();
			}
		},
	});

	// ---------------------------------------------------------------------------
	// browser_content
	// ---------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_content",
		label: "Browser Content",
		description:
			"Return the raw HTML of the current page (document.documentElement.outerHTML). No truncation — the full DOM is returned. Use this to inspect page structure or extract data via JS evaluation afterwards.",
		parameters: Type.Object({}),
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("browser_content")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const len = result.details?.length ?? 0;
			const kb = (len / 1024).toFixed(1);
			return new Text(theme.fg("success", `${kb} KB received`), 0, 0);
		},
		async execute() {
			const browser = await connectToBrave();
			try {
				const page = await getActivePage(browser);
				const html = await page.evaluate(
					() => document.documentElement.outerHTML,
				);
				return {
					content: [{ type: "text", text: html }],
					details: { length: html.length },
				};
			} finally {
				await browser.disconnect();
			}
		},
	});

	// ---------------------------------------------------------------------------
	// browser_cookies
	// ---------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_cookies",
		label: "Browser Cookies",
		description:
			"List all cookies for the current tab, including domain, path, httpOnly, and secure flags.",
		parameters: Type.Object({}),
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("browser_cookies")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const cookies = result.details?.cookies ?? [];
			const text =
				cookies.length === 0
					? theme.fg("dim", "No cookies")
					: theme.fg("success", `${cookies.length} cookie(s)`);
			return new Text(text, 0, 0);
		},
		async execute() {
			const browser = await connectToBrave();
			try {
				const page = await getActivePage(browser);
				const cookies = await page.cookies();
				if (cookies.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "No cookies found for the current tab.",
							},
						],
						details: { cookies: [] },
					};
				}

				const lines = cookies.map(
					(c) =>
						`${c.name}: ${c.value}\n  domain: ${c.domain}\n  path: ${c.path}\n  httpOnly: ${c.httpOnly}\n  secure: ${c.secure}`,
				);

				return {
					content: [
						{
							type: "text",
							text: lines.join("\n\n"),
						},
					],
					details: { cookies },
				};
			} finally {
				await browser.disconnect();
			}
		},
	});

	// ---------------------------------------------------------------------------
	// browser_pick
	// ---------------------------------------------------------------------------
	pi.registerTool({
		name: "browser_pick",
		label: "Browser Pick",
		description:
			"Inject an interactive element picker into the current page. The user clicks elements to select them. Returns tag, id, class, text, HTML, and parent selectors. Use this when the user wants to select specific DOM elements visually.",
		parameters: Type.Object({
			message: Type.String({
				description:
					"Message shown to the user in the picker banner, e.g. 'Click the submit button'",
			}),
		}),
		renderCall(args, theme) {
			const msg = args.message.length > 40 ? `${args.message.slice(0, 37)}...` : args.message;
			let text = theme.fg("toolTitle", theme.bold("browser_pick "));
			text += theme.fg("accent", `"${msg}"`);
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			if (result.details?.cancelled) {
				return new Text(theme.fg("warning", "Picker cancelled"), 0, 0);
			}
			const selections = result.details?.selections ?? [];
			const text =
				selections.length > 1
					? theme.fg("success", `${selections.length} elements selected`)
					: theme.fg("success", "1 element selected");
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const browser = await connectToBrave();
			try {
				const page = await getActivePage(browser);

				// Inject window.pick if not present
				await page.evaluate(() => {
					if (!(window as any).pick) {
						(window as any).pick = async (message: string) => {
							if (!message) {
								throw new Error("pick() requires a message parameter");
							}
							return new Promise<any>((resolve) => {
								const selections: any[] = [];
								const selectedElements = new Set<Element>();

								const overlay = document.createElement("div");
								overlay.style.cssText =
									"position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none";

								const highlight = document.createElement("div");
								highlight.style.cssText =
									"position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);transition:all 0.1s";
								overlay.appendChild(highlight);

								const banner = document.createElement("div");
								banner.style.cssText =
									"position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1f2937;color:white;padding:12px 24px;border-radius:8px;font:14px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:auto;z-index:2147483647";

								const updateBanner = () => {
									banner.textContent = `${message} (${selections.length} selected, Cmd/Ctrl+click to add, Enter to finish, ESC to cancel)`;
								};
								updateBanner();

								document.body.append(banner, overlay);

								const cleanup = () => {
									document.removeEventListener("mousemove", onMove, true);
									document.removeEventListener("click", onClick, true);
									document.removeEventListener("keydown", onKey, true);
									overlay.remove();
									banner.remove();
									selectedElements.forEach((el) => {
										(el as HTMLElement).style.outline = "";
									});
								};

								const onMove = (e: MouseEvent) => {
									const el = document.elementFromPoint(e.clientX, e.clientY);
									if (!el || overlay.contains(el) || banner.contains(el)) return;
									const r = el.getBoundingClientRect();
									highlight.style.cssText = `position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px`;
								};

								const buildElementInfo = (el: Element) => {
									const parents: string[] = [];
									let current: Element | null = el.parentElement;
									while (current && current !== document.body) {
										const parentInfo = current.tagName.toLowerCase();
										const id = current.id ? `#${current.id}` : "";
										const cls = current.className
											? `.${current.className.trim().split(/\s+/).join(".")}`
											: "";
										parents.push(parentInfo + id + cls);
										current = current.parentElement;
									}

									return {
										tag: el.tagName.toLowerCase(),
										id: el.id || null,
										class: el.className || null,
										text: el.textContent?.trim().slice(0, 200) || null,
										html: (el as HTMLElement).outerHTML?.slice(0, 500) ?? null,
										parents: parents.join(" > "),
									};
								};

								const onClick = (e: MouseEvent) => {
									if (banner.contains(e.target as Node)) return;
									e.preventDefault();
									e.stopPropagation();
									const el = document.elementFromPoint(e.clientX, e.clientY);
									if (!el || overlay.contains(el) || banner.contains(el)) return;

									if (e.metaKey || e.ctrlKey) {
										if (!selectedElements.has(el)) {
											selectedElements.add(el);
											(el as HTMLElement).style.outline = "3px solid #10b981";
											selections.push(buildElementInfo(el));
											updateBanner();
										}
									} else {
										cleanup();
										const info = buildElementInfo(el);
										resolve(selections.length > 0 ? selections : info);
									}
								};

								const onKey = (e: KeyboardEvent) => {
									if (e.key === "Escape") {
										e.preventDefault();
										cleanup();
										resolve(null);
									} else if (e.key === "Enter" && selections.length > 0) {
										e.preventDefault();
										cleanup();
										resolve(selections);
									}
								};

								document.addEventListener("mousemove", onMove, true);
								document.addEventListener("click", onClick, true);
								document.addEventListener("keydown", onKey, true);
							});
						};
					}
				});

				// Notify user to interact with browser
				ctx.ui.notify(
					"Browser picker active — click elements in Brave",
					"info",
				);

				const result = await page.evaluate(
					(msg: string) => (window as any).pick(msg),
					params.message,
				);

				if (result === null) {
					return {
						content: [
							{
								type: "text",
								text: "Picker cancelled (ESC pressed)",
							},
						],
						details: { cancelled: true },
					};
				}

				const entries = Array.isArray(result) ? result : [result];
				const formatted = entries
					.map((item, i) => {
						const lines = Object.entries(item)
							.map(([k, v]) => `${k}: ${v}`)
							.join("\n");
						return entries.length > 1
							? `--- Selection ${i + 1} ---\n${lines}`
							: lines;
					})
					.join("\n\n");

				return {
					content: [{ type: "text", text: formatted }],
					details: { selections: entries },
				};
			} finally {
				await browser.disconnect();
			}
		},
	});
}
