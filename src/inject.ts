/**
 * 常量与页内注入脚本：静音脚本 / 背景修复脚本的注入与剥离。
 * 全部为无副作用的纯函数与字符串常量。
 */

export const EMBED_SELECTOR = 'iframe, webview';

// 注入 srcdoc 的自持型静音脚本：
// MutationObserver 覆盖"后来创建的"媒体元素，捕获阶段 play 监听强制静音；
// 只有 MutationObserver 不可用时才降级为定时重扫。
// MUTE_SCRIPT_MARKER 是注入脚本的唯一幂等标记；注入/剥离都围绕它进行。
export const MUTE_SCRIPT_MARKER = '__napMuteScriptV1';
export const MUTE_SCRIPT =
	'<script>(function(){window.' + MUTE_SCRIPT_MARKER + '=true;function m(){var els=document.querySelectorAll("video,audio");for(var i=0;i<els.length;i++){els[i].muted=true;els[i].defaultMuted=true}}try{new MutationObserver(m).observe(document.documentElement||document,{childList:true,subtree:true})}catch(e){setInterval(m,2000)}document.addEventListener("play",function(ev){var t=ev.target;if(t&&(t.tagName==="VIDEO"||t.tagName==="AUDIO")){t.muted=true;t.defaultMuted=true}},true);window.addEventListener("DOMContentLoaded",m);m()})();<\/script>';
export const DRAG_THRESHOLD = 5; // px，区分点击与拖动
// Chromium 顶层导航 URL 上限约 2MB，base64 再膨胀 4/3；超过此长度的 srcdoc 无法走 data URL 抓图
export const MAX_SRCDOC_CAPTURE = 1500000;
// 同时存活的临时抓图 webview 上限：打开大画布时几十张卡会同时后台补拍，
// 不限流就瞬间孵化等量渲染进程（CPU/内存尖峰），排队逐个来
export const MAX_TEMP_CAPTURES = 3;
// 全量兜底扫描间隔：DOM 变化已由 MutationObserver 覆盖，sweep 只是漏接管时的保险，
// 间隔不必太短，避免大画布下频繁全文档 querySelectorAll
export const SWEEP_INTERVAL_MS = 10000;

// —— 各流程使用的固定时长/时限（集中命名，避免散落的魔法数字）——

// 容器"激活继承"标记的有效期：标记只存在 DOM 里，重启 Obsidian 后自然消失，
// 该时限只约束同一会话内"重建元素继承 live"的最长有效期
export const ACTIVATION_MARK_TTL_MS = 12 * 3600 * 1000;
// 窗口 blur 误报判定窗口：webview 抢焦点会让窗口瞬间 blur，窗口期内恢复就不算"切走应用"
export const BLUR_GUARD_MS = 300;
// 临时 webview 抓图前的渲染静置时长（页面加载完成后等 JS 画出首帧）
export const TEMP_CAPTURE_SETTLE_MS = 800;
// live 卡片点开期间静默抓图前的静置时长（比临时抓图更宽，确保渲染完整）
export const LIVE_CAPTURE_SETTLE_MS = 1000;
// "加载中…"状态文本的兜底移除时限（页面没触发 dom-ready/失败事件时也会消失）
export const STATUS_TIMEOUT_MS = 10000;
// 右键菜单弹出前等待"右键松开"的兜底时限（异常输入环境收不到 pointerup 也照常弹菜单）
export const CONTEXT_MENU_FALLBACK_MS = 600;

// 修复背景透明：仅当页面自身 html/body 背景确实透明时才补充白色背景。
// 如果站点已有自己的背景色（包括深色主题），则不干预，避免把黑底站点改白。
export const BG_FIX_MARKER = '__napBgFixStyle';
export const BG_FIX_JS =
	"(function(){function fix(){try{var root=document.documentElement,body=document.body;if(!root||!body)return;function isTransparent(el){var c=getComputedStyle(el).backgroundColor;if(!c||c==='transparent')return true;var m=c.match(/rgba?\\(([^)]*)\\)/);if(m){var p=m[1].split(',');var a=p.length>=4?parseFloat(p[3]):1;if(a===0)return true;}return false;}if(isTransparent(root)&&isTransparent(body)){root.style.backgroundColor='#ffffff';body.style.backgroundColor='#ffffff';}}catch(e){}}if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',fix)}else{fix()}})();";
