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
// 核心 API
// =============================================================================

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
		link,        // 建立依赖关系
		unlink,      // 解除依赖关系
		propagate,   // 推送阶段：通知下游
		checkDirty,  // 拉取阶段：检查是否脏
		shallowPropagate, // 浅层推送：只标记脏，不递归
	};

	// ===========================================================================
	// link 函数：建立 dep → sub 的依赖关系
	// ===========================================================================

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
		// 获取 sub 当前的最后一个依赖
		const prevDep = sub.depsTail;

		// 优化1：如果 prevDep 正好是 dep，说明之前已经链接过了
		// 因为通常一个节点会按顺序依赖多个源，这个缓存能快速去重
		if (prevDep !== undefined && prevDep.dep === dep) {
			return; // 已存在，直接返回
		}

		// 优化2：如果 depsTail 的 nextDep 是 dep，说明 dep 在链表中
		// 但这种情况较少见，主要是为了处理某些边界情况
		const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps;
		if (nextDep !== undefined && nextDep.dep === dep) {
			// 找到了，更新版本号
			nextDep.version = version;
			// 将此节点移到 depsTail 位置（最近访问的依赖在最后，方便快速访问）
			sub.depsTail = nextDep;
			return;
		}

		// 优化3：在 dep 的订阅者链表中查找是否已有相同连接
		// 如果有且版本相同，说明已经建立过关系了
		const prevSub = dep.subsTail;
		if (prevSub !== undefined && prevSub.version === version && prevSub.sub === sub) {
			return;
		}

		// 走到这里说明确实需要创建新的 Link
		// 创建新的链路节点，同时设置好四个指针
		const newLink
			= sub.depsTail  // 新节点成为 sub 的最后一个依赖
			= dep.subsTail  // 新节点成为 dep 的最后一个订阅者
			= {
				version,
				dep,           // 指向被依赖的节点
				sub,           // 指向依赖它的节点
				prevDep,       // 在 sub.deps 中的前驱
				nextDep,       // 在 sub.deps 中的后继
				prevSub,       // 在 dep.subs 中的前驱
				nextSub: undefined, // 后继暂时为 undefined
			};

		// 双向链表插入：更新相邻节点的指针
		// 1. 如果有后继，更新后继的前向指针
		if (nextDep !== undefined) {
			nextDep.prevDep = newLink;
		}
		// 2. 如果有前驱，更新前驱的后向指针
		//    如果没有前驱，说明这是 sub.deps 的第一个节点
		if (prevDep !== undefined) {
			prevDep.nextDep = newLink;
		} else {
			sub.deps = newLink;
		}

		// 3. 如果有前驱，更新前驱的后向指针（dep.subs 链表）
		//    如果没有前驱，说明这是 dep.subs 的第一个节点
		if (prevSub !== undefined) {
			prevSub.nextSub = newLink;
		} else {
			dep.subs = newLink;
		}
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
		// nextSub: 下一条要处理的订阅链路
		let next = link.nextSub;
		// stack: 栈，用于保存"待处理的分支"
		// 当遇到有多个订阅者的节点时，将其他分支入栈，先处理一个分支
		let stack: Stack<Link | undefined> | undefined;

		top: do {
			// link.sub 是当前链路对应的订阅者节点
			const sub = link.sub;
			let flags = sub.flags;

			// ========== 状态判断：确定如何处理这个节点 ==========
			//
			// 这段逻辑是整个算法最复杂的部分，需要理解各种标志位的组合
			//
			// 场景分析：
			//

			// 分支1：节点是"干净"的，从未参与过任何处理
			// - 没有 RecursedCheck 标志
			// - 没有 Recursed 标志
			// - 没有 Dirty 标志
			// - 没有 Pending 标志
			// 处理：标记为 Pending，表示"等待被处理"
			if (!(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending))) {
				sub.flags = flags | ReactiveFlags.Pending;

			// 分支2：节点已有 Pending 标志，但没有递归检查相关标志
			// 说明这个节点已经被标记过，现在重新被触发
			// 处理：清除状态，准备重新评估
			} else if (!(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed))) {
				flags = ReactiveFlags.None;

			// 分支3：节点有 Recursed 标志，但没有 RecursedCheck
			// 这是在递归检测过程中发现的场景
			// 处理：移除 Recursed 标志，添加 Pending 标志
			} else if (!(flags & ReactiveFlags.RecursedCheck)) {
				sub.flags = (flags & ~ReactiveFlags.Recursed) | ReactiveFlags.Pending;

			// 分支4：节点"干净"但触发了递归检测
			// - 没有 Dirty 和 Pending
			// - isValidLink 检查确认链路仍然有效
			// 这是递归检查通过，正常继续
			} else if (!(flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) && isValidLink(link, sub)) {
				// 设置递归标志并标记为待处理
				sub.flags = flags | (ReactiveFlags.Recursed | ReactiveFlags.Pending);
				// 保留 Mutable 标志用于后续判断
				flags &= ReactiveFlags.Mutable;

			// 分支5：其他所有情况，不做特殊处理
			} else {
				flags = ReactiveFlags.None;
			}

			// ========== 通知阶段 ==========

			// 如果节点有 Watching 标志，触发通知
			// Watching 表示有 effect 在监听这个节点
			if (flags & ReactiveFlags.Watching) {
				notify(sub);
			}

			// ========== 递归处理订阅者 ==========
			// 只有节点可变更（Mutable）才需要继续传播

			if (flags & ReactiveFlags.Mutable) {
				const subSubs = sub.subs;
				if (subSubs !== undefined) {
					// 获取当前节点的第一个订阅者
					const nextSub = (link = subSubs).nextSub;
					if (nextSub !== undefined) {
						// 有多个订阅者，需要保存当前分支的状态
						// next: 当前链路处理完后的下一个（在这里会被忽略）
						// nextSub: 下一个订阅者
						stack = { value: next, prev: stack };
						next = nextSub; // 继续处理下一个订阅者
					}
					continue; // 跳回循环开始，处理新设置的 link
				}
			}

			// ========== 继续处理下一个订阅者 ==========

			if ((link = next!) !== undefined) {
				next = link.nextSub;
				continue; // 跳回 top，继续处理下一个
			}

			// ========== 回溯阶段：从栈中恢复未处理的分支 ==========

			while (stack !== undefined) {
				link = stack.value!;
				stack = stack.prev;
				if (link !== undefined) {
					next = link.nextSub;
					continue top; // 跳回 top，继续处理栈中恢复的分支
				}
			}

			// 栈为空，所有分支都处理完了
			break;

		} while (true);
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
		let stack: Stack<Link> | undefined;
		let checkDepth = 0;  // 当前递归深度
		let dirty = false;   // 是否真的脏了

		top: do {
			const dep = link.dep;
			const flags = dep.flags;

			// ========== 第一层检查：sub 本身是否已经脏了 ==========

			if (sub.flags & ReactiveFlags.Dirty) {
				dirty = true;

			// ========== 第二层检查：dep 是否可变更且脏 ==========
			// 同时满足：Mutable（可变更）+ Dirty（已脏）

			} else if ((flags & (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) === (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) {
				// 调用外部的 update 函数来更新 dep 的值
				if (update(dep)) {
					// update 返回 true 表示值真的变了
					const subs = dep.subs!;
					// 如果 dep 有多个订阅者，需要传播脏状态
					if (subs.nextSub !== undefined) {
						shallowPropagate(subs);
					}
					dirty = true;
				}

			// ========== 第三层检查：dep 是否可变更且待处理 ==========
			// 同时满足：Mutable + Pending
			// 这是一个更复杂的情况，需要深入依赖链检查

			} else if ((flags & (ReactiveFlags.Mutable | ReactiveFlags.Pending)) === (ReactiveFlags.Mutable | ReactiveFlags.Pending)) {
				// 如果 link 有多个同级别的依赖，把当前链路入栈保存
				// 这样检查完当前分支后可以回来继续检查其他分支
				if (link.nextSub !== undefined || link.prevSub !== undefined) {
					stack = { value: link, prev: stack };
				}
				// 深入到 dep 的依赖列表
				link = dep.deps!;
				sub = dep;  // 现在要检查的是 dep自己了
				++checkDepth;  // 深度增加
				continue;  // 跳回循环开始，处理新的 link

			// ========== 其他情况：dep 没有脏，不需要处理 ==========
			}

			// ========== 继续检查同级的下一个依赖 ==========

			if (!dirty) {
				const nextDep = link.nextDep;
				if (nextDep !== undefined) {
					link = nextDep;
					continue;  // 继续检查下一个依赖
				}
			}

			// ========== 回溯阶段：检查栈中待处理的链路 ==========
			// 当 checkDepth > 0 时，说明我们深入过依赖图，需要回溯

			while (checkDepth--) {
				// 获取当前订阅者的第一个下游
				const firstSub = sub.subs!;
				// 检查是否只有一个订阅者
				const hasMultipleSubs = firstSub.nextSub !== undefined;

				if (hasMultipleSubs) {
					// 多个订阅者，需要从栈中恢复
					link = stack!.value;
					stack = stack!.prev;
				} else {
					// 只有一个订阅者，继续使用 firstSub
					link = firstSub;
				}

				if (dirty) {
					// 确实脏了，需要更新
					if (update(sub)) {
						// 值变了，需要传播给下游
						if (hasMultipleSubs) {
							shallowPropagate(firstSub);
						}
						// 移动到链表的下一个节点
						sub = link.sub;
						continue;  // 继续检查更新后的值
					}
					// 值没变，清除脏标志
					dirty = false;
				} else {
					// 清除 Pending 标志，表示检查完成
					sub.flags &= ~ReactiveFlags.Pending;
				}

				// 继续检查下一个节点
				sub = link.sub;
				const nextDep = link.nextDep;
				if (nextDep !== undefined) {
					link = nextDep;
					continue top;  // 跳回顶层循环
				}
			}

			// 所有深度都检查完了，返回结果
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
		do {
			const sub = link.sub;
			const flags = sub.flags;

			// 只标记"待处理但未脏"的节点为脏
			// 如果已经是脏的或有其他状态，跳过
			if ((flags & (ReactiveFlags.Pending | ReactiveFlags.Dirty)) === ReactiveFlags.Pending) {
				sub.flags = flags | ReactiveFlags.Dirty;

				// 只有设置了 Watching 且没有 RecursedCheck 的节点才通知
				// 这是一个性能优化：避免在递归检查期间触发不必要的通知
				if ((flags & (ReactiveFlags.Watching | ReactiveFlags.RecursedCheck)) === ReactiveFlags.Watching) {
					notify(sub);
				}
			}
			// 移动到链表的下一个节点
		} while ((link = link.nextSub!) !== undefined);
	}

	// ===========================================================================
	// isValidLink 函数：检查链路是否仍然有效
	// ===========================================================================

	/**
	 * 检查链路是否仍然有效
	 *
	 * 背景：
	 * 在 propagate 的递归检测过程中，需要确认某条链路在当前依赖图中仍然存在
	 * 如果依赖关系在检查过程中发生了变化，链路可能已经无效
	 *
	 * 例如：
	 * ```ts
	 * const a = signal(1);
	 * const b = signal(2);
	 * const c = computed(() => a() + b());
	 *
	 * effect(() => {
	 *   if (condition) {
	 *     c(); // 依赖 a 和 b
	 *   } else {
	 *     a(); // 只依赖 a
	 *   }
	 * });
	 *
	 * // 当 condition 变化时，effect 的依赖关系会改变
	 * ```
	 *
	 * @param checkLink - 要检查的链路
	 * @param sub - 链路所属的订阅者
	 * @returns - true 表示链路仍然有效
	 */
	function isValidLink(checkLink: Link, sub: ReactiveNode): boolean {
		// 从 depsTail（最新依赖）向前遍历
		let link = sub.depsTail;
		while (link !== undefined) {
			if (link === checkLink) {
				return true;  // 找到了，链路有效
			}
			link = link.prevDep;  // 继续向前查找
		}
		return false;  // 没找到，链路可能已失效
	}
}
