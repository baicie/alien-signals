/**
 * alien-signals 高层 API 实现
 *
 * 本文件在 system.ts 核心算法的基础上，封装了 signal、computed、effect、effectScope 四个高层 API。
 *
 * 架构理解：
 * ```
 * ┌─────────────────────────────────────────────────────────┐
 * │                      index.ts                          │
 * │                                                         │
 * │  ┌─────────┐  ┌───────────┐  ┌────────┐  ┌──────────┐  │
 * │  │ signal  │  │ computed  │  │ effect │  │effectScope│ │
 * │  └────┬────┘  └─────┬─────┘  └───┬────┘  └────┬─────┘  │
 * │       │             │            │            │        │
 * │       └─────────────┴────────────┴────────────┘        │
 * │                         │                               │
 * │                    内部操作函数                          │
 * │                         │                               │
 * └─────────────────────────┼───────────────────────────────┘
 *                           │
 *                           ▼
 * ┌─────────────────────────────────────────────────────────┐
 * │                      system.ts                          │
 * │                                                         │
 * │           ┌──────────┐  ┌──────────┐  ┌──────────┐     │
 * │           │   link   │  │propagate │  │checkDirty│     │
 * │           └──────────┘  └──────────┘  └──────────┘     │
 * │                                                         │
 * └─────────────────────────────────────────────────────────┘
 * ```
 *
 * 设计理念：
 * - system.ts 提供通用算法，不关心具体业务逻辑
 * - index.ts 填充 update/notify/unwatched 三个回调，实现具体语义
 */

// =============================================================================
// 导入核心算法
// =============================================================================

import { createReactiveSystem, ReactiveFlags, type ReactiveNode } from './system.js';

// =============================================================================
// 类型定义
// =============================================================================

/**
 * Effect 节点 - 代表一个 effect
 *
 * 与 ReactiveNode 的区别：
 * - ReactiveNode 是通用节点，只有 deps/subs/flags
 * - EffectNode 额外有 fn（用户传入的回调函数）
 */
interface EffectNode extends ReactiveNode {
	/** effect 要执行的函数 */
	fn(): void;
}

/**
 * Computed 节点 - 代表一个 computed（计算属性）
 *
 * 与 ReactiveNode 的区别：
 * - ReactiveNode 是通用节点
 * - ComputedNode 额外有 value（缓存值）和 getter（计算函数）
 */
interface ComputedNode<T = any> extends ReactiveNode {
	/** 缓存的计算值（如果值为 undefined，可能是真正计算出来的 undefined） */
	value: T | undefined;
	/** 计算函数，接收上一个值用于比较 */
	getter: (previousValue?: T) => T;
}

/**
 * Signal 节点 - 代表一个 signal（响应式变量）
 *
 * 与 ReactiveNode 的区别：
 * - ReactiveNode 是通用节点
 * - SignalNode 额外有 currentValue 和 pendingValue
 */
interface SignalNode<T = any> extends ReactiveNode {
	/** 当前已确认的值 */
	currentValue: T;
	/** 待处理的（可能已更新但未 flush 的）值 */
	pendingValue: T;
}

// =============================================================================
// 调试工具
// =============================================================================

const DEBUG = Symbol("debug");
const nodeNames = new WeakMap<object, string>();
let nodeId = 0;

function name(node: object, label: string): string {
    if (!nodeNames.has(node)) {
        nodeNames.set(node, `${label}#${++nodeId}`);
    }
    return nodeNames.get(node)!;
}

function flagStr(flags: number): string {
    const parts: string[] = [];
    if (flags & 1) parts.push("Mutable");
    if (flags & 2) parts.push("Watching");
    if (flags & 4) parts.push("RecursedCheck");
    if (flags & 8) parts.push("Recursed");
    if (flags & 16) parts.push("Dirty");
    if (flags & 32) parts.push("Pending");
    return parts.length ? `[${parts.join("|")}]` : "[None]";
}

function log(label: string, ...args: any[]) {
    const pad = label.padEnd(24, " ");
    console.log(`\x1b[36m[${pad}]\x1b[0m`, ...args);
}

// =============================================================================
// 全局状态
// =============================================================================

/**
 * 版本周期计数器
 *
 * 作用：每当有 signal 或 computed 更新时递增
 * - 用于 link 函数的 version 参数
 * - 帮助检测依赖是否过时
 *
 * 理解：可以类比数据库的事务 ID，每次更新就像开启一个新事务
 */
