# 响应式依赖图谱

## 示例代码

```typescript
const a = signal(1);                      // SignalNode(A)
const b = signal(2);                      // SignalNode(B)
const c = computed(() => a() + b());       // ComputedNode(C)
const e = effect(() => console.log(c()));  // EffectNode(E)
```

## 图例

```
○ ReactiveNode（圆形）
■ Link（方形）
──► 依赖方向（sub 依赖 dep）
```

## 完整依赖图

```
                        ┌─────────────────────────────────────────┐
                        │                                         │
                        │    ○ SignalNode A                      │
                        │    a.subs ──────────────────────┐      │
                        │    a.subsTail ─────────────────┐│      │
                        │              │                   ││      │
                        │              │ a() 读取值         ││      │
                        │              ▼                   ││      │
                        │         ┌─────────┐              ││      │
                        │         │ ■ Link  │              ││      │
                        │         │(A→C)    │              ││      │
                        │         │ version │              ││      │
                        │         └────┬────┘              ││      │
                        │              │                   ││      │
                        └──────────────┼───────────────────┼┘      │
                                       │                    │
                                       │ b() 读取值         │
                                       ▼                    │
                        ┌───────────────────────────────────────────┐
                        │                                           │
                        │    ○ SignalNode B                         │
                        │    b.subs ──────────────────────┐         │
                        │    b.subsTail ─────────────────┐│         │
                        │              │                   ││         │
                        │              ▼                   ││         │
                        │         ┌─────────┐              ││         │
                        │         │ ■ Link  │              ││         │
                        │         │(B→C)    │              ││         │
                        │         │ version │              ││         │
                        │         └────┬────┘              ││         │
                        │              │                   ││         │
                        └──────────────┼───────────────────┼┘         │
                                       │                    │
                        ┌──────────────┼────────────────────┼──────────┐
                        │              │                    │          │
                        │              │                    │          │
                        │              ▼                    │          │
                        │         ┌─────────┐               │          │
                        │         │ ■ Link  │               │          │
                        │         │(C→E)    │               │          │
                        │         │ version │               │          │
                        │         └────┬────┘               │          │
                        │              │                    │          │
                        │              │ c() 计算值          │          │
                        │              ▼                    │          │
                        │    ○ ComputedNode C                                 │
                        │    c.deps ──────────────────────┐                  │
                        │    c.depsTail ─────────────────┐│                  │
                        │    c.subs ─────────────────────┘│                  │
                        │    c.subsTail ──────────────────┘│                  │
                        │              │                     │                  │
                        └──────────────┼─────────────────────┼──────────────────┘
                                       │                     │
                                       │ console.log(c())   │
                                       ▼                     │
                        ┌───────────────────────────────────────────────────────┐
                        │                                                               │
                        │    ○ EffectNode E                                        │
                        │    e.deps ─────────────────────────────┐                 │
                        │    e.depsTail ──────────────────────────┘                 │
                        │    e.subs ─ undefined                                     │
                        │    e.subsTail ─ undefined                                 │
                        │                                                               │
                        └───────────────────────────────────────────────────────────┘
```

## 简化版（有向图视角）

```
○ A ───────────────► ○ C ───────────────► ○ E
       Link(A→C)          Link(C→E
○ B ──────┘
       Link(B→C)

含义：
  A、B、C、E 都是 ○ ReactiveNode
  依赖关系用 ■ Link 表示（A→C 表示 C 依赖 A）

  ○ A ─────► ○ C  表示：
    C.deps 链中有 Link(A→C)
    A.subs 链中有 Link(A→C)

  ○ B ─────► ○ C  表示：
    C.deps 链中有 Link(B→C)
    B.subs 链中有 Link(B→C)

  ○ C ─────► ○ E  表示：
    E.deps 链中有 Link(C→E)
    C.subs 链中有 Link(C→E)
```

## Link 的双重身份

