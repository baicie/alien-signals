# alien-signals 项目讲解与 Link 节点示例

## 一、项目讲解

### 1.1 项目定位

**alien-signals** 是一个高性能的"响应式信号"算法库，它的目标是：当一个值变化时，所有依赖这个值的下游计算和副作用都能自动更新。它和 Vue 3、Preact Signals、SolidJS、Svelte 等的响应式系统是同一类东西，但跑得更快。

### 1.2 核心思想：Push-Pull（推送 + 拉取）

| 阶段 | 触发时机 | 做什么 |
|------|----------|--------|
| **Push（推送）** | `signal` 写入新值时 | 沿着依赖图向下"打标记"（标记下游节点为脏/待处理）|
| **Pull（拉取）** | 读取 `computed` 或执行 `effect` 时 | 检查自己依赖的上游有没有真正变化，再决定是否重算 |

这种设计避免了"推送阶段就立即重算所有 computed"的浪费——只有真正被读取时才会计算。

### 1.3 架构分层

项目代码就两个核心文件：

```
src/system.ts   ← 纯算法层（不知道 signal/computed 是什么）
                  导出 createReactiveSystem()，提供 link/unlink/propagate/checkDirty

src/index.ts    ← 高层 API（使用上面的算法实现 signal/computed/effect）
```

这种分离让别人也能基于 `system.ts` 做出符合自己 API 风格的库（Vue 3.6 就是这么干的）。

### 1.4 两个最关键的数据结构

**`ReactiveNode`（节点）—— 一个 signal、computed 或 effect 都是它**

```ts
export interface ReactiveNode {
    deps?: Link;
    depsTail?: Link;
    subs?: Link;
    subsTail?: Link;
    flags: ReactiveFlags;
}
```

| 字段 | 含义 |
|------|------|
| `deps` / `depsTail` | "我依赖谁"链表的头/尾 |
| `subs` / `subsTail` | "谁依赖我"链表的头/尾 |
| `flags` | 状态位（脏/待处理/正在监听等）|

**`Link`（链接节点）—— 连接两个节点的"桥"**

```ts
export interface Link {
    version: number;
    dep: ReactiveNode;
    sub: ReactiveNode;
    prevSub: Link | undefined;
    nextSub: Link | undefined;
    prevDep: Link | undefined;
    nextDep: Link | undefined;
}
```

**关键认知**：一条 `Link` 同时挂在两条双向链表上：

- 它在 `dep.subs` 链表里（通过 `prevSub` / `nextSub` 串联）
- 它也在 `sub.deps` 链表里（通过 `prevDep` / `nextDep` 串联）

这样从任意一边都能高效地遍历和插入/删除。

---

## 二、举一个超简单的例子：建立联系 + 创建 Link 节点

我们假设业务代码是：

```ts
const count = signal(1);                      // signal 节点 A
const double = computed(() => count() * 2);   // computed 节点 B

double();                                      // 第一次读取，会触发依赖收集
```

下面我一步步追这条链路是怎么建立起来的。

---

### 步骤 1：创建 signal 节点 A

调用 `signal(1)` 时，`index.ts` 里执行：

```ts
export function signal<T>(initialValue?: T): {
    (): T | undefined;
    (value: T | undefined): void;
} {
    return signalOper.bind({
        currentValue: initialValue,
        pendingValue: initialValue,
        subs: undefined,
        subsTail: undefined,
        flags: ReactiveFlags.Mutable,
    }) as () => T | undefined;
}
```

得到节点 A：

```
A = {
  currentValue: 1,
  pendingValue: 1,
  subs: undefined,      ← 还没人依赖我
  subsTail: undefined,
  flags: Mutable        ← 我的值可以变
}
```

### 步骤 2：创建 computed 节点 B

```ts
export function computed<T>(getter: (previousValue?: T) => T): () => T {
    return computedOper.bind({
        value: undefined,
        subs: undefined,
        subsTail: undefined,
        deps: undefined,
        depsTail: undefined,
        flags: ReactiveFlags.None,
        getter: getter as (previousValue?: unknown) => unknown,
    }) as () => T;
}
```