let cycle = 0;

/**
 * 批量深度计数器
 *
 * 作用：追踪当前是否在批量更新模式
 * - startBatch() 递增，endBatch() 递减
 * - 当 batchDepth > 0 时，不会立即 flush effect
 * - 只有 batchDepth 降为 0 时才真正 flush
 *
 * 示例：
 * ```ts
 * startBatch();
 * a(1);
 * b(2);  // 这里不会触发 flush
 * c(3);
 * endBatch();  // 这里才统一触发一次 flush
 * ```
 */
let batchDepth = 0;

/**
 * Effect 队列当前处理位置
 *
 * 作用：指向 queued 数组中下一个要处理的 effect
 * - 每次处理一个 effect 后递增
 * - flush 完成后重置为 0
 */
let notifyIndex = 0;

/**
 * Effect 队列长度
 *
 * 作用：标记队列中有多少个待处理的 effect
 */
let queuedLength = 0;

/**
 * 当前活跃的订阅者
 *
 * 作用：追踪"谁在读取值"
 *
 * 工作原理：
 * 1. effect 执行时，设置 activeSub = 当前 effect
 * 2. 读取 signal/computed 时，检查 activeSub 是否存在
 * 3. 如果存在，自动建立 activeSub → 当前读取的节点 的依赖关系
 *
 * 示例：
 * ```ts
 * effect(() => {
 *   console.log(a());  // 这里 activeSub = 当前 effect
 *                       // 自动建立 effect → signal(a) 的依赖
 * });
 * ```
 */
let activeSub: ReactiveNode | undefined;

/**
 * 待处理的 effect 队列
 *
 * 作用：缓存被触发的 effect，等待 flush
 *
 * 为什么用数组而不是 Set？
 * - 需要保持顺序（FIFO）
 * - 同一个 effect 可能被多次触发，只保留一次
 *
 * 注意：数组可能包含 undefined（已处理的会被设为 undefined）
 */
const queued: (EffectNode | undefined)[] = [];

// =============================================================================
// 核心算法实例化
// =============================================================================

/**
 * 创建响应式系统实例
 *
 * 这里传入三个回调函数，定义了 signal/computed/effect 的具体行为
 */
const {
	link,      // 建立依赖关系
	unlink,    // 解除依赖关系
	propagate, // 推送变化
	checkDirty,// 检查是否脏
	shallowPropagate, // 浅层传播
} = createReactiveSystem({

	// ===========================================================================
	// update 回调：当需要更新一个节点时调用
	// ===========================================================================

	/**
	 * 更新节点
	 *
	 * @param node - 要更新的节点（SignalNode 或 ComputedNode）
	 * @returns - true 表示值确实变了，false 表示值没变
	 *
	 * 区分 signal 和 computed：
	 * - signal：有 depsTail（依赖列表非空）→ 调用 updateSignal
	 * - signal：无 depsTail → 值直接来自 pendingValue
	 * - computed：调用 updateComputed 重新计算
	 */
	update(node: SignalNode | ComputedNode): boolean {
		if (node.depsTail !== undefined) {
			// 有依赖列表，说明是 computed，需要重新计算
			return updateComputed(node as ComputedNode);
		} else {
			// 无依赖列表，说明是基础 signal，直接更新值
			return updateSignal(node as SignalNode);
		}
	},

	// ===========================================================================
	// notify 回调：当 effect 被触发时调用
	// ===========================================================================

	/**
	 * 通知 effect
	 *
	 * 这个函数将 effect 加入队列，并处理嵌套 effect 的去重
	 *
	 * 算法解释：
	 * 1. 沿着 effect 的订阅链向上遍历
	 * 2. 清除每个节点的 Watching 标志（防止重复通知）
	 * 3. 沿途收集的 effect 全部加入队列
	 * 4. 最后反转队列顺序，确保从内到外执行
	 *
	 * @param effect - 被触发的 effect
	 */
	notify(effect: EffectNode) {
		let insertIndex = queuedLength;
		let firstInsertedIndex = insertIndex;
		log("notify         ", name(effect, "effect"), "queued at index", insertIndex, "flags =", flagStr(effect.flags));

		do {
			queued[insertIndex++] = effect;
			effect.flags &= ~ReactiveFlags.Watching;
			effect = effect.subs?.sub as EffectNode;
			if (effect === undefined || !(effect.flags & ReactiveFlags.Watching)) {
				break;
			}
		} while (true);

		queuedLength = insertIndex;

		while (firstInsertedIndex < --insertIndex) {
			const left = queued[firstInsertedIndex];
			queued[firstInsertedIndex++] = queued[insertIndex];
			queued[insertIndex] = left;
		}
	},

	// ===========================================================================
	// unwatched 回调：当节点失去所有订阅者时调用
	// ===========================================================================

	/**
	 * 节点失去所有订阅者时的处理
	 *
	 * 三种情况：
	 * 1. effectScope：没有 Mutable 标志 → 清理内部的 effect
	 * 2. computed：有依赖但无订阅者 → 重置状态
	 * 3. signal：有依赖且有订阅者 → 不做处理（等待所有订阅者离开）
	 *
	 * @param node - 失去订阅者的节点
	 */
	unwatched(node) {
		if (!(node.flags & ReactiveFlags.Mutable)) {
			// 没有 Mutable 标志，说明是 effectScope
			// 调用 effectScopeOper 清理内部的 effect
			effectScopeOper.call(node);
		} else if (node.depsTail !== undefined) {
			// 有 Mutable 且有依赖，说明是 computed
			// 重置状态，清空依赖列表
			node.depsTail = undefined;
			node.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
			// 清理所有的依赖关系
			purgeDeps(node);
		}
		// 注意：如果有 Mutable 但没有 depsTail（普通 signal），不做处理
	},
});

