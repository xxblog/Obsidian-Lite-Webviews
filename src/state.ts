/**
 * 卡片状态中心。
 *
 * 重构动机：此前 17 个状态字段以字符串形式散落在 DOM 的 dataset 上（'0'/'1'/时间戳），
 * DOM 既是渲染载体又是唯一真相源，带来三个后果：
 *   1. 每一次 el.dataset.xxx 读写都可能拼错 key 或写错字面量，编译器无从校验；
 *   2. 状态迁移没有任何约束，任意代码都能把卡片从任意状态直接改到任意状态；
 *   3. 元素被 Canvas / Excalidraw 销毁重建时状态随之蒸发，只能再往父容器上写一份
 *      "激活继承"标记兜底 —— 同一份状态存在两处，靠手工同步。
 *
 * 现在：状态存放在 WeakMap 中，DOM 只负责渲染（CSS 用 class，不读 dataset）。
 * 本模块刻意不引用任何 DOM 类型——键一律当作不透明对象——因此可以脱离
 * Obsidian / Electron 直接做单元测试。
 */

/** 卡片生命周期阶段。
 *  unknown   = 元素刚出现、尚未被 handle 分类（对应原先"dataset 不存在"）
 *  screenshot= 已挂起，显示占位截图，真实页面已卸载
 *  live      = 已加载真实网页 */
export type CardPhase = 'unknown' | 'screenshot' | 'live';

/** 允许的阶段迁移。刻意写死成表：
 *  非法迁移（例如 screenshot → screenshot 的重复挂起）会被拒绝并返回 false，
 *  调用方据此提前 return，替代原先散落各处的 "if (dataset.x === 'screenshot') return"。 */
const TRANSITIONS: Record<CardPhase, readonly CardPhase[]> = {
	unknown: ['screenshot', 'live'],
	screenshot: ['live'],
	live: ['screenshot'],
};

export interface CardState {
	phase: CardPhase;
	/** 卡片的真实网页地址（挂起后 DOM 上的 src 会被清空，靠它复原） */
	src: string;
	/** 保活：免疫自动挂起与 Esc */
	locked: boolean;
	/** 单卡静音覆盖；null = 跟随全局"默认静音"设置 */
	muted: boolean | null;
	/** 渲染进程被杀过，激活时需要 reload 而非仅设 src */
	crashed: boolean;
	/** 焦点在该 webview 内（用于隐藏悬浮按钮） */
	focused: boolean;
	/** 插件自建的临时抓图 webview，所有业务逻辑都必须跳过它 */
	temp: boolean;
	/** 正在后台刷新截图，防止重入 */
	refreshing: boolean;
	/** 内容代数：抓图是异步的，回填前比对代数，避免旧抓图覆盖新内容 */
	generation: number;
	/** 已挂载的事件钩子，防止重复挂载 */
	hooked: { mute: boolean; bgFix: boolean; focus: boolean };
	/** 最近一次实际下发的静音值；null = 从未下发。用于跳过无变化的跨进程调用 */
	muteApplied: boolean | null;
	/** 已注入背景修复脚本（卸载时需要反向清理） */
	bgFixApplied: boolean;
	/** 上次写入的按钮尺寸，值未变则跳过样式写入，避免 ResizeObserver 抖动 */
	sizeLast: string;
	/** 该卡片持有的全部注销函数（事件监听、观察器等），挂起/销毁时统一执行 */
	cleanups: Array<() => void>;
}

function createCardState(): CardState {
	return {
		phase: 'unknown',
		src: '',
		locked: false,
		muted: null,
		crashed: false,
		focused: false,
		temp: false,
		refreshing: false,
		generation: 0,
		hooked: { mute: false, bgFix: false, focus: false },
		muteApplied: null,
		bgFixApplied: false,
		sizeLast: '',
		cleanups: [],
	};
}

/**
 * 容器级状态：挂在【父容器】而非 webview 元素上。
 *
 * 为什么必须单独存一份：Canvas / Excalidraw 会在滚动、缩放、切标签页时销毁并重建
 * 内部的 webview 元素。以元素为键的状态会随之丢失，而容器（.canvas-node 等）是存活的，
 * 所以"这张卡刚才是打开状态"这件事必须记在容器上，新元素出现时据此继承。
 *
 * 相比原先写在 DOM dataset 上的最大差别：本存储随插件实例存在，
 * 重启 Obsidian 后自然清空 —— 原先写死的 12 小时墙钟标记会让"昨晚点开过的卡片，
 * 今早重开画布又自动变回真网页"，与省内存的目标直接相悖。
 */
