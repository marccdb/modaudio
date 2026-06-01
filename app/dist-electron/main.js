import { BrowserWindow as e, Menu as t, app as n, dialog as r, ipcMain as i, net as a, protocol as o, session as s } from "electron";
import { promises as c } from "node:fs";
import l from "node:path";
import { fileURLToPath as u, pathToFileURL as d } from "node:url";
//#region electron/main.ts
var f = {
	pickFolder: "desktop:pick-folder",
	refreshFolder: "desktop:refresh-folder",
	readTrack: "desktop:read-track"
}, p = new Set([
	".aac",
	".aif",
	".aiff",
	".flac",
	".m4a",
	".m4b",
	".m4v",
	".mkv",
	".mov",
	".mp3",
	".mp4",
	".oga",
	".ogg",
	".opus",
	".wav",
	".weba",
	".webm",
	".wma"
]), m = {
	".aac": "audio/aac",
	".aif": "audio/aiff",
	".aiff": "audio/aiff",
	".flac": "audio/flac",
	".m4a": "audio/mp4",
	".m4b": "audio/mp4",
	".m4v": "video/mp4",
	".mkv": "video/x-matroska",
	".mov": "video/quicktime",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".oga": "audio/ogg",
	".ogg": "audio/ogg",
	".opus": "audio/ogg",
	".wav": "audio/wav",
	".weba": "audio/webm",
	".webm": "video/webm",
	".wma": "audio/x-ms-wma"
}, ee = u(import.meta.url), h = l.dirname(ee), g = l.join(h, "../dist"), _ = l.join(h, "../build/icons/icon.ico"), v = "modaudio", y = "app", b = `${v}://${y}/index.html`, x = 128, S = 4096, C = 200, w = "folder-allowlist.v1.json";
o.registerSchemesAsPrivileged([{
	scheme: v,
	privileges: {
		standard: !0,
		secure: !0,
		supportFetchAPI: !0,
		stream: !0
	}
}]);
var T = /* @__PURE__ */ new Map(), E = /* @__PURE__ */ new Map(), D = /* @__PURE__ */ new Map(), O = 1, k = null;
function A(e) {
	return {
		ok: !0,
		data: e
	};
}
function j(e, t) {
	return {
		ok: !1,
		code: e,
		message: t
	};
}
function M(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function N(e) {
	return l.resolve(e);
}
function P(e, t) {
	return l.relative(e, t).split(l.sep).join("/");
}
function F(e, t) {
	let n = l.relative(e, t);
	return n === "" || !n.startsWith("..") && !l.isAbsolute(n);
}
function I(e) {
	return e.byteOffset === 0 && e.byteLength === e.buffer.byteLength ? e.buffer : e.buffer.slice(e.byteOffset, e.byteOffset + e.byteLength);
}
function L(e, t, n) {
	if (!M(e)) return null;
	let r = e[t];
	return typeof r != "string" || r.length === 0 || r.length > n || r.includes("\0") ? null : r;
}
function R(e) {
	return l.isAbsolute(e) || e.startsWith("/") || e.startsWith("\\") ? !1 : e.replace(/\\/g, "/").split("/").every((e) => e !== "" && e !== "." && e !== "..");
}
function z(e) {
	try {
		let t = new URL(e);
		if (t.protocol === `${v}:`) return t.hostname === y;
		let n = process.env.VITE_DEV_SERVER_URL;
		if (!n) return !1;
		let r = new URL(n);
		return t.origin === r.origin;
	} catch {
		return !1;
	}
}
function B(e) {
	return z(e.senderFrame?.url || e.sender.getURL()) ? null : j("IPC_SENDER_FORBIDDEN", "IPC sender is not trusted.");
}
function V(e) {
	try {
		let t = new URL(e);
		if (t.protocol !== `${v}:` || t.hostname !== y) return null;
		let n = decodeURIComponent(t.pathname === "/" ? "/index.html" : t.pathname).slice(1), r = N(l.join(g, n));
		return F(g, r) ? r : null;
	} catch {
		return null;
	}
}
function H() {
	o.handle(v, async (e) => {
		let t = V(e.url);
		if (!t) return new Response("Not found", { status: 404 });
		try {
			return (await c.stat(t)).isFile() ? a.fetch(d(t).toString()) : new Response("Not found", { status: 404 });
		} catch {
			return new Response("Not found", { status: 404 });
		}
	});
}
function U(e) {
	let t = (e, t) => {
		z(t) || e.preventDefault();
	};
	e.webContents.on("will-navigate", t), e.webContents.on("will-redirect", t), e.webContents.on("will-attach-webview", (e) => e.preventDefault()), e.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}
async function W() {
	await new Promise((e) => {
		setImmediate(e);
	});
}
function G(e) {
	return p.has(l.extname(e).toLowerCase());
}
function K() {
	return l.join(n.getPath("userData"), w);
}
function q() {
	let e = 1;
	for (let t of E.keys()) {
		let n = /^folder_(\d+)$/.exec(t);
		if (!n) continue;
		let r = Number.parseInt(n[1], 10);
		Number.isFinite(r) && (e = Math.max(e, r + 1));
	}
	O = e;
}
async function J() {
	let e = K();
	try {
		let t = await c.readFile(e, "utf-8"), n = JSON.parse(t);
		if (n.version !== 1 || !Array.isArray(n.folders)) return;
		for (let e of n.folders) {
			if (!e || typeof e.folderId != "string" || typeof e.rootPath != "string") continue;
			let t = e.folderId.trim(), n = e.rootPath.trim();
			if (!t || !n || t.length > x || t.includes("\0") || n.includes("\0")) continue;
			let r = N(n);
			T.set(r, t), E.set(t, r);
		}
		q();
	} catch (e) {
		e instanceof Error && "code" in e && e.code === "ENOENT" || console.warn("Failed to load persisted folder allowlist.", e);
	}
}
function Y() {
	return k ||= J(), k;
}
async function X() {
	let e = K(), t = {
		version: 1,
		folders: Array.from(E.entries()).map(([e, t]) => ({
			folderId: e,
			rootPath: t
		}))
	};
	t.folders.sort((e, t) => e.folderId.localeCompare(t.folderId)), await c.mkdir(l.dirname(e), { recursive: !0 }), await c.writeFile(e, JSON.stringify(t), "utf-8");
}
function Z(e) {
	let t = T.get(e);
	if (t) return t;
	let n = `folder_${O}`;
	for (; E.has(n);) O += 1, n = `folder_${O}`;
	return O += 1, T.set(e, n), E.set(n, e), n;
}
async function Q(e) {
	let t = [], n = /* @__PURE__ */ new Map(), r = N(e), i = Z(r), a = 0;
	async function o(e) {
		let i = await c.readdir(e, { withFileTypes: !0 });
		for (let s of i) {
			a += 1, a % C === 0 && await W();
			let i = l.join(e, s.name);
			if (s.isSymbolicLink()) continue;
			if (s.isDirectory()) {
				await o(i);
				continue;
			}
			if (!s.isFile() || !G(i)) continue;
			let u = await c.stat(i), d = P(r, i), f = `${d}:${u.size}:${Math.trunc(u.mtimeMs)}`, p = {
				id: f,
				name: s.name,
				relativePath: d,
				fingerprint: f,
				size: u.size,
				lastModified: Math.trunc(u.mtimeMs)
			};
			t.push(p), n.set(d, {
				absolutePath: i,
				track: p
			});
		}
	}
	return await o(r), t.sort((e, t) => e.relativePath.localeCompare(t.relativePath, void 0, { sensitivity: "base" })), {
		folderId: i,
		rootPath: r,
		tracks: t,
		byRelativePath: n
	};
}
async function $() {
	let t = new e({
		width: 1680,
		height: 920,
		show: !1,
		icon: _,
		webPreferences: {
			preload: l.join(h, "preload.mjs"),
			contextIsolation: !0,
			nodeIntegration: !1,
			sandbox: !0
		}
	});
	U(t), t.once("ready-to-show", () => {
		t.show();
	});
	let n = process.env.VITE_DEV_SERVER_URL;
	return n ? await t.loadURL(n) : await t.loadURL(b), t;
}
function te() {
	i.handle(f.pickFolder, async (t) => {
		let n = B(t);
		if (n) return n;
		let i = e.getFocusedWindow(), a = {
			title: "Select music folder",
			properties: ["openDirectory", "dontAddToRecent"]
		}, o = i ? await r.showOpenDialog(i, a) : await r.showOpenDialog(a);
		if (o.canceled || o.filePaths.length === 0) return j("PICKER_CANCELLED", "Folder selection cancelled.");
		let s = N(o.filePaths[0]);
		try {
			let e = await Q(s);
			D.set(e.folderId, e);
			try {
				await X();
			} catch (e) {
				console.warn("Failed to persist folder allowlist.", e);
			}
			return A({
				folderId: e.folderId,
				folderName: l.basename(e.rootPath),
				tracks: e.tracks
			});
		} catch (e) {
			return j("SCAN_FAILED", e instanceof Error ? e.message : "Failed to scan folder.");
		}
	}), i.handle(f.refreshFolder, async (e, t) => {
		await Y();
		let n = B(e);
		if (n) return n;
		let r = L(t, "folderId", x) ?? "";
		if (!r) return j("FOLDER_FORBIDDEN", "Folder id is not in allowlist.");
		let i = D.get(r);
		if (!i) {
			let e = E.get(r);
			if (!e) return j("FOLDER_FORBIDDEN", "Folder id is not in allowlist.");
			try {
				i = {
					...await Q(e),
					folderId: r
				}, D.set(r, i);
			} catch (e) {
				return j("SCAN_FAILED", e instanceof Error ? e.message : "Failed to refresh folder.");
			}
		}
		try {
			let e = {
				...await Q(i.rootPath),
				folderId: i.folderId
			};
			return D.set(r, e), A({ tracks: e.tracks });
		} catch (e) {
			return j("SCAN_FAILED", e instanceof Error ? e.message : "Failed to refresh folder.");
		}
	}), i.handle(f.readTrack, async (e, t) => {
		await Y();
		let n = B(e);
		if (n) return n;
		let r = L(t, "folderId", x) ?? "", i = L(t, "relativePath", S) ?? "", a = D.get(r);
		if (!a && r) {
			let e = E.get(r);
			if (e) try {
				a = {
					...await Q(e),
					folderId: r
				}, D.set(r, a);
			} catch (e) {
				return j("SCAN_FAILED", e instanceof Error ? e.message : "Failed to refresh folder.");
			}
		}
		if (!a) return j("TRACK_FORBIDDEN", "Folder id is not in allowlist.");
		if (!R(i)) return j("TRACK_FORBIDDEN", "Track path is not valid.");
		let o = a.byRelativePath.get(i);
		if (!o || !F(a.rootPath, o.absolutePath)) return j("TRACK_FORBIDDEN", "Track path is not in allowlist.");
		try {
			let [e, t] = await Promise.all([c.stat(o.absolutePath), c.readFile(o.absolutePath)]);
			if (!e.isFile()) return j("TRACK_NOT_FILE", "Track path is not a file.");
			let n = l.extname(o.absolutePath).toLowerCase();
			return A({
				name: l.basename(o.absolutePath),
				mimeType: m[n] ?? "application/octet-stream",
				arrayBuffer: I(t)
			});
		} catch (e) {
			return j("READ_FAILED", e instanceof Error ? e.message : "Failed to read track.");
		}
	});
}
n.whenReady().then(async () => {
	H(), s.defaultSession.setPermissionRequestHandler((e, t, n) => n(!1)), t.setApplicationMenu(null), te(), await $(), Y(), n.on("activate", async () => {
		e.getAllWindows().length === 0 && await $();
	});
}), n.on("window-all-closed", () => {
	process.platform !== "darwin" && n.quit();
});
//#endregion
export {};