// =============================================================================
// 公开 API：追踪当前活跃订阅者
// =============================================================================

/**
 * 获取当前活跃的订阅者
 *
 * @returns - 当前正在建立依赖关系的节点
 *
 * 使用场景：
 * - 在 effect/computed 内部，可以通过此函数知道"谁在依赖我"
 */
export function getActiveSub(): ReactiveNode | undefined {
	return activeSub;
}

/**
 * 设置当前活跃的订阅者
 *
 * @param sub - 要设置的活跃订阅者
 * @returns - 之前的活跃订阅者
 *
 * 这是一个典型的"保存-修改-恢复"模式
 *
 * 示例：
 * ```ts
 * const prev = setActiveSub(effect);
 * // ... 执行一些操作 ...
 * setActiveSub(prev);  // 恢复之前的值
 * ```
 */
export function setActiveSub(sub?: ReactiveNode) {
	const prevSub = activeSub;
	activeSub = sub;
	return prevSub;
}

// =============================================================================
// 公开 API：批量更新
// =============================================================================

/**
 * 获取当前批量深度
 *
 * @returns - 当前 batchDepth 值
 */
export function getBatchDepth(): number {
	return batchDepth;
}

/**
 * 开始批量更新
 *
 * 调用后，signal 的变化不会立即触发 effect
 * 必须调用 endBatch() 后才会真正执行 effect
 *
 * 示例：
 * ```ts
 * startBatch();
 * a(1);
 * b(2);
 * c(3);  // 多个 signal 变化，只触发一次 flush
 * endBatch();
 * ```
 */
export function startBatch() {
	++batchDepth;
}

/**
 * 结束批量更新
 *
 * 当 batchDepth 降为 0 时，触发 flush 执行所有排队的 effect
 */
export function endBatch() {
	if (!--batchDepth) {
		flush();
	}
}

// =============================================================================
// 公开 API：类型检查
// =============================================================================

/**
 * 检查一个函数是否是 signal
 *
 * @param fn - 要检查的函数
 * @returns - true 表示是 signal
 *
 * 原理：通过函数名判断
 * signal 绑定后的函数名是 "bound signalOper"
 */
export function isSignal(fn: () => void): boolean {
	return fn.name === 'bound ' + signalOper.name;
}

/**
 * 检查一个函数是否是 computed
 */
export function isComputed(fn: () => void): boolean {
	return fn.name === 'bound ' + computedOper.name;
}

/**
 * 检查一个函数是否是 effect
 */
export function isEffect(fn: () => void): boolean {
	return fn.name === 'bound ' + effectOper.name;
}

/**
 * 检查一个函数是否是 effectScope
 */
export function isEffectScope(fn: () => void): boolean {
	return fn.name === 'bound ' + effectScopeOper.name;
}

// =============================================================================
// 公开 API：signal
// =============================================================================

/**
 * signal 重载签名：声明返回值类型
 *
 * signal<T>() 表示值可能是 undefined
 * signal<T>(initialValue) 表示值是 T
 */
