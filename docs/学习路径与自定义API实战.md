# alien-signals 学习路径与自定义 API 实战

下面是一条**最短路径**——按这个顺序走，大约 **1-2 个周末**就能从看懂到能自己造轮子。

---

## 一、学习路径（5 个阶段，循序渐进）

### 阶段 1：建立"心智模型"（30 分钟，纯阅读）

不要急着读源码，先在脑子里建立这张图：

```
  signal/computed/effect 都是节点（ReactiveNode）
                ↓
  节点之间用 Link 双向链表互相挂着
                ↓
  读取时收集依赖（Pull）+ 写入时推送变化（Push）
                ↓
  flags 是位掩码，记录每个节点的状态
```

**任务**：读完 `docs/runtime-data-structures.md` 一遍即可，不要看代码。

---

### 阶段 2：动手画一遍依赖图（1 小时，关键！）

这一步是**最容易被跳过、但收益最高**的一步。拿张纸或开个 Excalidraw，对着 `tests/demo.spec.ts` 这个 10 行的例子手动画：

```ts
const a = signal(0);
const b = computed(() => a() + 1);
const c = computed(() => b() + 2);
expect(c()).toBe(3);
```

要画出来的内容：

| 步骤 | 内存里多了什么 |
|------|---------------|
| `signal(0)` | 节点 A |
| `computed(() => a()+1)` | 节点 B（此时 deps 还是空的）|
| `computed(() => b()+2)` | 节点 C（同上）|
| `c()` | 触发 C 的 getter → 读 b → 读 a，**期间 activeSub 怎么变？link 被调用几次？三个 Link 长什么样？** |

画完后你应该能回答：

- 谁的 `subs` 链表里有什么？
- 谁的 `deps` 链表里有什么？
- 如果调 `a(10)`，propagate 会沿着哪条路径传播？

---

### 阶段 3：源码精读（2-3 小时，按这个顺序）

**只读 6 个函数，按这个顺序，别跳：**

| 顺序 | 文件 | 函数 | 读的目的 |
|------|------|------|---------|
| 1 | `system.ts` | `link()` | 看双向链表如何挂 |
| 2 | `system.ts` | `unlink()` | 看双向链表如何拆 |
| 3 | `index.ts` | `signalOper()` 的"读"分支 | 看 `link(this, activeSub, cycle)` 在哪触发 |
| 4 | `index.ts` | `computedOper()` | 看读取时怎么决定要不要重算 |
| 5 | `system.ts` | `propagate()` | 暂时**忽略**消除递归的栈逻辑，只看主流程 |
| 6 | `system.ts` | `checkDirty()` | 同上，先抓主干 |

**心法**：`propagate` 和 `checkDirty` 的"消除递归"代码很烧脑，第一遍**直接看 README 末尾给的递归版本**就行，理解了主流程再回头看消除递归的版本。

---

### 阶段 4：边读边断点（1 小时）

把这段最简代码贴到一个新的测试文件里，在 VS Code 里打断点跑：

```ts
import { signal, computed, effect } from '../src';

const count = signal(1);
const double = computed(() => count() * 2);
effect(() => console.log(double()));   // 打印 2
count(5);                                // 打印 10
```

**关键断点位置**：

1. `link()` 函数入口 —— 看每次 `dep` / `sub` 是谁
2. `signalOper` 写入分支里 `propagate(subs)` 那行 —— 看推送如何启动
3. `flush()` 入口 —— 看 effect 何时被真正执行

走完一遍，你就**真正理解了"读触发依赖收集，写触发推送"**这句话。

---

### 阶段 5：自定义 API 实战（这才是终点）

经过前 4 步，你已经具备造轮子的能力了。下面给你三个**难度递增**的练习。

---

## 二、自定义 API 三连练（推荐都做一遍）

### 练习 1：仿 TC39 Signals 提案（最简单，30 分钟）

实现 `.get()` / `.set()` 风格的 API：

```ts
// 目标用法
const s = new Signal.State(0);
s.get();        // 0
s.set(10);
const c = new Signal.Computed(() => s.get() * 2);
c.get();        // 20
```

**关键骨架**（你只需填空）：