```
每条 ■ Link 同时是 dep.subs 链的成员 和 sub.deps 链的成员：

■ Link(A→C) 的两重身份：
  身份1（dep 视角）：在 A.subs 链中，角色是"A 的订阅者"
  身份2（sub 视角）：在 C.deps 链中，角色是"C 的依赖"

■ Link(B→C) 的两重身份：
  身份1：在 B.subs 链中，B 的订阅者
  身份2：在 C.deps 链中，C 的依赖

■ Link(C→E) 的两重身份：
  身份1：在 C.subs 链中，C 的订阅者
  身份2：在 E.deps 链中，E 的依赖
```

## 依赖传递关系

```
A ─────┐
       ├──► C ──► E
B ─────┘

当 A 或 B 变化时：
  A/B 变化 → propagate(A/B) → 找到 A/B.subs 中的 Link → 通知 C
  C 变化（如果 A 或 B 变了）→ propagate(C) → 找到 C.subs 中的 Link → 通知 E
  E 收到通知 → 执行 console.log(c())
```

## 完整数据结构对照

```
ReactiveNode A (Signal)
┌────────────────────────────┐
│  currentValue: 1           │
│  pendingValue: 1           │
│  flags: Mutable            │
│                            │
│  deps: ∅      depsTail: ∅  │  ← 没有上游依赖
│                            │
│  subs: Link(A→C)           │──┐
│  subsTail: Link(C→E)       │──┘
└────────────────────────────┘

ReactiveNode B (Signal)
┌────────────────────────────┐
│  currentValue: 2           │
│  pendingValue: 2           │
│  flags: Mutable            │
│                            │
│  deps: ∅      depsTail: ∅  │
│                            │
│  subs: Link(B→C)           │
│  subsTail: Link(B→C)       │
└────────────────────────────┘

ReactiveNode C (Computed)
┌────────────────────────────┐
│  value: 3                  │
│  getter: () => a() + b()   │
│  flags: None               │
│                            │
│  deps: Link(A→C)           │──┐
│  depsTail: Link(C→E)       │──┤
│                            │  │
│  subs: Link(C→E)           │──┘
│  subsTail: Link(C→E)       │
└────────────────────────────┘

ReactiveNode E (Effect)
┌────────────────────────────┐
│  fn: () => console.log(c())│
│  flags: Watching|Recursed  │
│                            │
│  deps: Link(C→E)           │
│  depsTail: Link(C→E)       │
│                            │
│  subs: ∅    subsTail: ∅    │  ← 叶子节点
└────────────────────────────┘

Link(A→C)
┌────────────────────────────────┐
│  version: 0                     │
│  dep: A  │  sub: C             │
│  prevSub: ∅ │ nextSub: Link(C→E)│
│  prevDep: ∅ │ nextDep: Link(B→C)│
└────────────────────────────────┘

Link(B→C)
┌────────────────────────────────┐
│  version: 0                     │
│  dep: B  │  sub: C             │
│  prevSub: ∅ │ nextSub: ∅       │
│  prevDep: Link(A→C) │ nextDep: ∅│
└────────────────────────────────┘

Link(C→E)
┌────────────────────────────────┐
│  version: 1                     │
│  dep: C  │  sub: E             │
│  prevSub: Link(A→C) │ nextSub: ∅│
│  prevDep: Link(B→C) │ nextDep: ∅│
└────────────────────────────────┘
```

## 每个阶段的完整数据追踪

### 代码执行顺序

```typescript
const a = signal(1);                      // 第 1 步
const b = signal(2);                      // 第 2 步
const c = computed(() => a() + b());       // 第 3 步
const e = effect(() => console.log(c()));  // 第 4 步
a(3);                                       // 第 5 步：a 从 1 变成 3
```

---

### 第 1 步：`const a = signal(1)`

创建 SignalNode A，初始值 1。

```
ReactiveNode A (Signal)
┌─────────────────────────────────────┐
│  currentValue: 1                    │
│  pendingValue: 1                    │
│  flags: Mutable (1)                 │
│                                     │
│  deps: undefined                    │
│  depsTail: undefined                │
│  subs: undefined                     │
│  subsTail: undefined                │
└─────────────────────────────────────┘
```

全局状态：
- `cycle = 0`
- `batchDepth = 0`
- `activeSub = undefined`

---

