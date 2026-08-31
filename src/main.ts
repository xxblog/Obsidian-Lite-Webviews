import { Menu, Notice, Plugin } from 'obsidian';
import {
	ACTIVATION_MARK_TTL_MS,
	BG_FIX_CLEANUP_JS,
	BG_FIX_JS,
	BG_FIX_MARKER,
	BLUR_GUARD_MS,
	CONTEXT_MENU_FALLBACK_MS,
	DRAG_THRESHOLD,
	EMBED_SELECTOR,
	LIVE_CAPTURE_SETTLE_MS,
	MAX_SRCDOC_CAPTURE,
	MAX_TEMP_CAPTURES,
	MUTE_SCRIPT_MARKER,
	STATUS_TIMEOUT_MS,
	SWEEP_INTERVAL_MS,
	TEMP_CAPTURE_SETTLE_MS,
	injectBackgroundFixHtml,
	injectMuteHtml,
	stripBackgroundFixHtml,
	stripMuteHtml,
	stripPluginHtml,
} from './inject';
import {
	categorize,
	formatAge,
	hashUrl,
	htmlToDataUrl,
	isBlank,
	isEmbed,
	isScreenshotTargetEl,
	isTempEmbed,
	isWebSrc,
	stripAutoplayPermission,
} from './utils';
import { DEFAULT_SETTINGS, LiteWebviewsSettingsTab } from './settings';
import type { LiteWebviewsSettings } from './settings';
import { injectStyles } from './styles';
import { CardStore } from './state';

/**
 * Lite Webviews · 网页卡片轻量化（版本号以 manifest.json 为准）
 *
 * 功能一（静音）：画布 / Excalidraw / 网页浏览器标签页中的嵌入网页（webview）
 * 自动静音，范围可在设置中多选。
 *
 * 功能二（截图省内存）：画布与 Excalidraw 的嵌入网页平时只显示截图（页面卸载，
 * 释放 100~400MB/张）；点击卡片（拖动不算）才加载真网页。
 *
 * 切回截图规则：
 * - 操作其他卡片/画布（点空白、其他卡片、拖动、缩放）→ 5 分钟（可设置，-1=永不）；
 * - 切走应用/非画布标签页 → 30 秒（可设置，-1=永不）；回到画布/窗口即取消；
 * - Esc / "挂起"按钮 → 立即；
 * - "保活"按钮 → 保活后自动计时与 Esc 均免疫，仅"挂起"按钮可挂起；
 * - 网页内操作不触发任何计时。
 *
 * 提示与按钮使用 Obsidian 主题变量，自动适配明暗模式。
 */

export default class LiteWebviewsPlugin extends Plugin {
	liveCards = new Set<any>(); // 当前处于"真网页"状态的 webview（截图模式下）
	windows = new Set<any>(); // 主窗口 + 全部 popout 窗口（样式/观察器/事件按窗口挂载）
	winObservers = new Map<any, any>(); // MutationObserver -> 所属窗口
	cacheBytes = -1; // 缓存总字节的内存记账（-1 = 未知，cleanupCache 时校准）
	cacheInfoMemo = new Map(); // src -> existingCacheInfo 结果（含 null）；写/清缓存时失效，省重复的 exists/stat 跨进程往返
	cleanupSoonTimer = null; // 缓存超限清理的防抖句柄
	saveTimer = null; // 设置写盘的防抖句柄
	warnedLargeDoc = false; // 超大快照跳过抓图只警告一次
	tempCaptureSlots = 0; // 当前占用的临时抓图槽位
	tempCaptureQueue: any[] = []; // 等待槽位的抓图任务（先进先出）
	otherTimers = new Map<any, any>(); // leafEl -> 挂起计时器（每叶独立计时，操作其他叶子不打断本叶计时）
	blurTimer = null;
	blurGuard = null;
	webviewFocused = false;
	lastActiveWv = null; // 最近一次激活/聚焦的 live 卡片（供锁定命令使用）
	sizeObservers = new Map<any, any>(); // wv -> ResizeObserver（按钮尺寸随卡片缩放）
	scaleRoots = new WeakMap<any, any>(); // wv -> 所在画布根容器（同根卡片共享缩放比例，轮询每根只读一次布局）
	removedElements = new Map<any, any>(); // 父容器 -> {attrs, src}（挂起时被移除的 webview 快照）
	iframeDocs = new WeakMap<any, any>(); // iframe -> {srcdoc, src}（Excalidraw 快照型嵌入的内容）
	iframeCaptureQueues = new WeakMap<any, any>(); // iframe -> 串行抓图 Promise（避免同卡并发抓图）
	iframeGenerations = new WeakMap<any, any>(); // iframe -> 内容代数（旧抓图完成时不再刷新占位）
	statusCleanups = new WeakMap<any, any>(); // wv -> 清理"加载中…"状态监听器的函数
	muteHandlers = new WeakMap<any, any>(); // wv -> reMute 监听器（卸载时移除，避免插件重载后残留旧监听）
	bgHandlers = new WeakMap<any, any>(); // wv -> 背景修复监听器（卸载时移除）
	_unloaded = false;
	/** 卡片状态唯一真相源。DOM 只负责渲染，不再承载状态（详见 state.ts 顶部注释） */
	store = new CardStore();
	settings: LiteWebviewsSettings = { ...DEFAULT_SETTINGS };
	// 以下处理器在 onload 中定义（handle 首次扫描就会挂载）
	onWebviewFocus: any;
	onWebviewBlur: any;
	blurHandler: any;
	focusHandler: any;
	escHandler: any;
	pointerHandler: any;

	/* ---------------- 工具 ---------------- */

	cacheDir() {
		return `${this.app.vault.configDir}/plugins/lite-webviews/cache`;
	}

	effectiveScreenshotQuality() {
		const q = parseInt(String(this.settings.screenshotQuality), 10);
		if (isNaN(q)) return 80;
		return Math.min(100, Math.max(10, q));
	}

	screenshotExt() {
		return this.effectiveScreenshotQuality() < 100 ? 'jpg' : 'png';
	}

	/** 截图最长边上限（px）：0 = 显式关闭；非法值回退默认；合法值收敛到 320~4096 */
	effectiveScreenshotMaxEdge() {
		const n = parseInt(String(this.settings.screenshotMaxEdgePx), 10);
		if (isNaN(n)) return DEFAULT_SETTINGS.screenshotMaxEdgePx;
		if (n <= 0) return 0;
		return Math.min(4096, Math.max(320, n));
	}

	/** 存盘前按最长边降采样。
	 *  capturePage() 返回的是【物理像素】图：Retina 上一张 400×300 CSS 的卡片会抓出约
	 *  3400×2600，像素量是占位图实际显示所需的十几倍。而占位图是用 object-fit: cover
	 *  缩放呈现的，多出来的分辨率既看不见，又要付出磁盘体积和位图解码内存的双重代价
	 *  （实测一张 3455×2694 的 PNG 解码后约 35MB）——这与本插件"省内存"的目标直接相悖。
	 *  任何一步不可用或失败都原样返回原图：宁可存大图，也不写坏缓存。 */
	downscaleForCache(image) {
		const maxEdge = this.effectiveScreenshotMaxEdge();
		if (!maxEdge || !image) return image;
		try {
			if (typeof image.getSize !== 'function' || typeof image.resize !== 'function') return image;
			const { width, height } = image.getSize();
			if (!width || !height) return image;
			if (Math.max(width, height) <= maxEdge) return image;
			// 只指定一条边，让 Electron 按原始宽高比自己算另一条，避免两边分别取整把比例带偏
			const opts = width >= height ? { width: maxEdge } : { height: maxEdge };
			const resized = image.resize({ ...opts, quality: 'good' });
			if (!resized) return image;
			if (typeof resized.isEmpty === 'function' && resized.isEmpty()) return image;
			return resized;
		} catch (e) {
			return image;
		}
	}

	cachePathFor(src, ext) {
		return `${this.cacheDir()}/${hashUrl(src)}.${ext || this.screenshotExt()}`;
	}

	async ensureCacheDir() {
		const adapter = this.app.vault.adapter;
		const dir = this.cacheDir();
		try {
			if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
		} catch (e) {
			/* ignore */
		}
	}