export function signal<T>(): {
	(): T | undefined;
	(value: T | undefined): void;
};
/**
 * signal 带初始值签名
 */
export function signal<T>(initialValue: T): {
	(): T;
	(value: T): void;
};
/**
 * 创建 signal
 *
 * @param initialValue - 初始值，默认为 undefined
 * @returns - 可调用函数，读取时返回当前值，设置时传入新值
 *
 * 示例：
 * ```ts
 * const count = signal(0);
 *
 * console.log(count());  // 读取：0
 * count(1);               // 设置：变为 1
 * console.log(count());  // 读取：1
 * ```
 *
 * 实现细节：
 * - 将 signalOper 函数绑定到 SignalNode 对象上
 * - 调用 count() 时，实际是调用 signalOper
 * - signalOper 通过 this 访问节点数据
 */
export function signal<T>(initialValue?: T): {
	(): T | undefined;
	(value: T | undefined): void;
} {
	const node = {
		currentValue: initialValue,
		pendingValue: initialValue,
		subs: undefined,
		subsTail: undefined,
		flags: ReactiveFlags.Mutable,
	};
	log("signal.create  ", name(node, "signal"), "initialValue =", initialValue, "flags =", flagStr(node.flags));
	return signalOper.bind(node) as () => T | undefined;
}

// =============================================================================
// 公开 API：computed
// =============================================================================

/**
 * 创建 computed（计算属性）
 *
 * @param getter - 计算函数，返回计算结果
 * @returns - 可调用函数，读取时返回计算值
 *
 * 示例：
 * ```ts
 * const firstName = signal('John');
 * const lastName = signal('Doe');
 *
 * const fullName = computed(() => `${firstName()} ${lastName()}`);
 *
 * console.log(fullName());  // "John Doe"
 * firstName('Jane');
 * console.log(fullName());  // "Jane Doe"
 * ```
 *
 * 实现细节：
 * - computed 默认没有 Mutable 标志（值由其他节点计算得出）
 * - 默认没有 Watching 标志（不会主动触发）
 * - 只在读取时检查是否需要重新计算
 */
export function computed<T>(getter: (previousValue?: T) => T): () => T {
	const node = {
		value: undefined,
		subs: undefined,
		subsTail: undefined,
		deps: undefined,
		depsTail: undefined,
		// computed 默认状态
		flags: ReactiveFlags.None,
		getter: getter as (previousValue?: unknown) => unknown,
	};
	log("computed.create ", name(node, "computed"), "flags =", flagStr(node.flags));
	return computedOper.bind(node) as () => T;
}

// =============================================================================
// 公开 API：effect
// =============================================================================

/**
 * 创建 effect（副作用）
 *
 * @param fn - 要执行的副作用函数
 * @returns - 停止函数，调用后 effect 停止响应变化
 *
 * 示例：
 * ```ts
 * const count = signal(0);
 *
 * const stop = effect(() => {
 *   console.log(`Count: ${count()}`);
 * }); // 立即执行：Count: 0
 *
 * count(1); // 触发执行：Count: 1
 * count(2); // 触发执行：Count: 2
 *
 * stop();   // 停止 effect
 * count(3); // 无输出
 * ```
 *
 * 实现细节：
 * 1. 创建 EffectNode，设置 Watching | RecursedCheck
 * 2. 将当前 effect 设为 activeSub
 * 3. 执行 fn()，自动收集依赖
 * 4. 清除 RecursedCheck
 * 5. 返回绑定了 effectOper 的停止函数
 */
export function effect(fn: () => void): () => void {
	const e: EffectNode = {
		fn,
		subs: undefined,
		subsTail: undefined,
		deps: undefined,
		depsTail: undefined,
		flags: ReactiveFlags.Watching | ReactiveFlags.RecursedCheck,
	};
	log("effect.create  ", name(e, "effect"), "flags =", flagStr(e.flags));

	const prevSub = setActiveSub(e);
	if (prevSub !== undefined) {
		link(e, prevSub, 0);
	}

	try {
		log("effect.create  ", name(e, "effect"), "executing fn()...");
		e.fn();
		log("effect.create  ", name(e, "effect"), "fn() done, deps collected");
	} finally {
		activeSub = prevSub;
		e.flags &= ~ReactiveFlags.RecursedCheck;
	}

	return effectOper.bind(e);
}

// =============================================================================
// 公开 API：effectScope
// =============================================================================