### 第 2 步：`const b = signal(2)`

创建 SignalNode B，初始值 2。

```
ReactiveNode B (Signal)
┌─────────────────────────────────────┐
│  currentValue: 2                    │
│  pendingValue: 2                    │
│  flags: Mutable (1)                 │
│                                     │
│  deps: undefined                    │
│  depsTail: undefined                │
│  subs: undefined                     │
│  subsTail: undefined                │
└─────────────────────────────────────┘

ReactiveNode A (Signal)
┌─────────────────────────────────────┐
│  currentValue: 1                    │
│  pendingValue: 1                    │
│  flags: Mutable (1)                 │
│  deps: undefined                    │
│  depsTail: undefined                │
│  subs: undefined                     │
│  subsTail: undefined                │
└─────────────────────────────────────┘
```

---

### 第 3 步：`const c = computed(() => a() + b())`

创建 ComputedNode C，执行 getter `() => a() + b()`。

执行流程：

#### 3.1 创建 ComputedNode（初始状态）

```
ReactiveNode C (Computed)
┌─────────────────────────────────────┐
│  value: undefined                   │
│  getter: () => a() + b()           │
│  flags: None (0)                    │
│                                     │
│  deps: undefined                    │
│  depsTail: undefined                │
│  subs: undefined                     │
│  subsTail: undefined                │
└─────────────────────────────────────┘
```

#### 3.2 读取 a() — 触发 signalOper（读取分支）

进入 `signalOper`，此时 `value.length = 0`（无参数）：

1. 检查 `flags & Dirty`：`0 & 16 = 0`，不脏
2. `activeSub` 当前是 `undefined`（因为这是 computed 初始化，不是 effect），跳过 link 逻辑
3. 返回 `currentValue: 1`

**A 的数据不变**，因为没有 activeSub，不建立依赖。

#### 3.3 读取 b() — 触发 signalOper（读取分支）

同样，跳过 link 逻辑（activeSub = undefined），返回 `currentValue: 2`。

#### 3.4 computed getter 返回 1 + 2 = 3

```
ReactiveNode C (Computed) 初始化完成后
┌─────────────────────────────────────┐
│  value: 3                           │
│  getter: () => a() + b()           │
│  flags: None (0)                    │
│                                     │
│  deps: undefined                    │
│  depsTail: undefined                │
│  subs: undefined                     │
│  subsTail: undefined                │
└─────────────────────────────────────┘
```

**注意**：computed 在初始化时（首次执行 getter），因为 `activeSub = undefined`，**没有建立任何依赖**。这是正常行为 —— computed 本身不依赖任何人，它的依赖是在被其他节点读取时才建立的。

---

### 第 4 步：`const e = effect(() => console.log(c()))`

创建 EffectNode E，执行 `() => console.log(c())`。

执行流程：

#### 4.1 创建 EffectNode E

```
ReactiveNode E (Effect)
┌─────────────────────────────────────┐
│  fn: () => console.log(c())        │
│  flags: Watching(2) | RecursedCheck(4) = 6
│                                     │
│  deps: undefined                    │
│  depsTail: undefined                │
│  subs: undefined                     │
│  subsTail: undefined                │
└─────────────────────────────────────┘
```

flags = 6 = Watching | RecursedCheck

#### 4.2 保存并设置 activeSub

```typescript
const prevSub = setActiveSub(e);
// activeSub = E
```

此时 `prevSub = undefined`（没有嵌套 effect）。

#### 4.3 执行 `e.fn()` 即 `() => console.log(c())`

进入 `computedOper`：

##### 4.3.1 检查脏标志

```typescript
const flags = this.flags; // flags = 0 (None)
```

- `flags & Dirty`：`0 & 16 = 0`，不脏
- `flags & Pending`：`0 & 32 = 0`，不是待处理

##### 4.3.2 进入 `else if (!flags)` 分支

`!flags = true`，说明是**首次读取**（或已同步）：

```typescript
this.flags = Mutable | RecursedCheck; // flags = 5
const prevSub = setActiveSub(this); // activeSub = C
try {
    this.value = this.getter(); // 执行 () => a() + b()
} finally { ... }
```