export interface ContainerState {
	/** 激活时记录的地址；'' 表示无激活标记。iframe 快照卡用固定串 'iframe' */
	activatedSrc: string;
	/** 记录时刻（Date.now()），配合 TTL 判定标记是否仍然有效 */
	activatedAt: number;
	locked: boolean;
	muted: boolean | null;
}

function createContainerState(): ContainerState {
	return { activatedSrc: '', activatedAt: 0, locked: false, muted: null };
}

/** 状态仓库。键是不透明对象（运行时为 DOM 元素），本模块不对其做任何 DOM 操作。 */
export class CardStore {
	private cards = new WeakMap<object, CardState>();
	private containers = new WeakMap<object, ContainerState>();

	/** 取卡片状态，不存在则创建 */
	get(el: object): CardState {
		let s = this.cards.get(el);
		if (!s) {
			s = createCardState();
			this.cards.set(el, s);
		}
		return s;
	}

	/** 只读探查：不创建条目。用于"这个元素我们管过吗"这类判断 */
	peek(el: object): CardState | undefined {
		return this.cards.get(el);
	}

	has(el: object): boolean {
		return this.cards.has(el);
	}

	/** 丢弃卡片状态（先跑完 cleanups，避免监听器泄漏） */
	drop(el: object): void {
		const s = this.cards.get(el);
		if (s) this.runCleanups(s);
		this.cards.delete(el);
	}

	/**
	 * 尝试迁移阶段。返回是否发生了迁移。
	 * 非法迁移（含"迁移到自身"）返回 false 且不改动状态——调用方应据此提前返回，
	 * 这正是原先散落各处的重复挂起/重复激活守卫的统一替代。
	 */
	transition(el: object, next: CardPhase): boolean {
		const s = this.get(el);
		if (!TRANSITIONS[s.phase].includes(next)) return false;
		s.phase = next;
		return true;
	}

	/** 阶段判定的语义化快捷方式 */
	phase(el: object): CardPhase {
		return this.get(el).phase;
	}
	isLive(el: object): boolean {
		return this.get(el).phase === 'live';
	}
	isSuspended(el: object): boolean {
		return this.get(el).phase === 'screenshot';
	}

	/** 内容代数 +1 并返回新值；异步抓图用它判断结果是否已过期 */
	bumpGeneration(el: object): number {
		const s = this.get(el);
		s.generation += 1;
		return s.generation;
	}
	isCurrentGeneration(el: object, generation: number | undefined): boolean {
		if (generation === undefined) return true;
		return this.get(el).generation === generation;
	}

	/** 登记一个注销函数，挂起/销毁时统一执行 */
	addCleanup(el: object, fn: () => void): void {
		this.get(el).cleanups.push(fn);
	}

	/** 执行并清空该元素的全部注销函数 */
	runCleanups(elOrState: object | CardState): void {
		const s = (elOrState as CardState).cleanups
			? (elOrState as CardState)
			: this.cards.get(elOrState as object);
		if (!s) return;
		const list = s.cleanups;
		s.cleanups = [];
		for (const fn of list) {
			try {
				fn();
			} catch (e) {
				/* 单个注销失败不能拖垮其余注销 */
			}
		}
	}

	/* ---------------- 容器级（跨元素重建继承） ---------------- */

	container(node: object): ContainerState {
		let s = this.containers.get(node);
		if (!s) {
			s = createContainerState();
			this.containers.set(node, s);
		}
		return s;
	}

	peekContainer(node: object): ContainerState | undefined {
		return this.containers.get(node);
	}

	/** 记录"这张卡处于打开状态"，供元素重建时继承 */
	markActivated(node: object, src: string, locked: boolean, muted: boolean | null): void {
		const s = this.container(node);
		s.activatedSrc = src;
		s.activatedAt = Date.now();
		s.locked = locked;
		s.muted = muted;
	}

	/** 清除激活标记（挂起、关闭截图模式时调用） */
	clearActivated(node: object): void {
		const s = this.containers.get(node);
		if (!s) return;
		s.activatedSrc = '';
		s.activatedAt = 0;
	}

	/** 激活标记是否仍然有效（存在且未超过 ttlMs） */
	isActivated(node: object, ttlMs: number): boolean {
		const s = this.containers.get(node);
		if (!s || !s.activatedSrc) return false;
		return Date.now() - s.activatedAt < ttlMs;
	}
}