export const BG_FIX_STYLE = '<script data-nap-bg-fix="' + BG_FIX_MARKER + '">' + BG_FIX_JS + '<\/script>';
export const BG_FIX_CLEANUP_JS =
	"(function(){try{var s=document.querySelector('[data-nap-bg-fix=\"" + BG_FIX_MARKER + "\"]');if(s)s.remove();document.documentElement.style.removeProperty('background-color');document.body.style.removeProperty('background-color');document.documentElement.style.removeProperty('color-scheme');}catch(e){}})();";

/** 把静音脚本注入 HTML 字符串：优先放入 <head> 末尾，保留原 <!DOCTYPE html>，避免 prepend 导致 quirks 模式 */
export function injectMuteHtml(doc) {
	if (!doc || doc.includes(MUTE_SCRIPT_MARKER)) return doc || '';
	// 用正则做大小写不敏感匹配，避免为整个 HTML 再 lowerCase 一份大字符串。
	const headMatches = doc.match(/<\/head>/gi);
	if (headMatches && headMatches.length) {
		const headEnd = doc.lastIndexOf(headMatches[headMatches.length - 1]);
		return doc.slice(0, headEnd) + MUTE_SCRIPT + doc.slice(headEnd);
	}
	const bodyMatch = doc.match(/<body[\s>]/i);
	if (bodyMatch && bodyMatch.index !== undefined) {
		const tagEnd = doc.indexOf('>', bodyMatch.index);
		if (tagEnd !== -1) {
			return doc.slice(0, tagEnd + 1) + MUTE_SCRIPT + doc.slice(tagEnd + 1);
		}
	}
	const doctype = doc.match(/^(\s*<!doctype[^>]*>)/i);
	if (doctype) {
		return doctype[0] + MUTE_SCRIPT + doc.slice(doctype[0].length);
	}
	return MUTE_SCRIPT + doc;
}

/** 从 HTML 字符串中精确移除我们注入的静音脚本（不会误删页面自身的 <script>） */
export function stripMuteHtml(doc) {
	if (!doc) return '';
	const i = doc.indexOf(MUTE_SCRIPT);
	if (i === -1) return doc;
	return doc.slice(0, i) + doc.slice(i + MUTE_SCRIPT.length);
}

/** 向 HTML 字符串注入背景修复样式（幂等）
 *  插入到 <head> 开头，让页面自身的样式可以覆盖兜底背景，避免破坏深色主题。 */
export function injectBackgroundFixHtml(doc) {
	if (!doc || doc.includes(BG_FIX_MARKER)) return doc || '';
	const headOpen = doc.match(/<head[^>]*>/i);
	if (headOpen && headOpen.index !== undefined) {
		const tagEnd = headOpen.index + headOpen[0].length;
		return doc.slice(0, tagEnd) + BG_FIX_STYLE + doc.slice(tagEnd);
	}
	const headMatches = doc.match(/<\/head>/gi);
	if (headMatches && headMatches.length) {
		const headEnd = doc.lastIndexOf(headMatches[headMatches.length - 1]);
		return doc.slice(0, headEnd) + BG_FIX_STYLE + doc.slice(headEnd);
	}
	const bodyMatch = doc.match(/<body[\s>]/i);
	if (bodyMatch && bodyMatch.index !== undefined) {
		const tagEnd = doc.indexOf('>', bodyMatch.index);
		if (tagEnd !== -1) {
			return doc.slice(0, tagEnd + 1) + BG_FIX_STYLE + doc.slice(tagEnd + 1);
		}
	}
	const doctype = doc.match(/^(\s*<!doctype[^>]*>)/i);
	if (doctype) {
		return doctype[0] + BG_FIX_STYLE + doc.slice(doctype[0].length);
	}
	return BG_FIX_STYLE + doc;
}

/** 从 HTML 字符串中移除背景修复脚本/样式（兼容旧版本不同内容的 style 标签） */
export function stripBackgroundFixHtml(doc) {
	if (!doc) return '';
	const pattern = new RegExp(
		'<(?:style|script) data-nap-bg-fix="' + BG_FIX_MARKER + '">[\\s\\S]*?</(?:style|script)>',
		'i'
	);
	const match = doc.match(pattern);
	if (!match || match.index === undefined) return doc;
	return doc.slice(0, match.index) + doc.slice(match.index + match[0].length);
}

/** 去掉插件注入到 srcdoc 的全部内容（静音脚本 + 背景修复样式），得到原始 HTML */
export function stripPluginHtml(doc) {
	return stripMuteHtml(stripBackgroundFixHtml(doc));
}
