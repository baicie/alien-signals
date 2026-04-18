# ReactiveNode 头尾指针与 Link 链表详解

## 核心数据结构

### ReactiveNode（点）

```typescript
interface ReactiveNode {
  deps?: Link; // 依赖链表的头指针（第一个依赖）
  depsTail?: Link; // 依赖链表的尾指针（最后一个依赖）
  subs?: Link; // 订阅者链表的头指针（第一个订阅者）
  subsTail?: Link; // 订阅者链表的尾指针（最后一个订阅者）
  flags: ReactiveFlags;
}
```

### Link（边）

```typescript
interface Link {
  version: number;
  dep: ReactiveNode; // "生产者" — 当前节点依赖的源节点
  sub: ReactiveNode; // "消费者" — 依赖 dep 的下游节点
  prevSub: Link | undefined; // 在 dep.subs 链表中的前驱
  nextSub: Link | undefined; // 在 dep.subs 链表中的后继
  prevDep: Link | undefined; // 在 sub.deps 链表中的前驱
  nextDep: Link | undefined; // 在 sub.deps 链表中的后继
}
```

## 完整内存结构示例

假设创建了这些信号：

```typescript
const a = signal(1); // SignalNode(A)
const b = signal(2); // SignalNode(B)
const c = computed(() => a() + b()); // ComputedNode(C)
const e = effect(() => console.log(c())); // EffectNode(E)
```

建立依赖后，内存中的实际结构如下：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           内存中的实际结构                                   │
└─────────────────────────────────────────────────────────────────────────────┘

  ReactiveNode A              ReactiveNode C              ReactiveNode E
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ deps: undefined  │    │ deps: Link(A)────┼────┼─►Link(C)         │
│ depsTail:undef.  │    │ depsTail: Link(C)│    │ depsTail: Link(E)│
│ subs: Link(A)────┼────┼─►Link(A)         │    │ subs: undefined  │
│ subsTail:Link(A) │    │ subsTail: Link(A) │    │ subsTail:undef.  │
│ flags: Mutable   │    │ flags: None      │    │ flags: Watching  │
│ currentValue: 1  │    │ value: 3         │    │ fn: ()=>{...}    │
│ pendingValue: 1  │    │ getter: fn       │    │                  │
└──────────────────┘    └──────────────────┘    └──────────────────┘

  ReactiveNode B              (Link 节点们)
┌──────────────────┐    ┌──────────────────────────────────────────────────────┐
│ deps: undefined  │    │ Link(A→C)           Link(B→C)          Link(C→E)   │
│ depsTail:undef.  │    │ ┌──────────────┐   ┌──────────────┐   ┌────────────┐│
│ subs: Link(B)────┼────┼─│ dep: A       │   │ dep: B       │   │ dep: C     ││
│ subsTail:Link(B) │    │ │ sub: C       │   │ sub: C       │   │ sub: E     ││
│ flags: Mutable   │    │ │              │   │              │   │            ││
│ currentValue: 2  │    │ │ prevDep:undef │   │ prevDep:L(A→C)│  │ prevDep:   ││
│ pendingValue: 2  │    │ │ nextDep:L(B→C)│   │ nextDep:undef │  │   undef    ││
└──────────────────┘    │ │ prevSub:undef │   │ prevSub:undef │  │ nextDep:   ││
                       │ │ nextSub:L(C→E) │   │ nextSub:L(C→E)│  │   undef    ││
                       │ └──────────────┘   └──────────────┘   │ prevSub:   ││
                       │      ▲                  ▲              │   L(B→C)   ││
                       │      │                  │              │ nextSub:   ││
                       └──────┼──────────────────┼──────────────┤   undef    ││
                              │                  │              └────────────┘│
                              │   subs 链表      │                              │
                              └──────┬───────────┘                              │
                                     │   deps 链表                              │
                                     └────────┬─────────────────────────────────┘
                                              │
```

## 从不同角度观察同一组 Link

一条 Link 同时属于两条链表：

```
                    ┌─────────────────────────────────────────────────────────┐
                    │              C.deps 链表（deps 视角）                  │
                    │                                                         │
                    │  C.deps ──► Link(A→C) ──► Link(B→C) ──► C.depsTail   │
                    │     head      prevDep/nextDep        tail              │
                    │                                                         │
                    │  C 依赖 A 和 B（从 C 的角度：我依赖了哪些节点）          │
                    └─────────────────────────────────────────────────────────┘

                    ┌─────────────────────────────────────────────────────────┐
                    │              C.subs 链表（subs 视角）                    │
                    │                                                         │
                    │  C.subs ──► Link(A→C) ──► Link(B→C) ──► C.subsTail    │
                    │     head      prevSub/nextSub        tail               │
                    │                                                         │
                    │  C 被 A 和 B 订阅（A/B 变化会通知 C）                    │
                    └─────────────────────────────────────────────────────────┘
```

## Link 的双向嵌入

```typescript
Link(A→C) {
    dep: A,           // Link(A→C) 在 A.subs 链中：表示 A 被 C 订阅
    sub: C,           // Link(A→C) 在 C.deps 链中：表示 C 依赖 A

    // 在 A.subs 链中移动：
    prevSub: undefined,
    nextSub: Link(C→E),   // A 的下一个订阅者是 E

    // 在 C.deps 链中移动：
    prevDep: undefined,
    nextDep: Link(B→C),   // C 的下一个依赖是 B
}
```

## 指针指向逻辑

```
C.deps = Link(A→C)      // C.deps 指向 deps 链的头
C.depsTail = Link(B→C)  // C.depsTail 指向 deps 链的尾

