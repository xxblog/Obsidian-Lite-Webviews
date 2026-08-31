import { App, PluginSettingTab, Setting } from 'obsidian';
import { categorize, isTempEmbed } from './utils';
import type LiteWebviewsPlugin from './main';

export interface LiteWebviewsSettings {
	screenshotMode: boolean;
	screenshotScope: { canvas: boolean; excalidraw: boolean };
	muteScope: { canvas: boolean; excalidraw: boolean; webviewer: boolean };
	defaultMute: boolean; // 默认静音：未单独设置卡片的初始静音状态
	otherCardTimeoutMs: number; // 操作其他卡片后挂起（-1 = 永不）
	appBlurTimeoutMs: number; // 切走应用/标签页后挂起（-1 = 永不）
	buttonFontSizePx: number; // 卡片按钮/状态文字的屏幕字号（固定像素，不随画布缩放变化）
	captureMinScreenPx: number; // 抓图最小屏幕短边（px）；卡片太小不抓图，0 = 不限制
	screenshotQuality: number; // 截图质量（%），10-100；100 使用 PNG 无损保存，<100 使用 JPEG
	screenshotMaxEdgePx: number; // 截图存盘前按最长边降采样的上限（px），0 = 不限制
	fixTransparentBackground: boolean; // 修复部分网页在 Obsidian 中背景透明、透出控件的问题
	killRendererOnSuspend: boolean; // 挂起时杀渲染进程（实验性，彻底释放内存）
	cacheSizeLimitMB: number; // 截图缓存大小上限（MB），0 = 不限制
}

export const DEFAULT_SETTINGS: LiteWebviewsSettings = {
	screenshotMode: true,
	screenshotScope: { canvas: true, excalidraw: true },
	muteScope: { canvas: true, excalidraw: true, webviewer: true },
	defaultMute: true,
	otherCardTimeoutMs: 5 * 60 * 1000, // 操作其他卡片后 5 分钟挂起
	appBlurTimeoutMs: 30 * 1000, // 切走应用/标签页后 30 秒挂起
	buttonFontSizePx: 13,
	captureMinScreenPx: 100,
	screenshotQuality: 80,
	screenshotMaxEdgePx: 1280,
	fixTransparentBackground: true,
	killRendererOnSuspend: false,
	cacheSizeLimitMB: 50,
};

export class LiteWebviewsSettingsTab extends PluginSettingTab {
	plugin: LiteWebviewsPlugin;
	cacheCheckTimer: any = null; // 缓存上限调整后的"按新上限清理"防抖句柄

