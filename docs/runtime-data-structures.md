image.png# alien-signals 运行时数据结构

## 概览

alien-signals 是一个基于 **push-pull（推送-拉取）** 的响应式信号库，核心设计借鉴了经典的响应式算法（如 Vue 3.6、Moonbit 等）。

```
┌─────────────────────────────────────────────────────────────────┐
│                         index.ts                                 │
│                                                                  │
│  ┌─────────┐  ┌───────────┐  ┌────────┐  ┌──────────────┐       │
│  │ signal  │  │  computed │  │ effect │  │ effectScope  │       │
│  └────┬────┘  └─────┬─────┘  └───┬────┘  └──────┬───────┘       │
│       └─────────────┴────────────┴──────────────┘                │
│                          │                                       │
│                     内部操作函数                                  │
│                          │                                       │
└──────────────────────────┼───────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                         system.ts                                │
│                                                                  │
│           ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│           │   link   │  │propagate │  │checkDirty│              │
│           └──────────┘  └──────────┘  └──────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 核心节点类型

### SignalNode（信号）

```typescript
interface SignalNode<T = any> extends ReactiveNode {
  currentValue: T; // 当前已确认的值
  pendingValue: T; // 待处理的（可能已更新但未 flush 的）值
  flags: ReactiveFlags.Mutable; // 可变标志
}
```

**特点**：值可以直接被修改（Mutable=1），没有上游依赖列表（deps=undefined）。

### ComputedNode（计算属性）

```typescript
interface ComputedNode<T = any> extends ReactiveNode {
  value: T | undefined; // 缓存的计算值
  getter: (previousValue?: T) => T; // 计算函数
  flags: ReactiveFlags.None; // 无 Mutable，可被覆盖
}
```

**特点**：值由其他节点计算得出，有上游依赖（deps 指向 Link 链表），无 Mutable 标志。

### EffectNode（副作用）

```typescript
interface EffectNode extends ReactiveNode {
  fn(): void; // 用户传入的回调函数
  flags: ReactiveFlags.Watching | ReactiveFlags.RecursedCheck;
}
```

**特点**：不存储值，只执行副作用，有 Watching 标志才能被通知。

---

## Link 链表 — 依赖图的核心

```typescript
interface Link {
  version: number; // 版本号，检测依赖是否过期
  dep: ReactiveNode; // "生产者" — 当前节点依赖的源节点
  sub: ReactiveNode; // "消费者" — 依赖 dep 的下游节点

  // 在 dep.subs 链表中的移动
  prevSub: Link | undefined;
  nextSub: Link | undefined;

  // 在 sub.deps 链表中的移动
  prevDep: Link | undefined;
  nextDep: Link | undefined;
}
```

### 双向链表示意图

```
                dep（被依赖的节点）
                   │
                   │ deps / subs
                   ▼
                 Link ──────────► Link ──────────► ...
                 │                 │
                 │                 │
                 ▼                 ▼
                sub               sub
            （订阅者）          （订阅者）
