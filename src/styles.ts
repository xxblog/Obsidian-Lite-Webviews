/**
 * 占位层/按钮/状态文本样式（使用 Obsidian 主题变量，自动适配明暗模式）。
 * 按 document 注入：主窗口与每个 popout 窗口各一份。
 */
export function injectStyles(doc = document) {
	const id = 'no-autoplay-styles';
	if (doc.getElementById(id)) return;
	const style = doc.createElement('style');
	style.id = id;
	style.textContent = `
.no-autoplay-placeholder {
	position: absolute; inset: 0; z-index: 1000;
	background: var(--background-primary);
	overflow: hidden;
	border-radius: inherit;
	cursor: pointer;
	user-select: none;
}
.no-autoplay-placeholder img.no-autoplay-shot {
	position: absolute; inset: 0; width: 100%; height: 100%;
	object-fit: cover;
	opacity: 0.85;
	filter: brightness(0.75);
	-webkit-user-drag: none;
	pointer-events: none;
}
.no-autoplay-status {
	position: absolute; right: 8px; bottom: 6px;
	z-index: 1003;
	font-size: calc(var(--nap-size, 13px) * 0.85);
	color: var(--text-faint);
	text-shadow: 0 1px 3px rgba(0,0,0,0.8);
	pointer-events: none;
	opacity: 0.5;
	white-space: nowrap;
}
.no-autoplay-freshness {
	position: absolute; left: 8px; bottom: 6px;
	z-index: 1003;
	font-size: calc(var(--nap-size, 13px) * 0.85);
	color: var(--text-faint);
	text-shadow: 0 1px 3px rgba(0,0,0,0.8);
	pointer-events: none;
	opacity: 0.5;
	white-space: nowrap;
}
.nap-group-header {
	background: transparent;
	padding: 6px 2px 2px;
	margin: 14px 0 2px;
	font-size: var(--font-ui-small);
	color: var(--text-muted);
	border-bottom: 1px solid var(--background-modifier-border);
}
.nap-option-row {
	margin-left: 16px;
	border-left: 2px solid var(--background-modifier-border);
}
.nap-option-row .setting-item-name {
	font-size: var(--font-ui-small);
}
.no-autoplay-zone {
	position: absolute; top: 0; right: 0;
	display: flex; align-items: center; justify-content: flex-end;
	gap: calc(var(--nap-size, 13px) * 0.4);
	padding: calc(var(--nap-size, 13px) * 0.45);
	z-index: 1001;
}
.no-autoplay-collapse, .no-autoplay-lock, .no-autoplay-mute {
	font-size: var(--nap-size, 13px);
	line-height: 1.2;
	min-width: calc(var(--nap-size, 13px) * 2.2);
	min-height: calc(var(--nap-size, 13px) * 2.2);
	display: flex; align-items: center; justify-content: center;
	padding: calc(var(--nap-size, 13px) * 0.3) calc(var(--nap-size, 13px) * 0.7);
	border-radius: calc(var(--nap-size, 13px) * 0.5);
	background: var(--background-primary);
	color: var(--text-muted);
	cursor: pointer;
	box-shadow: 0 2px 8px rgba(0,0,0,0.35);
	user-select: none;
	white-space: nowrap; /* 防止"保活"等中文被换行成竖排 */
	opacity: 0.5;
	transition: opacity 0.25s ease;
}
/* 鼠标进入右上角感应区（或按钮本身）→ 按钮清晰 */
.no-autoplay-zone.nap-zone-hover .no-autoplay-collapse,
.no-autoplay-zone.nap-zone-hover .no-autoplay-lock,
.no-autoplay-zone.nap-zone-hover .no-autoplay-mute {
	opacity: 1;
	pointer-events: auto;
}
/* 操作中（焦点在网页内）→ 隐藏 */
.canvas-node.nap-operating .no-autoplay-collapse,
.canvas-node.nap-operating .no-autoplay-lock,
.canvas-node.nap-operating .no-autoplay-mute,
.excalidraw__embeddable.nap-operating ~ .no-autoplay-zone .no-autoplay-collapse,
.excalidraw__embeddable.nap-operating ~ .no-autoplay-zone .no-autoplay-lock,
.excalidraw__embeddable.nap-operating ~ .no-autoplay-zone .no-autoplay-mute {
	opacity: 0;
	pointer-events: none;
}
/* 操作中 + 鼠标进入感应区 → 仍清晰 */
.canvas-node.nap-operating .no-autoplay-zone.nap-zone-hover .no-autoplay-collapse,
.canvas-node.nap-operating .no-autoplay-zone.nap-zone-hover .no-autoplay-lock,
.canvas-node.nap-operating .no-autoplay-zone.nap-zone-hover .no-autoplay-mute,
.excalidraw__embeddable.nap-operating ~ .no-autoplay-zone.nap-zone-hover .no-autoplay-collapse,
.excalidraw__embeddable.nap-operating ~ .no-autoplay-zone.nap-zone-hover .no-autoplay-lock,
.excalidraw__embeddable.nap-operating ~ .no-autoplay-zone.nap-zone-hover .no-autoplay-mute {
	opacity: 1;
	pointer-events: auto;
}
.no-autoplay-lock.is-locked, .no-autoplay-mute.is-muted {
	background: var(--interactive-accent);
	color: var(--text-on-accent);
}
`;
	(doc.head || doc.documentElement).appendChild(style);
}