```ts
import { createReactiveSystem, ReactiveFlags } from 'alien-signals/system';

let activeSub;
const { link, propagate, checkDirty, shallowPropagate } = createReactiveSystem({
    update(node) {
        if (node.getter) {
            // computed: 重算
            const prev = activeSub; activeSub = node;
            const old = node.value;
            node.value = node.getter();
            activeSub = prev;
            return old !== node.value;
        }
        // signal: 同步 pendingValue
        return node.currentValue !== (node.currentValue = node.pendingValue);
    },
    notify() { /* 这个练习暂时不实现 effect，留空 */ },
    unwatched() {},
});

class State {
    constructor(value) {
        Object.assign(this, {
            currentValue: value, pendingValue: value,
            flags: ReactiveFlags.Mutable,
        });
    }
    get() { /* 仿 signalOper 读分支 */ }
    set(v) { /* 仿 signalOper 写分支 */ }
}

class Computed {
    constructor(getter) { /* ... */ }
    get() { /* 仿 computedOper */ }
}
```

**学到什么**：理解 `createReactiveSystem` 三个回调（update/notify/unwatched）的作用，以及 `activeSub` 这个全局变量为什么必须存在。

---

### 练习 2：实现 `ref` + `watch`（中等，1 小时）

仿 Vue 风格的 API：

```ts
const count = ref(0);
count.value;           // 读
count.value = 10;      // 写
watch(count, (newVal, oldVal) => console.log(newVal, oldVal));
```

**核心难点**：

- `watch` 需要"显式指定"要监听的源，不像 `effect` 自动收集
- 提示：在内部用 `effect(() => watchSource())` 包装，并用变量缓存上一次的值

**学到什么**：理解 effect 的"自动依赖收集"和 watch 的"显式依赖"在算法层是同一回事，只是 API 包装不同。

---

### 练习 3：实现 `selector`（高难度，但最有成就感，2 小时）

类似 React Redux 的 `useSelector`，从一个对象里只订阅你关心的字段：

```ts
const state = signal({ user: { name: 'Tom', age: 18 }, theme: 'dark' });

// 只订阅 user.name，state 中其他字段变化不会触发回调
const name = selector(state, s => s.user.name);
effect(() => console.log(name()));  // 只在 user.name 变化时打印
```

**实现思路**：

- 内部就是一个 `computed`，但要在结果**等于**上次时**阻止**向下传播
- 利用 `update` 回调的返回值（`true=变了, false=没变`）控制传播
- 提示：你需要自定义一个 `ComputedNode` 的子类型，并在 `update` 里做相等性检查

**学到什么**：真正掌握"`update` 返回值如何决定 propagate 是否继续"这个核心机制——这是 alien-signals 最值钱的一个设计。

---

## 三、加速学习的 4 个小技巧

### 1. 把代码当**状态机**看，不要当**调用栈**看

`propagate` / `checkDirty` 里的 `flags` 各种位运算让人晕。把每个节点当作有限状态机：

```
None ─(被 propagate 触碰)→ Pending ─(checkDirty 确认变化)→ Dirty
                              │
                              └─(checkDirty 确认未变)→ None
```

理解了状态转换，flags 的位运算就只是"实现细节"。

### 2. 给自己做一个"调试版" system.ts

复制一份 `system.ts`，在每个关键函数入口加 `console.log`：

```ts
function link(dep, sub, version) {
    console.log(`[LINK] ${dep.name} → ${sub.name}`);  // 给节点临时加 name 字段
    // ...
}
```

跑测试时一目了然。这是性价比最高的"理解神器"。

### 3. 优先读 tests/，不要硬啃 src/

`tests/computed.spec.ts`、`tests/topology.spec.ts` 里每个测试都是一个**最小可运行场景**。看测试名就能知道"这段代码在解决什么问题"，然后去源码里找对应分支，比直接读源码高效 10 倍。

### 4. 善用启动模板

