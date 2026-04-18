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