	constructor(app: App, plugin: LiteWebviewsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** 带可见标签的开关行（用官方 Setting 组件，确保兼容） */
	addToggleRow(containerEl, label, value, onChange) {
		new Setting(containerEl)
			.setName(label)
			.setClass('nap-option-row')
			.addToggle((t) => t.setValue(value).onChange(onChange));
	}

	/** 数字输入框：限定范围与步进；失焦时把非法/越界输入恢复为当前生效值 */
	bindNumber(t, get, min, max, step) {
		const el = t.inputEl;
		el.type = 'number';
		el.min = String(min);
		el.max = String(max);
		el.step = String(step);
		el.addEventListener('blur', () => {
			const v = parseFloat(el.value);
			if (isNaN(v) || v < min || v > max) el.value = String(get());
		});
	}

	/** 毫秒 → 展示用分钟/秒数；-1（永不）原样展示，避免 Math.round(-ε) 被显示成 0 */
	minutesValue(ms) {
		return ms < 0 ? -1 : Math.round(ms / 60000);
	}
	secondsValue(ms) {
		return ms < 0 ? -1 : Math.round(ms / 1000);
	}

	display() {
		try {
			this._display();
		} catch (e) {
			console.error('[lite-webviews] 设置页渲染失败:', e);
			this.containerEl.createEl('p', {
				text: '设置页渲染出错：' + (e && e.message ? e.message : e) + '（详见开发者工具控制台）',
			});
		}
	}

	hide() {
		// 设置页关闭时放弃尚未执行的"按新上限清理"防抖任务
		if (this.cacheCheckTimer) {
			clearTimeout(this.cacheCheckTimer);
			this.cacheCheckTimer = null;
		}
	}

	_display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Lite Webviews · 网页卡片轻量化' });
		containerEl.createEl('p', { text: '网页静音 & 截图省内存', cls: 'setting-item-description' });

		// 总开关
		new Setting(containerEl)
			.setName('截图省内存模式')
			.setDesc('平时显示截图，点击卡片才加载真网页')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.screenshotMode).onChange(async (v) => {
					this.plugin.settings.screenshotMode = v;
					this.plugin.saveSettings();
					if (v) this.plugin.suspendEligibleNow();
					else this.plugin.restoreAllBlanked();
				})
			);

		// 截图范围
		containerEl.createDiv({ cls: 'nap-group-header', text: '截图范围' });
		this.addToggleRow(containerEl, '画布网页卡片', this.plugin.settings.screenshotScope.canvas, async (v) => {
			this.plugin.settings.screenshotScope.canvas = v;
			this.plugin.saveSettings();
			if (!v) this.plugin.restoreCategory('canvas');
			else this.plugin.suspendEligibleNow();
		});
		this.addToggleRow(containerEl, 'Excalidraw 嵌入网页', this.plugin.settings.screenshotScope.excalidraw, async (v) => {
			this.plugin.settings.screenshotScope.excalidraw = v;
			this.plugin.saveSettings();
			if (!v) this.plugin.restoreCategory('excalidraw');
			else this.plugin.suspendEligibleNow();
		});

		// 静音
		containerEl.createDiv({ cls: 'nap-group-header', text: '静音' });
		this.addToggleRow(containerEl, '画布网页卡片', this.plugin.settings.muteScope.canvas, async (v) => {
			this.plugin.settings.muteScope.canvas = v;
			this.plugin.saveSettings();
			this.plugin.applyMuteCategory('canvas');
		});
		this.addToggleRow(containerEl, 'Excalidraw 嵌入网页', this.plugin.settings.muteScope.excalidraw, async (v) => {
			this.plugin.settings.muteScope.excalidraw = v;
			this.plugin.saveSettings();
			this.plugin.applyMuteCategory('excalidraw');
		});
		this.addToggleRow(containerEl, '网页浏览器标签页', this.plugin.settings.muteScope.webviewer, async (v) => {
			this.plugin.settings.muteScope.webviewer = v;
			this.plugin.saveSettings();
			this.plugin.applyMuteCategory('webviewer');
		});
		new Setting(containerEl)
			.setName('默认静音')
			.setDesc('未单独设置的卡片默认静音')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.defaultMute).onChange(async (v) => {
					this.plugin.settings.defaultMute = v;
					this.plugin.saveSettings();
					this.plugin.applyMuteCategory('canvas');
					this.plugin.applyMuteCategory('excalidraw');
					this.plugin.applyMuteCategory('webviewer');
				})
			);

		// 渲染与截图
		containerEl.createDiv({ cls: 'nap-group-header', text: '渲染与截图' });
		new Setting(containerEl)
			.setName('修复背景透明')
			.setDesc('提供不透明兜底背景，并保留站点自身配色')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.fixTransparentBackground).onChange(async (v) => {
					this.plugin.settings.fixTransparentBackground = v;
					this.plugin.saveSettings();
					this.plugin.forEmbeds((el) => {
						if (isTempEmbed(el)) return;
						if (el.tagName === 'WEBVIEW') {
							this.plugin.applyBackgroundFix(el);
						} else if (el.tagName === 'IFRAME' && categorize(el) === 'excalidraw') {
							if (!this.plugin.store.isSuspended(el)) this.plugin.applyIframePlugins(el);
						}
					});
				})
			);
		new Setting(containerEl)
			.setName('截图质量（%）')
			.setDesc('10-100；100 为 PNG 无损')
			.addText((t) => {
				t.setValue(String(this.plugin.settings.screenshotQuality ?? 80));
				this.bindNumber(t, () => this.plugin.settings.screenshotQuality ?? 80, 10, 100, 1);
				t.onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 10 && n <= 100) {
						this.plugin.settings.screenshotQuality = n;
						this.plugin.saveSettings();
					}
				});
			});
		new Setting(containerEl)
			.setName('截图分辨率上限（px）')
			.setDesc('存盘前按最长边降采样，0 不限制。占位图是缩放显示的，过高分辨率只增加磁盘与内存开销')
			.addText((t) => {
				t.setValue(String(this.plugin.settings.screenshotMaxEdgePx));
				this.bindNumber(t, () => this.plugin.settings.screenshotMaxEdgePx, 0, 4096, 160);
				t.onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 0 && n <= 4096) {
						this.plugin.settings.screenshotMaxEdgePx = n;
						this.plugin.saveSettings();
					}
				});
			});
		new Setting(containerEl)
			.setName('最小抓图尺寸（px）')
			.setDesc('0 不限制')
			.addText((t) => {
				t.setValue(String(this.plugin.settings.captureMinScreenPx));
				this.bindNumber(t, () => this.plugin.settings.captureMinScreenPx, 0, 10000, 10);
				t.onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 0) {
						this.plugin.settings.captureMinScreenPx = n;
						this.plugin.saveSettings();
					}
				});
			});
		new Setting(containerEl)
			.setName('挂起时彻底卸载')
			.setDesc(
				this.plugin.canKillRenderer()
					? '实验性：释放更多内存。依赖 Obsidian 的非公开接口，升级后可能失效'
					: '⚠ 当前环境不支持（拿不到 electron.remote）：开启后会静默降级为普通挂起，不会额外省内存'
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.killRendererOnSuspend).onChange(async (v) => {
					this.plugin.settings.killRendererOnSuspend = v;
					this.plugin.saveSettings();
				})
			);

		// 自动挂起
		containerEl.createDiv({ cls: 'nap-group-header', text: '自动挂起' });
		new Setting(containerEl)
			.setName('操作其他卡片后')
			.setDesc('分钟；-1 永不')
			.addText((t) => {
				t.setValue(String(this.minutesValue(this.plugin.settings.otherCardTimeoutMs)));
				this.bindNumber(
					t,
					() => this.minutesValue(this.plugin.settings.otherCardTimeoutMs),
					-1,
					1440,
					1
				);
				t.onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= -1) {
						this.plugin.settings.otherCardTimeoutMs = n < 0 ? -1 : n * 60000;
						this.plugin.saveSettings();
					}
				});
			});
		new Setting(containerEl)
			.setName('切走应用或标签页后')
			.setDesc('秒；-1 永不')
			.addText((t) => {
				t.setValue(String(this.secondsValue(this.plugin.settings.appBlurTimeoutMs)));
				this.bindNumber(
					t,
					() => this.secondsValue(this.plugin.settings.appBlurTimeoutMs),
					-1,
					86400,
					1
				);
				t.onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= -1) {
						this.plugin.settings.appBlurTimeoutMs = n < 0 ? -1 : n * 1000;
						this.plugin.saveSettings();
					}
				});
			});

		// 卡片按钮
		containerEl.createDiv({ cls: 'nap-group-header', text: '卡片按钮' });
		new Setting(containerEl)
			.setName('按钮字号（px）')
			.setDesc('屏幕像素，固定大小不随画布缩放变化；9-24，默认 13')
			.addText((t) => {
				t.setValue(String(this.plugin.settings.buttonFontSizePx));
				this.bindNumber(t, () => this.plugin.settings.buttonFontSizePx, 9, 24, 1);
				t.onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 9 && n <= 24) {
						this.plugin.settings.buttonFontSizePx = n;
						this.plugin.saveSettings();
						this.plugin.sizeObservers.forEach((ro, wv) => {
							if (wv.isConnected) this.plugin.applySize(wv);
						});
					}
				});
			});

		// 截图缓存
		containerEl.createDiv({ cls: 'nap-group-header', text: '截图缓存' });

		const sizeInfo = containerEl.createEl('p', { text: '当前缓存：计算中…', cls: 'setting-item-description' });
		const showCacheSize = async (note?: string) => {
			try {
				const bytes = await this.plugin.cacheSize();
				sizeInfo.setText(
					'当前缓存：' + (bytes / 1024 / 1024).toFixed(2) + ' MB' + (note ? '（' + note + '）' : '')
				);
			} catch (e) {
				/* ignore */
			}
		};
		showCacheSize();

		new Setting(containerEl)
			.setName('缓存大小上限（MB）')
			.setDesc('0 不限制')
			.addText((t) => {
				t.setValue(String(this.plugin.settings.cacheSizeLimitMB));
				this.bindNumber(t, () => this.plugin.settings.cacheSizeLimitMB, 0, 100000, 100);
				t.onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 0) {
						this.plugin.settings.cacheSizeLimitMB = n;
						this.plugin.saveSettings();
						// 上限被调低时按新上限立即清理一次（连续键入只在停顿后执行），
						// 顺带刷新设置页的缓存尺寸显示
						if (this.cacheCheckTimer) clearTimeout(this.cacheCheckTimer);
						this.cacheCheckTimer = setTimeout(async () => {
							this.cacheCheckTimer = null;
							const deleted = await this.plugin.cleanupCache();
							if (deleted > 0) showCacheSize('已按新上限清理 ' + deleted + ' 个文件');
						}, 600);
					}
				});
			});

		new Setting(containerEl)
			.setName('立即清理')
			.setDesc('清空全部截图缓存')
			.addButton((btn) =>
				btn.setButtonText('清理').onClick(async () => {
					const before = await this.plugin.cacheSize();
					const deleted = await this.plugin.cleanupCache(true);
					const after = await this.plugin.cacheSize();
					if (deleted > 0) {
						showCacheSize(
							'已清理 ' +
								deleted +
								' 个文件，释放 ' +
								((before - after) / 1024 / 1024).toFixed(2) +
								' MB'
						);
					} else {
						showCacheSize('缓存已为空，无需清理');
					}
				})
			);

		containerEl.createEl('p', {
			text: '提示：点击卡片加载，拖动不会触发；右键截图卡片可刷新 / 复制截图；Esc / “挂起”立即切回；“保活”免疫自动挂起。',
			cls: 'setting-item-description',
		});
	}
}
