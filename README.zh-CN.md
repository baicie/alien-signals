<p align="center">
	<img src="assets/logo.png" width="250"><br>
<p>

<p align="center">
	<a href="https://npmjs.com/package/alien-signals"><img src="https://badgen.net/npm/v/alien-signals" alt="npm 包"></a>
	<a href="https://deepwiki.com/stackblitz/alien-signals"><img src="https://deepwiki.com/badge.svg" alt="咨询 DeepWiki"></a>
</p>

# alien-signals

本项目探索了一种基于推送-拉取（push-pull）的信号算法。其当前实现与以下前端项目类似或相关：

- Vue 3 的传播算法
- Preact 的双向链表方案（https://preactjs.com/blog/signal-boosting/）
- Svelte 的内部 effect 调度
- Reactively 的图着色方案（https://milomg.dev/2022-12-01/reactivity）

我们施加了一些约束（例如不使用 Array/Set/Map，以及在[算法核心](https://github.com/stackblitz/alien-signals/blob/master/src/system.ts)中禁止函数递归）来确保性能。我们发现，在这些条件下，保持算法的简洁性比复杂的调度策略能带来更显著的性能提升。

即使 Vue 3.4 已经过优化，alien-signals 仍然明显更快。（我为两者都编写了代码，由于它们共享相似的算法，具有很强的可比性。）

<img width="1210" alt="Image" src="https://github.com/user-attachments/assets/88448f6d-4034-4389-89aa-9edf3da77254" />

> 基准测试仓库：https://github.com/transitive-bullshit/js-reactivity-benchmark

## 背景

我花了大量时间[优化 Vue 3.4 的响应式系统](https://github.com/vuejs/core/pull/5912)，并在此过程中积累了经验。由于 Vue 3.5[切换到了类似 Preact 的基于拉取的算法](https://github.com/vuejs/core/pull/10397)，我决定在另一个项目中继续研究基于推送-拉取的实现。我们的最终目标是在 Vue 语言工具中实现基于 alien-signals 的完全增量式 AST 解析和虚拟代码生成。

## 其他语言实现

- **Dart:** [medz/alien-signals-dart](https://github.com/medz/alien-signals-dart)
- **Dart:** [void-signals/void_signals](https://github.com/void-signals/void_signals)
- **Lua:** [YanqingXu/alien-signals-in-lua](https://github.com/YanqingXu/alien-signals-in-lua)
- **Lua 5.4:** [xuhuanzy/alien-signals-lua](https://github.com/xuhuanzy/alien-signals-lua)
- **Luau:** [Nicell/alien-signals-luau](https://github.com/Nicell/alien-signals-luau)
- **Java:** [CTRL-Neo-Studios/java-alien-signals](https://github.com/CTRL-Neo-Studios/java-alien-signals)
- **C#:** [CTRL-Neo-Studios/csharp-alien-signals](https://github.com/CTRL-Neo-Studios/csharp-alien-signals)
- **Go:** [delaneyj/alien-signals-go](https://github.com/delaneyj/alien-signals-go)
- **Rust:** [wuzekang/samara-signals](https://github.com/wuzekang/samara/tree/main/crates/signals)
- **Rust:** [ohkami-rs/alien-signals-rs](https://github.com/ohkami-rs/alien-signals-rs)

## 衍生项目

- [Rajaniraiyn/react-alien-signals](https://github.com/Rajaniraiyn/react-alien-signals)：用于 alien-signals API 的 React 绑定
- [CCherry07/alien-deepsignals](https://github.com/CCherry07/alien-deepsignals)：将 alien-signals 与普通 JavaScript 对象的接口结合使用
- [hunghg255/reactjs-signal](https://github.com/hunghg255/reactjs-signal)：使用 Signal 模式共享 Store 状态
- [gn8-ai/universe-alien-signals](https://github.com/gn8-ai/universe-alien-signals)：在现代前端框架中轻松使用 Alien Signals 状态管理系统
- [WebReflection/alien-signals](https://github.com/WebReflection/alien-signals)：类似 Preact signals 的 API 和基于类的方法，便于进行类型检查
- [@lift-html/alien](https://github.com/JLarky/lift-html/tree/main/packages/alien)：将 alien-signals 集成到 lift-html

## 实际应用

- [vuejs/core](https://github.com/vuejs/core)：核心算法已移植到 v3.6（PR：https://github.com/vuejs/core/pull/12349）
- [statelyai/xstate](https://github.com/statelyai/xstate)：核心算法已移植用于实现 atom 架构（PR：https://github.com/statelyai/xstate/pull/5250）
- [flamrdevs/xignal](https://github.com/flamrdevs/xignal)：响应式系统的基础设施
- [vuejs/language-tools](https://github.com/vuejs/language-tools)：在 language-core 包中用于虚拟代码生成
- [unuse](https://github.com/un-ts/unuse)：受 `VueUse` 启发、框架无关的 `use` 库

## 使用方法

### 基础 API

```ts
import { signal, computed, effect } from 'alien-signals';

const count = signal(1);
const doubleCount = computed(() => count() * 2);

effect(() => {
  console.log(`Count is: ${count()}`);
}); // 控制台输出：Count is: 1

console.log(doubleCount()); // 2

count(2); // 控制台输出：Count is: 2

console.log(doubleCount()); // 4
```

### Effect 作用域

```ts
import { signal, effect, effectScope } from 'alien-signals';

const count = signal(1);

const stopScope = effectScope(() => {
  effect(() => {
    console.log(`Count in scope: ${count()}`);
  }); // 控制台输出：Count in scope: 1
});

count(2); // 控制台输出：Count in scope: 2

stopScope();

count(3); // 无控制台输出
```

### 嵌套 Effect

Effect 可以嵌套在其他 effect 内部。当外部 effect 重新运行时，会自动清理上一次运行中的内部 effect，并根据需要创建新的内部 effect。系统确保正确的执行顺序，外部 effect 始终在其内部 effect 之前运行：

```ts
import { signal, effect } from 'alien-signals';

const show = signal(true);
const count = signal(1);

effect(() => {
  if (show()) {
    // 当 show() 为 true 时创建这个内部 effect
    effect(() => {
      console.log(`Count is: ${count()}`);
    });
  }
}); // 控制台输出：Count is: 1

count(2); // 控制台输出：Count is: 2

// 当 show 变为 false 时，内部 effect 被清理
show(false); // 无输出

count(3); // 无输出（内部 effect 已不存在）
```

### 手动触发

当你直接修改了 signal 的值而没有使用 signal 的 setter 时，`trigger()` 函数允许你手动触发下游依赖的更新：

```ts
import { signal, computed, trigger } from 'alien-signals';

const arr = signal<number[]>([]);
const length = computed(() => arr().length);

console.log(length()); // 0

// 直接修改不会自动触发更新
arr().push(1);
console.log(length()); // 仍然是 0

// 手动触发更新
trigger(arr);
console.log(length()); // 1
```

你也可以一次触发多个 signal：

```ts
import { signal, computed, trigger } from 'alien-signals';

const src1 = signal<number[]>([]);
const src2 = signal<number[]>([]);
const total = computed(() => src1().length + src2().length);

src1().push(1);
src2().push(2);

trigger(() => {
  src1();
  src2();
});

console.log(total()); // 2
```

### 创建你自己的顶层 API

你可以通过 `createReactiveSystem()` 重用 alien-signals 的核心算法来构建你自己的 signal API。实现示例请参阅：

- [入门模板](https://github.com/johnsoncodehk/alien-signals-starter)（实现了 `.get()` 和 `.set()` 方法，类似于 [Signals 提案](https://github.com/tc39/proposal-signals)）
- [stackblitz/alien-signals/src/index.ts](https://github.com/stackblitz/alien-signals/blob/master/src/index.ts)
- [proposal-signals/signal-polyfill#44](https://github.com/proposal-signals/signal-polyfill/pull/44)

## 关于 `propagate` 和 `checkDirty` 函数

为了消除递归调用并提高性能，我们在 `propagate` 和 `checkDirty` 函数中记录了前一个循环的最后一个链接节点，并实现了回滚逻辑以返回到该节点。

这导致代码难以理解，而且在其他语言中你不一定能获得相同的性能提升，因此我们在这里记录了未消除递归调用的原始实现以供参考。

### `propagate`

```ts
function propagate(link: Link): void {
	do {
		const sub = link.sub;

		let flags = sub.flags;

		if (!(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending))) {
			sub.flags = flags | ReactiveFlags.Pending;
		} else if (!(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed))) {
			flags = ReactiveFlags.None;
		} else if (!(flags & ReactiveFlags.RecursedCheck)) {
			sub.flags = (flags & ~ReactiveFlags.Recursed) | ReactiveFlags.Pending;
		} else if (!(flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) && isValidLink(link, sub)) {
			sub.flags = flags | ReactiveFlags.Recursed | ReactiveFlags.Pending;
			flags &= ReactiveFlags.Mutable;
		} else {
			flags = ReactiveFlags.None;
		}

		if (flags & ReactiveFlags.Watching) {
			notify(sub);
		}

		if (flags & ReactiveFlags.Mutable) {
			const subSubs = sub.subs;
			if (subSubs !== undefined) {
				propagate(subSubs);
			}
		}

		link = link.nextSub!;
	} while (link !== undefined);
}
```

### `checkDirty`

```ts
function checkDirty(link: Link, sub: ReactiveNode): boolean {
	do {
		const dep = link.dep;
		const depFlags = dep.flags;

		if (sub.flags & ReactiveFlags.Dirty) {
			return true;
		} else if ((depFlags & (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) === (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) {
			if (update(dep)) {
				const subs = dep.subs!;
				if (subs.nextSub !== undefined) {
					shallowPropagate(subs);
				}
				return true;
			}
		} else if ((depFlags & (ReactiveFlags.Mutable | ReactiveFlags.Pending)) === (ReactiveFlags.Mutable | ReactiveFlags.Pending)) {
			if (checkDirty(dep.deps!, dep)) {
				if (update(dep)) {
					const subs = dep.subs!;
					if (subs.nextSub !== undefined) {
						shallowPropagate(subs);
					}
					return true;
				}
			} else {
				dep.flags = depFlags & ~ReactiveFlags.Pending;
			}
		}

		link = link.nextDep!;
	} while (link !== undefined);

	return false;
}
```