/**
 * 创建 effect 作用域
 *
 * @param fn - 在作用域内执行的函数
 * @returns - 停止函数，调用后作用域内所有 effect 停止响应
 *
 * 示例：
 * ```ts
 * const count = signal(0);
 *
 * const stopScope = effectScope(() => {
 *   effect(() => {
 *     console.log(`In scope: ${count()}`);
 *   });
 * }); // 输出：In scope: 0
 *
 * count(1); // 输出：In scope: 1
 *
 * stopScope(); // 停止整个作用域
 * count(2); // 无输出
 * ```
 *
 * 与 effect 的区别：
 * - effectScope 是一个"容器"，可以包含多个 effect
 * - 停止 effectScope 会停止其中所有 effect
 * - effectScope 本身不是 effect，不会被触发
 */
export function effectScope(fn: () => void): () => void {
	const e: ReactiveNode = {
		deps: undefined,
		depsTail: undefined,
		subs: undefined,
		subsTail: undefined,
		flags: ReactiveFlags.None,
	};

	const prevSub = setActiveSub(e);

	// 如果有上层 effect/activeSub，建立链接
	if (prevSub !== undefined) {
		link(e, prevSub, 0);
	}

	try {
		// 执行用户函数
		fn();
	} finally {
		// 恢复之前的 activeSub
		activeSub = prevSub;
	}

	// 返回绑定了 effectScopeOper 的停止函数
	return effectScopeOper.bind(e);
}

// =============================================================================
// 公开 API：trigger
// =============================================================================

/**
 * 手动触发依赖更新
 *
 * 当你直接修改了 signal 的值（而不是通过 setter）时，
 * 这个函数可以手动通知下游
 *
 * @param fn - 访问要触发的 signal
 *
 * 示例：
 * ```ts
 * const arr = signal<number[]>([]);
 * const length = computed(() => arr().length);
 *
 * // 直接修改数组内容
 * arr().push(1);
 *
 * // 手动触发更新
 * trigger(() => arr());
 *
 * console.log(length()); // 1
 * ```
 *
 * 实现流程：
 * 1. 创建临时订阅者，设置 Watching 标志
 * 2. 执行 fn()，收集访问过的 signal
 * 3. 对每个 signal，解除临时订阅并触发 propagate
 */
export function trigger(fn: () => void) {
	// 创建临时订阅者
	const sub: ReactiveNode = {
		deps: undefined,
		depsTail: undefined,
		flags: ReactiveFlags.Watching,
	};

	const prevSub = setActiveSub(sub);

	try {
		// 执行函数，收集依赖
		fn();
	} finally {
		// 恢复 activeSub
		activeSub = prevSub;
		sub.flags = ReactiveFlags.None;
		let link = sub.deps;
		while (link !== undefined) {
			const dep = link.dep;
			// 解除临时依赖关系
			link = unlink(link, sub);

			// 触发下游更新
			const subs = dep.subs;
			if (subs !== undefined) {
				propagate(subs);
				shallowPropagate(subs);
			}
		}

		// 如果不在批量模式，立即 flush
		if (!batchDepth) {
			flush();
		}
	}
}

// =============================================================================
// 内部函数：更新 computed
// =============================================================================

/**
 * 更新 computed 的值
 *
 * 流程：
 * 1. 递增 cycle 版本号
 * 2. 清空依赖列表（准备重新收集）
 * 3. 设置 RecursedCheck（检测循环依赖）
 * 4. 重新执行 getter
 * 5. 比较新旧值是否相同
 *
 * @param c - 要更新的 computed 节点
 * @returns - true 表示值变了
 */
function updateComputed(c: ComputedNode): boolean {
	++cycle;
	c.depsTail = undefined;
	c.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;

	const prevSub = setActiveSub(c);
	try {
		const oldValue = c.value;
		log("computed.update ", name(c, "computed"), "oldValue =", oldValue);
		const newValue = c.getter(oldValue);
		const changed = oldValue !== newValue;
		c.value = newValue;
		log("computed.update ", name(c, "computed"), "newValue =", newValue, changed ? "CHANGED" : "unchanged");
		return changed;
	} finally {
		activeSub = prevSub;
		c.flags &= ~ReactiveFlags.RecursedCheck;
		purgeDeps(c);
	}
}

// =============================================================================
// 内部函数：更新 signal
// =============================================================================

