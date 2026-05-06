/**
 * alien-signals 核心算法实现
 *
 * 这是一个基于 push-pull（推送-拉取）的响应式信号算法。
 * - Push（推送）：当源信号变化时，主动通知下游依赖
 * - Pull（拉取）：当需要计算值时，检查并更新脏数据
 *
 * 核心优化：避免函数递归，通过双向链表和栈模拟遍历，回滚到之前的节点继续执行
 */

// =============================================================================
// 数据结构定义
// =============================================================================

/**
 * 响应式节点 - 代表一个 signal 或 computed
 *
 * 理解这个数据结构的关键：
 * - deps: 当前节点的"输入"依赖 - 当前节点依赖哪些上游节点
 * - subs: 当前节点的"输出"订阅者 - 当前节点变化后会通知哪些下游节点
 * - 通过 Link 双向链表连接 dep 和 sub，形成依赖图
 */
export interface ReactiveNode {
	/** 依赖链表的头指针（第一个依赖） */
	deps?: Link;
	/** 依赖链表的尾指针（最后一个依赖） */
	depsTail?: Link;
	/** 订阅者链表的头指针（第一个订阅者） */
	subs?: Link;
	/** 订阅者链表的尾指针（最后一个订阅者） */
	subsTail?: Link;
	/** 状态标志位，控制节点的行为 */
	flags: ReactiveFlags;
}

/**
 * 链表节点 - 连接 dep（依赖）和 sub（订阅者）
 *
 *                dep（被依赖的节点）
 *                   │
 *                   │ deps / subs
 *                   ▼
 *                 Link ──────────► Link ──────────► ...
 *                 │                 │
 *                 │                 │
 *                 ▼                 ▼
 *                sub               sub
 *            （订阅者）          （订阅者）
 *
 * 关键理解：
 * - 一条 Link 同时属于 dep 的 subs 链表（dep 的下游）和 sub 的 deps 链表（sub 的上游）
 * - 通过 prevSub/nextSub 在 dep 的 subs 链表中移动
 * - 通过 prevDep/nextDep 在 sub 的 deps 链表中移动
 */
export interface Link {
	/** 版本号，用于检测依赖是否已更新 */
	version: number;
	/** 这条链路的"生产者" - 当前节点依赖的源节点 */
	dep: ReactiveNode;
	/** 这条链路的"消费者" - 依赖 dep 的下游节点 */
	sub: ReactiveNode;
	/** 在 dep.subs 链表中的前驱 */
	prevSub: Link | undefined;
	/** 在 dep.subs 链表中的后继 */
	nextSub: Link | undefined;
	/** 在 sub.deps 链表中的前驱 */
	prevDep: Link | undefined;
	/** 在 sub.deps 链表中的后继 */
	nextDep: Link | undefined;
}

/**
 * 通用栈结构 - 用于模拟递归调用，避免函数递归
 *
 * 在 propagate 和 checkDirty 中，当我们遍历依赖图时，
 * 需要"暂停"当前分支的处理，去处理另一个分支，处理完后再回来。
 * 这就像递归调用一样，但用栈来保存状态，避免了函数调用栈溢出。
 */
interface Stack<T> {
	value: T;
	/** 指向前一个栈帧 */
	prev: Stack<T> | undefined;
}

// =============================================================================
// 状态标志位定义
// =============================================================================

/**
 * 响应式节点的状态标志位，使用位掩码（bitmask）高效存储多个状态
 *
 * 位掩码的好处：
 * - 可以用单个数字存储多个布尔状态
 * - 状态检查（flags & FLAG）和状态设置（flags | FLAG）都是 O(1) 操作
 * - 多个状态可以同时存在
 *
 * 例如：flags = 5 (二进制 101)
 * - 第一位(1): Mutable = 1
 * - 第三位(4): RecursedCheck = 4
 * - 5 & 1 = 1, 所以 Mutable 为 true
 * - 5 & 2 = 0, 所以 Watching 为 false
 */
