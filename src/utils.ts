/**
 * 通用工具：编码、时间格式化、嵌入元素识别与缓存键哈希。
 * 全部为无副作用的纯函数。
 */

/** 把 Unicode 安全的 HTML 字符串编码为 base64 data URL（避免 unescape 弃用 API） */
export function htmlToDataUrl(html) {
	try {
		const bytes = new TextEncoder().encode(html);
		let binary = '';
		const chunkSize = 0x8000;
		for (let i = 0; i < bytes.length; i += chunkSize) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
		}
		return 'data:text/html;base64,' + btoa(binary);
	} catch (e) {
		return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
	}
}

/** 人类可读的时间差（截图新鲜度标注用）：刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 */
export function formatAge(ts) {
	const diff = Date.now() - (ts || 0);
	if (diff < 60 * 1000) return '刚刚';
	if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
	if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
	if (diff < 30 * 24 * 3600000) return Math.floor(diff / 86400000) + ' 天前';
	return Math.floor(diff / (30 * 86400000)) + ' 个月前';
}

export function isEmbed(el) {
	return el.tagName === 'IFRAME' || el.tagName === 'WEBVIEW';
}

/** 识别网页来源：画布 / Excalidraw / 网页浏览器标签页 */
export function categorize(el) {
	try {
		if (el.closest && el.closest('.canvas-node')) return 'canvas';
	} catch (e) {
		/* ignore */
	}
	if (el.classList && el.classList.contains('excalidraw__embeddable')) return 'excalidraw';
	return 'webviewer';
}

export function isBlank(el) {
	try {
		return !el.src || el.src === 'about:blank';
	} catch (e) {
		return true;
	}
}

/** 判断是否为真正的网页地址（http/https/data），排除画布内部元素 */
export function isWebSrc(el) {
	try {
		const u = el.getAttribute('src') || el.src || '';
		return /^(https?:|data:)/i.test(u);
	} catch (e) {
		return false;
	}
}

/** 是否参与"截图省内存"：画布/Excalidraw 的真网页 webview，或 Excalidraw 快照型 iframe */
export function isScreenshotTargetEl(el, cat) {
	return (
		(el.tagName === 'WEBVIEW' && isWebSrc(el)) ||
		(el.tagName === 'IFRAME' &&
			cat === 'excalidraw' &&
			el.classList &&
			el.classList.contains('excalidraw__embeddable'))
	);
}

export function isTempEmbed(el) {
	return !!(el && el.dataset && el.dataset.noAutoplayTemp === '1');
}

/** 去掉 iframe allow 属性中的 autoplay 权限（桌面端基本用不到，兜底用） */
export function stripAutoplayPermission(el) {
	const allow = el.getAttribute('allow');
	if (!allow) return;
	const tokens = allow
		.split(/[;, ]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	const filtered = [];
	for (const t of tokens) {
		const low = t.toLowerCase();
		if (low === 'autoplay') continue;
		if (low === '*') {
			filtered.push('fullscreen', 'encrypted-media', 'picture-in-picture', 'web-share');
			continue;
		}
		filtered.push(t);
	}
	const unique = [...new Set(filtered)];
	const next = unique.join('; ');
	if (unique.length === 0) {
		if (el.hasAttribute('allow')) el.removeAttribute('allow');
	} else if (el.getAttribute('allow') !== next) {
		el.setAttribute('allow', next);
	}
}

/** 缓存键哈希：优先沿用 Node crypto 的 SHA-256 前 16 位（兼容旧缓存文件）；
 *  沙箱里 crypto 不可用时回退到纯 JS 64 位哈希，插件仍可正常加载 */
export function hashUrl(src) {
	src = String(src || '');
	try {
		const crypto = require('crypto');
		if (crypto && crypto.createHash) {
			return crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
		}
	} catch (e) {
		/* 沙箱无 crypto：走纯 JS 回退 */
	}
	try {
		let h1 = 0x811c9dc5; // FNV-1a 种子
		let h2 = 0x01000193; // 另一组种子，双通道凑足 64 位
		for (let i = 0; i < src.length; i++) {
			const c = src.charCodeAt(i);
			h1 = Math.imul(h1 ^ c, 0x01000193);
			h2 = Math.imul(h2 ^ c, 0x85ebca6b);
		}
		const hex = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
		return hex(h1) + hex(h2);
	} catch (e) {
		let h = 5381;
		for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) | 0;
		return 'h' + (h >>> 0).toString(16);
	}
}