/**
 * 更新 signal 的值
 *
 * @param s - 要更新的 signal 节点
 * @returns - true 表示值变了
 *
 * 注意：signal 的值变化通常在 signalOper 中处理
 * 这个函数主要用于从 pendingValue 同步到 currentValue
 */
function updateSignal(s: SignalNode): boolean {
	s.flags = ReactiveFlags.Mutable;
	const changed = s.currentValue !== (s.currentValue = s.pendingValue);
	log("signal.update  ", name(s, "signal"), "current:", changed ? `(${s.currentValue} changed)` : `(${s.currentValue} unchanged)`);
	return changed;
}

// =============================================================================
// 内部函数：运行 effect
// =============================================================================

/**
 * 运行一个 effect
 *
 * 判断条件（满足任一即可）：
 * 1. 已有 Dirty 标志
 * 2. 有 Pending 标志，且 checkDirty 返回 true
 *
 * 流程：
 * 1. 递增 cycle
 * 2. 清空依赖列表
 * 3. 设置 Watching | RecursedCheck
 * 4. 重新执行 fn()
 * 5. 恢复状态
 *
 * @param e - 要运行的 effect
 */
function run(e: EffectNode): void {
	const flags = e.flags;

	if (
		flags & ReactiveFlags.Dirty
		|| (
			flags & ReactiveFlags.Pending
			&& checkDirty(e.deps!, e)
		)
	) {
		++cycle;
		e.depsTail = undefined;
		e.flags = ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;

		const prevSub = setActiveSub(e);
		log("effect.run     ", name(e, "effect"), "START");
		try {
			(e as EffectNode).fn();
		} finally {
			activeSub = prevSub;
			e.flags &= ~ReactiveFlags.RecursedCheck;
			purgeDeps(e);
			log("effect.run     ", name(e, "effect"), "DONE");
		}
	} else {
		e.flags = ReactiveFlags.Watching;
	}
}

// =============================================================================
// 内部函数：flush
// =============================================================================

/**
 * 刷新队列，执行所有待处理的 effect
 *
 * 分两个阶段：
 *
 * 第一阶段（try 块）：
 * - 按顺序执行队列中的 effect
 * - 处理过的位置设为 undefined
 *
 * 第二阶段（finally 块）：
 * - 处理任何在执行过程中新加入的 effect
 * - 设置 Watch 和 Recursed 标志
 * - 重置队列
 *
 * 为什么需要 finally？
 * - 执行 effect 时可能会触发新的 signal 变化
 * - 新变化可能加入更多 effect 到队列
 * - finally 确保这些新 effect 也能被处理
 */
function flush(): void {
	log("flush          ", "========== FLUSH START ==========");
	try {
		while (notifyIndex < queuedLength) {
			const effect = queued[notifyIndex]!;
			queued[notifyIndex++] = undefined;
			log("flush          ", "running effect at index", notifyIndex - 1);
			run(effect);
		}
	} finally {
		while (notifyIndex < queuedLength) {
			const effect = queued[notifyIndex]!;
			queued[notifyIndex++] = undefined;
			effect.flags |= ReactiveFlags.Watching | ReactiveFlags.Recursed;
		}
		notifyIndex = 0;
		queuedLength = 0;
		log("flush          ", "========== FLUSH END ==========");
	}
}

// =============================================================================
// 内部函数：computed 操作（读取）
// =============================================================================

/**
 * computed 读取操作
 *
 * 这个函数被绑定到 ComputedNode，当调用 computed() 时执行
 *
 * 执行流程：
 *
 * 1. 检查是否脏（Dirty 或 Pending + checkDirty）
 *
 * 2. 如果脏了：
 *    - 调用 updateComputed 重新计算
 *    - 如果值变了，调用 shallowPropagate 通知下游
 *
 * 3. 如果不脏但没有任何标志：
 *    - 说明是首次读取，需要初始化
 *    - 执行一次 getter 来建立依赖
 *
 * 4. 建立当前订阅者到自己的依赖关系
 *
 * @returns - computed 的当前值
 */