export const enum ReactiveFlags {
	/** 无标志 - 默认状态 */
	None = 0,
	/** 可变标志 - 表示节点的值可能会变化（如 signal）
	 *
	 * 对比：
	 * - signal 有此标志：值可以直接被修改
	 * - computed 无此标志：值由其他节点计算得出，不能直接修改
	 */
	Mutable = 1,
	/** 观察中标志 - 表示有 effect 正在监听这个节点的变化
	 *
	 * 只有设置了 Watching 标志的节点才会触发 notify
	 * 这是性能优化的关键：不需要通知所有订阅者，只需通知正在观察的
	 */
	Watching = 2,
	/** 递归检查标志 - 用于检测依赖图中的循环引用
	 *
	 * 递归检查的工作原理：
	 * 1. 开始检查时设置此标志
	 * 2. 如果检查过程中再次访问同一个节点，说明有循环
	 * 3. 通过位运算检测这种情况
	 *
	 * 例如：effect 依赖 computed，computed 依赖同一个 effect
	 */
	RecursedCheck = 4,
	/** 已递归标志 - 表示正在处理递归情况
	 *
	 * 与 RecursedCheck 配合使用：
	 * - RecursedCheck = 4: 正在检查是否递归
	 * - Recursed = 8: 检测到递归发生
	 * - 同时设置两者表示"已知是递归，但仍在处理"
	 */
	Recursed = 8,
	/** 脏标志 - 表示节点的值已经过期，需要重新计算
	 *
	 * 何时设置：
	 * - 当依赖的上游节点变化时，标记为脏
	 * - 下次访问时触发重新计算
	 */
	Dirty = 16,
	/** 待处理标志 - 表示节点正在等待被处理
	 *
	 * 用于批量更新：
	 * - 当多个信号同时变化时，不需要立即处理每个变化
	 * - 先标记为 Pending，最后统一处理
	 * - 避免重复处理同一个节点多次
	 */
	Pending = 32,
}

// =============================================================================
// 调试工具
// =============================================================================

const nodeNames = new WeakMap<object, string>();
let nodeId = 0;

function name(node: object): string {
	if (!nodeNames.has(node)) {
		nodeNames.set(node, `#${++nodeId}`);
	}
	return nodeNames.get(node)!;
}

function flagStr(flags: number): string {
	const parts: string[] = [];
	if (flags & 1) parts.push("M");
	if (flags & 2) parts.push("W");
	if (flags & 4) parts.push("RC");
	if (flags & 8) parts.push("R");
	if (flags & 16) parts.push("D");
	if (flags & 32) parts.push("P");
	return `[${parts.join("|")}]`;
}

function log(label: string, ...args: any[]) {
	const pad = label.padEnd(18, " ");
	console.log(`\x1b[33m[${pad}]\x1b[0m`, ...args);
}

/**
 * 创建响应式系统
 *
 * @param update - 更新函数：当一个节点的依赖变化时调用，返回值是否真的变了
 * @param notify - 通知函数：当节点被标记为脏时调用，通常用于触发 effect
 * @param unwatched - 取消观察函数：当一个节点没有任何订阅者时调用
 *
 * 这个工厂函数的设计理念：
 * - 核心算法与具体实现（signal/computed/effect）分离
 * - 同一套算法可以被不同的高级 API 复用
 * - 比如 Vue 3.6、XState 都移植了这个算法的核心部分
 */