##### 4.3.3 执行 getter：`a() + b()`

**读取 a()**：

进入 `signalOper`（读取分支，`value.length = 0`）：

```typescript
let sub = activeSub; // sub = C（当前的 computed）
while (sub !== undefined) {
    if (sub.flags & (Mutable | Watching)) { // 5 & 3 = 1
        link(this, sub, cycle); // link(A, C, cycle)
        break;
    }
    sub = sub.subs?.sub; // 尝试父订阅者
}
return this.currentValue; // 返回 1
```

执行 `link(A, C, cycle)`：

```
link(A, C, cycle=0):
  prevDep = sub.depsTail = undefined
  prevSub = dep.subsTail = undefined
  新建 Link(A→C):
    version = 0
    dep = A, sub = C
    prevDep = undefined, nextDep = undefined
    prevSub = undefined, nextSub = undefined
```

插入链表后：

```
ReactiveNode A (Signal)
  subs: Link(A→C)
  subsTail: Link(A→C)

ReactiveNode C (Computed)
  deps: Link(A→C)
  depsTail: Link(A→C)
  value: 1 (a() 的返回值，累加中)
```

**读取 b()**：

同样执行 `link(B, C, cycle=0)`：

```
Link(B→C):
  version = 0
  dep = B, sub = C
  prevSub = Link(A→C), nextSub = undefined
  prevDep = Link(A→C), nextDep = undefined
```

插入链表后：

```
ReactiveNode A (Signal)
  subs: Link(A→C) ──► undefined
  subsTail: Link(A→C)

ReactiveNode B (Signal)
  subs: Link(B→C) ──► undefined
  subsTail: Link(B→C)

ReactiveNode C (Computed)
  deps: Link(A→C) ──► Link(B→C) ──► undefined
  depsTail: Link(B→C)
  value: 3 (a() + b() = 1 + 2)
```

getter 执行完毕，返回 3。

##### 4.3.4 恢复 activeSub 并清除标志

```typescript
} finally {
    activeSub = prevSub; // activeSub = E
    this.flags &= ~ReactiveFlags.RecursedCheck; // flags = Mutable(1)
}
```

此时 `C.flags = 1` (Mutable)。

##### 4.3.5 建立 E 对 C 的依赖

```typescript
const sub = activeSub; // sub = E
if (sub !== undefined) {
    link(this, sub, cycle); // link(C, E, cycle=0)
}
```

执行 `link(C, E, cycle=0)`：

```
Link(C→E):
  version = 0
  dep = C, sub = E
  prevSub = undefined, nextSub = undefined
  prevDep = undefined, nextDep = undefined
```

插入链表后：

```
ReactiveNode C (Computed)
  subs: Link(C→E) ──► undefined
  subsTail: Link(C→E)

ReactiveNode E (Effect)
  deps: Link(C→E) ──► undefined
  depsTail: Link(C→E)
```

##### 4.3.6 返回 c() 的值

`computedOper` 返回 `this.value! = 3`。

##### 4.3.7 执行 console.log(3)

输出 `3`。

#### 4.4 恢复 activeSub 和清除标志

```typescript
} finally {
    activeSub = prevSub; // activeSub = undefined
    e.flags &= ~ReactiveFlags.RecursedCheck; // E.flags = Watching(2)
}
```

---

### 第 4 步完成后的完整数据结构