	/** 当前缓存总大小（字节） */
	async cacheSize() {
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.cacheDir()))) return 0;
			const files = await adapter.list(this.cacheDir());
			const stats = await Promise.all(
				files.files.map(async (f) => {
					try {
						return await adapter.stat(f);
					} catch (e) {
						return null;
					}
				})
			);
			return stats.reduce((total, st) => total + (st && st.size ? st.size : 0), 0);
		} catch (e) {
			return 0;
		}
	}

	/** 清理缓存：force=true 无条件删除全部；否则仅当超限时删最旧文件直到达标（上限 0 = 不自动清理）。返回删除的文件数 */
	async cleanupCache(force = false) {
		if (this._unloaded) return 0; // 卸载后不再动磁盘（onunload 不调用本方法，守卫不会误伤）
		const limitBytes = (this.settings.cacheSizeLimitMB || 0) * 1024 * 1024;
		if (!force && limitBytes <= 0) return 0;
		this.cacheInfoMemo.clear(); // 即将删文件，memo 里的路径/mtime 不可再信
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.cacheDir()))) return 0;
			const files = await adapter.list(this.cacheDir());
			const stats = await Promise.all(
				files.files.map(async (f) => {
					try {
						return { path: f, st: await adapter.stat(f) };
					} catch (e) {
						return null;
					}
				})
			);
			const infos = [];
			let total = 0;
			for (const item of stats) {
				if (!item || !item.st || !item.st.size) continue;
				infos.push({ path: item.path, size: item.st.size, mtime: item.st.mtime || 0 });
				total += item.st.size;
			}
			this.cacheBytes = total; // 校准内存记账
			if (!force && total <= limitBytes) return 0;
			// 最旧优先删
			infos.sort((a, b) => a.mtime - b.mtime);
			let deleted = 0;
			for (const info of infos) {
				if (!force && total <= limitBytes) break;
				try {
					await adapter.remove(info.path);
					total -= info.size;
					deleted++;
				} catch (e) {
					/* ignore */
				}
			}
			this.cacheBytes = total;
			return deleted;
		} catch (e) {
			return 0;
		}
	}

	/** 写入缓存后的增量记账；达到上限则防抖触发一次清理（不必等 24 小时周期） */
	noteCacheDelta(delta) {
		if ((this.settings.cacheSizeLimitMB || 0) <= 0) return;
		if (this.cacheBytes >= 0) {
			this.cacheBytes += delta;
			if (this.cacheBytes <= this.settings.cacheSizeLimitMB * 1024 * 1024) return;
		}
		if (this.cleanupSoonTimer) return;
		this.cleanupSoonTimer = setTimeout(() => {
			this.cleanupSoonTimer = null;
			this.cleanupCache();
		}, 2000);
	}

	/** 设置写盘防抖：设置页连续调整时合并为一次写入；onunload 会尽力 flush */
	saveSettings() {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.saveData(this.settings).catch(() => {});
		}, 400);
	}

	abToDataUrl(ab, mime) {
		return new Promise<string | null>((resolve) => {
			const blob = new Blob([ab], { type: mime });
			const fr = new FileReader();
			fr.onload = () => resolve(fr.result as string | null);
			fr.onerror = () => resolve(null);
			fr.readAsDataURL(blob);
		});
	}

	/** 找到该地址对应的缓存文件（跨 png/jpg 兼容 + 空文件清理），返回 { path, mtime } 或 null。
	 *  结果按 src memo 到内存（含 null）：同一张卡的初始填充与补抓刷新会连续查同一个键，
	 *  memo 掉成对的 exists/stat 跨进程往返；写入/清理缓存时按需失效。 */
	async existingCacheInfo(src) {
		if (!src) return null;
		if (this.cacheInfoMemo.has(src)) return this.cacheInfoMemo.get(src) || null;
		try {
			const adapter = this.app.vault.adapter;
			const preferredExt = this.screenshotExt();
			// 兼容旧版本/不同质量设置留下的 .png/.jpg 缓存。
			const exts = preferredExt === 'jpg' ? ['jpg', 'png'] : ['png', 'jpg'];
			let info = null;
			for (const candidate of exts) {
				const candidatePath = this.cachePathFor(src, candidate);
				if (!(await adapter.exists(candidatePath))) continue;
				// 验尸：文件太小说明是空抓图污染的缓存，删除并视为无缓存
				let st = null;
				try {
					st = await adapter.stat(candidatePath);
				} catch (e) {
					/* ignore */
				}
				if (!st || !st.size || st.size < 100) {
					try {
						await adapter.remove(candidatePath);
					} catch (e) {
						/* ignore */
					}
					continue;
				}
				info = { path: candidatePath, mtime: st.mtime || 0 };
				break;
			}
			// 条目极小（路径+mtime），2000 个上限只是防极端场景无限增长
			if (this.cacheInfoMemo.size >= 2000) this.cacheInfoMemo.clear();
			this.cacheInfoMemo.set(src, info);
			return info;
		} catch (e) {
			return null;
		}
	}

	/** 截图缓存的完整信息：可显示 URL + 抓图时间（mtime 供新鲜度标注）。
	 *  URL 优先 app:// 资源地址（Chromium 按需从磁盘加载，不进 JS 堆）；
	 *  环境不支持 getResourcePath 时回退 data URL。 */
	async cachedImageInfo(src) {
		const info = await this.existingCacheInfo(src);
		if (!info) return null;
		try {
			const adapter = this.app.vault.adapter;
			if (typeof adapter.getResourcePath === 'function') {
				return { url: adapter.getResourcePath(info.path), mtime: info.mtime };
			}
		} catch (e) {
			/* 回退 data URL */
		}
		const dataUrl = await this.readCacheAsDataUrl(info.path);
		return dataUrl ? { url: dataUrl, mtime: info.mtime } : null;
	}

	async readCacheAsDataUrl(path) {
		try {
			const ab = await this.app.vault.adapter.readBinary(path);
			if (!ab || ab.byteLength < 100) return null;
			return await this.abToDataUrl(ab, path.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
		} catch (e) {
			return null;
		}
	}

	async saveScreenshot(src, nativeImage) {
		if (!src) return;
		// 卸载守卫：抓图链最长跨越约 6 秒（等加载 + 渲染静置），期间插件可能已被卸载。
		// 这里是全插件唯一的 writeBinary 出口，守住这一处即可杜绝"卸载后仍在写盘"。
		if (this._unloaded) return;
		try {
			// 空图/损坏图绝不写入缓存（防止污染）
			if (!nativeImage) return;
			if (typeof nativeImage.isEmpty === 'function' && nativeImage.isEmpty()) return;
			const quality = this.effectiveScreenshotQuality();
			// 先降采样再编码：既省磁盘，也省占位图显示时的位图解码内存
			const image = this.downscaleForCache(nativeImage);
			const useJpeg = quality < 100 && typeof image.toJPEG === 'function';
			const data = useJpeg ? image.toJPEG(quality) : image.toPNG();
			if (!data || data.length < 100) return;
			await this.ensureCacheDir();
			const adapter = this.app.vault.adapter;
			// 记账按差额：覆盖写/删除另一格式旧文件前先扣除旧大小，
			// 否则同一地址反复抓图会让 cacheBytes 虚高、缓存清理被提前触发
			let delta = data.length;
			// 换质量档后另一格式的旧缓存已失效，顺手删掉避免同 hash 双份占用
			try {
				const other = this.cachePathFor(src, useJpeg ? 'png' : 'jpg');
				if (await adapter.exists(other)) {
					const st = await adapter.stat(other);
					if (st && st.size) delta -= st.size;
					await adapter.remove(other);
				}
			} catch (e) {
				/* ignore */
			}
			const targetPath = this.cachePathFor(src, useJpeg ? 'jpg' : 'png');
			try {
				const st = await adapter.stat(targetPath);
				if (st && st.size) delta -= st.size;
			} catch (e) {
				/* ignore */
			}
			const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
			await adapter.writeBinary(targetPath, ab);
			this.cacheInfoMemo.delete(src); // 写入了新图，失效 memo 让下次读到新的 mtime
			this.noteCacheDelta(delta);
		} catch (e) {
			/* 截图保存失败不致命 */
		}
	}

	leafElOf(el) {
		try {
			return el.closest('.workspace-leaf');
		} catch (e) {
			return null;
		}
	}

	isLocked(wv) {
		return this.store.get(wv).locked;
	}

	/** 当前可操作的卡片：最近激活的优先，其次任意 live 卡（"挂起/保活/刷新当前"命令共用） */
	currentCard() {
		if (this.lastActiveWv && this.lastActiveWv.isConnected) return this.lastActiveWv;
		return [...this.liveCards].find((w) => w.isConnected) || null;
	}

	/** 快照卡的稳定缓存键：优先用 Excalidraw 元素 id（embed-xxx，跨会话不变），否则用原始内容哈希 */
	iframeKey(wv) {
		try {
			let el = this.napParent(wv);
			for (let i = 0; el && i < 6; i++) {
				if (el.id && String(el.id).startsWith('embed-')) return 'iframe:' + el.id;
				el = el.parentElement;
			}
		} catch (e) {
			/* ignore */
		}
		const doc = stripPluginHtml(wv.getAttribute('srcdoc') || '');
		let content = doc || wv.getAttribute('src') || '';
		if (!content) {
			// 当前属性已被"停止全部"等命令清空时，用已保存快照作缓存键，避免键跳变
			const stored = this.iframeDocs.get(wv);
			content = (stored && (stored.srcdoc || stored.src)) || '';
		}
		return 'iframe:' + hashUrl(content);
	}

	/** 占位图原地刷新（补抓成功后更新已有占位层的截图；只更新同 key 且同代的内容，避免旧抓图覆盖新内容） */
	async refreshPlaceholderImage(wv, key, generation) {
		if (generation !== undefined && this.iframeGenerations.get(wv) !== generation) return;
		const parent = this.napParent(wv);
		if (!parent) return;
		const overlay = parent.querySelector('.no-autoplay-placeholder');
		if (!overlay || this.store.get(overlay).src !== key) return;
		const info = await this.cachedImageInfo(key);
		if (!info) return;
		let img = overlay.querySelector('img.no-autoplay-shot');
		if (!img) {
			img = overlay.ownerDocument.createElement('img');
			img.className = 'no-autoplay-shot';
			img.draggable = false;
			overlay.prepend(img);
		}
		// 同路径补抓了新图，追加时间戳绕过 Chromium 的图片缓存；
		// data URL（getResourcePath 不可用时的回退）带查询串会失效，不能追加
		img.src = info.url.startsWith('data:')
			? info.url
			: info.url + (info.url.includes('?') ? '&' : '?') + 'r=' + Date.now();
		this.updateFreshness(overlay, info.mtime);
	}

	/** 全局临时抓图并发闸：同一时刻最多 MAX_TEMP_CAPTURES 个 temp webview 存活。
	 *  返回 false 表示插件已卸载，调用方应放弃抓图且不得调用 release。 */
	acquireTempSlot() {
		if (this._unloaded) return Promise.resolve(false);
		if (this.tempCaptureSlots < MAX_TEMP_CAPTURES) {
			this.tempCaptureSlots++;
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			this.tempCaptureQueue.push(resolve);
		}).then(() => !this._unloaded);
	}

	releaseTempSlot() {
		const wake = this.tempCaptureQueue.shift();
		if (wake) {
			wake(); // 槽位直接转交给下一个等待者，计数不变
		} else {
			this.tempCaptureSlots = Math.max(0, this.tempCaptureSlots - 1);
		}
	}

	/** 用临时 webview 渲染并抓图（快照 iframe 补拍与"刷新截图"共用）。
	 *  parent 必须仍在文档中且有尺寸（临时层铺满它来取景）；
	 *  shouldAbort 在排队前与加载静置后各调用一次，true 则放弃（状态已变，避免旧内容覆盖新缓存）。 */
	async captureWithTempWebview(doc, src, parent, shouldAbort) {
		if (shouldAbort && shouldAbort()) return null; // 状态已变，不再排队占槽
		if (!(await this.acquireTempSlot())) return null; // 插件已卸载
		let holder = null;
		let wv = null;
		try {
			const ownerDoc = parent.ownerDocument || document;
			holder = ownerDoc.createElement('div');
			holder.style.cssText =
				'position:absolute;inset:0;z-index:900;opacity:0.01;pointer-events:none;overflow:hidden;';
			wv = ownerDoc.createElement('webview');
			wv.dataset.noAutoplayTemp = '1';
			wv.style.cssText = 'width:100%;height:100%;';
			// 抓图期间必须全程静音：webview 元素 attach 之前 setAudioMuted 是无效空调用
			// （try/catch 会吞掉失败），自动播放的站点会一直响到抓图结束、元素被移除。
			// 在 attach/导航/加载的每个时机反复补刀，确保任何一个时刻都不出声。
			const muteNow = () => {
				try {
					wv.setAudioMuted(true);
				} catch (e) {
					/* ignore */
				}
			};
			muteNow();
			wv.addEventListener('did-attach', muteNow);
			wv.addEventListener('did-start-loading', muteNow);
			wv.addEventListener('dom-ready', muteNow);
			wv.addEventListener('did-navigate', muteNow);
			wv.addEventListener('did-navigate-in-page', muteNow);
			holder.appendChild(wv);
			parent.appendChild(holder);
			// srcdoc 快照注入页内静音脚本：媒体元素一创建就置 muted，比 webContents
			// 级静音更早生效（此处的 doc 是剥离插件注入后的临时副本，注入不会污染快照）
			wv.setAttribute('src', doc ? htmlToDataUrl(injectMuteHtml(doc)) : src);
			await this.waitForLoadEvent(wv, 4000);
			await new Promise((r) => setTimeout(r, TEMP_CAPTURE_SETTLE_MS)); // 渲染静置
			if (this._unloaded) return null; // 上面两个 await 合计最长约 4.8 秒
			if (shouldAbort && shouldAbort()) return null;
			return await wv.capturePage();
		} catch (e) {
			return null; // 抓图失败则继续暗色占位
		} finally {
			if (wv || holder) {
				try {
					if (wv) wv.remove();
					if (holder) holder.remove();
				} catch (e) {
					/* ignore */
				}
			}
			this.releaseTempSlot();
		}
	}

	/** 用临时 webview 渲染快照 HTML（或原 src）并抓图。iframe 内容无法直接 capturePage，只能另建 temp webview */
	async captureSnapshotScreenshot(iframe, doc, src, key, generation) {
		if (!doc && !src) return;
		if (doc && doc.length > MAX_SRCDOC_CAPTURE) {
			// 超大 HTML 走 data URL 会撞 Chromium 的 ~2MB 导航上限，与其静默失败不如明说
			if (!this.warnedLargeDoc) {
				this.warnedLargeDoc = true;
				console.warn(
					'[lite-webviews] 快照 HTML 约 ' +
						(doc.length / 1048576).toFixed(1) +
						'MB，超过 data URL 导航上限，已跳过抓图'
				);
			}
			return;
		}
		if (iframe.dataset.noAutoplayScreenshot !== 'screenshot') return; // 已重新激活，旧抓图不再写缓存
		const parent = this.napParent(iframe);
		if (!parent || !parent.isConnected) return;
		if (!this.sizeOk(iframe)) return;
		if (generation !== undefined && this.iframeGenerations.get(iframe) !== generation) return;
		const cacheKey = key || 'iframe:' + hashUrl(doc || src || '');
		const isStale = () =>
			iframe.dataset.noAutoplayScreenshot !== 'screenshot' ||
			(generation !== undefined && this.iframeGenerations.get(iframe) !== generation);
		const img = await this.captureWithTempWebview(doc, src, parent, isStale);
		if (img) {
			await this.saveScreenshot(cacheKey, img);
		}
	}

	/** 后台刷新挂起卡片的截图：不加载真网页，用临时 webview 重抓一张并原地更新占位层 */
	async refreshScreenshot(wv) {
		const parent = this.napParent(wv);
		if (!parent || !parent.isConnected) return;
		const overlay = parent.querySelector('.no-autoplay-placeholder');
		if (!overlay) return; // 不在挂起状态
		const st = this.store.get(wv);
		if (st.refreshing) return; // 已在刷新中
		st.refreshing = true;
		const status = this.showStatus(parent, '刷新截图中…');
		try {
			const isIframe = wv.tagName === 'IFRAME';
			let doc = null;
			let src = '';
			if (isIframe) {
				const stored = this.iframeDocs.get(wv);
				doc = (stored && stored.srcdoc) || null;
				src = (stored && stored.src) || '';
			} else {
				src = this.store.get(wv).src;
			}
			if (!doc && !/^https?:/i.test(src || '')) {
				new Notice('Lite Webviews：该卡片没有可后台加载的网页内容');
				return;
			}
			if (doc && doc.length > MAX_SRCDOC_CAPTURE) {
				new Notice('Lite Webviews：快照内容过大（超过 data URL 上限），无法后台刷新');
				return;
			}
			// 尺寸门槛按占位层算：webview 元素可能已被移除，自身没有尺寸
			if (this.settings.captureMinScreenPx) {
				const rect = overlay.getBoundingClientRect();
				if (Math.min(rect.width, rect.height) < this.settings.captureMinScreenPx) {
					new Notice('Lite Webviews：卡片太小，未刷新截图');
					return;
				}
			}
			const img = await this.captureWithTempWebview(doc, src, parent, null);
			const empty = !img || (typeof img.isEmpty === 'function' && img.isEmpty());
			if (empty) {
				new Notice('Lite Webviews：截图刷新失败（页面未完成加载）');
				return;
			}
			const key = isIframe ? this.iframeKey(wv) : this.store.get(wv).src;
			await this.saveScreenshot(key, img);
			await this.refreshPlaceholderImage(wv, key, undefined);
			new Notice('Lite Webviews：截图已刷新');
		} finally {
			st.refreshing = false;
			if (status && status.isConnected) status.remove();
		}
	}

	/** 刷新"当前卡片"的截图（命令入口）：挂起卡走后台重抓（不加载真网页），
	 *  live 卡直接抓当前画面；live 的 Excalidraw 快照型 iframe 无法直接抓图，提示先挂起 */
	async refreshCurrentScreenshot(wv) {
		if (wv.dataset.noAutoplayScreenshot === 'screenshot') {
			await this.refreshScreenshot(wv);
			return;
		}
		if (wv.tagName !== 'WEBVIEW' || typeof wv.capturePage !== 'function') {
			new Notice('Lite Webviews：快照型嵌入请先挂起，再刷新截图');
			return;
		}
		const src = this.store.get(wv).src;
		if (!src) {
			new Notice('Lite Webviews：该卡片没有可抓图的网页地址');
			return;
		}
		if (!this.sizeOk(wv)) {
			new Notice('Lite Webviews：卡片太小，未刷新截图');
			return;
		}
		try {
			const img = await wv.capturePage();
			if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) {
				new Notice('Lite Webviews：截图失败（页面未完成加载）');
				return;
			}
			await this.saveScreenshot(src, img);
			new Notice('Lite Webviews：截图已刷新');
		} catch (e) {
			new Notice('Lite Webviews：截图失败');
		}
	}

	/** 复制挂起卡片的截图到系统剪贴板（经 ImageBitmap→canvas 转 PNG；blob 解码不会污染 canvas） */
	async copyScreenshot(wv) {
		const key = wv.tagName === 'IFRAME' ? this.iframeKey(wv) : this.store.get(wv).src;
		const info = await this.existingCacheInfo(key);
		if (!info) {
			new Notice('Lite Webviews：该卡片还没有截图可复制');
			return;
		}
		if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
			new Notice('Lite Webviews：当前环境不支持复制图片到剪贴板');
			return;
		}
		try {
			const ab = await this.app.vault.adapter.readBinary(info.path);
			const blob = new Blob([ab], {
				type: info.path.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
			});
			const bmp = await createImageBitmap(blob);
			const canvas = document.createElement('canvas');
			canvas.width = bmp.width;
			canvas.height = bmp.height;
			canvas.getContext('2d').drawImage(bmp, 0, 0);
			if (bmp.close) bmp.close();
			const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
			if (!pngBlob) throw new Error('canvas 导出失败');
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
			new Notice('Lite Webviews：截图已复制到剪贴板');
		} catch (e) {
			new Notice('Lite Webviews：复制截图失败（' + (e && e.message ? e.message : e) + '）');
		}
	}

	/** 挂起卡片的右键菜单：常用操作集中在这里，比右上角小按钮更易发现 */
	showPlaceholderMenu(wv, e) {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('加载网页')
				.setIcon('globe')
				.onClick(() => this.activate(wv))
		);
		menu.addItem((item) =>
			item
				.setTitle('刷新截图')
				.setIcon('refresh-cw')
				.onClick(() => {
					this.refreshScreenshot(wv).catch(() => {});
				})
		);
		menu.addItem((item) =>
			item
				.setTitle('复制截图')
				.setIcon('images')
				.onClick(() => {
					this.copyScreenshot(wv).catch(() => {});
				})
		);
		const src = wv.tagName === 'IFRAME' ? '' : this.store.get(wv).src;
		if (/^https?:/i.test(src)) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle('在浏览器打开')
					.setIcon('external-link')
					.onClick(() => {
						try {
							window.open(src); // Obsidian 会把外部地址交给系统浏览器
						} catch (err) {
							new Notice('Lite Webviews：打开浏览器失败');
						}
					})
			);
		}
		// 保险：菜单关闭时补发一对合成的右键松开事件（button=2，不影响左键拖拽的
		// 收尾判断）。若仍有组件 arm 了右键拖拽却没收到被菜单吞掉的真实 pointerup，
		// 合成事件可让它收尾，画布不会跟着鼠标漂移。
		try {
			const view = this.viewOf(wv);
			const x = e.clientX || 0;
			const y = e.clientY || 0;
			(menu as any).onClose = () => {
				try {
					const doc = view.document;
					const target = doc.elementFromPoint(x, y) || doc.body;
					if (typeof view.PointerEvent === 'function') {
						target.dispatchEvent(
							new view.PointerEvent('pointerup', {
								button: 2,
								buttons: 0,
								clientX: x,
								clientY: y,
								bubbles: true,
								cancelable: true,
								isPrimary: true,
								pointerId: 1,
								pointerType: 'mouse',
							})
						);
					}
					target.dispatchEvent(
						new view.MouseEvent('mouseup', {
							button: 2,
							buttons: 0,
							clientX: x,
							clientY: y,
							bubbles: true,
							cancelable: true,
						})
					);
				} catch (err) {
					/* ignore */
				}
			};
		} catch (err) {
			/* ignore */
		}
		menu.showAtMouseEvent(e);
	}

	/** 向 iframe 的 srcdoc 注入静音脚本（幂等；空 srcdoc 不注入，等内容出现后由 suspendIframe 接管） */
	injectMuteSrcdoc(iframe) {
		try {
			const doc = iframe.getAttribute('srcdoc') || '';
			if (!doc.trim() || doc.includes(MUTE_SCRIPT_MARKER)) return;
			iframe.setAttribute('srcdoc', injectMuteHtml(doc));
		} catch (e) {
			/* ignore */
		}
	}

	/** 从 iframe 的 srcdoc 精确剥掉我们注入的静音脚本（取消单卡静音时用） */
	stripMuteSrcdoc(iframe) {
		try {
			const doc = iframe.getAttribute('srcdoc') || '';
			if (!doc.includes(MUTE_SCRIPT_MARKER)) return;
			const stripped = stripMuteHtml(doc);
			if (stripped !== doc) iframe.setAttribute('srcdoc', stripped);
		} catch (e) {
			/* ignore */
		}
	}

	/** 向 iframe 的 srcdoc 注入背景修复样式（幂等） */
	injectBackgroundFixSrcdoc(iframe) {
		try {
			const doc = iframe.getAttribute('srcdoc') || '';
			if (!doc.trim() || doc.includes(BG_FIX_MARKER)) return;
			iframe.setAttribute('srcdoc', injectBackgroundFixHtml(doc));
		} catch (e) {
			/* ignore */
		}
	}

	/** 从 iframe 的 srcdoc 移除背景修复样式 */
	stripBackgroundFixSrcdoc(iframe) {
		try {
			const doc = iframe.getAttribute('srcdoc') || '';
			const stripped = stripBackgroundFixHtml(doc);
			if (stripped !== doc) iframe.setAttribute('srcdoc', stripped);
		} catch (e) {
			/* ignore */
		}
	}

	/** 按当前设置统一处理 iframe 的静音脚本与背景修复样式 */
	applyIframePlugins(iframe) {
		if (this.shouldMute(iframe, 'excalidraw')) this.injectMuteSrcdoc(iframe);
		else this.stripMuteSrcdoc(iframe);
		if (this.settings.fixTransparentBackground) this.injectBackgroundFixSrcdoc(iframe);
		else this.stripBackgroundFixSrcdoc(iframe);
	}

	/* ---------------- 静音 ---------------- */

	/** 某张卡是否应处于静音状态：范围开关 && (每卡设置 ?? 默认静音) */
	shouldMute(el, cat) {
		if (!this.settings.muteScope[cat]) return false;
		// null = 该卡未单独设置，落回全局"默认静音"
		const own = this.store.get(el).muted;
		if (own !== null) return own;
		return !!this.settings.defaultMute;
	}

	/** 按当前设置把 webview 置为静音/非静音，并挂跳转补刀钩子 */
	applyMuteState(wv, cat) {
		const want = this.shouldMute(wv, cat);
		// sweep 每轮会重入一次；状态没变就不重复调用 setAudioMuted，减少对音频播放的干扰
		const st = this.store.get(wv);
		if (st.muteApplied !== want) {
			try {
				if (typeof wv.setAudioMuted === 'function') {
					wv.setAudioMuted(want);
					st.muteApplied = want;
				}
			} catch (e) {
				/* ignore */
			}
		}
		if (!st.hooked.mute) {
			st.hooked.mute = true;
			const reMute = () => {
				try {
					if (typeof wv.setAudioMuted === 'function') {
						const want = this.shouldMute(wv, categorize(wv));
						wv.setAudioMuted(want);
						// 同步去重标记：applyMuteState 靠它判断状态是否变化；元素"先插入、
						// 后归位"期间类别可能变过，不同步会让下一轮 sweep 多做一次冗余切换
						st.muteApplied = want;
					}
				} catch (e) {
					/* ignore */
				}
			};
			this.muteHandlers.set(wv, reMute);
			// did-attach 是 setAudioMuted 最早生效的时机：刚插入的 webview（如快照重建）
			// 在 attach 前调用是无效空调用，缺这一拍的话 attach→dom-ready 间会漏出声音
			wv.addEventListener('did-attach', reMute);
			wv.addEventListener('dom-ready', reMute);
			wv.addEventListener('did-navigate', reMute);
			wv.addEventListener('did-navigate-in-page', reMute);
		}
	}

	/** 在 webview 内执行脚本。
	 *  executeJavaScript 返回的是 Promise：webview 已销毁、尚未 attach 或正在导航时
	 *  会 reject，而同步 try/catch 抓不到异步 rejection —— 不显式 .catch() 的话，
	 *  每次卡片销毁都会在控制台留下 unhandled rejection（onunload 里对正在销毁的
	 *  webview 调用尤其必现）。失败本身无需处理：背景修复是尽力而为的增强，
	 *  注入不上就维持页面原样。 */
	execInWebview(wv, js) {
		if (!wv || typeof wv.executeJavaScript !== 'function') return;
		try {
			const p = wv.executeJavaScript(js);
			if (p && typeof p.catch === 'function') p.catch(() => {});
		} catch (e) {
			/* 同步抛出（元素已不是 webview）同样忽略 */
		}
	}

	/** 修复网页背景透明：在 webview 加载/导航后注入低优先级不透明兜底背景。
	 *  透明透出控件是画布/Excalidraw 嵌入特有的合成问题；网页浏览器标签页整页
	 *  显示不存在该问题，跳过后每次导航可省两次跨进程 executeJavaScript。 */
	applyBackgroundFix(wv) {
		if (categorize(wv) === 'webviewer') return;
		const want = !!this.settings.fixTransparentBackground;
		const cleanup = () => {
			const fix = this.bgHandlers.get(wv);
			if (fix) {
				try {
					wv.removeEventListener('dom-ready', fix);
					wv.removeEventListener('did-navigate', fix);
					wv.removeEventListener('did-navigate-in-page', fix);
				} catch (e) {
					/* ignore */
				}
				this.bgHandlers.delete(wv);
			}
			const s = this.store.get(wv);
			s.hooked.bgFix = false;
			s.bgFixApplied = false;
			this.execInWebview(wv, BG_FIX_CLEANUP_JS);
		};
		if (!want) {
			cleanup();
			return;
		}
		const applyFix = () => {
			// 先清除旧版本可能残留的强制内联白底，再注入低优先级兜底背景
			this.execInWebview(wv, BG_FIX_CLEANUP_JS);
			this.execInWebview(wv, BG_FIX_JS);
		};
		// 挂钩以本实例的 bgHandlers 为准（插件重载后旧监听已在 onunload 摘除，这里会
		// 重新挂上，比旧的 dataset 标记更准确）；只在首次接管且页面已加载完时立即补
		// 一次注入，此后全靠导航事件重放。绝不能在每次 handle/sweep 都 executeJavaScript
		// ——那等于每张卡每 5 秒两次跨进程往返 + 页内 getComputedStyle 强制样式重算。
		if (!this.bgHandlers.has(wv)) {
			const fix = () => applyFix();
			this.bgHandlers.set(wv, fix);
			wv.addEventListener('dom-ready', fix);
			wv.addEventListener('did-navigate', fix);
			wv.addEventListener('did-navigate-in-page', fix);
			// 已加载完的页面不会再触发 dom-ready，立即补一次；加载中的等事件
			try {
				if (typeof wv.isLoading !== 'function' || !wv.isLoading()) applyFix();
			} catch (e) {
				applyFix();
			}
		}
		this.store.get(wv).bgFixApplied = true;
	}

	/* ---------------- 按钮显隐 ---------------- */

	/** 按钮字号（屏幕像素）：固定值，9-24，默认 13 */
	effectiveButtonSizePx() {
		const n = parseInt(String(this.settings.buttonFontSizePx), 10);
		if (isNaN(n)) return 13;
		return Math.min(24, Math.max(9, n));
	}

	/**
	 * 计算并写入按钮/状态文字的 CSS 字号 = 目标屏幕字号 ÷ 画布缩放比例。
	 * 画布缩放是 transform 变换（rect/offset 宽度之比即缩放比例），CSS 字号反向
	 * 除回去抵消变换——任何缩放级别下，按钮在屏幕上都是固定的像素大小，
	 * 不随画布缩放、卡片大小变化。
	 * scale 可由调用方传入（同一画布内所有卡片共享同一比例，见 pollFocus，
	 * 避免逐卡重复读布局）；缺省/无效时自行测量。
	 */
	applySize(wv, scale?) {
		const container = wv.parentElement;
		if (!container) return;
		if (!scale) scale = this.zoomScaleOf(wv);
		if (!scale) return;
		// 不设 CSS 字号下限：再小的 CSS 字号乘上缩放，屏幕上仍是目标像素；
		// 之前的 6px 下限会让画布高倍放大时按钮在屏幕上跟着变大
		const px = Math.round((this.effectiveButtonSizePx() / scale) * 100) / 100;
		// 值没变就不写 style：500ms 一轮的轮询会反复调用，别让它制造无谓的样式失效
		const val = px + 'px';
		const cs = this.store.get(container);
		if (cs.sizeLast === val) return;
		cs.sizeLast = val;
		container.style.setProperty('--nap-size', val);
	}

	/** 测量卡片当前所处的画布缩放比例（rect 宽 ÷ CSS 宽）；卡片不可见/无尺寸时返回 0 */
	zoomScaleOf(wv) {
		const node =
			wv.closest && wv.closest('.canvas-node') ? wv.closest('.canvas-node') : wv;
		if (!node || !node.isConnected) return 0;
		const cssW = node.offsetWidth || 0;
		if (cssW <= 0) return 0;
		const rect = node.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return 0;
		return rect.width / cssW; // 画布缩放比例
	}

	/** 卡片所在画布/Excalidraw 的根容器：缩放比例按根共享，pollFocus 每根只测一次 */
	scaleRootOf(wv) {
		let root = this.scaleRoots.get(wv);
		if (root && root.isConnected) return root;
		try {
			root = wv.closest('.canvas-wrapper, .excalidraw') || null;
		} catch (e) {
			root = null;
		}
		if (root) this.scaleRoots.set(wv, root);
		return root;
	}

	/** 为卡片挂尺寸监听（观察卡片本体，拖拽改大小实时生效） */
	ensureSizeObserver(wv) {
		if (this.sizeObservers.has(wv)) return;
		const node =
			wv.closest && wv.closest('.canvas-node') ? wv.closest('.canvas-node') : wv;
		if (!node) return;
		const ro = new ResizeObserver(() => {
			try {
				this.applySize(wv);
			} catch (e) {
				/* ignore */
			}
		});
		ro.observe(node);
		this.sizeObservers.set(wv, ro);
		this.applySize(wv);
	}

	/** 切换卡片的"操作中"状态（按钮显隐交给 CSS 处理，这里只控制状态类） */
	applyOperating(wv, operating) {
		const node =
			wv.closest('.canvas-node') ||
			(wv.classList && wv.classList.contains('excalidraw__embeddable') ? wv : null);
		if (node) node.classList.toggle('nap-operating', operating);
	}

	/** 轮询检测焦点（Electron 的 webview focus/blur 事件不可靠，双通道保险） */
	pollFocus() {
		// 完全没有受管卡片时跳过，避免纯笔记/无画布场景下的常驻空转
		if (this.liveCards.size === 0 && this.sizeObservers.size === 0) return;
		for (const wv of this.liveCards) {
			if (!wv.isConnected) continue;
			// 每张卡用自己窗口的 activeElement（popout 里的 webview 不在主窗口焦点链上）
			const ae = wv.ownerDocument ? wv.ownerDocument.activeElement : null;
			const focused = ae === wv;
			const st = this.store.get(wv);
			if (st.focused !== focused) {
				st.focused = focused;
				if (focused) this.lastActiveWv = wv;
				this.applyOperating(wv, focused);
			}
		}
		// 顺带刷新按钮/状态字号：画布缩放是 transform 变换，不会触发 ResizeObserver，
		// 靠这 500ms 轮询让缩放后字号立刻回到固定的屏幕大小。
		// 缩放比例是画布级的（同画布所有卡片相同）：每画布只测一次，套用到全部卡，
		// 不再逐卡 offsetWidth+getBoundingClientRect——大画布下每秒几十次强制布局
		// 读取就是从这里来的；测不出（如代表卡隐藏）时该卡退回自行测量。
		const scaleByRoot = new Map();
		for (const wv of this.sizeObservers.keys()) {
			if (!wv.isConnected) continue;
			const root = this.scaleRootOf(wv);
			if (!root) {
				this.applySize(wv);
				continue;
			}
			if (!scaleByRoot.has(root)) scaleByRoot.set(root, this.zoomScaleOf(wv));
			this.applySize(wv, scaleByRoot.get(root));
		}
	}

	/* ---------------- 截图省内存模式 ---------------- */

	/** 挂起 Excalidraw 快照型 iframe：
	 *  同步记录并清空 srcdoc/src（立即停止加载/释放资源）→ 显示缓存截图/占位 →
	 *  后台用临时 webview 补抓最新截图。srcdoc 晚赋值时由 handle 再次调用本方法。 */
	async suspendIframe(wv) {
		wv.dataset.noAutoplayScreenshot = 'screenshot';
		this.store.get(wv).locked = false;
		this.liveCards.delete(wv);
		this.removeCardButtons(wv);

		const markNode = wv.closest('.canvas-node') || this.napParent(wv);
		if (markNode) {
			delete markNode.dataset.noAutoplayActivatedSrc;
			delete markNode.dataset.noAutoplayActivatedUntil;
			this.store.container(markNode).locked = false;
		}

		// 先取原始内容再清空；MUTE_SCRIPT 是插件注入的，不能存进原始快照
		const rawDoc = wv.getAttribute('srcdoc') || '';
		const originalDoc = stripPluginHtml(rawDoc);
		const originalSrc = wv.getAttribute('src') || '';
		let stored = this.iframeDocs.get(wv);
		if (!stored) {
			stored = {};
			this.iframeDocs.set(wv, stored);
		}
		if (originalDoc || (originalSrc && originalSrc !== 'about:blank')) {
			stored.srcdoc = originalDoc;
			stored.src = originalSrc;
		} else if (!stored.srcdoc && !stored.src) {
			stored.srcdoc = '';
			stored.src = '';
		}
		// 当前属性为空但快照里已有有效内容时保留旧快照（例如"停止全部"先存后清，随后自动挂起）
		stored.muted = this.store.get(wv).muted;

		// 稳定缓存键（元素 id 优先，跨会话稳定：上次抓到过就直接显示）
		const key = this.iframeKey(wv);

		try {
			wv.removeAttribute('srcdoc');
			wv.removeAttribute('src');
		} catch (e) {
			/* ignore */
		}

		const parent = this.napParent(wv);
		if (parent) await this.showPlaceholder(wv, key);

		// 有内容才抓；晚赋值的内容由 handle 中的属性监听再次进入这里。
		// 用代数标记防止"上一次抓图"在内容已更新后把旧截图刷回占位层。
		const generation = (this.iframeGenerations.get(wv) || 0) + 1;
		this.iframeGenerations.set(wv, generation);
		if (originalDoc || (originalSrc && originalSrc !== 'about:blank')) {
			const prev = this.iframeCaptureQueues.get(wv) || Promise.resolve();
			const capture = prev
				.catch(() => {})
				.then(() => this.captureSnapshotScreenshot(wv, originalDoc, originalSrc, key, generation))
				.then(() => this.refreshPlaceholderImage(wv, key, generation))
				.catch(() => {});
			this.iframeCaptureQueues.set(wv, capture);
		}
	}

	/** 一张卡片切回"截图状态"：抓图 → 卸载页面 → 显示截图/占位（并重置锁定）
	 *  fresh=true 表示元素刚被创建（进入画布/重渲染）：
	 *  立即同步置空中止加载，绝不先做抓图等耗时操作，避免页面趁机加载。
	 */
	async switchToScreenshot(wv, fresh = false) {
		if (wv.dataset.noAutoplayScreenshot === 'screenshot') return;
		if (wv.tagName === 'IFRAME') {
			await this.suspendIframe(wv);
			return;
		}
		wv.dataset.noAutoplayScreenshot = 'screenshot';
		this.store.get(wv).locked = false;
		this.liveCards.delete(wv);
		this.removeCardButtons(wv);
		// 清除"操作中"状态类
		const opNode =
			wv.closest('.canvas-node') ||
			(wv.classList && wv.classList.contains('excalidraw__embeddable') ? wv : null);
		if (opNode) opNode.classList.remove('nap-operating');
		// 清除容器上的激活标记（收起后重建元素不再继承 live）
		const node = wv.closest('.canvas-node') || wv.parentElement;
		if (node) {
			delete node.dataset.noAutoplayActivatedSrc;
			delete node.dataset.noAutoplayActivatedUntil;
			this.store.container(node).locked = false;
		}

		let src = this.store.get(wv).src;
		if (!src && !isBlank(wv)) {
			// 极端兜底：元素没经过 handle 记录地址时，至少从当前 src 抢救一次
			try {
				src = wv.src || '';
				if (src && src !== 'about:blank') this.store.get(wv).src = src;
			} catch (e) {
				/* ignore */
			}
		}
		if (fresh && this.settings.killRendererOnSuspend) {
			// 新元素 + 杀进程模式：立即【移除元素】（进程还没来得及出生），已出生则补杀。
			// 进入画布时 26 个元素在微秒级被摘除 → 零进程、零卡顿。
			const parent = wv.parentElement;
			let id = 0;
			try {
				id = typeof wv.getWebContentsId === 'function' ? wv.getWebContentsId() : 0;
			} catch (e) {
				/* ignore */
			}
			const attrs = this.snapshotAttrs(wv);
			if (parent) {
				wv._napParent = parent; // 移除后 parentElement 为 null，保存引用
				this.removedElements.set(parent, {
					attrs,
					src: this.store.get(wv).src,
					cat: categorize(wv),
					muted: this.store.get(wv).muted,
					locked: this.store.get(wv).locked,
				});
				this.safeRemoveWebview(wv);
				if (id) {
					try {
						const wc =
							(window as any).electron &&
							(window as any).electron.remote &&
							(window as any).electron.remote.webContents &&
							(window as any).electron.remote.webContents.fromId(id);
						if (wc && !wc.isDestroyed()) wc.forcefullyCrashRenderer();
					} catch (e) {
						/* ignore */
					}
				}
			}
			this.store.get(wv).crashed = true;
			await this.showPlaceholder(wv, src);
			return;
		}
		if (fresh) {
			// 新元素（未开杀进程模式）：先【同步置空】中止加载
			try {
				if (!isBlank(wv)) wv.src = 'about:blank';
			} catch (e) {
				/* ignore */
			}
		} else {
			// 收起时：页面已加载完才补抓一张最新图（加载中不硬抓，避免"加载前图像"）
			if (src && !isBlank(wv) && typeof wv.capturePage === 'function') {
				let loaded = true;
				try {
					loaded = !(typeof wv.isLoading === 'function' && wv.isLoading());
				} catch (e) {
					/* ignore */
				}
				if (loaded && this.sizeOk(wv)) {
					try {
						const img = await wv.capturePage();
						if (img) await this.saveScreenshot(src, img); // 内部有空图保护
					} catch (e) {
						/* 抓图失败则用缓存或占位 */
					}
				}
			}
		}
		// 先显示占位（不阻塞），后台统一流程：
		// 置空（中止页面加载，省网络/CPU）→ 等空白页加载完成（did-stop-loading）→ 杀（死透）。
		// 绝不杀"加载中/未开始导航"的页面——那会被 Chromium 自动重试复活。
		const placeholderPromise = this.showPlaceholder(wv, src);
		if (this.settings.killRendererOnSuspend) {
			if (!fresh) {
				try {
					if (!isBlank(wv)) wv.src = 'about:blank';
				} catch (e) {
					/* ignore */
				}
			}
			await this.waitForLoadEvent(wv, fresh ? 800 : 1500); // 空白页加载极快，等它完成
			const killed = this.killRenderer(wv);
			if (killed) {
				this.store.get(wv).crashed = true;
				// 彻底卸载：把元素从 DOM 移除（进程不再出生，进入画布零卡顿）。
				// 实验已验证：Excalidraw 不会重新插入、无报错。
				const parent = wv.parentElement;
				if (parent) {
					wv._napParent = parent;
					this.removedElements.set(parent, {
						attrs: this.snapshotAttrs(wv),
						src: this.store.get(wv).src,
						cat: categorize(wv),
						muted: this.store.get(wv).muted,
					});
					this.safeRemoveWebview(wv);
				}
			} else {
				this.store.get(wv).crashed = false; // 已是空白页
			}
		} else {
			this.store.get(wv).crashed = false;
			try {
				wv.src = 'about:blank';
			} catch (e) {
				/* ignore */
			}
		}
		await placeholderPromise;
	}

	/** 等待下一次 did-stop-loading（无 isLoading 短路，专门等置空后的空白页加载完成） */
	waitForLoadEvent(wv, timeoutMs) {
		return new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(t);
				try {
					wv.removeEventListener('did-stop-loading', finish);
				} catch (e) {
					/* ignore */
				}
				resolve();
			};
			const t = setTimeout(finish, timeoutMs);
			try {
				wv.addEventListener('did-stop-loading', finish);
			} catch (e) {
				finish();
			}
		});
	}

	/** sweep 时补刀：被杀过的卡若进程又活了（页面已加载）→ 立刻再杀（此时能死透） */
	recoverRespawned() {
		if (!this.settings.killRendererOnSuspend) return;
		this.forEmbeds((wv) => {
			if (wv.tagName !== 'WEBVIEW') return;
			if (isTempEmbed(wv)) return;
			if (!this.store.get(wv).crashed) return;
			let loading = false;
			try {
				loading = typeof wv.isLoading === 'function' && wv.isLoading();
			} catch (e) {
				/* ignore */
			}
			if (this.rendererState(wv) === 'alive' && !loading) {
				this.killRenderer(wv); // 页面已加载完，此时杀必然死透
			}
		});
	}

	/** Obsidian 渲染进程里的 electron.remote.webContents；不同 Obsidian 版本/环境可能拿不到 */
	remoteWebContents() {
		try {
			const api = (window as any).electron;
			if (api && api.remote && api.remote.webContents) return api.remote.webContents;
		} catch (e) {
			/* ignore */
		}
		return null;
	}

	/** "挂起时彻底卸载"依赖的非公开接口是否可用。
	 *  该能力建立在 window.electron.remote 之上——它不是 Obsidian 的公开 API，
	 *  Obsidian 升级 Electron 或收紧 remote 后可能随时消失。届时 killRenderer 会
	 *  一路返回 false、静默降级为普通的 about:blank 挂起，用户不会看到任何异常，
	 *  也就无从判断开关为什么"没效果"——所以设置页要据此显式告知。 */
	canKillRenderer() {
		return !!this.remoteWebContents();
	}

	/** 杀掉 webview 的渲染进程（元素留在 DOM，激活时 reload 复活）。
	 *  通过 window.electron.remote（Obsidian 渲染进程全局可用）拿到 webContents 后
	 *  forcefullyCrashRenderer。注意：页面【加载中】被杀会被 Chromium 自动重试复活，
	 *  必须等页面加载完成后再杀才能死透。返回是否成功。 */
	killRenderer(wv) {
		try {
			const webContents = this.remoteWebContents();
			if (!webContents) return false;
			const id = typeof wv.getWebContentsId === 'function' ? wv.getWebContentsId() : 0;
			if (!id) return false;
			const wc = webContents.fromId(id);
			if (!wc || wc.isDestroyed()) return false;
			if (typeof wc.isCrashed === 'function' && wc.isCrashed()) return true; // 已死，视为成功
			wc.forcefullyCrashRenderer();
			return true;
		} catch (e) {
			return false;
		}
	}

	/** 渲染进程状态：'crashed'（已死）/ 'alive'（活着）/ 'unknown' */
	rendererState(wv) {
		try {
			const webContents = this.remoteWebContents();
			if (!webContents) return 'unknown';
			const id = typeof wv.getWebContentsId === 'function' ? wv.getWebContentsId() : 0;
			if (!id) return 'unknown';
			const wc = webContents.fromId(id);
			if (!wc || wc.isDestroyed()) return 'unknown';
			if (typeof wc.isCrashed === 'function') return wc.isCrashed() ? 'crashed' : 'alive';
			return 'unknown';
		} catch (e) {
			return 'unknown';
		}
	}

	/** 记录 webview 的属性快照（排除插件自己的标记和 src，重建元素时还原） */
	snapshotAttrs(el) {
		const attrs = {};
		for (const a of el.attributes) {
			if (a.name === 'src') continue;
			if (a.name.startsWith('data-no-autoplay')) continue;
			if (a.name.startsWith('data-nap')) continue;
			attrs[a.name] = a.value;
		}
		return attrs;
	}

	/** 根据快照重建一个 webview 元素（挂起时被移除的卡，激活时用这个复活） */
	createWebviewFromSnapshot(parent, stored) {
		// 必须在目标窗口的 document 里创建：webview 自定义元素按窗口注册，跨窗口创建再插入不生效
		const el = (parent.ownerDocument || document).createElement('webview');
		for (const [k, v] of Object.entries(stored.attrs || {})) {
			try {
				el.setAttribute(k, v);
			} catch (e) {
				/* ignore */
			}
		}
		// 恢复原始地址（快照时跳过了 src，这里补上；空则 about:blank，绝不给 null）
		try {
			el.setAttribute('src', stored.src || 'about:blank');
		} catch (e) {
			/* ignore */
		}
		this.store.get(el).src = stored.src || '';
		el.dataset.noAutoplayScreenshot = 'screenshot'; // 交给 activate 流程接管状态
		this.store.get(el).muted = stored.muted ?? null;
		this.store.get(el).locked = !!stored.locked;
		// 先插回 DOM（src 属性会触发加载），插到占位层之前
		const ph = parent.querySelector('.no-autoplay-placeholder');
		parent.insertBefore(el, ph || null);
		// 立即静音并修复背景，避免重建瞬间页面加载出声/背景透出
		this.applyMuteState(el, categorize(el));
		this.applyBackgroundFix(el);
		return el;
	}

	/** 元素的父容器（元素可能已被移除，用 _napParent 兜底） */
	napParent(el) {
		return el._napParent || el.parentElement;
	}

	/** 元素所属窗口的 view（getComputedStyle 要用元素自己窗口的，popout 场景下全局的会拿错） */
	viewOf(el) {
		return (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
	}

	/** 安全移除 webview 元素：
	 *  推迟到下一宏任务（让 Electron 内部属性回调先完成，避免 connectedCallback/createGuest
	 *  在移除过程中被同步触发而抛异常），并用 parent.removeChild 绕开可能的自定义 remove。 */
	safeRemoveWebview(wv) {
		try {
			const p = wv.parentNode;
			if (!p) return;
			setTimeout(() => {
				try {
					if (p.contains(wv)) p.removeChild(wv);
				} catch (e) {
					/* ignore */
				}
			}, 0);
		} catch (e) {
			/* ignore */
		}
	}

	/** 卡片屏幕尺寸是否达到抓图门槛（captureMinScreenPx，0=不限制） */
	sizeOk(wv) {
		if (!this.settings.captureMinScreenPx) return true;
		try {
			const node =
				wv.closest && wv.closest('.canvas-node') ? wv.closest('.canvas-node') : wv;
			const rect = node.getBoundingClientRect();
			return Math.min(rect.width, rect.height) >= this.settings.captureMinScreenPx;
		} catch (e) {
			return true;
		}
	}

	/** 点开期间静默抓图：等页面加载完成 + 静置 1 秒再抓（保证抓到渲染后的画面） */
	async captureAfterLoad(wv) {
		try {
			await this.waitForLoad(wv, 5000);
			await new Promise((r) => setTimeout(r, LIVE_CAPTURE_SETTLE_MS)); // 静置等待 JS 渲染
			if (this._unloaded) return; // 上面两个 await 合计最长约 6 秒，期间插件可能已卸载
			if (!wv.isConnected) return;
			if (wv.dataset.noAutoplayScreenshot !== 'live') return;
			const src = this.store.get(wv).src;
			if (!src || isBlank(wv) || typeof wv.capturePage !== 'function') return;
			if (!this.sizeOk(wv)) return; // 卡片太小不抓，与挂起时的抓图策略一致
			const img = await wv.capturePage();
			if (img) await this.saveScreenshot(src, img);
		} catch (e) {
			/* 静默失败不影响使用 */
		}
	}

	/** 等待页面加载完成（did-stop-loading / 已加载 / 超时） */
	waitForLoad(wv, timeoutMs) {
		return new Promise<void>((resolve) => {
			try {
				if (typeof wv.isLoading === 'function' && !wv.isLoading()) return resolve();
			} catch (e) {
				/* ignore */
			}
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(t);
				try {
					wv.removeEventListener('did-stop-loading', finish);
				} catch (e) {
					/* ignore */
				}
				resolve();
			};
			const t = setTimeout(finish, timeoutMs);
			wv.addEventListener('did-stop-loading', finish);
		});
	}

	/** 显示截图（有缓存图）或暗色占位（无缓存）；右下角小字"已挂起"。
	 *  先同步挂载占位层，再异步读取缓存图，避免磁盘慢时出现长时间空白。 */
	showPlaceholder(wv, src) {
		this.removeCardButtons(wv);
		const parent = this.napParent(wv);
		if (!parent) return;

		const ownerDoc = parent.ownerDocument || document;
		const overlay = ownerDoc.createElement('div');
		overlay.className = 'no-autoplay-placeholder';
		this.store.get(overlay).src = src || '';

		// 单击加载：按下时记录位置，移动超过阈值视为拖动（不触发加载，画布可正常拖动卡片）
		let startX = 0,
			startY = 0,
			down = false;
		overlay.addEventListener('pointerdown', (e) => {
			if (e.button === 2) {
				// 右键按下不冒泡给画布：画布把右键按下当作平移起点，而右键菜单会盖在
				// 指针位置上吞掉随后的 pointerup——画布等不到"松开"，菜单关闭后就会
				// 跟着鼠标漂移。拦下按下事件，画布根本不进入平移态。
				e.stopPropagation();
				return;
			}
			if (e.button !== 0) return;
			down = true;
			startX = e.clientX;
			startY = e.clientY;
		});
		// 画布/Excalidraw 若监听的是鼠标事件而非指针事件，同样拦下右键按下
		overlay.addEventListener('mousedown', (e) => {
			if (e.button === 2) e.stopPropagation();
		});
		overlay.addEventListener('pointerup', (e) => {
			if (!down) return;
			down = false;
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			if (dx * dx + dy * dy <= DRAG_THRESHOLD * DRAG_THRESHOLD) {
				this.activate(wv);
			}
		});
		overlay.addEventListener('pointercancel', () => {
			down = false;
		});

		// 右键菜单：挂起状态下的常用操作（加载/刷新截图/复制/浏览器打开）。
		// 弹出时机很关键：菜单会盖在指针位置上并拦截随后的 pointerup——凡是已"按下"
		// 的拖拽平移（捕获阶段 arm 的监听拦不住）收不到松开就会卡死，画布从此跟着
		// 鼠标漂移。因此 macOS（contextmenu 在按下瞬间触发）必须等右键真正松开、
		// 松开事件完整送达应用之后再弹菜单。
		overlay.addEventListener('contextmenu', (e) => {
			if (e.button !== 2) return;
			e.preventDefault();
			e.stopPropagation(); // 不再冒泡给画布自己的节点菜单
			const view = this.viewOf(overlay);
			if (!(e.buttons & 2)) {
				// 松开后才触发 contextmenu 的平台（Windows/Linux）：直接弹，不会吞 pointerup
				this.showPlaceholderMenu(wv, e);
				return;
			}
			const ctxEvent = e;
			const startX = e.clientX;
			const startY = e.clientY;
			let finished = false;
			const finish = (show) => {
				if (finished) return;
				finished = true;
				view.clearTimeout(fallback);
				view.removeEventListener('pointerup', onUp, true);
				view.removeEventListener('pointercancel', onUp, true);
				if (show) this.showPlaceholderMenu(wv, ctxEvent);
			};
			// 窗口级捕获：无论松开时指针落在哪（含被拖出卡片）都能收到
			const onUp = (ev) => {
				if (ev.button !== 2) return;
				const dx = ev.clientX - startX;
				const dy = ev.clientY - startY;
				// 位移超过阈值说明这是一次右键拖拽（平移），不弹菜单
				finish(dx * dx + dy * dy <= DRAG_THRESHOLD * DRAG_THRESHOLD);
			};
			view.addEventListener('pointerup', onUp, true);
			view.addEventListener('pointercancel', onUp, true);
			// 兜底：万一收不到 pointerup（异常输入环境），600ms 后仍弹出
			const fallback = view.setTimeout(() => finish(true), CONTEXT_MENU_FALLBACK_MS);
		});

		const cs = this.viewOf(parent).getComputedStyle(parent);
		if (cs.position === 'static') parent.style.position = 'relative';
		parent.appendChild(overlay);

		// 右下角不显眼的"已挂起"状态文本（加载时变为"加载中…"）
		this.showStatus(parent, '已挂起');
		this.ensureSizeObserver(wv);

		// 缓存图异步就绪后再填入；若期间占位层已被移除/替换则放弃。
		this.cachedImageInfo(src)
			.then((info) => {
				if (!info || !overlay.isConnected) return;
				if (this.store.get(overlay).src !== (src || '')) return;
				let img = overlay.querySelector('img.no-autoplay-shot');
				if (!img) {
					img = ownerDoc.createElement('img');
					img.className = 'no-autoplay-shot';
					img.draggable = false;
					overlay.prepend(img);
				}
				img.src = info.url;
				this.updateFreshness(overlay, info.mtime);
			})
			.catch(() => {});
	}

	/** 右下角状态文本 */
	showStatus(parent, text) {
		if (!parent) return;
		parent.querySelectorAll('.no-autoplay-status').forEach((el) => el.remove());
		const div = (parent.ownerDocument || document).createElement('div');
		div.className = 'no-autoplay-status';
		div.textContent = text;
		const cs = this.viewOf(parent).getComputedStyle(parent);
		if (cs.position === 'static') parent.style.position = 'relative';
		parent.appendChild(div);
		return div;
	}

	/** 占位层左下角标注截图新鲜度（取缓存文件 mtime；刷新截图后原地更新为"刚刚"） */
	updateFreshness(overlay, mtime) {
		if (!overlay || !overlay.isConnected || !mtime) return;
		let el = overlay.querySelector('.no-autoplay-freshness');
		if (!el) {
			el = overlay.ownerDocument.createElement('div');
			el.className = 'no-autoplay-freshness';
			overlay.appendChild(el);
		}
		el.textContent = '截图于 ' + formatAge(mtime);
	}

	/** 点击占位 → 加载真网页（默认未锁定）。
	 *  挂起时被移除的卡：根据快照重建元素再走正常激活流程。 */
	activate(oldEl) {
		const parent = this.napParent(oldEl);
		if (oldEl.tagName === 'IFRAME') {
			// Excalidraw 快照型嵌入：还原 srcdoc（注入静音脚本）
			const stored = this.iframeDocs.get(oldEl);
			this.iframeDocs.delete(oldEl);
			if (stored) {
				// 先恢复每卡静音设置，再统一注入静音脚本和背景修复样式
				this.store.get(oldEl).muted = stored.muted ?? null;
				try {
					if (stored.srcdoc) oldEl.setAttribute('srcdoc', stored.srcdoc);
					if (stored.src) oldEl.setAttribute('src', stored.src);
				} catch (e) {
					/* ignore */
				}
				this.applyIframePlugins(oldEl);
			}
			oldEl.dataset.noAutoplayScreenshot = 'live';
			this.store.get(oldEl).locked = false;
			this.liveCards.add(oldEl);
			this.lastActiveWv = oldEl;
			this.removeCardButtons(oldEl);
			// 记录激活标记（重建元素时继承 live）
			const markNode = oldEl.closest('.canvas-node') || parent;
			if (markNode) {
				markNode.dataset.noAutoplayActivatedSrc = 'iframe';
				markNode.dataset.noAutoplayActivatedUntil = String(Date.now() + ACTIVATION_MARK_TTL_MS);
				this.store.container(markNode).locked = false;
			}
			const status = this.showStatus(parent, '加载中…');
			if (status) setTimeout(() => status.remove(), 1500); // iframe 无 dom-ready，定时清除
			this.addCardButtons(oldEl);
			return;
		}
		let wv = oldEl;
		if (parent) {
			const stored = this.removedElements.get(parent);
			if (stored) {
				// 先清理旧占位元素上的按钮/占位层/ResizeObserver，再插入重建的 webview
				this.removeCardButtons(oldEl);
				this.removedElements.delete(parent);
				wv = this.createWebviewFromSnapshot(parent, stored);
			}
		}
		if (wv.dataset.noAutoplayScreenshot === 'live') return; // 已是真网页（重复触发兜底）
		wv.dataset.noAutoplayScreenshot = 'live';
		this.store.get(wv).locked = false;
		this.liveCards.add(wv);
		this.lastActiveWv = wv;
		this.removeCardButtons(wv);
		this.applyMuteState(wv, categorize(wv));
		this.applyBackgroundFix(wv);

		const src = this.store.get(wv).src;
		// 在卡片容器上记录激活状态：画布/Excalidraw 重建 webview 元素时继承 live
		const node = wv.closest('.canvas-node') || wv.parentElement;
		if (node) {
			node.dataset.noAutoplayActivatedSrc = src;
			node.dataset.noAutoplayActivatedUntil = String(Date.now() + ACTIVATION_MARK_TTL_MS);
			this.store.container(node).locked = false;
			this.store.container(node).muted = this.store.get(wv).muted;
		}
		if (this.store.get(wv).crashed) {
			// 渲染进程被杀过：地址可能已被置空，先恢复地址；地址正确则 reload 复活
			this.store.get(wv).crashed = false;
			if (src) {
				try {
					let cur = '';
					try {
						cur = wv.src || '';
					} catch (e) {
						/* ignore */
					}
					if (cur && cur !== 'about:blank' && cur !== src) {
						wv.src = src;
					} else if (cur === src && typeof wv.reload === 'function') {
						wv.reload();
					} else {
						wv.src = src;
					}
				} catch (e) {
					try {
						wv.src = src;
					} catch (e2) {
						/* ignore */
					}
				}
			}
		} else if (src && isBlank(wv)) {
			try {
				wv.src = src;
			} catch (e) {
				/* ignore */
			}
		}
		const status = this.showStatus(this.napParent(wv), '加载中…');
		this.attachStatusClear(wv, status);
		this.addCardButtons(wv);
		// 点开期间静默抓一张新鲜截图（页面加载完 + 静置后）
		this.captureAfterLoad(wv);
	}

	/** 页面加载完成/失败/超时后移除"加载中…"状态文本；监听器集中管理，避免卸载后残留 */
	attachStatusClear(wv, statusEl) {
		if (!statusEl) return;
		const oldCleanup = this.statusCleanups.get(wv);
		if (oldCleanup) oldCleanup();

		const dispose = () => {
			if (this.statusCleanups.get(wv) !== dispose) return;
			this.statusCleanups.delete(wv);
			clearTimeout(timeout);
			try {
				wv.removeEventListener('dom-ready', finish);
				wv.removeEventListener('did-stop-loading', finish);
				wv.removeEventListener('did-fail-load', onFail);
			} catch (e) {
				/* ignore */
			}
			if (statusEl.isConnected) statusEl.remove();
		};
		const finish = () => dispose();
		const timeout = setTimeout(finish, STATUS_TIMEOUT_MS); // 兜底：状态文本最多显示这么久
		const onFail = (ev) => {
			const isMain = ev && ev.isMainFrame === undefined ? true : !!ev.isMainFrame;
			if (!isMain || (ev && ev.errorCode === -3)) return;
			dispose();
			this.switchToScreenshot(wv).catch(() => {});
		};

		this.statusCleanups.set(wv, dispose);
		wv.addEventListener('dom-ready', finish);
		wv.addEventListener('did-stop-loading', finish);
		wv.addEventListener('did-fail-load', onFail);
	}

	/** 真网页状态下右上角的"静音 / 保活 / 挂起"按钮（包在感应区内，靠近即显示） */
	addCardButtons(wv) {
		const parent = this.napParent(wv);
		if (!parent) return;
		const cs = this.viewOf(parent).getComputedStyle(parent);
		if (cs.position === 'static') parent.style.position = 'relative';

		// 感应区：覆盖右上角按钮区域，鼠标进入即显示按钮。
		// （Electron 中网页区域鼠标事件不可达，这是"靠近即显示"的物理上限；
		//  感应区会吃掉该角落的网页点击，属于设计内代价。）
		const ownerDoc = parent.ownerDocument || document;
		const zone = ownerDoc.createElement('div');
		zone.className = 'no-autoplay-zone';
		zone.addEventListener('mouseenter', () => zone.classList.add('nap-zone-hover'));
		zone.addEventListener('mouseleave', () => zone.classList.remove('nap-zone-hover'));

		// 静音按钮（单卡开关）
		const muteBtn = ownerDoc.createElement('div');
		muteBtn.className = 'no-autoplay-mute';
		const cat = categorize(wv);
		const initialMuted = this.shouldMute(wv, cat);
		muteBtn.textContent = initialMuted ? '已静音' : '静音';
		muteBtn.classList.toggle('is-muted', initialMuted);
		muteBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
		muteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const cur = this.shouldMute(wv, cat);
			this.store.get(wv).muted = !cur;
			const now = this.shouldMute(wv, cat);
			muteBtn.textContent = now ? '已静音' : '静音';
			muteBtn.classList.toggle('is-muted', now);
			if (wv.tagName === 'IFRAME') {
				this.applyIframePlugins(wv);
			} else {
				this.applyMuteState(wv, cat);
			}
			const node = wv.closest('.canvas-node') || this.napParent(wv);
			if (node) this.store.container(node).muted = this.store.get(wv).muted;
		});
		zone.appendChild(muteBtn);

		// 保活按钮（原锁定）
		const lockBtn = ownerDoc.createElement('div');
		lockBtn.className = 'no-autoplay-lock';
		const initialLocked = this.store.get(wv).locked;
		lockBtn.textContent = initialLocked ? '已保活' : '保活';
		lockBtn.classList.toggle('is-locked', initialLocked);
		lockBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
		lockBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const locked = this.store.get(wv).locked;
			this.store.get(wv).locked = !locked;
			lockBtn.textContent = locked ? '保活' : '已保活';
			lockBtn.classList.toggle('is-locked', !locked);
			const node = wv.closest('.canvas-node') || this.napParent(wv);
			if (node) this.store.container(node).locked = this.store.get(wv).locked;
		});
		zone.appendChild(lockBtn);

		// 挂起按钮（原收起）
		const collapseBtn = ownerDoc.createElement('div');
		collapseBtn.className = 'no-autoplay-collapse';
		collapseBtn.textContent = '挂起';
		collapseBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
		collapseBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.switchToScreenshot(wv).catch(() => {}); // 挂起按钮对保活卡片也生效
		});
		zone.appendChild(collapseBtn);

		parent.appendChild(zone);

		// 操作中显隐由 CSS 处理（焦点轮询 + 事件双通道）
		this.ensureSizeObserver(wv);
		this.applyOperating(wv, this.store.get(wv).focused);
	}

	removeCardButtons(wv) {
		const cleanup = this.statusCleanups.get(wv);
		if (cleanup) cleanup();
		const parent = this.napParent(wv);
		if (!parent) return;
		parent
			.querySelectorAll(
				'.no-autoplay-zone, .no-autoplay-placeholder, .no-autoplay-collapse, .no-autoplay-lock, .no-autoplay-mute, .no-autoplay-loading, .no-autoplay-status'
			)
			.forEach((el) => el.remove());
		const ro = this.sizeObservers.get(wv);
		if (ro) {
			ro.disconnect();
			this.sizeObservers.delete(wv);
		}
	}

	/* ---------------- 计时器（切回截图） ---------------- */

	/** 操作其他卡片/画布后计时：只收起该叶子内未锁定的 live 卡片。
	 *  计时器按叶子独立保存：并排多个画布时，操作画布 B 不再顶掉画布 A 已在
	 *  跑的计时（此前全局单计时器会让 A 的卡片一直不被挂起）。 */
	restartOtherTimer(leafEl) {
		if (!leafEl) return;
		const prev = this.otherTimers.get(leafEl);
		if (prev) clearTimeout(prev);
		if (this.settings.otherCardTimeoutMs < 0) {
			this.otherTimers.delete(leafEl);
			return;
		}
		this.otherTimers.set(
			leafEl,
			setTimeout(() => {
				this.otherTimers.delete(leafEl);
				for (const wv of [...this.liveCards]) {
					if (!wv.isConnected || this.isLocked(wv)) continue;
					if (this.leafElOf(wv) === leafEl) this.switchToScreenshot(wv).catch(() => {});
				}
			}, this.settings.otherCardTimeoutMs)
		);
	}

	/** 切走应用/标签页后计时：收起未被查看的 live 卡片。
	 *  主窗口 ↔ popout 之间的切换只让一侧窗口 blur，不能当成"切走应用"一刀切；
	 *  到期时跳过"正被查看"的卡片（见 isViewingCard），应用整体失焦时没有
	 *  任何窗口持有焦点，全部挂起（与原行为一致）。 */
	restartBlurTimer() {
		if (this.blurTimer) {
			clearTimeout(this.blurTimer);
			this.blurTimer = null;
		}
		if (this.settings.appBlurTimeoutMs < 0) return;
		this.blurTimer = setTimeout(() => {
			this.blurTimer = null;
			let activeEl = null;
			try {
				const ws: any = this.app.workspace;
				const leaf = ws
					? typeof ws.getActiveLeaf === 'function'
						? ws.getActiveLeaf()
						: ws.activeLeaf
					: null;
				activeEl = leaf && leaf.view && leaf.view.containerEl ? leaf.view.containerEl : null;
			} catch (e) {
				/* ignore */
			}
			for (const wv of [...this.liveCards]) {
				if (!wv.isConnected || this.isLocked(wv)) continue;
				if (activeEl && this.isViewingCard(wv, activeEl)) continue;
				this.switchToScreenshot(wv).catch(() => {});
			}
		}, this.settings.appBlurTimeoutMs);
	}

	/** 卡片是否正被查看：焦点就在卡片网页内（Electron 里 activeElement 会指向
	 *  webview/iframe 元素，pollFocus 已把它记到 dataset），或所在窗口持有焦点
	 *  且卡片就在当前活动视图内。 */
	isViewingCard(wv, activeEl) {
		try {
			if (this.store.get(wv).focused) return true;
			const doc = wv.ownerDocument;
			if (!doc || typeof doc.hasFocus !== 'function' || !doc.hasFocus()) return false;
			return !!(activeEl && activeEl.contains(wv));
		} catch (e) {
			return false;
		}
	}

	cancelTimers() {
		for (const t of this.otherTimers.values()) clearTimeout(t);
		this.otherTimers.clear();
		if (this.blurTimer) {
			clearTimeout(this.blurTimer);
			this.blurTimer = null;
		}
	}

	/* ---------------- 核心调度 ---------------- */

	async handle(el) {
		if (!el || !el.dataset || isTempEmbed(el)) return; // 临时抓图元素不处理
		const cat = categorize(el);
		// 分类自愈：categorize 依赖祖先（.canvas-node）与 class（excalidraw__embeddable），
		// 观察器只监听 src/srcdoc，"先插入、后归位/后补 class"的元素会被误判成兜底的
		// webviewer（静音范围/截图范围都会按错类别处理），要等最长 10 秒的 sweep 才纠正。
		// 延迟一帧复验：类别变了就按新类别重新处理；没变则立即退出，正常 webviewer
		// 标签页只有一次空转的 setTimeout，开销可忽略。
		if (cat === 'webviewer') {
			setTimeout(() => {
				if (this._unloaded || !el.isConnected) return;
				if (categorize(el) !== 'webviewer') this.handle(el).catch(() => {});
			}, 0);
		}
		const target = isScreenshotTargetEl(el, cat);
		const screenshotEnabled = this.settings.screenshotMode && this.settings.screenshotScope[cat] && target;
		// 即将被自动挂起的新 iframe 不需要先注入静音脚本（suspend 会剥离并保存原内容），
		// 等真正激活为 live 时再按需注入，减少无意义的字符串处理。
		const willSuspend =
			screenshotEnabled &&
			el.tagName === 'IFRAME' &&
			cat === 'excalidraw' &&
			el.dataset.noAutoplayScreenshot !== 'screenshot' &&
			el.dataset.noAutoplayScreenshot !== 'live';

		if (el.tagName === 'WEBVIEW') {
			this.applyMuteState(el, cat);
			this.applyBackgroundFix(el);
		} else if (el.tagName === 'IFRAME' && cat === 'excalidraw') {
			if (el.dataset.noAutoplayScreenshot === 'screenshot') {
				// 已挂起的占位卡：Excalidraw 可能"先插空 iframe、后补 srcdoc"。
				// 内容一到就立即记录并再次清空，绝不长期留在 DOM 里占内存。
				const lateDoc = el.getAttribute('srcdoc') || '';
				const lateSrc = el.getAttribute('src') || '';
				if (lateDoc.trim() || (lateSrc && lateSrc !== 'about:blank')) {
					this.suspendIframe(el).catch(() => {});
				}
			} else if (!willSuspend) {
				this.applyIframePlugins(el);
			}
		} else if (this.settings.muteScope[cat]) {
			// 只移除 autoplay 权限；不要做 el.src = el.src，那会让普通 iframe 每轮 sweep 被强制刷新一次
			stripAutoplayPermission(el);
		}

		if (el.tagName === 'WEBVIEW' && !this.store.get(el).hooked.focus && this.onWebviewFocus) {
			this.store.get(el).hooked.focus = true;
			el.addEventListener('focus', this.onWebviewFocus);
			el.addEventListener('blur', this.onWebviewBlur);
		}
		if (!this.store.get(el).src) {
			try {
				this.store.get(el).src = el.src || '';
			} catch (e) {
				/* ignore */
			}
		}

		// 画布/Excalidraw 重建元素（点击/选中/重渲染/切标签后重挂载）→ 继承 live 状态。
		// 只有截图模式+该范围真的开启时才继承，避免关闭截图后仍给新元素挂按钮/计时。
		if (screenshotEnabled && (el.tagName === 'WEBVIEW' || (el.tagName === 'IFRAME' && cat === 'excalidraw'))) {
			const node = el.closest('.canvas-node') || el.parentElement;
			if (
				node &&
				node.dataset.noAutoplayActivatedSrc &&
				Number(node.dataset.noAutoplayActivatedUntil || 0) > Date.now()
			) {
				const isIframe = el.tagName === 'IFRAME';
				let cur = '';
				try {
					cur = el.src || '';
				} catch (e) {
					/* ignore */
				}
				// webview 按地址匹配；iframe（快照卡）同容器即视为同一张
				if (isIframe || cur === node.dataset.noAutoplayActivatedSrc) {
					const alreadyManaged = this.liveCards.has(el);
					el.dataset.noAutoplayScreenshot = 'live';
					this.store.get(el).locked = this.store.container(node).locked;
					// null 表示"跟随全局默认"，直接继承即可，无需再区分"未设置"
					this.store.get(el).muted = this.store.container(node).muted;
					this.liveCards.add(el);
					// 继承为 live 的 iframe 需要补上静音脚本和背景修复（上面 willSuspend 时跳过了）
					if (el.tagName === 'IFRAME' && cat === 'excalidraw') {
						this.applyIframePlugins(el);
					}
					// 真正的新元素才需要清理残留并重建按钮；activate() 刚插入的受管元素跳过，避免把"加载中…"状态误删
					if (!alreadyManaged) {
						this.removeCardButtons(el);
						this.addCardButtons(el);
					}
				}
			}
		}

		// 自愈：插件重载/更新后，onunload 的 restoreAllBlanked 已把元素标成 live，但新
		// 实例的 liveCards 是空的——页面保持加载却没有按钮/自动计时/Esc，省内存模式
		// 静默失效。重新收养这类"无主 live 卡"（卸载时容器激活标记已清，继承分支接不到）。
		if (
			screenshotEnabled &&
			el.dataset.noAutoplayScreenshot === 'live' &&
			!this.liveCards.has(el)
		) {
			this.liveCards.add(el);
			this.removeCardButtons(el);
			this.addCardButtons(el);
		}

		// 只处理"真正参与截图的网页卡片"（webview 或 Excalidraw 快照型 iframe）：
		// 画布文本/文件卡片的内容是 iframe 渲染的，绝不能动。
		if (
			screenshotEnabled &&
			el.dataset.noAutoplayScreenshot !== 'screenshot' &&
			el.dataset.noAutoplayScreenshot !== 'live'
		) {
			await this.switchToScreenshot(el, true); // fresh：新元素，置空优先级最高
		}
	}

	handleTree(root) {
		try {
			root.querySelectorAll(EMBED_SELECTOR).forEach((el) => {
				this.handle(el).catch(() => {});
			});
			root
				.querySelectorAll('video[autoplay], audio[autoplay]')
				.forEach((el) => el.removeAttribute('autoplay'));
		} catch (e) {
			/* 扫描失败不影响插件主体 */
		}
	}

	attachObserver(root) {
		const obs = new MutationObserver((mutations) => {
			const pending = new Set();
			try {
				for (const mutation of mutations) {
					for (const added of mutation.addedNodes) {
						if (added.nodeType !== Node.ELEMENT_NODE) continue;
						const node: any = added;
						if (isEmbed(node)) pending.add(node);
						if (node.querySelectorAll) {
							node.querySelectorAll(EMBED_SELECTOR).forEach((el) => pending.add(el));
							node
								.querySelectorAll('video[autoplay], audio[autoplay]')
								.forEach((el) => el.removeAttribute('autoplay'));
						}
					}
					// 属性变化（Obsidian 常"先插入元素、后设置 src/srcdoc"）→ 重新处理该元素
					if (mutation.type === 'attributes' && isEmbed(mutation.target)) {
						pending.add(mutation.target);
					}
				}
				for (const el of pending) {
					this.handle(el).catch((err) => {
						console.error('[lite-webviews] handle 失败:', err);
					});
				}
			} catch (e) {
				/* 观察器回调不抛未捕获异常 */
			}
		});
		obs.observe(root, {
			childList: true,
			subtree: true,
			attributes: true,
			// 不监听 class：子树内任意元素的 class 抖动（画布选区/hover）都会触发回调，
			// 代价远大于收益；类名晚到的元素由 sweep 兜底重新识别。
			attributeFilter: ['src', 'srcdoc'],
		});
		return obs;
	}

	/** 主窗口 + 已打开的全部 popout（floatingSplit 是内部结构，尽力枚举、失败不致命） */
	knownWindows() {
		const wins = [window];
		try {
			const floating = this.app.workspace && (this.app.workspace as any).floatingSplit;
			if (floating && floating.children) {
				for (const child of floating.children) {
					const w = child && child.win;
					if (w && w.document && !wins.includes(w)) wins.push(w);
				}
			}
		} catch (e) {
			/* ignore */
		}
		return wins;
	}

	/** 接管一个窗口：样式、观察器、全局事件（Esc/焦点/指针）全部按窗口挂载 */
	attachWindow(win) {
		if (!win || !win.document || this.windows.has(win)) return;
		this.windows.add(win);
		try {
			injectStyles(win.document);
			const obs = this.attachObserver(win.document);
			if (obs) this.winObservers.set(obs, win);
			// registerDomEvent：插件卸载时自动摘除；窗口关闭时仍由 detachWindow 手动摘
			this.registerDomEvent(win, 'blur', this.blurHandler);
			this.registerDomEvent(win, 'focus', this.focusHandler);
			this.registerDomEvent(win, 'keydown', this.escHandler);
			this.registerDomEvent(win, 'pointerdown', this.pointerHandler, true);
			this.handleTree(win.document); // popout 里可能带着现成的嵌入卡片
		} catch (e) {
			/* ignore */
		}
	}

	/** 放开一个窗口：摘事件、断观察器、移除注入的样式 */
	detachWindow(win) {
		if (!this.windows.has(win)) return;
		this.windows.delete(win);
		try {
			win.removeEventListener('blur', this.blurHandler);
			win.removeEventListener('focus', this.focusHandler);
			win.removeEventListener('keydown', this.escHandler);
			win.removeEventListener('pointerdown', this.pointerHandler, true);
		} catch (e) {
			/* ignore */
		}
		for (const [obs, owner] of [...this.winObservers]) {
			if (owner === win) {
				try {
					obs.disconnect();
				} catch (e) {
					/* ignore */
				}
				this.winObservers.delete(obs);
			}
		}
		try {
			const style = win.document.getElementById('no-autoplay-styles');
			if (style) style.remove();
		} catch (e) {
			/* ignore */
		}
	}

	/** 全部存活窗口的 document（顺带清理已关闭的窗口） */
	allDocs() {
		const docs = [];
		for (const win of [...this.windows]) {
			if (win.closed) {
				this.detachWindow(win);
				continue;
			}
			try {
				docs.push(win.document);
			} catch (e) {
				/* ignore */
			}
		}
		return docs;
	}

	/** 遍历所有窗口中的嵌入元素 */
	forEmbeds(cb) {
		for (const doc of this.allDocs()) {
			try {
				doc.querySelectorAll(EMBED_SELECTOR).forEach((el) => cb(el));
			} catch (e) {
				/* 单个窗口失败不影响其他窗口 */
			}
		}
	}

	/** 清理已脱离文档的元素状态，避免 Map/Set 越积越多 */
	pruneState() {
		for (const wv of [...this.liveCards]) {
			if (!wv.isConnected) this.liveCards.delete(wv);
		}
		for (const [wv, ro] of [...this.sizeObservers]) {
			if (!wv.isConnected) {
				try {
					ro.disconnect();
				} catch (e) {
					/* ignore */
				}
				this.sizeObservers.delete(wv);
			}
		}
		for (const [parent] of [...this.removedElements]) {
			if (!parent || !parent.isConnected) this.removedElements.delete(parent);
		}
		// 叶子被关掉/重排后清掉残留计时器（最长 otherCardTimeoutMs 后也会自清）
		for (const [leafEl, t] of [...this.otherTimers]) {
			if (!leafEl.isConnected) {
				clearTimeout(t);
				this.otherTimers.delete(leafEl);
			}
		}
	}

	sweep() {
		this.pruneState();
		// 自愈：把漏接管的窗口补上（floatingSplit 枚举时序/事件丢失的兜底）
		for (const win of this.knownWindows()) {
			if (!win.closed && !this.windows.has(win)) this.attachWindow(win);
		}
		for (const doc of this.allDocs()) this.handleTree(doc);
		this.recoverRespawned();
	}

	async onload() {
		// data.json 损坏（同步冲突/磁盘问题）时回退默认设置，而不是让插件加载失败
		let loaded: any = {};
		try {
			loaded = (await this.loadData()) || {};
		} catch (e) {
			console.error('[lite-webviews] 设置读取失败，使用默认设置:', e);
		}
		if (typeof loaded !== 'object' || Array.isArray(loaded)) loaded = {};
		// 深合并范围对象，避免旧数据缺少 webviewer 等键时静音/截图范围判断失效；
		// 同时避免无数据时修改到 DEFAULT_SETTINGS 里的共享对象。
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded, {
			screenshotScope: Object.assign({}, DEFAULT_SETTINGS.screenshotScope, loaded.screenshotScope || {}),
			muteScope: Object.assign({}, DEFAULT_SETTINGS.muteScope, loaded.muteScope || {}),
		});
		// 清理旧版本遗留字段（如 screenshotMaxAgeMs / buttonSizePx / idleSwitchDelayMs），
		// 避免无用配置继续写入 data.json。
		for (const key of Object.keys(this.settings)) {
			if (!(key in DEFAULT_SETTINGS)) delete this.settings[key];
		}
		for (const scopeKey of ['screenshotScope', 'muteScope']) {
			const scope = this.settings[scopeKey] || {};
			for (const key of Object.keys(scope)) {
				if (!(key in DEFAULT_SETTINGS[scopeKey])) delete scope[key];
			}
		}
		injectStyles();

		// 必须先定义 webview focus/blur 处理器，再开始 sweep：
		// handle() 在首次扫描时就会把这两个监听器挂到已有 webview 上。
		this.onWebviewFocus = (ev) => {
			const wv = ev && ev.target;
			if (!wv || isTempEmbed(wv)) return;
			this.webviewFocused = true;
			this.cancelTimers();
			if (wv.tagName === 'WEBVIEW') {
				this.store.get(wv).focused = true;
				this.lastActiveWv = wv;
				this.applyOperating(wv, true);
			}
		};
		this.onWebviewBlur = (ev) => {
			const wv = ev && ev.target;
			if (!wv || isTempEmbed(wv)) return;
			this.webviewFocused = false;
			if (wv.tagName === 'WEBVIEW') {
				this.store.get(wv).focused = false;
				this.applyOperating(wv, false);
			}
		};

		// 窗口失焦：延迟 300ms 判断是否为 webview 焦点导致的 Electron 误报
		this.blurHandler = () => {
			if (this.blurGuard) clearTimeout(this.blurGuard);
			this.blurGuard = setTimeout(() => {
				this.blurGuard = null;
				if (this.webviewFocused) return;
				this.restartBlurTimer();
			}, BLUR_GUARD_MS);
		};
		this.focusHandler = () => {
			this.webviewFocused = false;
			this.cancelTimers();
		};

		// Esc：收起按键所在窗口内未锁定的 live 卡片
		this.escHandler = (e) => {
			if (e.key !== 'Escape') return;
			// 在输入框/文本编辑区按 Esc 是退出编辑，不应顺手把网页全挂起
			const t = e.target;
			if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
			// 处理器按窗口挂载：只处理本窗口的卡片，主窗口按 Esc 不应把
			// popout 里正在使用的卡片一起挂起
			const win = e.view || (t && t.ownerDocument && t.ownerDocument.defaultView) || null;
			for (const wv of [...this.liveCards]) {
				if (this.isLocked(wv)) continue;
				if (win && this.viewOf(wv) !== win) continue;
				this.switchToScreenshot(wv).catch(() => {});
			}
		};

		// 画布内操作其他卡片/空白 → 重启"5 分钟"计时（不影响锁定卡片）
		this.pointerHandler = (e) => {
			if (this.liveCards.size === 0) return;
			const target = e.target;
			if (!target || !target.closest) return;
			const leafEl = target.closest('.workspace-leaf');
			if (!leafEl) return;
			for (const wv of this.liveCards) {
				if (!wv.isConnected) continue;
				const node = wv.closest('.canvas-node') || null;
				if (node && node.contains(target)) return; // 点在 live 卡片上，不启动计时
				if (
					wv.classList.contains('excalidraw__embeddable') &&
					(wv.contains(target) || target === wv)
				)
					return;
			}
			this.restartOtherTimer(leafEl);
		};

		if (this.settings.killRendererOnSuspend && !this.remoteWebContents()) {
			// 提前告知而非静默降级：用户升级 Obsidian 后此能力可能随版本消失
			new Notice(
				'Lite Webviews：当前环境无法访问 electron.remote，"挂起时彻底卸载"不可用，将回退为仅置空页面。',
				6000
			);
		}

		// 接管主窗口与已打开的 popout（样式/观察器/全局事件按窗口挂载）；之后的开关由事件维护
		for (const win of this.knownWindows()) this.attachWindow(win);
		this.registerEvent((this.app.workspace as any).on('window-open', (win) => this.attachWindow(win)));
		this.registerEvent((this.app.workspace as any).on('window-close', (win) => this.detachWindow(win)));

		this.sweep();
		this.app.workspace.onLayoutReady(() => {
			if (!this._unloaded) this.sweep();
		});
		// registerInterval：卸载时自动清理，无需在 onunload 手动 clear
		this.registerInterval(window.setInterval(() => this.sweep(), SWEEP_INTERVAL_MS));
		// 缓存清理：启动时一次 + 每 24 小时一次
		this.cleanupCache();
		this.registerInterval(window.setInterval(() => this.cleanupCache(), 24 * 3600 * 1000));

		// 切走画布/应用 → 30 秒计时；回到画布 → 取消并刷新截图
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				const type = leaf && leaf.view ? leaf.view.getViewType() : '';
				if (type === 'canvas' || type === 'excalidraw') {
					this.cancelTimers();
				} else {
					// 离开画布后，"操作其他卡片"的旧计时已无意义，取消后只保留离开计时
					this.cancelTimers();
					this.restartBlurTimer();
				}
			})
		);

		// 焦点轮询：webview 的 focus/blur 事件时灵时不灵，用 activeElement 双通道兜底
		this.registerInterval(window.setInterval(() => this.pollFocus(), 500));

		// 命令
		this.addCommand({
			id: 'toggle-screenshot-mode',
			name: '切换截图省内存模式',
			callback: () => {
				this.settings.screenshotMode = !this.settings.screenshotMode;
				this.saveSettings();
				if (this.settings.screenshotMode) {
					// 不能只 sweep：现有卡片都标着 live，handle 会跳过它们。
					// 需要强制把当前所有符合条件的 live 卡收成截图。
					this.suspendEligibleNow();
				} else {
					this.restoreAllBlanked();
				}
			},
		});
		this.addCommand({
			id: 'stop-all-embeds',
			name: '停止所有嵌入网页（立即静音）',
			callback: () => {
				this.forEmbeds((el) => {
					if (isTempEmbed(el)) return;
					const cat = categorize(el);
					// 截图模式内的卡片统一走挂起流程：抓图/占位/状态与其他入口一致，
					// 避免只置空 src 留下"标记 live 却一片空白"的中间状态。
					if (
						this.settings.screenshotMode &&
						this.settings.screenshotScope[cat] &&
						isScreenshotTargetEl(el, cat)
					) {
						this.switchToScreenshot(el, el.dataset.noAutoplayScreenshot !== 'live').catch(
							() => {}
						);
						return;
					}
					if (el.tagName === 'IFRAME' && cat === 'excalidraw') {
						// srcdoc iframe 只设 src=about:blank 不会停止 srcdoc 内容，必须保存后清空
						let stored = this.iframeDocs.get(el);
						if (!stored) {
							stored = {};
							this.iframeDocs.set(el, stored);
						}
						stored.srcdoc = stripPluginHtml(el.getAttribute('srcdoc') || '');
						stored.src = el.getAttribute('src') || '';
						stored.muted = this.store.get(el).muted;
						try {
							el.removeAttribute('srcdoc');
							el.removeAttribute('src');
						} catch (e) {
							/* ignore */
						}
						return;
					}
					// 只停止真正的网页（http/data 来源）。画布中的 PDF 等文件卡片同样
					// 由 iframe 渲染（src 为 app:// 本地地址），清空它们只会让卡片白屏
					if (!isWebSrc(el)) return;
					if (!this.store.get(el).src) {
						try {
							this.store.get(el).src = el.src || '';
						} catch (e) {
							/* ignore */
						}
					}
					try {
						el.src = 'about:blank';
					} catch (e) {
						/* ignore */
					}
				});
			},
		});
		this.addCommand({
			id: 'restore-all-embeds',
			name: '恢复所有嵌入网页',
			callback: () => {
				// 被杀进程模式移除的 webview 也要重建，才能谈得上"恢复所有"
				this.removedElements.forEach((stored, parent) => {
					if (!parent || !parent.isConnected) return;
					try {
						this.createWebviewFromSnapshot(parent, stored);
						this.removedElements.delete(parent);
					} catch (e) {
						/* ignore */
					}
				});
				this.forEmbeds((el) => {
					if (isTempEmbed(el)) return;
					const cat = categorize(el);
					// 保留容器上的激活继承标记：截图模式仍开着，重建元素应继续继承 live
					this.restoreOne(el, cat, false);
					const target =
						this.settings.screenshotMode &&
						this.settings.screenshotScope[cat] &&
						isScreenshotTargetEl(el, cat);
					if (target) {
						// 恢复到 live 后要加入 liveCards，自动计时/按钮才会继续生效
						this.liveCards.add(el);
						this.lastActiveWv = el;
						this.addCardButtons(el);
					}
				});
			},
		});

		this.addCommand({
			id: 'toggle-lock-current',
			name: '保活/取消保活当前卡片',
			callback: () => {
				const wv = this.currentCard();
				if (!wv) {
					return;
				}
				const locked = this.store.get(wv).locked;
				this.store.get(wv).locked = !locked;
				const node = wv.closest('.canvas-node') || this.napParent(wv);
				if (node) this.store.container(node).locked = this.store.get(wv).locked;
				if (this.napParent(wv)) {
					this.napParent(wv).querySelectorAll('.no-autoplay-lock').forEach((btn) => {
						btn.textContent = locked ? '保活' : '已保活';
						btn.classList.toggle('is-locked', !locked);
					});
				}
			},
		});

		this.addCommand({
			id: 'suspend-current',
			name: '挂起当前卡片',
			callback: () => {
				const wv = this.currentCard();
				if (!wv) {
					new Notice('Lite Webviews：当前没有可挂起的卡片');
					return;
				}
				if (wv.dataset.noAutoplayScreenshot === 'screenshot') return; // 已是截图状态
				this.switchToScreenshot(wv).catch(() => {}); // 手动挂起对保活卡片也生效
			},
		});

		this.addCommand({
			id: 'refresh-current-screenshot',
			name: '刷新当前卡片截图',
			callback: () => {
				const wv = this.currentCard();
				if (!wv) {
					new Notice('Lite Webviews：当前没有可刷新的卡片');
					return;
				}
				this.refreshCurrentScreenshot(wv).catch(() => {});
			},
		});

		this.addSettingTab(new LiteWebviewsSettingsTab(this.app, this));
	}

	/** 开启截图模式/某范围时：把当前所有符合条件的 live/未知卡片强制收成截图。
	 *  不能只 sweep：现有 live 卡片会被 handle 跳过，导致开关看似失效。 */
	suspendEligibleNow() {
		if (!this.settings.screenshotMode) return;
		this.forEmbeds((el) => {
			if (isTempEmbed(el)) return;
			const cat = categorize(el);
			if (!this.settings.screenshotScope[cat] || !isScreenshotTargetEl(el, cat)) return;
			if (el.dataset.noAutoplayScreenshot === 'screenshot') return;
			// 这些元素已经存在于 DOM，按"非 fresh"处理：已加载完就先补抓一张最新截图
			this.switchToScreenshot(el, false).catch(() => {});
		});
	}

	/** 恢复 Excalidraw 快照型 iframe 的原始 srcdoc/src（关闭截图模式/恢复命令共用） */
	restoreIframeContent(el) {
		const stored = this.iframeDocs.get(el);
		if (!stored) return false;
		this.store.get(el).muted = stored.muted ?? null;
		try {
			if (stored.srcdoc) el.setAttribute('srcdoc', stored.srcdoc);
			else el.removeAttribute('srcdoc');
			if (stored.src) el.setAttribute('src', stored.src);
			else el.removeAttribute('src');
		} catch (e) {
			/* ignore */
		}
		this.applyIframePlugins(el);
		this.iframeDocs.delete(el);
		return true;
	}

	/** 清除容器上的"激活继承"标记，防止关闭截图模式后 12 小时内新建元素仍被误标 live */
	clearActivationMarkers(el) {
		try {
			const node = el.closest('.canvas-node') || el.parentElement || this.napParent(el);
			if (!node || !node.dataset) return;
			delete node.dataset.noAutoplayActivatedSrc;
			delete node.dataset.noAutoplayActivatedUntil;
			this.store.container(node).locked = false;
		} catch (e) {
			/* ignore */
		}
	}

	/** 恢复单张卡片为真网页：还原被清空的地址/内容、复活被杀的渲染进程、
	 *  重置状态标记并清掉卡片按钮（恢复所有/关闭模式/取消范围共用）。
	 *  clearMarkers=false 时保留容器上的"激活继承"标记（"恢复所有"命令需要沿用，
	 *  截图模式仍开着时重建元素应继续继承 live）。 */
	restoreOne(el, cat, clearMarkers = true) {
		if (el.tagName === 'IFRAME' && cat === 'excalidraw') {
			// 关键：srcdoc 被清空的占位 iframe 不能只改状态，必须从快照恢复内容
			this.restoreIframeContent(el);
		} else {
			const orig = this.store.get(el).src;
			if (this.store.get(el).crashed) {
				this.store.get(el).crashed = false;
				try {
					el.reload();
				} catch (e) {
					try {
						if (typeof el.loadURL === 'function') el.loadURL(orig);
						else el.src = orig;
					} catch (e2) {
						/* ignore */
					}
				}
			} else if (orig && orig !== 'about:blank' && isBlank(el)) {
				try {
					el.src = orig;
				} catch (e) {
					/* ignore */
				}
			}
		}
		el.dataset.noAutoplayScreenshot = 'live';
		this.store.get(el).locked = false;
		if (clearMarkers) this.clearActivationMarkers(el);
		this.removeCardButtons(el);
		// 重建/恢复的 webview 需要立即应用静音和背景修复，避免等到下一次 sweep
		if (el.tagName === 'WEBVIEW') {
			this.applyMuteState(el, cat);
			this.applyBackgroundFix(el);
		}
	}

	/** 关闭截图模式时：恢复所有被置空/被杀进程/被移除的网页 */
	restoreAllBlanked() {
		// 重建被移除的元素
		this.removedElements.forEach((stored, parent) => {
			if (!parent || !parent.isConnected) return;
			try {
				this.createWebviewFromSnapshot(parent, stored);
			} catch (e) {
				/* ignore */
			}
		});
		this.removedElements.clear();

		this.forEmbeds((el) => {
			if (isTempEmbed(el)) return;
			this.restoreOne(el, categorize(el));
		});
		this.liveCards.clear();
		this.cancelTimers();
	}

	/** 取消某范围的截图模式：把该范围已截图的卡片恢复为真网页 */
	restoreCategory(cat) {
		this.removedElements.forEach((stored, parent) => {
			if (!parent || !parent.isConnected) return;
			if (stored.cat !== cat) return;
			try {
				this.createWebviewFromSnapshot(parent, stored);
				this.removedElements.delete(parent);
			} catch (e) {
				/* ignore */
			}
		});
		this.forEmbeds((el) => {
			if (isTempEmbed(el)) return;
			if (categorize(el) !== cat) return;
			this.restoreOne(el, cat);
			this.liveCards.delete(el);
		});
	}

	/** 按范围重新应用静音状态（尊重每卡设置与默认静音） */
	applyMuteCategory(cat) {
		this.forEmbeds((el) => {
			if (isTempEmbed(el)) return;
			if (categorize(el) !== cat) return;
			if (el.tagName === 'WEBVIEW') {
				this.applyMuteState(el, cat);
				this.applyBackgroundFix(el);
			} else if (el.tagName === 'IFRAME' && cat === 'excalidraw') {
				// 占位 iframe 的 srcdoc 已清空，注入没有意义；激活时会按当前设置处理
				if (el.dataset.noAutoplayScreenshot === 'screenshot') return;
				this.applyIframePlugins(el);
			}
		});
	}

	onunload() {
		this._unloaded = true;
		// 先停掉所有监听/观察器，避免恢复操作触发 mutation 回调又把页面收起来
		for (const [obs] of this.winObservers) {
			try {
				obs.disconnect();
			} catch (e) {
				/* ignore */
			}
		}
		this.winObservers.clear();
		if (this.cleanupSoonTimer) clearTimeout(this.cleanupSoonTimer);
		// 设置写盘防抖未落盘就卸载：尽力 flush 一次
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
			this.saveData(this.settings).catch(() => {});
		}
		// 唤醒所有排队等待抓图槽的任务：它们会看到已卸载并直接放弃，不再孵化新进程
		this.tempCaptureQueue.splice(0).forEach((wake) => wake());
		this.tempCaptureSlots = 0;
		this.cancelTimers();
		if (this.blurGuard) clearTimeout(this.blurGuard);

		// 恢复被挂起的网页（会顺带清理按钮、占位与状态监听器）
		this.restoreAllBlanked();

		// 卸载时移除挂在 webview 上的本插件监听器，并清除幂等标记；
		// 否则插件重载后旧监听仍残留，新实例又因标记已存在而不再挂载。
		this.forEmbeds((wv) => {
			if (wv.tagName !== 'WEBVIEW') return;
			const st = this.store.peek(wv); // peek：从未管过的元素不必凭空建状态
			if (st && st.hooked.focus && this.onWebviewFocus) {
				try {
					wv.removeEventListener('focus', this.onWebviewFocus);
					wv.removeEventListener('blur', this.onWebviewBlur);
				} catch (e) {
					/* ignore */
				}
				st.hooked.focus = false;
			}
			const reMute = this.muteHandlers.get(wv);
			if (reMute) {
				try {
					wv.removeEventListener('did-attach', reMute);
					wv.removeEventListener('dom-ready', reMute);
					wv.removeEventListener('did-navigate', reMute);
					wv.removeEventListener('did-navigate-in-page', reMute);
				} catch (e) {
					/* ignore */
				}
				this.muteHandlers.delete(wv);
				if (st) st.hooked.mute = false;
			}
			const bgFix = this.bgHandlers.get(wv);
			if (bgFix) {
				try {
					wv.removeEventListener('dom-ready', bgFix);
					wv.removeEventListener('did-navigate', bgFix);
					wv.removeEventListener('did-navigate-in-page', bgFix);
				} catch (e) {
					/* ignore */
				}
				this.bgHandlers.delete(wv);
			}
			if (st && st.bgFixApplied) {
				this.execInWebview(wv, BG_FIX_CLEANUP_JS);
			}
			if (st) {
				st.hooked.bgFix = false;
				st.bgFixApplied = false;
			}
		});

		for (const [, ro] of this.sizeObservers) {
			try {
				ro.disconnect();
			} catch (e) {
				/* ignore */
			}
		}
		this.sizeObservers.clear();
		for (const doc of this.allDocs()) {
			try {
				doc.querySelectorAll('webview[data-no-autoplay-temp="1"]').forEach((el) => el.remove());
			} catch (e) {
				/* ignore */
			}
		}
		// 最后统一摘掉各窗口上的事件监听与注入样式
		for (const win of [...this.windows]) this.detachWindow(win);
		this.windows.clear();
	}
}