```

**关键理解**：一条 Link **同时**属于两条双向链表：

- 它是 `dep.subs` 链表的一个节点（dep 的下游）
- 它是 `sub.deps` 链表的一个节点（sub 的上游）

通过 `prevSub/nextSub` 和 `prevDep/nextDep` 八指针，所有节点形成一个**依赖图**。

---

## ReactiveFlags 标志位

使用位掩码（bitmask）高效存储多个状态，可同时存在多个状态。

| 位  | 名称          | 值  | 说明                         |
| --- | ------------- | --- | ---------------------------- |
| 1   | Mutable       | 1   | 可变（只有 signal 有此标志） |
| 2   | Watching      | 2   | 正在监听，有 effect 需要通知 |
| 4   | RecursedCheck | 4   | 递归检查中                   |
| 8   | Recursed      | 8   | 检测到递归发生               |
| 16  | Dirty         | 16  | 脏值，需要重新计算           |
| 32  | Pending       | 32  | 待处理，在批量更新中等待     |

### 标志位检查示例

```typescript
// 同时满足 Mutable + Dirty
if (
  (flags & (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) ===
  (ReactiveFlags.Mutable | ReactiveFlags.Dirty)
) {
  // signal 的值已变化，需要传播
}

// 检查 Watching 标志
if (flags & ReactiveFlags.Watching) {
  notify(sub); // 触发通知
}
```

---

## 全局状态

```typescript
// 当前活跃的订阅者 — 追踪"谁在读取值"
let activeSub: ReactiveNode | undefined;

// 待处理的 effect 队列
const queued: (EffectNode | undefined)[] = [];

// 批量深度计数器
let batchDepth = 0;

// 版本周期计数器
let cycle = 0;

// Effect 队列处理位置
let notifyIndex = 0;
let queuedLength = 0;
```

### activeSub 的作用

依赖自动建立的核心机制：

```typescript
effect(() => {
  console.log(a()); // activeSub = 当前 effect
  // 自动建立 a → effect 的依赖
});
```

---

## 依赖图示例

```
┌─────────────────────────────────────────────────────────────┐
│                                                              │
│   signal(a)  ──subs─→  Link  ──dep─→  computed(c)          │
│  currentValue=1              │          deps─→ Link        │
│     ↑                  prevSub/nextSub          │           │
│     │                   Link                     │           │
│     └───────subs────────┘              prevDep/nextDep      │
│                                        deps─→  Link          │
│                                                   │         │
│                                                   ▼         │
│                                              signal(a)       │
│                                                              │
│   signal(b)  ──subs─→  Link  ──dep─→  effect(fn)           │
│  currentValue=2                                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘

解读：
- effect(fn) 依赖 computed(c)
- computed(c) 依赖 signal(a) 和 signal(b)
- signal(a) 同时被 computed(c) 和 effect(fn) 订阅
```

---

## 核心算法流程

### 1. 依赖建立（link）

```typescript
function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
  // 1. 检查是否已存在这条依赖链（去重）
  // 2. 如果已存在，只更新版本号
  // 3. 如果不存在，创建新的 Link 并插入双向链表
}
```

**优化**：

- 检查 `sub.depsTail` 是否正好是 `dep`（最近访问的缓存）
- 检查 `dep.subsTail` 是否已存在相同连接
- 避免重复创建 Link

### 2. 推送阶段（propagate）

当 signal 变化时，沿着依赖链传播变化：

```
signal 变化
    │
    ▼
propagate(Link 链表)
    │
    ├── 标记节点为 Pending/Dirty
    │
    ├── 如果有 Watching 标志 → notify(effect) 加入队列
    │
    └── 如果是 Mutable → 递归处理订阅者
```

### 3. 拉取阶段（checkDirty）

按需检查是否需要更新：

```
读取 computed/effect
    │
    ▼
checkDirty(link, sub)
    │
    ├── 检查 sub 本身是否 Dirty
    │
    ├── 如果 dep 是 Mutable + Dirty → update(dep)
    │
    └── 如果 dep 是 Mutable + Pending → 深入依赖链检查
```

### 4. 批量更新（batchDepth）

```typescript
startBatch();
a(1);
b(2);
c(3); // 多个 signal 变化，只触发一次 flush
endBatch();
```

当 `batchDepth > 0` 时，signal 变化不会立即 flush effect，直到 `batchDepth` 降为 0。

### 5. Effect 执行（flush）

```
queued 队列
    │
    ▼
第一阶段：按顺序执行所有 effect
    │
    ├── run(effect) → 重新执行 fn()
    │
    └── 处理过的位置设为 undefined
    │
    ▼
finally 阶段：处理执行过程中新加入的 effect
    │
    ▼
重置队列状态
```

---

## 设计亮点

### 1. 双向链表实现 O(1) 增删

Link 同时属于两条链表，插入和删除都是 O(1) 操作，无需遍历。

### 2. 栈模拟递归避免栈溢出

`propagate` 和 `checkDirty` 使用显式栈 + `labeled break` 代替递归调用：

```typescript
function propagate(link: Link): void {
  let stack: Stack<Link | undefined> | undefined;
  top: do {
    // 处理当前链路
    if (多个订阅者) {
      stack = { value: next, prev: stack }; // 入栈
    }
    // ...
    continue top; // 跳回循环开始
  } while (true);
}
```

### 3. 位掩码实现 O(1) 状态检查

单个数字存储多个状态，`flags & FLAG` 和 `flags | FLAG` 都是 O(1)。

### 4. 懒更新策略

- **signal**：变化时立即传播（push）
- **computed**：读取时才检查是否脏（pull）
- **effect**：加入队列，批量执行

### 5. 循环依赖检测

通过 `RecursedCheck` 和 `Recursed` 标志组合检测循环引用。

---

## 类型层次关系

```
ReactiveNode（基础节点）
    │
    ├── SignalNode（扩展）
    │       + currentValue, pendingValue
    │       + 无 deps
    │
    ├── ComputedNode（扩展）
    │       + value, getter
    │       + 有 deps
    │
    └── EffectNode（扩展）
            + fn
            + Watching 标志
```