A.subs = Link(A→C)      // A.subs 指向 subs 链的头
A.subsTail = Link(A→C)  // A 只有一个订阅者，所以头尾都是 Link(A→C)
```

## 为什么 ReactiveNode 要存储头尾指针

存储头尾指针是为了 **O(1) 时间的追加和删除**，避免每次操作都要遍历整个链表。

| 操作           | 只有 head（单向）     | 有 head + tail（双向）          |
| -------------- | --------------------- | ------------------------------- |
| 追加新 Link    | O(n) 遍历到尾部       | **O(1)**                        |
| 删除尾部 Link  | O(n) 找前驱更新 tail  | **O(1)**                        |
| 从尾部向前清理 | 需要先找 tail，再遍历 | **O(1)** 直接从 `depsTail` 开始 |
| 尾部去重检查   | O(n)                  | **O(1)** `prevDep.dep === dep`  |

### 源码中的具体应用

1. **`link()` 函数 — 尾部去重优化**（system.ts）：

```typescript
const prevDep = sub.depsTail;
if (prevDep !== undefined && prevDep.dep === dep) {
  return; // depsTail 就是最近一次追加的，通常命中率高
}
```

2. **`purgeDeps()` 函数 — 从尾向前清理**（index.ts）：

```typescript
const depsTail = sub.depsTail;
let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps;
// 从 depsTail.nextDep 开始往前清理
```

3. **`unlink()` 函数 — 删除尾部时 O(1) 更新 tail**（system.ts）：

```typescript
if (nextDep !== undefined) {
  nextDep.prevDep = prevDep;
} else {
  sub.depsTail = prevDep; // 删除最后一个节点，O(1) 更新 tail
}
```

## 操作示例：`a(3)` 触发变化

```
1. signalOper 中，设置 a() 的值为 3
2. 发现 a 有 subs 链表：Link(A→C) ──► Link(C→E)
3. 调用 propagate(Link(A→C))
4. propagate 沿着 Link(A→C).nextSub 继续：Link(C→E)
5. 最终通知到 E，执行 effect
```

## 四指针设计的本质

```
同一块内存（一条 Link），
两套指针（prevSub/nextSub 和 prevDep/nextDep），
两个身份（在 dep.subs 链中是"订阅者"，在 sub.deps 链中是"依赖"）。
```

### 为什么需要四指针而不是更简单的设计

**方案 A：拆成两个独立结构**

```typescript
interface DepToSub { dep, sub, next }    // dep.subs 链表
interface SubToDep { sub, dep, next }    // sub.deps 链表
```

- 问题：需要两个结构、两组内存、两处同步更新
- 问题：删除一条依赖关系时需要同时操作两个对象

**方案 B：单向链表**

- 问题：`purgeDeps` 需要从尾向前遍历，单向无法实现
- 问题：删除中间节点需要 O(n) 找到前驱

**当前设计：一元化边 + 四指针**

- 一条 Link 同时嵌入两条链表，只需要一个内存分配
- 双向指针支持从头、从尾、任意节点 O(1) 增删
- `link`/`unlink` 各只需一处逻辑，不需同步两个结构

### 四指针设计的具体好处

| 维度 | 效果 |
|------|------|
| **内存** | 只需要一个 Link 对象，不重复存储 |
| **一致性** | 边是唯一的，dep/sub 一旦确定就不再分裂 |
| **遍历灵活性** | 双向指针支持从头、从尾、任意节点 O(1) 增删 |
| **代码简洁** | `link`/`unlink` 各只需一处逻辑，不需同步两个结构 |

### 从源码理解

`purgeDeps(sub)` 需要从尾向前遍历清理：

```typescript
// 从 depsTail 开始往前清理
const depsTail = sub.depsTail;
let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps;

while (dep !== undefined) {
    dep = unlink(dep, sub);  // unlink 返回 nextDep
}
```

`unlink` 删除中间节点，三种情况都 O(1)：

```typescript
// 删除尾部：更新 tail 指针
if (nextDep !== undefined) {
    nextDep.prevDep = prevDep;
} else {
    sub.depsTail = prevDep;  // O(1) 更新 tail
}

// 删除头部：更新 head 指针
if (prevDep !== undefined) {
    prevDep.nextDep = nextDep;
} else {
    sub.deps = nextDep;       // O(1) 更新 head
}
```

## 总结

- **ReactiveNode = 点**：signal / computed / effect
- **Link = 边**：连接两个节点的关系
- **头尾指针 = 链表的入口/出口**：
  - `deps / depsTail`：从"谁依赖我"的入口进入我的 deps 链表
  - `subs / subsTail`：从"我依赖谁"的入口进入我的 subs 链表
- **一条 Link 同时是上下游两条链表的成员**，通过两组 prev/next 指针分别嵌入两条链表
- 头尾指针的核心价值是所有尾部操作达到 **O(1)** 复杂度，这对响应式系统中 signal 频繁变化、频繁增删依赖的场景至关重要