```
┌──────────────────────────────────────────────────────────────┐
│  ReactiveNode A (Signal)                                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  currentValue: 1                                        │  │
│  │  pendingValue: 1                                        │  │
│  │  flags: Mutable (1)                                     │  │
│  │                                                          │  │
│  │  deps: undefined      depsTail: undefined                │  │
│  │  subs: Link(A→C)      subsTail: Link(A→C)              │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  ReactiveNode B (Signal)                                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  currentValue: 2                                        │  │
│  │  pendingValue: 2                                        │  │
│  │  flags: Mutable (1)                                     │  │
│  │                                                          │  │
│  │  deps: undefined      depsTail: undefined                │  │
│  │  subs: Link(B→C)      subsTail: Link(B→C)              │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  ReactiveNode C (Computed)                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  value: 3                                                │  │
│  │  getter: () => a() + b()                                 │  │
│  │  flags: Mutable (1)                                      │  │
│  │                                                          │  │
│  │  deps: Link(A→C) ──► Link(B→C)    depsTail: Link(B→C)   │  │
│  │  subs: Link(C→E)                  subsTail: Link(C→E)   │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  ReactiveNode E (Effect)                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  fn: () => console.log(c())                             │  │
│  │  flags: Watching (2)                                     │  │
│  │                                                          │  │
│  │  deps: Link(C→E) ──► undefined       depsTail: Link(C→E) │  │
│  │  subs: undefined                  subsTail: undefined    │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Link(A→C)                                                    │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  version: 0                                             │   │
│  │  dep: A            │  sub: C                            │   │
│  │  prevSub: undefined │ nextSub: undefined                 │   │
│  │  prevDep: undefined │ nextDep: Link(B→C)                │   │
│  └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Link(B→C)                                                    │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  version: 0                                             │   │
│  │  dep: B            │  sub: C                            │   │
│  │  prevSub: undefined │ nextSub: undefined                 │   │
│  │  prevDep: Link(A→C) │ nextDep: undefined                 │   │
│  └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Link(C→E)                                                    │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  version: 0                                             │   │
│  │  dep: C            │  sub: E                            │   │
│  │  prevSub: undefined │ nextSub: undefined                 │   │
│  │  prevDep: undefined │ nextDep: undefined                 │   │
│  └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**全局状态**：
- `cycle = 0`
- `activeSub = undefined`
- `batchDepth = 0`
- `queued = []`, `queuedLength = 0`

---

### 第 5 步：`a(3)` — 将 signal A 从 1 改成 3

执行 `signalOper`（设置分支）。

#### 5.1 设置值

```typescript
if (this.pendingValue !== (this.pendingValue = value[0])) { // 1 !== 3 = true
    this.flags = ReactiveFlags.Mutable | ReactiveFlags.Dirty; // A.flags = 17
```

```
ReactiveNode A (Signal) 更新后：
  pendingValue: 3
  flags: Mutable | Dirty = 17
```

#### 5.2 触发推送

```typescript
const subs = this.subs; // subs = Link(A→C)
if (subs !== undefined) {
    propagate(subs); // 传播到 Link(A→C)
    if (!batchDepth) flush(); // batchDepth=0，触发 flush
}
```

进入 `propagate(Link(A→C))`：

```
let next = link.nextSub; // next = undefined
let stack: undefined
top: do {
    const sub = link.sub; // sub = C
    let flags = sub.flags; // C.flags = 1 (Mutable)

    // 第一个分支：没有 RecursedCheck|Recursed|Dirty|Pending
    // 1 & (4|8|16|32) = 0
    sub.flags = flags | Pending; // C.flags = 33 (Mutable | Pending)

    // Watching 标志检查：1 & 2 = 0，不触发 notify

    // Mutable 检查：1 & 1 = 1，需要传播
    const subSubs = sub.subs; // subSubs = Link(C→E)
    if (subSubs !== undefined) {
        const nextSub = (link = subSubs).nextSub; // nextSub = undefined
        // nextSub 是 undefined，不入栈
        continue; // 跳回循环，处理 Link(C→E)
    }
} while(true)
```

处理 `Link(C→E)`：

```
const sub = link.sub; // sub = E
let flags = E.flags; // E.flags = 2 (Watching)

没有 RecursedCheck|Recursed|Dirty|Pending
→ sub.flags = flags | Pending; // E.flags = 34 (Watching | Pending)

Watching 检查：2 & 2 = 2，触发 notify(E)
→ notify(E)
```

进入 `notify(E)`：

```typescript
notify(effect=E):
  let insertIndex = queuedLength; // insertIndex = 0
  let firstInsertedIndex = 0;

  do {
    queued[insertIndex++] = E; // queued[0] = E
    effect.flags &= ~Watching; // E.flags = 32 (Pending)
    effect = effect.subs?.sub; // E.subs = Link(C→E), E.subs.sub = C
    // C.flags = 33 (Mutable | Pending), 33 & 2 = 2 (Watching? 不对)
    // C 没有 Watching 标志，所以 break
  } while (...);

  queuedLength = 1;

  // 反转（只有 E 一个，不用反转）
```

此时 `queued = [E]`, `queuedLength = 1`。

回到 `propagate`，E 不需要继续传播（E 没有 subs）。

`propagate` 结束。

#### 5.3 flush()

```typescript
flush():
  while (notifyIndex < queuedLength) { // 0 < 1
    const effect = queued[0]!; // effect = E
    queued[0] = undefined;
    notifyIndex++; // notifyIndex = 1
    run(effect);
  }
```

进入 `run(E)`：

```typescript
const flags = E.flags; // E.flags = 32 (Pending)

flags & Dirty: 0，不脏
flags & Pending: 32 & 32 = 32，且
  checkDirty(E.deps!, E) // 检查 Link(C→E)
```

进入 `checkDirty(Link(C→E), E)`：

```
let stack: undefined
let checkDepth = 0
let dirty = false

top: do {
    const dep = link.dep; // dep = C
    const flags = C.flags; // C.flags = 33 (Mutable | Pending)

    sub.flags & Dirty: E 没有 Dirty，false

    (flags & (Mutable|Dirty)) = (33 & 3) = 1，不是 3，false

    (flags & (Mutable|Pending)) = (33 & 33) = 33，等于 33，true
    // 进入第三层检查：Mutable + Pending
    if (link.nextSub !== undefined ...) // Link(C→E).nextSub = undefined
    if (link.prevSub !== undefined ...) // Link(C→E).prevSub = undefined
    // 都不满足，不入栈
    link = dep.deps!; // link = Link(A→C)
    sub = dep; // sub = C
    ++checkDepth; // checkDepth = 1
    continue;
}
```

处理 `Link(A→C)`：

```
const dep = link.dep; // dep = A
const flags = A.flags; // A.flags = 17 (Mutable | Dirty)

sub.flags & Dirty: E 没有 Dirty，false

(flags & (Mutable|Dirty)) = (17 & 3) = 1，不等于 3，false

(flags & (Mutable|Pending)) = (17 & 33) = 1，不等于 33，false

// 进入其他情况：
flags = ReactiveFlags.None; // flags = 0
```

继续检查下一个依赖：

```
!dirty: true
const nextDep = link.nextDep; // Link(A→C).nextDep = Link(B→C)
if (nextDep !== undefined) {
    link = nextDep; // link = Link(B→C)
    continue;
}
```

处理 `Link(B→C)`：

```
const dep = link.dep; // dep = B
const flags = B.flags; // B.flags = 1 (Mutable)

sub.flags & Dirty: false
(flags & (Mutable|Dirty)) = (1 & 3) = 1，不等于 3，false
(flags & (Mutable|Pending)) = (1 & 33) = 1，不等于 33，false

flags = None

!dirty: true
const nextDep = link.nextDep; // Link(B→C).nextDep = undefined
// link.nextDep 是 undefined，不继续
```

回溯阶段（checkDepth = 1）：

```
checkDepth--: checkDepth = 0
const firstSub = C.subs!; // firstSub = Link(C→E)
const hasMultipleSubs = firstSub.nextSub !== undefined; // undefined !== undefined = false

!hasMultipleSubs:
    link = firstSub; // link = Link(C→E)

dirty = false

sub.flags &= ~Pending; // E.flags = 32 & ~32 = 0

sub = link.sub; // sub = E
const nextDep = link.nextDep; // Link(C→E).nextDep = undefined

return dirty; // dirty = false
```

`checkDirty` 返回 `false`，说明 E 不需要重新运行（因为 C 的值还没变）。

回到 `run(E)`：

```typescript
checkDirty 返回 false，不满足条件
E.flags = Watching; // E.flags = 2
```

#### 5.4 flush 继续

flush 的 try 块结束，进入 finally：

```typescript
finally {
  while (notifyIndex < queuedLength) { // 1 < 1，不进入
  }
  notifyIndex = 0;
  queuedLength = 0;
}
```

flush 结束。

**注意**：此时 console.log 还没有被调用，因为 `checkDirty` 返回了 false（E 不脏）。

这是正常的 —— `checkDirty` 检查发现 A 虽然标记了 Dirty，但 A 的值实际上还没同步（pendingValue 还是旧值），所以 E 暂时不需要运行。

---

### 第 5 步结束后的完整数据结构

```
┌──────────────────────────────────────────────────────────────┐
│  ReactiveNode A (Signal)                                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  currentValue: 1  ← 还没同步！                          │  │
│  │  pendingValue: 3  ← 新值已经写入                         │  │
│  │  flags: Mutable | Dirty (17)                            │  │
│  │                                                          │  │
│  │  deps: undefined      depsTail: undefined                │  │
│  │  subs: Link(A→C)      subsTail: Link(A→C)               │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  ReactiveNode B (Signal)                                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  currentValue: 2                                        │  │
│  │  pendingValue: 2                                        │  │
│  │  flags: Mutable (1)                                     │  │
│  │                                                          │  │
│  │  deps: undefined      depsTail: undefined                │  │
│  │  subs: Link(B→C)      subsTail: Link(B→C)               │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  ReactiveNode C (Computed)                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  value: 3  ← 还没重新计算！                              │  │
│  │  getter: () => a() + b()                                 │  │
│  │  flags: Mutable | Pending (33)                           │  │
│  │                                                          │  │
│  │  deps: Link(A→C) ──► Link(B→C)    depsTail: Link(B→C)  │  │
│  │  subs: Link(C→E)                  subsTail: Link(C→E)   │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  ReactiveNode E (Effect)                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  fn: () => console.log(c())                             │  │
│  │  flags: Watching (2)  ← Pending 已清除                  │  │
│  │                                                          │  │
│  │  deps: Link(C→E) ──► undefined    depsTail: Link(C→E)  │  │
│  │  subs: undefined                  subsTail: undefined  │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**关键变化**：
- A 的 `currentValue = 1`，但 `pendingValue = 3`，`flags = Dirty`
- C 的 `flags = Pending`，`value = 3`（还没重新计算）
- E 的 `flags = Watching`，Pending 已清除

---

### 如果现在访问 c()：`c()`

当其他地方再次调用 `c()` 时，会触发重新计算。

#### C.computedOper 被调用

```typescript
const flags = this.flags; // C.flags = 33 (Mutable | Pending)

flags & Dirty: 0，不脏
flags & Pending: 33 & 32 = 32，且 checkDirty 会被调用
```

进入 `checkDirty(C.deps!, C)`，检查发现 A 是脏的（A.flags 有 Dirty），触发 `updateComputed(C)`：

```
cycle++: cycle = 1
C.depsTail = undefined // 清空依赖
C.flags = Mutable | RecursedCheck = 5

重新执行 getter：
  a() 读取时检测到 A.flags 有 Dirty
  → 调用 updateSignal(A): A.currentValue = 3, 返回 true（A 的值变了）
  → A.currentValue = 3
  → a() 返回 3
  b() 返回 2
  getter 返回 5
```

然后 `shallowPropagate(Link(C→E))`：

```
Link(C→E).sub = E
E.flags = Pending (原为 Watching)
E.flags 有 Watching，触发 notify(E)
→ E 加入队列

console.log(5) 将在 flush 时执行
```

## 总结：数据变化的本质

| 阶段 | 关键变化 |
|------|---------|
| 创建 signal | 初始化 value + flags（Mutable） |
| 创建 computed | 初始化空 deps/subs，getter 绑定 |
| 创建 effect | 设置 Watching + RecursedCheck 标志 |
| effect 执行时读取 computed | 触发 computed 首次计算 + 建立依赖 |
| effect 执行时读取 signal | 通过 link() 建立 Link |
| signal 写入 | 设置 Dirty → propagate → 标记下游 Pending |
| effect 重新运行 | checkDirty 确认脏 → 重新执行 fn() |
