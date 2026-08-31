import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardStore } from '../src/state.ts';

/** 状态机的键在运行时是 DOM 元素；这里用普通对象即可，state.ts 不碰 DOM */
const el = () => ({});

test('新元素初始为 unknown，且不会凭空创建条目', () => {
	const store = new CardStore();
	const a = el();
	assert.equal(store.peek(a), undefined, 'peek 不应创建条目');
	assert.equal(store.has(a), false);
	assert.equal(store.phase(a), 'unknown', 'get 之后才存在');
	assert.equal(store.has(a), true);
});

test('合法迁移：unknown → screenshot → live → screenshot', () => {
	const store = new CardStore();
	const a = el();
	assert.equal(store.transition(a, 'screenshot'), true);
	assert.equal(store.transition(a, 'live'), true);
	assert.equal(store.transition(a, 'screenshot'), true);
	assert.equal(store.phase(a), 'screenshot');
});

test('unknown 可直接进入 live（继承激活标记的新元素）', () => {
	const store = new CardStore();
	const a = el();
	assert.equal(store.transition(a, 'live'), true);
	assert.equal(store.isLive(a), true);
});

test('非法迁移被拒绝且不改动状态 —— 替代原先散落的重复守卫', () => {
	const store = new CardStore();
	const a = el();
	store.transition(a, 'screenshot');
	// 重复挂起：原代码靠 "if (dataset.x === 'screenshot') return" 拦截
	assert.equal(store.transition(a, 'screenshot'), false);
	assert.equal(store.phase(a), 'screenshot');

	store.transition(a, 'live');
	// 重复激活
	assert.equal(store.transition(a, 'live'), false);
	assert.equal(store.phase(a), 'live');
	// 任何阶段都不能退回 unknown
	assert.equal(store.transition(a, 'unknown'), false);
	assert.equal(store.phase(a), 'live');
});

test('默认状态字段符合预期', () => {
	const store = new CardStore();
	const s = store.get(el());
	assert.equal(s.src, '');
	assert.equal(s.locked, false);
	assert.equal(s.muted, null, 'null = 跟随全局默认，区别于显式 false');
	assert.equal(s.crashed, false);
	assert.equal(s.temp, false);
	assert.equal(s.generation, 0);
	assert.equal(s.muteApplied, null);
	assert.deepEqual(s.hooked, { mute: false, bgFix: false, focus: false });
	assert.deepEqual(s.cleanups, []);
});

test('代数递增用于丢弃过期抓图', () => {
	const store = new CardStore();
	const a = el();
	const g1 = store.bumpGeneration(a);
	assert.equal(g1, 1);
	assert.equal(store.isCurrentGeneration(a, g1), true);
	const g2 = store.bumpGeneration(a);
	assert.equal(g2, 2);
	assert.equal(store.isCurrentGeneration(a, g1), false, '旧抓图必须被判定为过期');
	assert.equal(store.isCurrentGeneration(a, undefined), true, 'undefined 表示不校验');
});

test('cleanups 执行一次、执行后清空、单个失败不影响其余', () => {
	const store = new CardStore();
	const a = el();
	const calls: string[] = [];
	store.addCleanup(a, () => calls.push('first'));
	store.addCleanup(a, () => {
		throw new Error('boom');
	});
	store.addCleanup(a, () => calls.push('third'));

	store.runCleanups(a);
	assert.deepEqual(calls, ['first', 'third'], '抛错的注销不能拖垮后面的');
	assert.deepEqual(store.get(a).cleanups, [], '执行后必须清空');

	store.runCleanups(a);
	assert.deepEqual(calls, ['first', 'third'], '不得重复执行');
});

test('drop 会先跑 cleanups 再丢弃状态', () => {
	const store = new CardStore();
	const a = el();
	let ran = false;
	store.addCleanup(a, () => {
		ran = true;
	});
	store.transition(a, 'screenshot');
	store.drop(a);
	assert.equal(ran, true, 'drop 必须注销监听器，否则就是泄漏');
	assert.equal(store.peek(a), undefined);
	assert.equal(store.phase(a), 'unknown', '丢弃后重新 get 是全新状态');
});

test('容器激活标记：记录 / 判定 / 清除', () => {
	const store = new CardStore();
	const node = el();
	assert.equal(store.isActivated(node, 1000), false, '未标记时为 false');

	store.markActivated(node, 'https://example.com', true, false);
	assert.equal(store.isActivated(node, 1000), true);
	const c = store.container(node);
	assert.equal(c.activatedSrc, 'https://example.com');
	assert.equal(c.locked, true);
	assert.equal(c.muted, false);

	store.clearActivated(node);
	assert.equal(store.isActivated(node, 1000), false);
	assert.equal(store.container(node).locked, true, 'clearActivated 只清标记，不动静音/保活');
});

test('容器激活标记会因 TTL 过期', () => {
	const store = new CardStore();
	const node = el();
	store.markActivated(node, 'https://example.com', false, null);
	store.container(node).activatedAt = Date.now() - 5000;
	assert.equal(store.isActivated(node, 1000), false, '超过 TTL 应失效');
	assert.equal(store.isActivated(node, 10000), true, 'TTL 内仍有效');
});

test('不同元素状态互相隔离', () => {
	const store = new CardStore();
	const a = el();
	const b = el();
	store.transition(a, 'live');
	assert.equal(store.phase(b), 'unknown');
	store.get(a).locked = true;
	assert.equal(store.get(b).locked, false);
});