export function createReactiveSystem({
	update,
	notify,
	unwatched,
}: {
	update(sub: ReactiveNode): boolean;
	notify(sub: ReactiveNode): void;
	unwatched(sub: ReactiveNode): void;
}) {
	// 返回核心算法函数
	return {
		link,
		unlink,
		propagate,
		checkDirty,
		shallowPropagate,
	};

	/**
	 * 建立依赖关系：dep（被依赖的节点）→ sub（依赖的节点）
	 *
	 * 伪代码理解：
	 * sub.dependsOn(dep) // sub 依赖 dep
	 *
	 * 执行过程：
	 * 1. 检查是否已存在这条依赖链（去重）
	 * 2. 如果已存在，只更新版本号
	 * 3. 如果不存在，创建新的 Link 并插入双向链表
	 *
	 * @param dep - 被依赖的节点（上游）
	 * @param sub - 依赖它的节点（下游）
	 * @param version - 当前版本号，用于检测是否需要更新
	 */
	function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
		const prevDep = sub.depsTail;

		if (prevDep !== undefined && prevDep.dep === dep) {
			log("link           ", "SKIP (cached): dep", name(dep), "-> sub", name(sub));
			return;
		}

		const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps;
		if (nextDep !== undefined && nextDep.dep === dep) {
			nextDep.version = version;
			sub.depsTail = nextDep;
			log("link           ", "UPDATE: dep", name(dep), "-> sub", name(sub), "ver =", version);
			return;
		}

		const prevSub = dep.subsTail;
		if (prevSub !== undefined && prevSub.version === version && prevSub.sub === sub) {
			log("link           ", "SKIP (exists): dep", name(dep), "-> sub", name(sub));
			return;
		}

		const newLink
			= sub.depsTail
			= dep.subsTail
			= {
				version,
				dep,
				sub,
				prevDep,
				nextDep,
				prevSub,
				nextSub: undefined,
			};

		if (nextDep !== undefined) {
			nextDep.prevDep = newLink;
		}
		if (prevDep !== undefined) {
			prevDep.nextDep = newLink;
		} else {
			sub.deps = newLink;
		}

		if (prevSub !== undefined) {
			prevSub.nextSub = newLink;
		} else {
			dep.subs = newLink;
		}

		log("link           ", "CREATE: dep", name(dep), "-> sub", name(sub), "ver =", version);
	}

	// ===========================================================================
	// unlink 函数：解除依赖关系
	// ===========================================================================

	/**
	 * 解除依赖关系
	 *
	 * 伪代码理解：
	 * sub.undependsOn(dep) // sub 不再依赖 dep
	 *
	 * 这个函数同时在 dep.subs 和 sub.deps 两条双向链表中删除 Link
	 * 是一个典型的双向链表删除操作
	 *
	 * @param link - 要删除的链路节点
	 * @param sub - 链路所属的订阅者节点（默认为 link.sub）
	 * @returns - 返回链表中的下一个链路，用于批量删除
	 */
	function unlink(link: Link, sub = link.sub): Link | undefined {
		// 缓存链路节点的各个指针，避免重复访问
		const dep = link.dep;
		const prevDep = link.prevDep;
		const nextDep = link.nextDep;
		const nextSub = link.nextSub;
		const prevSub = link.prevSub;

		// ========== 第一步：在 sub.deps 链表中删除 ==========

		// 如果有后继，后继指向前驱
		if (nextDep !== undefined) {
			nextDep.prevDep = prevDep;
		} else {
			// 没有后继，说明是链表的最后一个节点
			// 更新 tail 指针指向前驱
			sub.depsTail = prevDep;
		}

		// 如果有前驱，前驱指向后继
		if (prevDep !== undefined) {
			prevDep.nextDep = nextDep;
		} else {
			// 没有前驱，说明是链表的第一个节点
			// 更新 head 指针指向后继
			sub.deps = nextDep;
		}

		// ========== 第二步：在 dep.subs 链表中删除 ==========

		// 逻辑同上，但在删除最后一个订阅者时，需要通知 dep 它已无订阅者
		if (nextSub !== undefined) {
			nextSub.prevSub = prevSub;
		} else {
			dep.subsTail = prevSub;
		}

		if (prevSub !== undefined) {
			prevSub.nextSub = nextSub;
		} else if ((dep.subs = nextSub) === undefined) {
			// 关键点：prevSub 为 undefined 且 nextSub 也为 undefined
			// 说明这是 dep 的最后一个订阅者，现在 dep 没有任何订阅者了
			// 调用 unwatched 通知外部（如可以清理内存、停止某些监听等）
			unwatched(dep);
		}

		// 返回 dep.deps 链表中的下一个链路
		// 这允许调用者批量删除：while (link = unlink(link)) ...
		return nextDep;
	}

	// ===========================================================================
	// propagate 函数：推送阶段 - 通知下游节点
	// ===========================================================================

	/**
	 * 推送阶段：沿着依赖链传播变化
	 *
	 * 这是算法的核心之一，采用了"消除递归"的优化技术。
	 *
	 * 消除递归的原理：
	 * 正常递归版本：
	 * ```ts
	 * function propagate(link: Link) {
	 *   const sub = link.sub;
	 *   sub.notify();
	 *   if (sub.hasSubscribers()) {
	 *     for (const subSub of sub.subs) {
	 *       propagate(subSub); // 递归调用！
	 *     }
	 *   }
	 * }
	 * ```
	 *
	 * 问题：如果依赖图很深（数千个节点），递归会导致栈溢出
	 *
	 * 消除递归版本：使用栈 + 循环 + labeled break
	 * - 用 stack 保存"待处理的分支"
	 * - 用 continue top 跳回循环开始
	 * - 用 link.nextSub 继续遍历当前分支
	 *
	 * 形象理解：
	 * 假设依赖图是 A → B → C
	 *                    ↘
	 *                     D
	 *
	 * 当 A 变化时，需要通知 B、C、D
	 * 1. 处理 A 的订阅者 B
	 * 2. B 有订阅者 C 和 D
	 * 3. 先处理 C，把 D 入栈
	 * 4. 处理完 C，处理栈中的 D
	 */
	function propagate(link: Link): void {
		log("propagate      ", "--- START --- from sub", name(link.sub));
		let next = link.nextSub;
		let stack: Stack<Link | undefined> | undefined;

		top: do {
			const sub = link.sub;
			let flags = sub.flags;

			if (!(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending))) {
				sub.flags = flags | ReactiveFlags.Pending;
				log("propagate      ", "branch1: sub", name(sub), "set Pending", "flags =", flagStr(sub.flags));
			} else if (!(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed))) {
				flags = ReactiveFlags.None;
				log("propagate      ", "branch2: sub", name(sub), "clear flags", "flags =", flagStr(flags));
			} else if (!(flags & ReactiveFlags.RecursedCheck)) {
				sub.flags = (flags & ~ReactiveFlags.Recursed) | ReactiveFlags.Pending;
				log("propagate      ", "branch3: sub", name(sub), "R->P", "flags =", flagStr(sub.flags));
			} else if (!(flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) && isValidLink(link, sub)) {
				sub.flags = flags | (ReactiveFlags.Recursed | ReactiveFlags.Pending);
				flags &= ReactiveFlags.Mutable;
				log("propagate      ", "branch4: sub", name(sub), "valid link, set R|P, mutable =", !!(flags & ReactiveFlags.Mutable));
			} else {
				flags = ReactiveFlags.None;
				log("propagate      ", "branch5: sub", name(sub), "no action");
			}

			if (flags & ReactiveFlags.Watching) {
				log("propagate      ", "  -> notify sub", name(sub), "flags =", flagStr(sub.flags));
				notify(sub);
			}

			if (flags & ReactiveFlags.Mutable) {
				const subSubs = sub.subs;
				if (subSubs !== undefined) {
					const nextSub = (link = subSubs).nextSub;
					if (nextSub !== undefined) {
						stack = { value: next, prev: stack };
						next = nextSub;
						log("propagate      ", "  -> push branch, stack depth+1, continue to sub", name(link.sub));
					} else {
						log("propagate      ", "  -> continue to sub", name(link.sub), "(single subscriber)");
					}
					continue;
				} else {
					log("propagate      ", "  -> no subs on sub", name(sub));
				}
			}

			if ((link = next!) !== undefined) {
				next = link.nextSub;
				continue;
			}

			while (stack !== undefined) {
				link = stack.value!;
				stack = stack.prev;
				if (link !== undefined) {
					next = link.nextSub;
					log("propagate      ", "  <- pop from stack, continue to sub", name(link.sub));
					continue top;
				}
			}

			break;

		} while (true);
		log("propagate      ", "--- END ---");
	}

	// ===========================================================================
	// checkDirty 函数：拉取阶段 - 检查并更新脏值
	// ===========================================================================

	/**
	 * 拉取阶段：检查节点是否需要更新
	 *
	 * 与 propagate 的区别：
	 * - propagate：主动推送变化，从源到目标
	 * - checkDirty：按需拉取，检查是否真的需要更新
	 *
	 * 调用场景：
	 * 当 effect/computed 读取一个值时，会调用 checkDirty 来确认值是否有效
	 *
	 * checkDepth 机制：
	 * 用于模拟递归深度，当进入依赖图深处时增加，出栈时减少
	 * 这样可以正确处理嵌套的 computed 依赖
	 *
	 * @param link - 要检查的链路
	 * @param sub - 当前正在检查的订阅者
	 * @returns - true 表示确实脏了，false 表示没有变化
	 */
	function checkDirty(link: Link, sub: ReactiveNode): boolean {
		log("checkDirty     ", "START for sub", name(sub));
		let stack: Stack<Link> | undefined;
		let checkDepth = 0;
		let dirty = false;

		top: do {
			const dep = link.dep;
			const flags = dep.flags;
			log("checkDirty     ", "  dep", name(dep), "flags =", flagStr(flags), "sub", name(sub), "flags =", flagStr(sub.flags));

			if (sub.flags & ReactiveFlags.Dirty) {
				dirty = true;
				log("checkDirty     ", "  -> branch1: sub already Dirty, dirty = true");

			} else if ((flags & (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) === (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) {
				log("checkDirty     ", "  -> branch2: dep is Mutable|Dirty, calling update()");
				if (update(dep)) {
					const subs = dep.subs!;
					if (subs.nextSub !== undefined) {
						shallowPropagate(subs);
					}
					dirty = true;
					log("checkDirty     ", "  -> dep changed, dirty = true");
				} else {
					log("checkDirty     ", "  -> dep unchanged");
				}

			} else if ((flags & (ReactiveFlags.Mutable | ReactiveFlags.Pending)) === (ReactiveFlags.Mutable | ReactiveFlags.Pending)) {
				if (link.nextSub !== undefined || link.prevSub !== undefined) {
					stack = { value: link, prev: stack };
					log("checkDirty     ", "  -> branch3: dep is Mutable|Pending, push stack, depth++");
				} else {
					log("checkDirty     ", "  -> branch3: dep is Mutable|Pending, no stack");
				}
				link = dep.deps!;
				sub = dep;
				++checkDepth;
				continue;

			} else {
				log("checkDirty     ", "  -> branch4: dep not dirty, continue");
			}

			if (!dirty) {
				const nextDep = link.nextDep;
				if (nextDep !== undefined) {
					link = nextDep;
					continue;
				}
			}

			while (checkDepth--) {
				const firstSub = sub.subs!;
				const hasMultipleSubs = firstSub.nextSub !== undefined;

				if (hasMultipleSubs) {
					link = stack!.value;
					stack = stack!.prev;
				} else {
					link = firstSub;
				}

				if (dirty) {
					if (update(sub)) {
						if (hasMultipleSubs) {
							shallowPropagate(firstSub);
						}
						sub = link.sub;
						log("checkDirty     ", "  -> sub", name(sub), "changed, dirty = true");
						continue;
					}
					dirty = false;
				} else {
					sub.flags &= ~ReactiveFlags.Pending;
				}

				sub = link.sub;
				const nextDep = link.nextDep;
				if (nextDep !== undefined) {
					link = nextDep;
					continue top;
				}
			}

			log("checkDirty     ", "RETURN dirty =", dirty);
			return dirty;

		} while (true);
	}

	// ===========================================================================
	// shallowPropagate 函数：浅层传播
	// ===========================================================================

	/**
	 * 浅层传播：快速标记多个节点为脏，不递归处理它们的订阅者
	 *
	 * 与 propagate 的区别：
	 * - propagate：会递归处理整个子树，触发所有 effect
	 * - shallowPropagate：只标记脏，不触发后续传播
	 *
	 * 使用场景：
	 * 当一个节点有多个订阅者，但它们不需要立即全部更新时
	 * 比如批量更新中，先统一标记脏，最后再统一处理
	 *
	 * 优化：
	 * 只需要一次链表遍历，O(n) 时间复杂度
	 */
	function shallowPropagate(link: Link): void {
		log("shallowProp    ", "START");
		do {
			const sub = link.sub;
			const flags = sub.flags;
			if ((flags & (ReactiveFlags.Pending | ReactiveFlags.Dirty)) === ReactiveFlags.Pending) {
				sub.flags = flags | ReactiveFlags.Dirty;
				log("shallowProp    ", "sub", name(sub), "Pending->Dirty", "flags =", flagStr(sub.flags));
				if ((flags & (ReactiveFlags.Watching | ReactiveFlags.RecursedCheck)) === ReactiveFlags.Watching) {
					log("shallowProp    ", "  -> notify sub", name(sub));
					notify(sub);
				}
			}
		} while ((link = link.nextSub!) !== undefined);
		log("shallowProp    ", "END");
	}

	// ===========================================================================
	// isValidLink 函数：检查链路是否仍然有效
	// ===========================================================================

	function isValidLink(checkLink: Link, sub: ReactiveNode): boolean {
		let link = sub.depsTail;
		while (link !== undefined) {
			if (link === checkLink) {
				return true;
			}
			link = link.prevDep;
		}
		return false;
	}

	return {
		link,
		unlink,
		propagate,
		checkDirty,
		shallowPropagate,
	};
}