function computedOper<T>(this: ComputedNode<T>): T {
	const flags = this.flags;

	// 检查是否需要更新
	if (
		flags & ReactiveFlags.Dirty  // 已经是脏的
		|| (
			flags & ReactiveFlags.Pending  // 等待中
			&& (
				checkDirty(this.deps!, this)  // 检查是否真的脏
				// 如果不脏，清除 Pending 标志
				|| (this.flags = flags & ~ReactiveFlags.Pending, false)
			)
		)
	) {
		// 需要更新
		if (updateComputed(this)) {
			// 值变了，通知下游
			const subs = this.subs;
			if (subs !== undefined) {
				shallowPropagate(subs);
			}
		}
	} else if (!flags) {
		// 没有任何标志，说明是首次读取或已同步
		// 需要执行一次 getter 来建立依赖
		this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
		const prevSub = setActiveSub(this);
		try {
			this.value = this.getter();
		} finally {
			activeSub = prevSub;
			this.flags &= ~ReactiveFlags.RecursedCheck;
		}
	}

	// 建立依赖关系：如果有活跃订阅者，当前 computed 被它依赖
	const sub = activeSub;
	if (sub !== undefined) {
		link(this, sub, cycle);
	}

	return this.value!;
}

// =============================================================================
// 内部函数：signal 操作（读取/写入）
// =============================================================================

/**
 * signal 读取/写入操作
 *
 * 这个函数被绑定到 SignalNode，当调用 signal() 时执行
 *
 * 调用约定：
 * - signal() 无参数：读取值
 * - signal(value) 带参数：设置值
 *
 * @param this - signal 节点
 * @param value - 要设置的值（rest 参数支持可选）
 */
function signalOper<T>(this: SignalNode<T>, ...value: [T]): T | void {
	if (value.length) {
		// ========== 设置值 ==========
		log("signal.write   ", name(this, "signal"), "pending:", this.pendingValue, "=>", value[0]);

		if (this.pendingValue !== (this.pendingValue = value[0])) {
			this.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty;
			log("signal.changed ", name(this, "signal"), "flags =", flagStr(this.flags));

			const subs = this.subs;
			if (subs !== undefined) {
				propagate(subs);
				if (!batchDepth) {
					flush();
				}
			}
		}
	} else {
		// ========== 读取值 ==========
		if (this.flags & ReactiveFlags.Dirty) {
			if (updateSignal(this)) {
				const subs = this.subs;
				if (subs !== undefined) {
					shallowPropagate(subs);
				}
			}
		}

		let sub = activeSub;
		while (sub !== undefined) {
			if (sub.flags & (ReactiveFlags.Mutable | ReactiveFlags.Watching)) {
				link(this, sub, cycle);
				log("signal.link    ", name(this, "signal"), "=>", name(sub, sub.flags & ReactiveFlags.Mutable ? "signal" : "effect"));
				break;
			}
			sub = sub.subs?.sub;
		}

		log("signal.read    ", name(this, "signal"), "=>", this.currentValue);
		return this.currentValue;
	}
}

// =============================================================================
// 内部函数：effect 操作（停止）
// =============================================================================

/**
 * effect 停止操作
 *
 * 这个函数被绑定到 EffectNode，当调用停止函数时执行
 *
 * 作用：停止 effect 的响应，清除所有依赖关系
 */
function effectOper(this: EffectNode): void {
	effectScopeOper.call(this);
}

// =============================================================================
// 内部函数：effectScope 操作（停止/清理）
// =============================================================================

/**
 * effectScope 清理操作
 *
 * 这个函数被绑定到 effectScope 节点或 effect 节点
 *
 * 流程：
 * 1. 清空 depsTail
 * 2. 重置 flags
 * 3. 清理所有依赖关系
 * 4. 如果有订阅者，解除链接
 */
function effectScopeOper(this: ReactiveNode): void {
	// 1-2. 清空状态
	this.depsTail = undefined;
	this.flags = ReactiveFlags.None;

	// 3. 清理依赖
	purgeDeps(this);

	// 4. 解除订阅者链接
	const sub = this.subs;
	if (sub !== undefined) {
		unlink(sub);
	}
}

// =============================================================================
// 内部函数：清理依赖
// =============================================================================

/**
 * 清理节点的所有依赖
 *
 * @param sub - 要清理的节点
 *
 * 遍历节点的依赖链表，逐个 unlink
 *
 * 这在 effect/computed 重新执行时调用，
 * 用于清除旧的依赖关系，重新建立新的
 */
function purgeDeps(sub: ReactiveNode) {
	// 从 depsTail 向前遍历（从最新到最旧）
	const depsTail = sub.depsTail;
	let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps;

	while (dep !== undefined) {
		// unlink 返回下一个依赖
		dep = unlink(dep, sub);
	}
}