得到节点 B（注意 `flags = None`，所以**第一次读取**时会进入"初始化分支"）：

```
B = {
  value: undefined,
  deps: undefined,      ← 还没收集到依赖
  depsTail: undefined,
  subs: undefined,
  subsTail: undefined,
  flags: None,
  getter: () => count() * 2
}
```

### 步骤 3：调用 `double()`，触发首次依赖收集

执行 `computedOper`，因为 `flags === None`，进入"首次读取"分支：

```ts
} else if (!flags) {
    this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
    const prevSub = setActiveSub(this);
    try {
        this.value = this.getter();
    } finally {
        activeSub = prevSub;
        this.flags &= ~ReactiveFlags.RecursedCheck;
    }
}
```

关键操作：**把 B 设为 `activeSub`**（"现在是 B 在读东西"），然后执行 `getter`。

### 步骤 4：`getter` 内部调用 `count()`，触发 `signalOper` 的读取分支

```ts
let sub = activeSub;
while (sub !== undefined) {
    if (sub.flags & (ReactiveFlags.Mutable | ReactiveFlags.Watching)) {
        link(this, sub, cycle);
        break;
    }
    sub = sub.subs?.sub;
}
```

这里 `this = A`，`activeSub = B`，于是调用：

```ts
link(A, B, cycle);   // 含义：B 依赖 A
```

### 步骤 5：进入 `link()`，正式创建 Link 节点

```ts
function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
    const prevDep = sub.depsTail;

    if (prevDep !== undefined && prevDep.dep === dep) {
        return;
    }
    // ... 一些去重的快速路径 ...

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
}
```

由于这是首次链接：

- `sub.depsTail (B.depsTail)` = undefined → 跳过去重
- `prevSub (A.subsTail)` = undefined → 跳过去重
- 创建新 `Link` L

L 创建好后，**同时被挂到两边**：

- `B.deps = L`、`B.depsTail = L`
- `A.subs = L`、`A.subsTail = L`

### 步骤 6：依赖图建立完成

最终内存中的结构：

```
   ┌──────────────────┐                  ┌──────────────────┐
   │ A (signal count) │                  │ B (computed)     │
   │  currentValue:1  │                  │  value: 2        │
   │  subs: ───┐      │                  │  deps: ───┐      │
   │  subsTail:┤      │                  │  depsTail:┤      │
   └───────────┼──────┘                  └───────────┼──────┘
               │                                     │
               │                                     │
               └───────────►  ┌──────────────┐  ◄────┘
                              │   Link  L    │
                              │  dep: → A    │
                              │  sub: → B    │
                              │  prevSub: -  │
                              │  nextSub: -  │
                              │  prevDep: -  │
                              │  nextDep: -  │
                              └──────────────┘
```

后续如果调用 `count(2)`：

1. `signalOper` 写入分支检测到值变化 → 调用 `propagate(A.subs)`
2. 沿着 `A.subs → L → L.sub (= B)` 找到 B
3. 把 B 标记为 `Pending`（脏的候选）
4. 下次读取 `double()` 时，`computedOper` 发现 `Pending` 标志 → 调用 `checkDirty` → 真的脏 → 重新执行 `getter` → 拿到 4

---

## 三、记住三句话就能理解整个项目

1. **节点（`ReactiveNode`）** 就是 signal / computed / effect 的内部对象，每个节点持有"我依赖谁"和"谁依赖我"两条链表。
2. **链接（`Link`）** 是连接两个节点的桥，一个 Link 同时存在于 `dep.subs` 和 `sub.deps` 两条双向链表上，所以两边都能 O(1) 地插入/删除。
3. **依赖关系是"读出来"的**：执行 `effect` 或 `computed` 的 getter 时把节点设为 `activeSub`，函数体里读取的每个 signal 都会回调 `link(被读节点, activeSub, cycle)`，从而自动建立依赖。

如果你想进一步看，建议下一步阅读 `tests/demo.spec.ts` 或 `tests/computed.spec.ts`，配合 `link` 函数打断点跑一遍，会对双向链表的指针走向印象更深。