官方提供了脚手架：[alien-signals-starter](https://github.com/johnsoncodehk/alien-signals-starter)（README 里有链接）。基于它二次开发比从零开始快很多。

---

## 四、总结：通关检验清单

如果你能流畅回答这 7 个问题，就算"学透"了：

- [ ] `Link` 为什么要同时挂在两条链表上？只挂一条不行吗？
- [ ] `cycle`（version）这个数字到底解决了什么问题？
- [ ] `signal` 写入时是 push，`computed` 读取时是 pull——为什么不能两边都用 push？
- [ ] `RecursedCheck` 和 `Recursed` 这两个标志为什么要分开？
- [ ] `unwatched` 回调在什么时候被调用？为什么 `signal` 不需要做清理但 `computed` 需要？
- [ ] `flush` 里的 `try/finally` 为什么要分两阶段处理队列？
- [ ] 如果让你给 `effect` 加一个 `onCleanup(fn)` API（在 effect 重新执行前调用上一次的清理函数），你会怎么改？

**最后一个问题（onCleanup）就是你的"毕业设计"**——它需要你完整理解节点生命周期，做完之后基本上可以去给主仓库提 PR 了。

---

## 五、一图看懂学习节奏

```
阶段1: 心智模型 (30min)
   │
   ▼
阶段2: 手画依赖图 (1h)  ← 最关键！别跳！
   │
   ▼
阶段3: 6个核心函数精读 (2-3h)
   │
   ▼
阶段4: 断点调试 (1h)
   │
   ▼
阶段5: 三个练习
   ├─ TC39 风格 API (30min)
   ├─ ref + watch (1h)
   └─ selector (2h)  ← 通关！
   │
   ▼
回答 7 个通关问题
   │
   ▼
能给主仓库提 PR
```

---

## 二（补充）、阶段 2 详细图解：手画依赖图

以 `tests/demo.spec.ts` 为例：

```ts
const a = signal(0);                  // ① 创建 signal 节点 A
const b = computed(() => a() + 1);    // ② 创建 computed 节点 B（deps 此时为空）
const c = computed(() => b() + 2);    // ③ 创建 computed 节点 C（deps 此时为空）

expect(c()).toBe(3);                  // ④ 读取 C，触发完整的依赖收集
```

---

### 步骤 ①：`const a = signal(0)`

`signal(0)` 调用 `signalOper.bind(...)`，创建一个对象：

```
┌─────────────────────────────────────────────────┐
│              节点 A（SignalNode）                │
│                                                 │
│  currentValue : 0                               │
│  pendingValue : 0                               │
│  subs         : undefined   ← 还没有下游订阅   │
│  subsTail     : undefined                        │
│  flags        : Mutable (= 1, 二进制 000001)   │
└─────────────────────────────────────────────────┘
```

**此时内存中只有 A，没有任何 Link。**

---

### 步骤 ②：`const b = computed(() => a() + 1)`

`computed(() => ...)` 调用 `computedOper.bind(...)`，创建一个对象：

```
┌─────────────────────────────────────────────────┐
│              节点 B（ComputedNode）               │
│                                                 │
│  value        : undefined   ← 还没有计算过       │
│  getter       : () => a() + 1                   │
│  deps         : undefined   ← 还没有建立依赖     │
│  depsTail     : undefined                        │
│  subs         : undefined   ← 还没有下游订阅     │
│  subsTail     : undefined                        │
│  flags        : None (= 0, 二进制 000000)       │
└─────────────────────────────────────────────────┘
```

**B 创建了，但 getter 还没有执行，`b.deps` 为空，A 和 B 之间还没有 Link。**

---

### 步骤 ③：`const c = computed(() => b() + 2)`

同样创建一个对象：

```
┌─────────────────────────────────────────────────┐
│              节点 C（ComputedNode）               │
│                                                 │
│  value        : undefined                        │
│  getter       : () => b() + 2                   │
│  deps         : undefined                        │
│  depsTail     : undefined                        │
│  subs         : undefined                        │
│  subsTail     : undefined                        │
│  flags        : None (= 0)                      │
└─────────────────────────────────────────────────┘
```

**C 也创建了，A、B、C 三者之间仍然没有任何 Link 连接。**

**当前总览（①②③结束后）：**

```
   节点 A                    节点 B                    节点 C
┌──────────┐           ┌──────────┐           ┌──────────┐
│signal    │           │computed  │           │computed  │
│value: 0  │           │value: -  │           │value: -  │
│subs: -   │           │deps: -   │           │deps: -   │
│subsTail:-│           │subs: -   │           │subs: -   │
│flags:M   │           │flags:0   │           │flags:0   │
└──────────┘           └──────────┘           └──────────┘

（- 表示 undefined）
没有任何 Link！没有任何连接！
```

---

### 步骤 ④：`c()` —— 依赖收集的完整过程

这是最关键的一步。`c()` 实际调用 `computedOper()`，分两个阶段执行。

#### 4.1 进入 computedOper，发现 flags === None，走"首次读取"分支

```871:905:src/index.ts
} else if (!flags) {
    this.flags = ReactiveFlags.Mutable | ReactiveFlags.RecursedCheck;
    const prevSub = setActiveSub(this);
    try {
        this.value = this.getter();   // ← 执行 c 的 getter
    } finally {
        activeSub = prevSub;
        this.flags &= ~ReactiveFlags.RecursedCheck;
    }
}
```

做了三件事：

```
┌──────────────────────────────────────────────────────────────┐
│  1. this.flags = Mutable | RecursedCheck                     │
│                                                             │
│  2. setActiveSub(this)                                      │
│     global activeSub = C   （全局变量从 undefined 变为 C）     │
│                                                             │
│  3. 执行 getter: () => b() + 2                               │
│                                                             │
│     └── 进入 b() → 执行 b 的 getter: () => a() + 1           │
│              └── 进入 a() → 读取 signal 的值                 │
│                  此时 activeSub = C，触发 link(A, C, 0)      │
│                  生成 Link L_AC                               │
│              回到 b() 的 getter，继续执行 → 返回 a()+1 = 1    │
│         回到 c() 的 getter，继续执行 → 返回 b()+2 = 3         │
│                                                             │
│  4. activeSub = prevSub（恢复为 undefined）                   │
│     this.flags &= ~RecursedCheck                             │
└──────────────────────────────────────────────────────────────┘
```

#### 4.2 细看 `b()` 的执行

`b()` 调用 `computedOper`，检查 `flags === None`（首次），同样走"首次读取"分支：

```
1. b.flags = Mutable | RecursedCheck
2. activeSub = B   （覆盖了之前的 C！）
3. 执行 getter: () => a() + 1
   → 调用 a()
```

#### 4.3 细看 `a()` 的执行

`a()` 调用 `signalOper`，进入**读取分支**（无参数调用）：

```932:979:src/index.ts
} else {
    // 读取分支
    if (this.flags & ReactiveFlags.Dirty) {
        // ...
    }

    // 建立依赖关系 —— 这是 link 被调用的地方！
    let sub = activeSub;
    while (sub !== undefined) {
        if (sub.flags & (ReactiveFlags.Mutable | ReactiveFlags.Watching)) {
            link(this, sub, cycle);   // ← link(A, B, 0)
            break;
        }
        sub = sub.subs?.sub;
    }

    return this.currentValue;
}
```

此时 `activeSub = B`，`B.flags = Mutable`，条件满足，调用：

```ts
link(A, B, 0);   // 含义：B 依赖 A
```

#### 4.4 进入 `link()`，创建 Link L_AB

```207:270:src/system.ts
function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
    // prevDep = sub.depsTail = B.depsTail = undefined（首次，去重全部跳过）
    // prevSub = dep.subsTail = A.subsTail = undefined（首次，去重全部跳过）

    const newLink = B.depsTail = A.subsTail = {
        version: 0,
        dep: A,       // A 是被依赖的（上游）
        sub: B,       // B 是依赖者（下游）
        prevDep: undefined,
        nextDep: undefined,
        prevSub: undefined,
        nextSub: undefined,
    };

    // 双向链表插入（因为 prevDep/prevSub 都是 undefined，所以：
    //   B.deps = newLink, B.depsTail = newLink
    //   A.subs = newLink, A.subsTail = newLink
}
```

**L_AB 创建完成，同时挂在 A 和 B 两条链表上：**

```
   A.subs ─────────────────────────┐
   A.subsTail ─────────────────────┘
             │
             ▼
         ┌─────────┐
         │ L_AB    │
         │ dep → A │
         │ sub → B │
         │prevSub:-│
         │nextSub:-│
         │prevDep:-│
         │nextDep:-│
         └─────────┘
             │  A.deps 链表     B.deps 链表
             │    无            无
             ▼                  ▼
         ┌──────────┐       ┌──────────┐
         │signal    │       │computed  │
         │value: 0  │       │value: 1  │  ← b() 的返回值
         │subs: L_AB│       │deps: L_AB│  ← 现在 B.deps 非空了
         │subsTail: │       │depsTail: │
         │  L_AB    │       │  L_AB    │
         │flags: M  │       │flags: M  │
         └──────────┘       └──────────┘
```

#### 4.5 b 的 getter 执行完毕，返回 1

`b()` 的 getter `() => a() + 1` 执行完，`a()` 返回 0，`b()` 返回 1。

此时回到外层 `c()` 的 getter `() => b() + 2`，调用 `b()` —— 这次 `b()` **不是首次读取**了，会走不同的分支。

#### 4.6 回到 c() 的 getter，调用 b()

`c()` 执行 getter 时调用 `b()`，`b()` 的 `flags` 此时是 `Mutable | RecursedCheck`（不等于 None），不走"首次读取"分支：

```871:894:src/index.ts
if (
    flags & ReactiveFlags.Dirty
    || (
        flags & ReactiveFlags.Pending
        && (checkDirty(...) || (this.flags = flags & ~ReactiveFlags.Pending, false))
    )
) {
    // Dirty 或 Pending 分支 → 重算
    if (updateComputed(this)) { ... }
} else if (!flags) {
    // 首次读取分支（上面走过了，不会再进来）
}
```

`b.flags = Mutable | RecursedCheck`（值是 5），既没有 Dirty 也没有 Pending，走**不重算**路径。然后执行 `b.getter()` 获取值。

关键来了：读取 `b()` 时，**会再次建立依赖**。

```907:913:src/index.ts
// 建立依赖关系：如果有活跃订阅者，当前 computed 被它依赖
const sub = activeSub;
if (sub !== undefined) {
    link(this, sub, cycle);  // ← link(B, C, cycle)
}
```

此时 `activeSub = C`，于是调用：

```ts
link(B, C, 0);   // 含义：C 依赖 B
```

#### 4.7 进入 `link()`，创建 Link L_BC

和 L_AB 完全相同的流程：

```
A.subs = L_AB ──► L_BC  （A 的第二个订阅者）
A.subsTail = L_BC

B.subs = L_BC ──►
B.subsTail = L_BC

C.deps = L_BC ──►
C.depsTail = L_BC
```

**L_BC 创建完成：**

```
         ┌─────────┐
         │ L_BC    │
         │ dep → B │
         │ sub → C │
         └─────────┘
```

---

### 完整依赖图（步骤 ④ 结束后）

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                      global: cycle = 0                          │
│                      global: activeSub = undefined              │
│                                                                 │
│  ┌───────────┐                     ┌───────────┐                 │
│  │  A        │  subs(L_AB)        │  B        │                 │
│  │ (signal)  │ ─────────────────► │(computed) │                 │
│  │           │       ▲             │           │                 │
│  │ value: 0  │       │             │ value: 1  │                 │
│  │subsTail:  │       │             │deps: L_AB │                 │
│  │  L_AB     │  deps(L_AB)        │depsTail:  │                 │
│  │subs: L_AB │       │             │  L_AB     │                 │
│  │   L_AB────┼───────┘             │subs: L_BC │                 │
│  │   L_BC────┼────────────────────►│subsTail:  │                 │
│  │subsTail:  │                     │  L_BC     │                 │
│  │   L_BC    │                     │flags: M   │                 │
│  │flags: M   │                     └───────────┘                 │
│  └───────────┘             deps(L_BC)▲                            │
│                               │                                  │
│  ┌───────────┐                 │                                  │
│  │  C        │◄────────────────┘                                  │
│  │(computed) │  subs: -（C 没有下游，所以 subs 全是 undefined）   │
│  │           │                                                   │
│  │ value: 3  │  ← c() 的返回值                                   │
│  │deps: L_BC │                                                   │
│  │depsTail:  │                                                   │
│  │  L_BC     │                                                   │
│  │flags: M   │                                                   │
│  └───────────┘                                                   │
│                                                                 │
│  Link 汇总：                                                      │
│  L_AB: { dep→A, sub→B, prevDep:-, nextDep:-, prevSub:-, nextSub:L_BC }  │
│  L_BC: { dep→B, sub→C, prevDep:-, nextDep:-, prevSub:L_AB, nextSub:- }  │
│                                                                 │
│  依赖方向（沿 dep→sub 读）：                                      │
│    A ──subs──► L_AB ──dep──► B                                   │
│    B ──subs──► L_BC ──dep──► C                                   │
│                                                                 │
│  反向引用（沿 sub→dep 读）：                                      │
│    C ──deps──► L_BC ──sub──► B                                   │
│    B ──deps──► L_AB ──sub──► A                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### 进阶：如果此时调用 `a(10)` 会发生什么？

```
a(10) 写入
   │
   ├─ pendingValue ≠ 10，触发值变化
   │  a.flags = Mutable | Dirty
   │
   ├─ propagate(a.subs) = propagate(L_AB)
   │
   ├─ 沿 L_AB 找到 B：
   │  B.flags = Mutable | Pending   （标记为待处理）
   │  B 是 Mutable，继续传播
   │  B.subs = L_BC
   │  沿 L_BC 找到 C：
   │    C.flags = Mutable | Pending  （标记为待处理）
   │    C 不是 Mutable，停止传播
   │
   ├─ 下次读取 c() 时：
   │    C 触发 checkDirty(C.deps = L_BC)
   │    沿 L_BC 检查 B → B 是 Mutable | Pending
   │    深入 B.deps = L_AB，检查 A → A 是 Mutable | Dirty
   │    update(A)：同步 pendingValue → currentValue
   │    返回 true（A 的值确实变了）
   │    回溯，更新 B → B = a() + 1 = 11
   │    回溯，更新 C → C = b() + 2 = 13
   │
   └─ c() 返回 13（从 3 更新到 13）
```

这就是 **Push（标记）+ Pull（重算）** 的完整流程：`a` 变化时只打标记（Pending），真正计算延迟到读取时才发生。
